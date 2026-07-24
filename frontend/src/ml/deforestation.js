// Browser-side deforestation detection.
//
// Fetches NASA GIBS MODIS Terra TrueColor daily mosaic tiles (Web Mercator
// XYZ, 256×256 JPG) for a "before" and "after" date, stitches them into
// per-year canvases clipped to the user's polygon, then runs a TensorFlow.js
// greenness-delta pipeline to flag pixels that lost vegetation between the
// two dates. No backend, no LLM.
//
// The imagery is RGB-only (no NIR), and in true color a greenness index alone
// cannot tell forest from grass or crops — a clearcut that regrows grass within
// a season stays "green" and a naive greenness delta misses it. What DOES
// separate closed-canopy forest in true color is that it is both green AND
// dark. So instead of differencing an index, each year is CLASSIFIED per pixel
// as forest / not-forest (dark relative to the scene AND green), and change is
// the classification transition: forest→not-forest = loss, not-forest→forest =
// regrowth. Scene-relative thresholds absorb year-to-year haze/processing
// drift between mosaics, and a transition only counts if the underlying
// scene-normalized brightness or greenness also moved by a solid margin in the
// claimed direction — classification flapping near the threshold does not.
//
// MODIS Terra has been imaging daily since Feb 2000 at 250 m native resolution,
// giving us a ~20-year change-detection window. The price is coarse pixels —
// sub-hectare clearings disappear into the resampling.

import * as tf from '@tensorflow/tfjs'

const TILE_PX = 256
const EARTH_RADIUS_M = 6378137
const MERCATOR_RES_AT_Z0 = (2 * Math.PI * EARTH_RADIUS_M) / TILE_PX // m per px at z=0

// Per-source max zoom (server caps). Web Mercator XYZ tile layers below.
// NOTE: order matters — the UI defaults to the first entry (SOURCE_LIST[0]) and
// lists sources in this order. Sentinel-2 is first so it is the default.
const SOURCES = {
  's2cloudless': {
    id: 's2cloudless',
    label: 'Sentinel-2 cloudless (10 m, 2018-2024)',
    yearRange: [2018, 2024],
    defaultBefore: 2018,
    defaultAfter: 2024,
    monthDay: null, // yearly mosaic — date isn't part of the URL
    compositeMonthDays: null, // already a cloud-free yearly composite server-side
    maxZoom: 14,
    nativeResolutionM: 10,
    minAreaKm2: 0.01,
    attribution: 'ESA Sentinel-2 cloudless yearly mosaic (EOX, 10 m native)',
    tileUrl: (year, _monthDay, z, x, y) =>
      `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${year}_3857/default/GoogleMapsCompatible/${z}/${y}/${x}.jpg`,
  },
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
    // Multi-date compositing: MODIS images daily, so we fetch several dates
    // spread across the year and keep, per pixel, the greenest (highest-GI)
    // observation. Clouds and shadows score low on GI, so a max-greenness
    // composite naturally rejects them — the standard cloud-free compositing
    // trick. The same date set is used for both years so phenology stays
    // comparable for change detection.
    compositeMonthDays: ['02-15', '05-01', '07-15', '09-01', '11-15'],
    attribution: 'NASA GIBS MODIS Terra TrueColor (250 m native, max-greenness composite of 5 dates/yr)',
    tileUrl: (year, monthDay, z, x, y) =>
      `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${year}-${monthDay}/GoogleMapsCompatible_Level9/${z}/${y}/${x}.jpg`,
  },
}

export { SOURCES }

const DEFAULT_SOURCE_ID = 's2cloudless'

const DEFAULTS = {
  minVegetatedGI: 0.06,   // absolute floor on the forest GI threshold (rejects water/shadow)
  targetCanvasMaxPx: 768, // cap stitched canvas size so TF stays snappy

  // --- Forest classification (per year, scene-relative) ----------------------
  // A pixel is "forest" when it is dark relative to the scene AND green. The
  // darkness anchor is the given percentile of in-polygon brightness (closed
  // canopy sits in the darkest quarter of a mixed scene), and a forest pixel
  // must stay below `forestDarknessCap` × anchor. Scene-relative thresholds
  // absorb the large tone/haze differences between yearly mosaics.
  darkAnchorPercentile: 0.25,
  forestDarknessCap: 1.30,
  // Hazy mosaics (e.g. EOX s2cloudless 2018 in places) compress scene contrast
  // and would sweep farmland under the darkness cap. Scene contrast is
  // p75/p25 of brightness; when it is low the cap is tightened toward 1:
  //   cap = min(forestDarknessCap, max(1.08, 1 + hazeContrastScale·(contrast−1)))
  hazeContrastScale: 0.75,
  // Forest greenness: GI must exceed this fraction of the median GI of the
  // scene's dark pixels (never below the `minVegetatedGI` floor).
  forestGIFraction: 0.55,

  // --- Transition confirmation ------------------------------------------------
  // A forest→not-forest (or reverse) flip only counts if the scene-normalized
  // brightness moved by ≥ confirmBrightnessDelta, or the scene-normalized GI by
  // ≥ confirmGreennessDelta, in the claimed direction. Real clearing brightens
  // a pixel by far more than this; threshold flapping does not.
  confirmBrightnessDelta: 0.30,
  confirmGreennessDelta: 0.35,

  // --- Accuracy controls ------------------------------------------------------
  // Cloud / snow / glare rejection: pixels whose darkest channel is still very
  // bright are almost never vegetation (forest is dark in TrueColor). If a pixel
  // is bright in EITHER year we exclude it from both loss and gain so a passing
  // cloud can't masquerade as a clearing or as regrowth.
  cloudBrightnessThreshold: 0.78,
  // Speckle removal: a flagged pixel is kept only if at least this many of its
  // 9-pixel (3×3, self-included) neighbourhood are also flagged. Kills isolated
  // single-pixel false positives from JPEG/resampling noise.
  minNeighbors: 4,
  // Edge-jitter suppression: when the two yearly mosaics are slightly mis-aligned,
  // the forest boundary flips to loss on one side and gain on the other. Real
  // change almost never produces loss and gain cheek-by-jowl, so drop any loss
  // pixel with a gain pixel within `jitterKernel`×`jitterKernel`, and vice-versa.
  suppressEdgeJitter: true,
  jitterKernel: 5,
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

// --- Multi-date max-greenness compositing -----------------------------------

// Combine N same-grid ImageData frames into one by keeping, per pixel, the RGB
// of the frame with the highest greenness index. Clouds/shadows have low GI, so
// this yields a (mostly) cloud-free composite. Alpha (polygon mask) is identical
// across frames so we take it from the first.
function compositeMaxGreenness(frames) {
  if (frames.length === 1) return frames[0]
  const { width: w, height: h } = frames[0]

  const selected = tf.tidy(() => {
    const tensors = frames.map((f) => tf.browser.fromPixels(f, 4).toFloat()) // [H,W,4] 0..255
    const gis = tensors.map((t) => {
      const r = t.slice([0, 0, 0], [-1, -1, 1])
      const g = t.slice([0, 0, 1], [-1, -1, 1])
      const b = t.slice([0, 0, 2], [-1, -1, 1])
      const a = t.slice([0, 0, 3], [-1, -1, 1])
      const gi = g.mul(2).sub(r).sub(b).div(g.add(r).add(b).add(1e-6)) // [H,W,1]
      // Force transparent (outside-polygon) pixels to the lowest possible GI so
      // they never win the argMax for an in-polygon neighbour by accident.
      return tf.where(a.greater(0.5), gi, tf.fill(gi.shape, -1e3)).squeeze([-1]) // [H,W]
    })
    const best = tf.stack(gis, 0).argMax(0) // [H,W] index of greenest frame
    const oneHot = tf.oneHot(best, frames.length) // [H,W,N]
    const stackHWN4 = tf.stack(tensors, 0).transpose([1, 2, 0, 3]) // [H,W,N,4]
    return oneHot.expandDims(-1).mul(stackHWN4).sum(2) // [H,W,4]
  })

  const flat = selected.dataSync()
  selected.dispose()
  const out = new Uint8ClampedArray(flat.length)
  for (let i = 0; i < flat.length; i++) out[i] = flat[i]
  return new ImageData(out, w, h)
}

// Fetch every composite date for a year and reduce to one cloud-free frame.
// Dates that fail to load entirely (missing imagery) are dropped; if every date
// fails we surface the last error.
async function fetchYearComposite(source, year, bounds, z, ring, onProgress) {
  const dates = source.compositeMonthDays || [source.monthDay]
  const settled = await Promise.allSettled(
    dates.map((md) => fetchYearMosaic(source, year, md, bounds, z, ring, onProgress))
  )
  const frames = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value)
  if (frames.length === 0) {
    const firstErr = settled.find((s) => s.status === 'rejected')
    throw firstErr ? firstErr.reason : new Error(`No imagery for ${year}`)
  }
  return { frame: compositeMaxGreenness(frames), datesUsed: frames.length, datesRequested: dates.length }
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

// Cloud test = the *darkest* of the three channels is still bright. We use the
// MIN channel (not overall brightness) on purpose: white clouds/snow/glare are
// bright in all three channels, so their min is high; freshly-cleared tan/brown
// bare soil keeps a LOW blue channel, so its min stays below the threshold and
// it is NOT masked — i.e. real clearings that turn to bare ground still count as
// loss, only genuine clouds get excluded.
function brightnessMin(rgbA) {
  return tf.tidy(() => {
    const r = rgbA.slice([0, 0, 0], [-1, -1, 1])
    const g = rgbA.slice([0, 0, 1], [-1, -1, 1])
    const b = rgbA.slice([0, 0, 2], [-1, -1, 1])
    return tf.minimum(tf.minimum(r, g), b).squeeze([-1]) // [H,W]
  })
}

// Mean-channel brightness, used for the scene-relative darkness test.
function brightnessMean(rgbA) {
  return tf.tidy(() => rgbA.slice([0, 0, 0], [-1, -1, 3]).mean(-1)) // [H,W]
}

// Per-scene statistics over valid (in-polygon, cloud-free) pixels, driving the
// scene-relative forest classifier. Returns null when the scene has no valid
// pixels or no dark population to anchor on.
function sceneStats(giArr, brArr, validArr, opts) {
  const brs = []
  for (let i = 0; i < validArr.length; i++) if (validArr[i]) brs.push(brArr[i])
  if (brs.length === 0) return null
  brs.sort((a, b) => a - b)
  const anchor = brs[Math.floor(brs.length * opts.darkAnchorPercentile)]
  const p75 = brs[Math.floor(brs.length * 0.75)]
  if (anchor <= 0) return null
  const contrast = p75 / anchor
  // Haze-adaptive darkness cap — see DEFAULTS.hazeContrastScale.
  const cap = Math.min(opts.forestDarknessCap, Math.max(1.08, 1 + opts.hazeContrastScale * (contrast - 1)))
  const darkGIs = []
  for (let i = 0; i < validArr.length; i++) {
    if (validArr[i] && brArr[i] < cap * anchor) darkGIs.push(giArr[i])
  }
  if (darkGIs.length === 0) return null
  darkGIs.sort((a, b) => a - b)
  const giMedDark = darkGIs[Math.floor(darkGIs.length / 2)]
  const giThresh = Math.max(opts.minVegetatedGI, opts.forestGIFraction * giMedDark)
  return { anchor, contrast, cap, giMedDark, giThresh }
}

const isForest = (gi, br, s) => br < s.cap * s.anchor && gi > s.giThresh

// Count of 1s in each pixel's 3×3 neighbourhood (self included), via a ones
// convolution. Used to drop isolated speckle flags.
function neighborhoodCount(maskFloat) {
  return tf.tidy(() => {
    const x = maskFloat.reshape([1, maskFloat.shape[0], maskFloat.shape[1], 1])
    const kernel = tf.ones([3, 3, 1, 1])
    return tf.conv2d(x, kernel, 1, 'same').reshape([maskFloat.shape[0], maskFloat.shape[1]])
  })
}

function denoise(mask, minNeighbors) {
  return tf.tidy(() => mask.logicalAnd(neighborhoodCount(mask.cast('float32')).greaterEqual(minNeighbors)))
}

// Boolean dilation: true wherever any pixel in the size×size window is set.
function dilate(maskBool, size) {
  return tf.tidy(() => {
    const x = maskBool.cast('float32').reshape([1, maskBool.shape[0], maskBool.shape[1], 1])
    const kernel = tf.ones([size, size, 1, 1])
    return tf.conv2d(x, kernel, 1, 'same').reshape([maskBool.shape[0], maskBool.shape[1]]).greater(0.5)
  })
}

async function detectChange(beforeData, afterData, opts) {
  const out = tf.tidy(() => {
    const before = imageDataToTensor(beforeData)
    const after = imageDataToTensor(afterData)

    // Polygon mask = the alpha channel of the (clipped) before image — pixels
    // outside the polygon are 0 alpha after the destination-in clip.
    const polyMask = before.slice([0, 0, 3], [-1, -1, 1]).squeeze([-1]).greater(0.5)

    // Cloud/glare mask: bright in EITHER year → unreliable, exclude from both
    // loss and gain. valid = in-polygon AND not bright in either year.
    const cloudBefore = brightnessMin(before).greater(opts.cloudBrightnessThreshold)
    const cloudAfter = brightnessMin(after).greater(opts.cloudBrightnessThreshold)
    const valid = polyMask.logicalAnd(cloudBefore.logicalNot()).logicalAnd(cloudAfter.logicalNot())

    const [h, w] = [valid.shape[0], valid.shape[1]]
    const giB = greennessIndex(before).dataSync()
    const giA = greennessIndex(after).dataSync()
    const brB = brightnessMean(before).dataSync()
    const brA = brightnessMean(after).dataSync()
    const validArr = valid.dataSync()

    // Scene-relative forest classification per year, then transition + confirm.
    const statsBefore = sceneStats(giB, brB, validArr, opts)
    const statsAfter = sceneStats(giA, brA, validArr, opts)
    const n = w * h
    const lossArr = new Uint8Array(n)
    const gainArr = new Uint8Array(n)
    let forestPxBefore = 0
    let forestPxAfter = 0
    if (statsBefore && statsAfter) {
      for (let i = 0; i < n; i++) {
        if (!validArr[i]) continue
        const fB = isForest(giB[i], brB[i], statsBefore)
        const fA = isForest(giA[i], brA[i], statsAfter)
        if (fB) forestPxBefore++
        if (fA) forestPxAfter++
        if (fB === fA) continue
        // Scene-normalized shifts: brightness relative to each scene's dark
        // anchor, GI relative to each scene's dark-median GI.
        const brShift = brA[i] / statsAfter.anchor - brB[i] / statsBefore.anchor
        const giShift = giA[i] / (statsAfter.giMedDark + 1e-6) - giB[i] / (statsBefore.giMedDark + 1e-6)
        if (fB && !fA) {
          if (brShift >= opts.confirmBrightnessDelta || -giShift >= opts.confirmGreennessDelta) lossArr[i] = 1
        } else {
          if (-brShift >= opts.confirmBrightnessDelta || giShift >= opts.confirmGreennessDelta) gainArr[i] = 1
        }
      }
    }
    let lossMask = tf.tensor(lossArr, [h, w], 'bool')
    let gainMask = tf.tensor(gainArr, [h, w], 'bool')

    // Edge-jitter suppression: remove loss/gain pixels that sit right next to
    // their opposite — the mirror-image bands a slight mosaic mis-registration
    // produces. Dilate both from the ORIGINAL masks before mutating either.
    if (opts.suppressEdgeJitter) {
      const gainNear = dilate(gainMask, opts.jitterKernel)
      const lossNear = dilate(lossMask, opts.jitterKernel)
      lossMask = lossMask.logicalAnd(gainNear.logicalNot())
      gainMask = gainMask.logicalAnd(lossNear.logicalNot())
    }

    // Speckle removal.
    lossMask = denoise(lossMask, opts.minNeighbors)
    gainMask = denoise(gainMask, opts.minNeighbors)

    const round3 = (v) => +v.toFixed(3)
    const sceneDebug = (s) => s && {
      anchor: round3(s.anchor),
      contrast: round3(s.contrast),
      darknessCap: round3(s.cap),
      giMedDark: round3(s.giMedDark),
      giThresh: round3(s.giThresh),
    }
    // bool tensors serialize as Uint8Array of 0/1; cast to int32 first so the
    // sums return numbers rather than booleans, but skip a uint8 cast on the
    // mask itself — TF.js doesn't accept 'uint8' as a cast target.
    return {
      lossMaskData: lossMask.dataSync(), // Uint8Array, values are 0 or 1
      gainMaskData: gainMask.dataSync(),
      shape: [h, w],
      lossPx: lossMask.cast('int32').sum().arraySync(),
      gainPx: gainMask.cast('int32').sum().arraySync(),
      polyPx: polyMask.cast('int32').sum().arraySync(),
      validPx: valid.cast('int32').sum().arraySync(),
      forestPxBefore,
      forestPxAfter,
      sceneBefore: sceneDebug(statsBefore),
      sceneAfter: sceneDebug(statsAfter),
    }
  })
  return out
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

function renderOverlayDataUrl(afterData, lossMaskData, gainMaskData, [h, w]) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.putImageData(afterData, 0, 0)

  const overlay = ctx.getImageData(0, 0, w, h)
  const px = overlay.data
  for (let i = 0; i < lossMaskData.length; i++) {
    const j = i * 4
    if (lossMaskData[i]) {
      // Blend 50% red over the pixel = forest loss.
      px[j]     = Math.round(0.5 * 255 + 0.5 * px[j])
      px[j + 1] = Math.round(0.5 * px[j + 1])
      px[j + 2] = Math.round(0.5 * px[j + 2])
    } else if (gainMaskData && gainMaskData[i]) {
      // Blend 50% green over the pixel = regrowth / reforestation.
      px[j]     = Math.round(0.5 * px[j])
      px[j + 1] = Math.round(0.5 * 255 + 0.5 * px[j + 1])
      px[j + 2] = Math.round(0.5 * px[j + 2])
    }
    // Keep alpha as-is so the polygon clip stays.
  }
  ctx.putImageData(overlay, 0, 0)
  return canvas.toDataURL('image/png')
}

// --- Verdict text ------------------------------------------------------------

// Gross forest-loss severity, ignoring regrowth (used only when loss dominates).
function lossSeverity(lossHa, lossFraction) {
  if (lossHa < 1.0 && lossFraction < 0.005) return { verdict: 'minor_loss', label: 'minor forest loss', confidence: 'medium' }
  if (lossHa > 50.0 || lossFraction > 0.10) return { verdict: 'severe_loss', label: 'severe forest loss', confidence: 'high' }
  return { verdict: 'significant_loss', label: 'significant forest loss', confidence: lossFraction > 0.02 ? 'medium' : 'low' }
}

// Net-aware verdict: the headline must not scream "loss" when loss and regrowth
// roughly cancel. We first ask whether one side clearly dominates, measured
// RELATIVELY — |loss − gain| as a share of total activity (loss + gain). When
// the two are comparable (dominance below BALANCE_RATIO) it's "mixed change",
// regardless of how large the gross numbers look — that pattern is usually
// transitional cover or residual mis-registration noise. Only when loss clearly
// dominates do we grade severity, and on NET loss (loss − gain), not gross. The
// stats panel still reports gross loss AND gain, so no detail is lost.
function classify(lossHa, lossFraction, gainHa, gainFraction) {
  const net = gainFraction - lossFraction // +ve = greener overall
  const activity = lossFraction + gainFraction
  const dominance = activity > 0 ? Math.abs(net) / activity : 0
  const BALANCE_RATIO = 0.34 // below this, neither side clearly wins → "mixed"

  if (lossHa < 0.1 && gainHa < 0.1) {
    return { verdict: 'no_loss', label: 'no detectable change', confidence: 'high' }
  }
  if (dominance < BALANCE_RATIO) {
    return { verdict: 'mixed_change', label: 'mixed change (loss ≈ regrowth)', confidence: 'low' }
  }
  if (net > 0) {
    return { verdict: 'net_regrowth', label: 'net regrowth / reforestation', confidence: 'medium' }
  }
  // Loss clearly dominates — grade on NET loss, not gross.
  return lossSeverity(lossHa - gainHa, lossFraction - gainFraction)
}

// --- Legality assessment (knowledge-grounded) -------------------------------
//
// We turn the *cleared fraction* of the drawn area into a legal-risk call using
// published, percentage-based forest-protection rules. The most concrete such
// rule is Brazil's Forest Code "Legal Reserve" (Lei 12.651/2012): every rural
// property must keep a fixed share of native vegetation —
//   • 80% inside the Amazon biome   → at most 20% may be cleared
//   • 35% in Cerrado within the Legal Amazon
//   • 20% elsewhere in Brazil       → at most 80% may be cleared
// Clearing past that share is, by definition, illegal deforestation of the
// Legal Reserve. Outside Brazil we have no single global %-rule, so we fall back
// to the EU Deforestation Regulation's frame (FAO forest definition + a hard
// 31-Dec-2020 cut-off: any forest→agriculture conversion after that date makes
// commodities non-compliant — effectively a 0% allowance for the EU market) plus
// a scale/concentration heuristic.
//
// CAVEAT baked into the wording: our percentage is of the *drawn polygon*, which
// we treat as a proxy for the legal property. Imagery also can't prove intent or
// the existence of a permit. So this is a risk flag, never a legal finding.

// Very rough geographic gates. The real biome/Legal-Amazon boundaries are
// irregular polygons; these bounding boxes only get us the right rule-of-thumb.
function jurisdiction(lat, lon) {
  const inLegalAmazon = lat <= 5.3 && lat >= -18 && lon >= -74 && lon <= -44
  if (inLegalAmazon) {
    return { country: 'Brazil', region: 'Legal Amazon (approx.)', biome: 'Amazon', reservePct: 80 }
  }
  const inBrazil = lat <= 5.3 && lat >= -34 && lon >= -74 && lon <= -34
  if (inBrazil) {
    return { country: 'Brazil', region: 'Brazil, outside the Legal Amazon (approx.)', biome: 'Cerrado / other', reservePct: 20 }
  }
  return null
}

const CITATIONS = {
  forestCode: 'Brazilian Forest Code, Lei nº 12.651/2012 — Legal Reserve (Reserva Legal): Amazon biome 80%, Cerrado in the Legal Amazon 35%, elsewhere 20% of each rural property must stay forested.',
  eudr: 'EU Deforestation Regulation (EU 2023/1115): forest follows the FAO definition (≥0.5 ha, trees >5 m, canopy ≥10%); commodities from land deforested after 31 Dec 2020 cannot be placed on the EU market.',
}

function assessLegality(centroid, lossFraction, lossHa) {
  const clearedPct = +(lossFraction * 100).toFixed(1)
  const j = jurisdiction(centroid.lat, centroid.lon)

  if (j) {
    const legalClearLimitPct = 100 - j.reservePct
    const over = clearedPct > legalClearLimitPct
    return {
      framework: 'Brazilian Forest Code (Lei 12.651/2012) — Legal Reserve',
      region: j.region,
      reservePct: j.reservePct,
      legalClearLimitPct,
      clearedPct,
      status: lossHa < 0.1 ? 'indeterminate' : over ? 'likely_illegal' : 'within_legal_limit',
      headline: lossHa < 0.1
        ? 'No clearing to assess'
        : over
          ? `Likely illegal — exceeds the ${legalClearLimitPct}% clearing limit`
          : `Within the ${legalClearLimitPct}% legal clearing limit`,
      rationale: lossHa < 0.1
        ? 'Negligible loss detected, so no legality call is meaningful.'
        : `In the ${j.biome} biome a rural property must keep ${j.reservePct}% under native vegetation, so at most ${legalClearLimitPct}% may legally be cleared. The detected clearing is ${clearedPct}% of the area${over ? `, which is over that limit and consistent with illegal Legal-Reserve clearing` : `, within that limit`}.`,
      citations: [CITATIONS.forestCode],
      assumption: 'Assumes the drawn polygon approximates one legal property; imagery cannot confirm a permit or land-use exemption.',
    }
  }

  // Outside Brazil: no single percentage rule, so we CANNOT make a legal/illegal
  // call from area alone — only a risk flag. Use the EUDR frame + a concentration
  // heuristic, and never assert "illegal" here.
  const flagged = lossHa >= 25.0 || lossFraction >= 0.05
  return {
    framework: 'EU Deforestation Regulation (EU 2023/1115) — frame of reference',
    region: 'Outside mapped %-threshold jurisdictions',
    reservePct: null,
    legalClearLimitPct: null,
    clearedPct,
    status: lossHa < 0.1 ? 'indeterminate' : flagged ? 'review' : 'indeterminate',
    headline: lossHa < 0.1
      ? 'No clearing to assess'
      : flagged
        ? 'High deforestation risk — flag for review'
        : 'No fixed %-threshold here; lower risk',
    rationale: lossHa < 0.1
      ? 'Negligible loss detected, so no legality call is meaningful.'
      : `No statutory percentage limit is mapped for this location, so a hard legal/illegal split isn't possible from area alone. Under the EUDR frame, any forest→agriculture conversion after 31 Dec 2020 would make resulting commodities non-compliant regardless of size. The detected clearing (${clearedPct}% of the area, ${lossHa.toFixed(1)} ha) is ${flagged ? 'large/concentrated enough to warrant review' : 'limited; could be selective harvest, fire, or noise'}.`,
    citations: [CITATIONS.eudr],
    assumption: 'No country-specific clearing limit applied; percentage is of the drawn polygon, not a legal property.',
  }
}

function buildMarkdown(cls, legality, stats, gainStats, overlayDataUrl, beforeYear, afterYear) {
  const { lossHa, lossFraction } = stats
  const lossPct = (lossFraction * 100).toFixed(1)
  const gainPct = (gainStats.gainFraction * 100).toFixed(1)
  const netPct = ((gainStats.gainFraction - lossFraction) * 100).toFixed(1)

  let body = `Between **${beforeYear}** and **${afterYear}**, **${lossHa.toFixed(2)} ha** (${lossPct}% of the area) lost vegetation`
  body += ` and **${gainStats.gainHa.toFixed(2)} ha** (${gainPct}%) regrew`
  body += ` — a net vegetation change of **${netPct >= 0 ? '+' : ''}${netPct}%**, classified as **${cls.label}**.`
  body += ` Legality assessed against the **${legality.framework}** (see panel above).`

  body += `\n\n![change overlay — red = forest loss, green = regrowth](${overlayDataUrl})`
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
      forestDarknessCap: cfg.forestDarknessCap,
      darkAnchorPercentile: cfg.darkAnchorPercentile,
      forestGIFraction: cfg.forestGIFraction,
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

  const dateCount = (source.compositeMonthDays || [source.monthDay]).length
  debug.tiles.compositeDates = dateCount

  onProgress('fetch', `Loading ${cfg.beforeYear} imagery (${dateCount} date${dateCount > 1 ? 's' : ''})…`)
  const tBefore = performance.now()
  const before = await fetchYearComposite(source, cfg.beforeYear, bounds, z, ring, onProgress)
  const beforeData = before.frame
  mark('beforeFetchMs', tBefore)
  debug.tiles.canvasW = beforeData.width
  debug.tiles.canvasH = beforeData.height
  debug.tiles.beforeDatesUsed = before.datesUsed
  push({})

  onProgress('fetch', `Loading ${cfg.afterYear} imagery (${dateCount} date${dateCount > 1 ? 's' : ''})…`)
  const tAfter = performance.now()
  const after = await fetchYearComposite(source, cfg.afterYear, bounds, z, ring, onProgress)
  const afterData = after.frame
  mark('afterFetchMs', tAfter)
  debug.tiles.afterDatesUsed = after.datesUsed
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
  const gainHa = result.gainPx * pxHa
  const lossFraction = result.polyPx > 0 ? result.lossPx / result.polyPx : 0
  const gainFraction = result.polyPx > 0 ? result.gainPx / result.polyPx : 0

  onProgress('render', 'Rendering overlay…')
  const tRender = performance.now()
  const overlayDataUrl = renderOverlayDataUrl(afterData, result.lossMaskData, result.gainMaskData, result.shape)
  mark('renderMs', tRender)
  debug.polygon.centroid = { lat: +centroidLat.toFixed(5), lon: +centroidLon.toFixed(5) }
  debug.tiles.metersPerPixel = +mpp.toFixed(2)
  debug.pixels = {
    polyPx: result.polyPx,
    validPx: result.validPx,
    lossPx: result.lossPx,
    gainPx: result.gainPx,
    lossFraction: +lossFraction.toFixed(5),
    gainFraction: +gainFraction.toFixed(5),
    forestPxBefore: result.forestPxBefore,
    forestPxAfter: result.forestPxAfter,
    sceneBefore: result.sceneBefore,
    sceneAfter: result.sceneAfter,
    hectaresPerPixel: +pxHa.toFixed(4),
    lossHa: +lossHa.toFixed(3),
    gainHa: +gainHa.toFixed(3),
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
  const gainStats = { gainHa, gainFraction, gainPx: result.gainPx }
  const cls = classify(lossHa, lossFraction, gainHa, gainFraction)
  const legality = assessLegality({ lat: centroidLat, lon: centroidLon }, lossFraction, lossHa)
  const markdown = buildMarkdown(cls, legality, stats, gainStats, overlayDataUrl, cfg.beforeYear, cfg.afterYear)

  onProgress('done', 'Done.')
  return {
    markdown,
    verdict: cls.verdict,           // 'no_loss' | 'minor_loss' | 'significant_loss' | 'severe_loss'
    verdictLabel: cls.label,
    likelyIllegal: legality.status === 'likely_illegal',
    legality,
    confidence: cls.confidence,
    stats,
    gainStats,
    netFraction: gainFraction - lossFraction,
    overlayDataUrl,
    beforeYear: cfg.beforeYear,
    afterYear: cfg.afterYear,
    source: { id: source.id, label: source.label, attribution: source.attribution },
  }
}
