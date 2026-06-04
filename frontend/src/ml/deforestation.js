// Browser-side deforestation detection.
//
// Fetches NASA GIBS MODIS Terra TrueColor daily mosaic tiles (Web Mercator
// XYZ, 256×256 JPG) for a "before" and "after" date, stitches them into
// per-year canvases clipped to the user's polygon, then runs a TensorFlow.js
// greenness-delta pipeline to flag pixels that lost vegetation between the
// two dates. No backend, no LLM.
//
// MODIS TrueColor is RGB-only (no NIR) so we approximate vegetation via a
// "greenness index" computed in TF: GI = (2G - R - B) / (G + R + B + eps).
// Forest pixels score high; bare ground / built-up score low. A drop > the
// configured threshold (and starting from a vegetated baseline) counts as
// loss.
//
// MODIS Terra has been imaging daily since Feb 2000 at 250 m native resolution,
// giving us a ~20-year change-detection window. The price is coarse pixels —
// sub-hectare clearings disappear into the resampling.

import * as tf from '@tensorflow/tfjs'

const TILE_PX = 256
const EARTH_RADIUS_M = 6378137
const MERCATOR_RES_AT_Z0 = (2 * Math.PI * EARTH_RADIUS_M) / TILE_PX // m per px at z=0

// Per-source max zoom (server caps). Web Mercator XYZ tile layers below.
const SOURCES = {
  'modis-terra': {
    id: 'modis-terra',
    label: 'MODIS Terra (250 m, 2004-2024)',
    yearRange: [2004, 2024],
    defaultBefore: 2004,
    defaultAfter: 2024,
    monthDay: '07-15', // mid-July: peak Northern-hemisphere greenness
    // Per the GIBS GetCapabilities: MODIS Terra TrueColor only publishes zoom
    // levels 0-9 under GoogleMapsCompatible_Level9. Asking for z=10+ returns
    // a 400 Bad Request.
    maxZoom: 9,
    nativeResolutionM: 250,
    minAreaKm2: 5,
    attribution: 'NASA GIBS MODIS Terra TrueColor (250 m native, mid-July of each year)',
    tileUrl: (year, monthDay, z, x, y) =>
      `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${year}-${monthDay}/GoogleMapsCompatible_Level9/${z}/${y}/${x}.jpg`,
  },
  's2cloudless': {
    id: 's2cloudless',
    label: 'Sentinel-2 cloudless (10 m, 2018-2024)',
    yearRange: [2018, 2024],
    defaultBefore: 2018,
    defaultAfter: 2024,
    monthDay: null, // yearly mosaic — date isn't part of the URL
    maxZoom: 14,
    nativeResolutionM: 10,
    minAreaKm2: 0.01,
    attribution: 'ESA Sentinel-2 cloudless yearly mosaic (EOX, 10 m native)',
    tileUrl: (year, _monthDay, z, x, y) =>
      `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${year}_3857/default/GoogleMapsCompatible/${z}/${y}/${x}.jpg`,
  },
}

export { SOURCES }

const DEFAULT_SOURCE_ID = 'modis-terra'

const DEFAULTS = {
  greennessDropThreshold: 0.08, // drop in GI required to flag loss
  minVegetatedGI: 0.06,         // before-year GI must exceed this to be "vegetation"
  targetCanvasMaxPx: 768,       // cap stitched canvas size so TF stays snappy
}

// --- Geometry / tile math ----------------------------------------------------

function getRing(geojson) {
  const g = geojson?.geometry || geojson
  if (g.type === 'Polygon') return g.coordinates[0]
  if (g.type === 'MultiPolygon') return g.coordinates[0][0]
  throw new Error('geometry must be a Polygon or MultiPolygon')
}

function polygonBounds(ring) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon
    if (lat < minLat) minLat = lat
    if (lon > maxLon) maxLon = lon
    if (lat > maxLat) maxLat = lat
  }
  return { minLon, minLat, maxLon, maxLat }
}

function lonLatToWorldPx(lon, lat, z) {
  const scale = TILE_PX * Math.pow(2, z)
  const x = ((lon + 180) / 360) * scale
  const sinLat = Math.sin((lat * Math.PI) / 180)
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale
  return { x, y }
}

function pickZoom({ minLon, minLat, maxLon, maxLat }, maxPx, maxZoom) {
  // Pick the largest zoom for which the bbox fits in maxPx × maxPx.
  for (let z = maxZoom; z >= 3; z--) {
    const tl = lonLatToWorldPx(minLon, maxLat, z)
    const br = lonLatToWorldPx(maxLon, minLat, z)
    if (Math.max(br.x - tl.x, br.y - tl.y) <= maxPx) return z
  }
  return 3
}

// --- Image fetch + canvas stitch --------------------------------------------

function loadTile(source, year, monthDay, z, x, y) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Failed to load tile ${source.id} ${year} z=${z} x=${x} y=${y}`))
    img.src = source.tileUrl(year, monthDay, z, x, y)
  })
}

async function fetchYearMosaic(source, year, monthDay, bounds, z, ring, onProgress) {
  const label = monthDay ? `${year}-${monthDay}` : `${year}`
  const tl = lonLatToWorldPx(bounds.minLon, bounds.maxLat, z)
  const br = lonLatToWorldPx(bounds.maxLon, bounds.minLat, z)

  const tx0 = Math.floor(tl.x / TILE_PX)
  const ty0 = Math.floor(tl.y / TILE_PX)
  const tx1 = Math.floor(br.x / TILE_PX)
  const ty1 = Math.floor(br.y / TILE_PX)

  const tileCols = tx1 - tx0 + 1
  const tileRows = ty1 - ty0 + 1
  const fullWidth = tileCols * TILE_PX
  const fullHeight = tileRows * TILE_PX

  // Crop offsets inside the stitched full-tile canvas so the output spans
  // exactly the bbox (not a tile boundary).
  const offsetX = tl.x - tx0 * TILE_PX
  const offsetY = tl.y - ty0 * TILE_PX
  const cropW = Math.ceil(br.x - tl.x)
  const cropH = Math.ceil(br.y - tl.y)

  const fullCanvas = document.createElement('canvas')
  fullCanvas.width = fullWidth
  fullCanvas.height = fullHeight
  const fullCtx = fullCanvas.getContext('2d')

  const total = tileCols * tileRows
  let done = 0
  const loads = []
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      loads.push(
        loadTile(source, year, monthDay, z, tx, ty).then((img) => {
          fullCtx.drawImage(img, (tx - tx0) * TILE_PX, (ty - ty0) * TILE_PX)
          done++
          onProgress?.(`fetch-${year}`, `Fetching ${label} imagery (${done}/${total} tiles)`)
        })
      )
    }
  }
  await Promise.all(loads)

  // Crop to bbox.
  const cropCanvas = document.createElement('canvas')
  cropCanvas.width = cropW
  cropCanvas.height = cropH
  const cropCtx = cropCanvas.getContext('2d')
  cropCtx.drawImage(fullCanvas, -offsetX, -offsetY)

  // Clip to the polygon: anything outside becomes transparent. The alpha
  // channel then doubles as our polygon mask downstream.
  cropCtx.globalCompositeOperation = 'destination-in'
  cropCtx.beginPath()
  ring.forEach(([lon, lat], i) => {
    const wp = lonLatToWorldPx(lon, lat, z)
    const px = wp.x - tx0 * TILE_PX - offsetX
    const py = wp.y - ty0 * TILE_PX - offsetY
    if (i === 0) cropCtx.moveTo(px, py)
    else cropCtx.lineTo(px, py)
  })
  cropCtx.closePath()
  cropCtx.fill()
  cropCtx.globalCompositeOperation = 'source-over'

  return cropCtx.getImageData(0, 0, cropW, cropH)
}

// --- TensorFlow change detection --------------------------------------------

function imageDataToTensor(imageData) {
  // Returns [H, W, 4] float32 in [0,1] — channels R, G, B, A (alpha = polygon mask).
  const t = tf.browser.fromPixels(imageData, 4).toFloat().div(255)
  return t
}

function greennessIndex(rgbA) {
  // GI = (2G - R - B) / (G + R + B + eps); rgbA is [H, W, 4].
  return tf.tidy(() => {
    const r = rgbA.slice([0, 0, 0], [-1, -1, 1])
    const g = rgbA.slice([0, 0, 1], [-1, -1, 1])
    const b = rgbA.slice([0, 0, 2], [-1, -1, 1])
    const num = g.mul(2).sub(r).sub(b)
    const den = g.add(r).add(b).add(1e-6)
    return num.div(den).squeeze([-1]) // [H, W]
  })
}

async function detectChange(beforeData, afterData, opts) {
  return tf.tidy(() => {
    const before = imageDataToTensor(beforeData)
    const after = imageDataToTensor(afterData)

    const giBefore = greennessIndex(before)
    const giAfter = greennessIndex(after)
    const drop = giBefore.sub(giAfter)

    // Polygon mask = the alpha channel of the (clipped) before image — pixels
    // outside the polygon are 0 alpha after the destination-in clip.
    const polyMask = before.slice([0, 0, 3], [-1, -1, 1]).squeeze([-1]).greater(0.5)

    const wasVegetated = giBefore.greater(opts.minVegetatedGI)
    const lostEnough = drop.greater(opts.greennessDropThreshold)
    const lossMask = wasVegetated.logicalAnd(lostEnough).logicalAnd(polyMask)

    // bool tensors serialize as Uint8Array of 0/1; cast to int32 first so the
    // sums return numbers rather than booleans, but skip a uint8 cast on the
    // mask itself — TF.js doesn't accept 'uint8' as a cast target.
    const lossPx = lossMask.cast('int32').sum().arraySync()
    const polyPx = polyMask.cast('int32').sum().arraySync()

    return {
      lossMaskData: lossMask.dataSync(), // Uint8Array, values are 0 or 1
      shape: [lossMask.shape[0], lossMask.shape[1]],
      lossPx,
      polyPx,
    }
  })
}

// --- Output rendering --------------------------------------------------------

function metersPerPixel(centroidLat, z) {
  return MERCATOR_RES_AT_Z0 * Math.cos((centroidLat * Math.PI) / 180) / Math.pow(2, z)
}

function ringCentroid(ring) {
  let lon = 0, lat = 0
  for (const [x, y] of ring) { lon += x; lat += y }
  return [lon / ring.length, lat / ring.length]
}

function renderOverlayDataUrl(afterData, lossMaskData, [h, w]) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.putImageData(afterData, 0, 0)

  const overlay = ctx.getImageData(0, 0, w, h)
  const px = overlay.data
  for (let i = 0; i < lossMaskData.length; i++) {
    if (lossMaskData[i] === 0) continue
    const j = i * 4
    // Blend 50% red over the existing pixel.
    px[j]     = Math.round(0.5 * 255 + 0.5 * px[j])
    px[j + 1] = Math.round(0.5 * px[j + 1])
    px[j + 2] = Math.round(0.5 * px[j + 2])
    // Keep alpha as-is so the polygon clip stays.
  }
  ctx.putImageData(overlay, 0, 0)
  return canvas.toDataURL('image/png')
}

// --- Verdict text ------------------------------------------------------------

function classify(lossHa, lossFraction) {
  if (lossHa < 0.1) return { verdict: 'no_loss', label: 'no detectable forest loss', confidence: 'high' }
  if (lossHa < 1.0 && lossFraction < 0.005) return { verdict: 'minor_loss', label: 'minor forest loss', confidence: 'medium' }
  if (lossHa > 50.0 || lossFraction > 0.10) return { verdict: 'severe_loss', label: 'severe forest loss', confidence: 'high' }
  return { verdict: 'significant_loss', label: 'significant forest loss', confidence: lossFraction > 0.02 ? 'medium' : 'low' }
}

function isLikelyIllegal(lossHa, lossFraction) {
  return lossHa >= 25.0 || lossFraction >= 0.05
}

function buildMarkdown(cls, illegal, stats, overlayDataUrl, beforeYear, afterYear) {
  const { lossHa, lossFraction } = stats
  const pct = (lossFraction * 100).toFixed(1)

  let body = `Between **${beforeYear}** and **${afterYear}**, **${lossHa.toFixed(2)} ha** (${pct}% of the polygon) shows ${cls.label}.`
  if (cls.verdict === 'no_loss') {
    body += ' No measurable change detected between the two years.'
  } else if (illegal) {
    body += ' The cleared area is large enough and concentrated enough to be consistent with unplanned clearing — worth flagging for review.'
  } else {
    body += ' Loss looks limited or scattered; could be natural disturbance, selective harvest, or noise.'
  }
  body += `\n\n![change overlay](${overlayDataUrl})`
  return body
}

// --- Orchestrator -----------------------------------------------------------

export async function runDeforestationAnalysis(geojson, opts = {}) {
  const sourceId = opts.sourceId || DEFAULT_SOURCE_ID
  const source = SOURCES[sourceId]
  if (!source) throw new Error(`Unknown imagery source: ${sourceId}`)

  const cfg = {
    ...DEFAULTS,
    beforeYear: source.defaultBefore,
    afterYear: source.defaultAfter,
    monthDay: source.monthDay,
    ...opts,
  }
  const onProgress = cfg.onProgress || (() => {})
  const onDebug = cfg.onDebug || (() => {})

  const debug = {
    source: {
      id: source.id,
      label: source.label,
      nativeResolutionM: source.nativeResolutionM,
      maxZoom: source.maxZoom,
    },
    config: {
      beforeYear: cfg.beforeYear,
      afterYear: cfg.afterYear,
      monthDay: cfg.monthDay,
      greennessDropThreshold: cfg.greennessDropThreshold,
      minVegetatedGI: cfg.minVegetatedGI,
      targetCanvasMaxPx: cfg.targetCanvasMaxPx,
    },
    tf: {
      backend: tf.getBackend(),
      memoryStart: tf.memory(),
    },
    userAgent: navigator.userAgent,
    timings: {},
  }
  const t0 = performance.now()
  const mark = (label, start) => { debug.timings[label] = Math.round(performance.now() - start) }
  const push = (patch) => { Object.assign(debug, patch); onDebug({ ...debug }) }
  push({})

  onProgress('init', `Preparing analysis (${source.label})…`)
  const ring = getRing(geojson)
  const bounds = polygonBounds(ring)
  const z = pickZoom(bounds, cfg.targetCanvasMaxPx, source.maxZoom)

  // Bbox in km — proxy for polygon area (real spherical area would need a
  // proper formula; pixel-derived area below is more accurate).
  const latMid = (bounds.minLat + bounds.maxLat) / 2
  const bboxWidthKm = Math.abs(bounds.maxLon - bounds.minLon) * 111.32 * Math.cos((latMid * Math.PI) / 180)
  const bboxHeightKm = Math.abs(bounds.maxLat - bounds.minLat) * 110.57
  debug.polygon = {
    vertices: ring.length - 1, // last point repeats the first
    bbox: bounds,
    bboxAreaKm2: +(bboxWidthKm * bboxHeightKm).toFixed(3),
  }
  debug.tiles = { zoom: z }
  push({})

  onProgress('fetch', `Loading ${cfg.beforeYear} imagery…`)
  const tBefore = performance.now()
  const beforeData = await fetchYearMosaic(source, cfg.beforeYear, cfg.monthDay, bounds, z, ring, onProgress)
  mark('beforeFetchMs', tBefore)
  debug.tiles.canvasW = beforeData.width
  debug.tiles.canvasH = beforeData.height
  push({})

  onProgress('fetch', `Loading ${cfg.afterYear} imagery…`)
  const tAfter = performance.now()
  const afterData = await fetchYearMosaic(source, cfg.afterYear, cfg.monthDay, bounds, z, ring, onProgress)
  mark('afterFetchMs', tAfter)
  push({})

  onProgress('infer', 'Running TensorFlow change detection…')
  const tInfer = performance.now()
  const result = await detectChange(beforeData, afterData, cfg)
  mark('inferMs', tInfer)
  debug.tf.memoryPeak = tf.memory()
  push({})

  const [centroidLon, centroidLat] = ringCentroid(ring)
  const mpp = metersPerPixel(centroidLat, z)
  const pxHa = (mpp * mpp) / 10000
  const lossHa = result.lossPx * pxHa
  const lossFraction = result.polyPx > 0 ? result.lossPx / result.polyPx : 0

  onProgress('render', 'Rendering overlay…')
  const tRender = performance.now()
  const overlayDataUrl = renderOverlayDataUrl(afterData, result.lossMaskData, result.shape)
  mark('renderMs', tRender)
  debug.polygon.centroid = { lat: +centroidLat.toFixed(5), lon: +centroidLon.toFixed(5) }
  debug.tiles.metersPerPixel = +mpp.toFixed(2)
  debug.pixels = {
    polyPx: result.polyPx,
    lossPx: result.lossPx,
    lossFraction: +lossFraction.toFixed(5),
    hectaresPerPixel: +pxHa.toFixed(4),
    lossHa: +lossHa.toFixed(3),
    pxAreaImpliedKm2: +((result.polyPx * mpp * mpp) / 1_000_000).toFixed(3),
  }
  debug.tf.memoryEnd = tf.memory()
  debug.timings.totalMs = Math.round(performance.now() - t0)
  push({})

  const stats = {
    lossHa,
    lossFraction,
    lossPx: result.lossPx,
    polyPx: result.polyPx,
    zoom: z,
    metersPerPixel: mpp,
    centroid: { lon: centroidLon, lat: centroidLat },
  }
  const cls = classify(lossHa, lossFraction)
  const illegal = isLikelyIllegal(lossHa, lossFraction)
  const markdown = buildMarkdown(cls, illegal, stats, overlayDataUrl, cfg.beforeYear, cfg.afterYear)

  onProgress('done', 'Done.')
  return {
    markdown,
    verdict: cls.verdict,           // 'no_loss' | 'minor_loss' | 'significant_loss' | 'severe_loss'
    verdictLabel: cls.label,
    likelyIllegal: illegal,
    confidence: cls.confidence,
    stats,
    overlayDataUrl,
    beforeYear: cfg.beforeYear,
    afterYear: cfg.afterYear,
    source: { id: source.id, label: source.label, attribution: source.attribution },
  }
}
