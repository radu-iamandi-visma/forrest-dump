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

        const { Map, ImageMapType, Polygon } = maps
        const { Size, LatLng, LatLngBounds } = core
        libsRef.current = { ImageMapType, Size, LatLng, LatLngBounds, Polygon }

        const map = new Map(mapDivRef.current, {
          center: { lat: 46.5, lng: 24.5 },
          zoom: Math.min(8, source.maxZoom),
          minZoom: 4,
          // Cap at the source's max zoom so users can't zoom past where the
          // imagery layer publishes tiles — above the cap, Google's basemap
          // would show through and the slider would appear to do nothing.
          maxZoom: source.maxZoom,
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

    const { ImageMapType, Size } = libs

    // Re-cap zoom in case the source's max dropped (e.g. Sentinel → MODIS),
    // and force-zoom out if we're currently above the new cap.
    map.setOptions({ maxZoom: source.maxZoom })
    if ((map.getZoom() ?? 0) > source.maxZoom) map.setZoom(source.maxZoom)

    if (baseLayerRef.current) {
      const arr = map.overlayMapTypes.getArray()
      const idx = arr.indexOf(baseLayerRef.current)
      if (idx >= 0) map.overlayMapTypes.removeAt(idx)
    }

    const layer = new ImageMapType({
      getTileUrl: (tile, z) => source.tileUrl(year, source.monthDay, z, tile.x, tile.y),
      tileSize: new Size(256, 256),
      name: `${source.label} ${year}`,
      maxZoom: source.maxZoom,
      minZoom: 0,
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

    const { ImageMapType, Size } = libs

    if (lossLayerRef.current) {
      const arr = map.overlayMapTypes.getArray()
      const idx = arr.indexOf(lossLayerRef.current)
      if (idx >= 0) map.overlayMapTypes.removeAt(idx)
      lossLayerRef.current = null
    }

    if (showLoss) {
      const layer = new ImageMapType({
        getTileUrl: (tile, z) => hansenTileUrl(z, tile.x, tile.y),
        tileSize: new Size(256, 256),
        name: 'Tree cover loss',
        maxZoom: 14,
        minZoom: 0,
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
            {source.attribution} — drag the slider to scrub years. Zoom is capped at {source.maxZoom}
            ({source.nativeResolutionM} m native).
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
