import { useEffect, useMemo, useRef, useState } from 'react'
import { loadGoogleMapsLibraries } from '../lib/googleMaps'

// ESA Sentinel-2 cloudless yearly mosaics, served by EOX. These are the years
// where a complete cloud-free composite is available globally.
const SENTINEL_YEARS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024]

const sentinelTileUrl = (year, z, x, y) =>
  `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${year}_3857/default/GoogleMapsCompatible/${z}/${y}/${x}.jpg`

// GFW Hansen tree-cover-loss tiles — pixels are colored by the year they were lost.
// We fade the overlay opacity so the underlying imagery stays visible.
const hansenTileUrl = (z, x, y) =>
  `https://tiles.globalforestwatch.org/umd_tree_cover_loss/v1.11/default/${z}/${x}/${y}.png`

function geometryRing(geometry) {
  const g = geometry?.geometry || geometry
  if (!g) return []
  if (g.type === 'Polygon') return g.coordinates[0]
  if (g.type === 'MultiPolygon') return g.coordinates[0][0]
  return []
}

export default function HistoricMapViewer({ geometry }) {
  const mapDivRef = useRef(null)
  const mapRef = useRef(null)
  const sentinelLayerRef = useRef(null)
  const lossLayerRef = useRef(null)
  const polygonRef = useRef(null)
  const libsRef = useRef(null) // { ImageMapType, Size, LatLng, LatLngBounds, Polygon }
  const [year, setYear] = useState(2024)
  const [showLoss, setShowLoss] = useState(true)
  const [error, setError] = useState(null)

  const ring = useMemo(() => geometryRing(geometry), [geometry])

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
          zoom: 8,
          minZoom: 4,
          maxZoom: 15,
          mapTypeId: 'hybrid',
          streetViewControl: false,
          fullscreenControl: false,
          mapTypeControl: false,
        })
        mapRef.current = map

        // Outline the analyzed polygon.
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
      if (sentinelLayerRef.current && mapRef.current) {
        const idx = mapRef.current.overlayMapTypes.getArray().indexOf(sentinelLayerRef.current)
        if (idx >= 0) mapRef.current.overlayMapTypes.removeAt(idx)
        sentinelLayerRef.current = null
      }
      if (lossLayerRef.current && mapRef.current) {
        const idx = mapRef.current.overlayMapTypes.getArray().indexOf(lossLayerRef.current)
        if (idx >= 0) mapRef.current.overlayMapTypes.removeAt(idx)
        lossLayerRef.current = null
      }
      mapRef.current = null
    }
  }, [ring])

  // Swap Sentinel-2 base layer when the year changes.
  useEffect(() => {
    const map = mapRef.current
    const libs = libsRef.current
    if (!map || !libs) return

    const { ImageMapType, Size } = libs

    // Remove previous Sentinel layer.
    if (sentinelLayerRef.current) {
      const arr = map.overlayMapTypes.getArray()
      const idx = arr.indexOf(sentinelLayerRef.current)
      if (idx >= 0) map.overlayMapTypes.removeAt(idx)
    }

    const layer = new ImageMapType({
      getTileUrl: (tile, z) => sentinelTileUrl(year, z, tile.x, tile.y),
      tileSize: new Size(256, 256),
      name: `Sentinel-2 ${year}`,
      maxZoom: 14,
      minZoom: 0,
      opacity: 1.0,
    })
    map.overlayMapTypes.insertAt(0, layer)
    sentinelLayerRef.current = layer
  }, [year])

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
            ESA Sentinel-2 cloudless mosaic — drag the slider to scrub years.
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
            min={SENTINEL_YEARS[0]}
            max={SENTINEL_YEARS[SENTINEL_YEARS.length - 1]}
            step={1}
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="flex-1 accent-emerald-500"
          />
        </div>
        <div className="flex justify-between text-[10px] text-gray-500 mt-1 font-mono px-12">
          {SENTINEL_YEARS.map((y) => (
            <span key={y} className={y === year ? 'text-emerald-300' : ''}>{y}</span>
          ))}
        </div>
        <div className="text-[10px] text-gray-600 mt-2 leading-relaxed">
          Sentinel-2 imagery © ESA / EOX. Tree-cover-loss tiles © Hansen et al. (UMD) / Global Forest Watch.
          Red pixels in the overlay mark years where tree cover was lost (2001 onward, cumulative).
        </div>
      </div>
    </div>
  )
}
