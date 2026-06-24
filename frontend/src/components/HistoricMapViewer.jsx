import { useEffect, useMemo, useRef, useState } from 'react'
import { loadGoogleMapsLibraries } from '../lib/googleMaps'
import { SOURCES } from '../ml/deforestation'

// GFW Hansen tree-cover-loss tiles — independent reference layer, not part
// of the in-browser ML pipeline.
const hansenTileUrl = (z, x, y) =>
  `https://tiles.globalforestwatch.org/umd_tree_cover_loss/v1.11/default/${z}/${x}/${y}.png`

function geometryRing(geometry) {
  const g = geometry?.geometry || geometry
  if (!g) return []
  if (g.type === 'Polygon') return g.coordinates[0]
  if (g.type === 'MultiPolygon') return g.coordinates[0][0]
  return []
}

// Cap the visible year labels under the slider so a 20-year MODIS range
// doesn't render 21 cramped numbers in a row.
function labelStep(yearCount) {
  return yearCount > 12 ? 4 : 1
}

// How many zoom levels past a source's native tile depth we let the user go.
// Beyond native zoom the imagery server has no tiles, so we synthesize them by
// upscaling the deepest real tile (see makeOverzoomLayer) instead of letting
// Google's basemap show through.
const OVERZOOM_LEVELS = 4

// Builds a custom google.maps.MapType (a plain object implementing the
// interface) that serves real tiles up to `nativeMaxZoom`, then "overzooms" by
// cropping+upscaling the matching parent tile onto a canvas for deeper zooms.
function makeOverzoomLayer(Size, { tileUrlForZXY, nativeMaxZoom, opacity = 1 }) {
  return {
    tileSize: new Size(256, 256),
    minZoom: 0,
    maxZoom: nativeMaxZoom + OVERZOOM_LEVELS,
    getTile(coord, zoom, ownerDocument) {
      const div = ownerDocument.createElement('div')
      div.style.width = '256px'
      div.style.height = '256px'

      const numTiles = 1 << zoom
      const y = coord.y
      if (y < 0 || y >= numTiles) return div // off the top/bottom of the world
      const x = ((coord.x % numTiles) + numTiles) % numTiles // wrap longitudinally

      if (zoom <= nativeMaxZoom) {
        const img = ownerDocument.createElement('img')
        img.style.width = '256px'
        img.style.height = '256px'
        img.style.opacity = String(opacity)
        img.onerror = () => { img.style.visibility = 'hidden' }
        img.src = tileUrlForZXY(zoom, x, y)
        div.appendChild(img)
        return div
      }

      // Overzoom: find the deepest real (parent) tile that contains this one and
      // draw the relevant sub-region scaled up to a full 256px tile.
      const dz = zoom - nativeMaxZoom
      const scale = 1 << dz
      const parentX = Math.floor(x / scale)
      const parentY = Math.floor(y / scale)
      const sub = 256 / scale // size, in parent-tile pixels, of this child
      const sx = (x - parentX * scale) * sub
      const sy = (y - parentY * scale) * sub

      const canvas = ownerDocument.createElement('canvas')
      canvas.width = 256
      canvas.height = 256
      canvas.style.width = '256px'
      canvas.style.height = '256px'
      canvas.style.opacity = String(opacity)
      const ctx = canvas.getContext('2d')
      ctx.imageSmoothingEnabled = false // keep upscaled pixels crisp

      // No crossOrigin: we only draw to screen, never read pixels back, so a
      // tainted canvas is fine — and it avoids CORS failures on tile servers
      // that don't send ACAO headers (e.g. the Hansen loss tiles).
      const img = new Image()
      img.onload = () => ctx.drawImage(img, sx, sy, sub, sub, 0, 0, 256, 256)
      img.src = tileUrlForZXY(nativeMaxZoom, parentX, parentY)
      div.appendChild(canvas)
      return div
    },
    releaseTile() {},
  }
}

export default function HistoricMapViewer({ geometry, sourceId = 'modis-terra', yearRangeOverride }) {
  const source = SOURCES[sourceId]
  const [yearStart, yearEnd] = yearRangeOverride || source.yearRange
  const years = useMemo(
    () => Array.from({ length: yearEnd - yearStart + 1 }, (_, i) => yearStart + i),
    [yearStart, yearEnd]
  )
  const step = labelStep(years.length)

  const mapDivRef = useRef(null)
  const mapRef = useRef(null)
  const baseLayerRef = useRef(null)
  const lossLayerRef = useRef(null)
  const polygonRef = useRef(null)
  const libsRef = useRef(null)
  const [year, setYear] = useState(yearEnd)
  const [showLoss, setShowLoss] = useState(true)
  const [error, setError] = useState(null)

  const ring = useMemo(() => geometryRing(geometry), [geometry])

  // Clamp `year` into the active range whenever the range changes (e.g. user
  // switched source or toggled "ignore 2018").
  useEffect(() => {
    setYear((y) => Math.min(Math.max(y, yearStart), yearEnd))
  }, [yearStart, yearEnd])

  // Bootstrap map once.
  useEffect(() => {
    let cancelled = false

    loadGoogleMapsLibraries()
      .then(({ maps, core }) => {
        if (cancelled || !mapDivRef.current) return

        const { Map, Polygon } = maps
        const { Size, LatLng, LatLngBounds } = core
        libsRef.current = { Size, LatLng, LatLngBounds, Polygon }

        const map = new Map(mapDivRef.current, {
          center: { lat: 46.5, lng: 24.5 },
          zoom: Math.min(8, source.maxZoom),
          minZoom: 4,
          // Allow zooming OVERZOOM_LEVELS past the source's native tile depth —
          // the imagery layer synthesizes upscaled tiles beyond that point, so
          // the basemap never shows through.
          maxZoom: source.maxZoom + OVERZOOM_LEVELS,
          mapTypeId: 'hybrid',
          streetViewControl: false,
          fullscreenControl: false,
          mapTypeControl: false,
        })
        mapRef.current = map

        if (ring.length > 1) {
          const path = ring.map(([lng, lat]) => new LatLng(lat, lng))
          const polygon = new Polygon({
            paths: path,
            strokeColor: '#fde047',
            strokeWeight: 3,
            fillOpacity: 0,
            clickable: false,
          })
          polygon.setMap(map)
          polygonRef.current = polygon

          const bounds = new LatLngBounds()
          for (const ll of path) bounds.extend(ll)
          map.fitBounds(bounds, 80)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })

    return () => {
      cancelled = true
      if (polygonRef.current) { polygonRef.current.setMap(null); polygonRef.current = null }
      if (baseLayerRef.current && mapRef.current) {
        const idx = mapRef.current.overlayMapTypes.getArray().indexOf(baseLayerRef.current)
        if (idx >= 0) mapRef.current.overlayMapTypes.removeAt(idx)
        baseLayerRef.current = null
      }
      if (lossLayerRef.current && mapRef.current) {
        const idx = mapRef.current.overlayMapTypes.getArray().indexOf(lossLayerRef.current)
        if (idx >= 0) mapRef.current.overlayMapTypes.removeAt(idx)
        lossLayerRef.current = null
      }
      mapRef.current = null
    }
  }, [ring])

  // Swap the source imagery layer when source or year changes.
  useEffect(() => {
    const map = mapRef.current
    const libs = libsRef.current
    if (!map || !libs) return

    const { Size } = libs

    // Re-cap zoom in case the source's max dropped (e.g. Sentinel → MODIS),
    // and force-zoom out if we're currently above the new cap.
    const displayMax = source.maxZoom + OVERZOOM_LEVELS
    map.setOptions({ maxZoom: displayMax })
    if ((map.getZoom() ?? 0) > displayMax) map.setZoom(displayMax)

    if (baseLayerRef.current) {
      const arr = map.overlayMapTypes.getArray()
      const idx = arr.indexOf(baseLayerRef.current)
      if (idx >= 0) map.overlayMapTypes.removeAt(idx)
    }

    const layer = makeOverzoomLayer(Size, {
      tileUrlForZXY: (z, x, y) => source.tileUrl(year, source.monthDay, z, x, y),
      nativeMaxZoom: source.maxZoom,
      opacity: 1.0,
    })
    map.overlayMapTypes.insertAt(0, layer)
    baseLayerRef.current = layer
  }, [year, source])

  // Toggle Hansen loss overlay.
  useEffect(() => {
    const map = mapRef.current
    const libs = libsRef.current
    if (!map || !libs) return

    const { Size } = libs

    if (lossLayerRef.current) {
      const arr = map.overlayMapTypes.getArray()
      const idx = arr.indexOf(lossLayerRef.current)
      if (idx >= 0) map.overlayMapTypes.removeAt(idx)
      lossLayerRef.current = null
    }

    if (showLoss) {
      // Hansen tiles publish up to z14; overzoom keeps them aligned with the
      // imagery layer when the user zooms deeper.
      const layer = makeOverzoomLayer(Size, {
        tileUrlForZXY: (z, x, y) => hansenTileUrl(z, x, y),
        nativeMaxZoom: 14,
        opacity: 0.7,
      })
      map.overlayMapTypes.push(layer)
      lossLayerRef.current = layer
    }
  }, [showLoss])

  if (error) {
    return (
      <div className="rounded-lg border border-red-900/50 bg-red-950/40 text-red-200 text-sm p-4">
        Could not load historic map: {error}
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/60 overflow-hidden">
      <div className="flex items-center justify-between gap-4 px-4 py-3 border-b border-gray-800">
        <div>
          <div className="text-sm font-semibold text-gray-100">Visual confirmation</div>
          <div className="text-xs text-gray-500">
            {source.attribution} — drag the slider to scrub years. Native tiles to z{source.maxZoom}
            ({source.nativeResolutionM} m); zooms in {OVERZOOM_LEVELS} levels further by upscaling (gets blocky).
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showLoss}
            onChange={(e) => setShowLoss(e.target.checked)}
            className="accent-red-500"
          />
          Tree-loss overlay
        </label>
      </div>

      <div ref={mapDivRef} style={{ height: 380 }} className="w-full" />

      <div className="px-4 py-3 border-t border-gray-800">
        <div className="flex items-center gap-3">
          <span className="text-sm font-mono text-emerald-300 w-12">{year}</span>
          <input
            type="range"
            min={yearStart}
            max={yearEnd}
            step={1}
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="flex-1 accent-emerald-500"
          />
        </div>
        <div className="flex justify-between text-[10px] text-gray-500 mt-1 font-mono px-12">
          {years.filter((y) => (y - yearStart) % step === 0 || y === yearEnd).map((y) => (
            <span key={y} className={y === year ? 'text-emerald-300' : ''}>{y}</span>
          ))}
        </div>
        <div className="text-[10px] text-gray-600 mt-2 leading-relaxed">
          {source.attribution}. Tree-cover-loss tiles © Hansen et al. (UMD) / Global Forest Watch
          (independent reference layer, not part of the in-browser ML). Red pixels in the overlay mark years where tree
          cover was lost (2001 onward, cumulative). The analysis uses only the imagery source above — Google Maps tiles
          are not part of the comparison.
        </div>
      </div>
    </div>
  )
}
