import { useEffect, useRef, useState } from 'react'
import { loadGoogleMapsLibraries } from '../lib/googleMaps'

// Browser-side TF.js inference stays responsive up to a stitched mosaic of
// ~768×768 px (set in src/ml/deforestation.js). The minimum polygon depends
// on the imagery source's native resolution and is passed in as a prop.
const MAX_AREA_KM2 = 200

const POLYGON_STYLE = {
  fillColor: '#10b981',
  fillOpacity: 0.25,
  strokeColor: '#10b981',
  strokeWeight: 2,
}

function polygonToGeoJSON(polygon) {
  const path = polygon.getPath()
  const ring = []
  for (let i = 0; i < path.getLength(); i++) {
    const p = path.getAt(i)
    ring.push([p.lng(), p.lat()])
  }
  if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
    ring.push(ring[0])
  }
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: {},
  }
}

export default function MapPicker({ onAnalyze, disabled, minAreaKm2 = 0.01 }) {
  const mapDivRef = useRef(null)
  const mapRef = useRef(null)
  const libRef = useRef(null)            // { Polygon, Polyline, spherical }
  const pointsRef = useRef([])           // google.maps.LatLng[] collected while drawing
  const polylineRef = useRef(null)       // live edge preview while drawing
  const polygonRef = useRef(null)        // finished, editable polygon
  const isDrawingRef = useRef(true)      // mirror of isDrawing for use inside listeners

  const [status, setStatus] = useState('Loading map…')
  const [isDrawing, setIsDrawing] = useState(true)
  const [pointCount, setPointCount] = useState(0)
  const [hasPolygon, setHasPolygon] = useState(false)
  const [areaKm2, setAreaKm2] = useState(0)

  const areaTooLarge = areaKm2 > MAX_AREA_KM2
  const areaTooSmall = hasPolygon && areaKm2 < minAreaKm2
  const canSubmit = hasPolygon && !areaTooLarge && !areaTooSmall && !disabled
  const canFinish = isDrawing && pointCount >= 3

  // --- drawing helpers (defined once, read mutable state via refs) -----------

  const setDrawing = (v) => {
    isDrawingRef.current = v
    setIsDrawing(v)
  }

  const computeArea = (path) => {
    const { spherical } = libRef.current
    setAreaKm2(spherical.computeArea(path) / 1_000_000)
  }

  const updatePreview = () => {
    const pts = pointsRef.current
    setPointCount(pts.length)
    if (polylineRef.current) polylineRef.current.setPath(pts)
    if (pts.length >= 3) computeArea(pts)
    else setAreaKm2(0)
  }

  const addPoint = (latLng) => {
    pointsRef.current.push(latLng)
    updatePreview()
  }

  const finishDrawing = () => {
    if (!libRef.current || pointsRef.current.length < 3) return
    const { Polygon } = libRef.current
    const map = mapRef.current

    const polygon = new Polygon({
      paths: pointsRef.current,
      ...POLYGON_STYLE,
      editable: true,
      draggable: false,
    })
    polygon.setMap(map)
    polygonRef.current = polygon

    // Tear down the in-progress preview.
    if (polylineRef.current) {
      polylineRef.current.setMap(null)
      polylineRef.current = null
    }
    pointsRef.current = []
    setDrawing(false)
    setHasPolygon(true)

    const path = polygon.getPath()
    computeArea(path)
    path.addListener('set_at', () => computeArea(path))
    path.addListener('insert_at', () => computeArea(path))
    path.addListener('remove_at', () => computeArea(path))
  }

  const startDrawing = () => {
    const { Polyline } = libRef.current
    const map = mapRef.current
    if (polygonRef.current) {
      polygonRef.current.setMap(null)
      polygonRef.current = null
    }
    if (polylineRef.current) polylineRef.current.setMap(null)
    polylineRef.current = new Polyline({
      path: [],
      strokeColor: POLYGON_STYLE.strokeColor,
      strokeWeight: POLYGON_STYLE.strokeWeight,
      map,
    })
    pointsRef.current = []
    setPointCount(0)
    setAreaKm2(0)
    setHasPolygon(false)
    setDrawing(true)
  }

  useEffect(() => {
    let cancelled = false

    loadGoogleMapsLibraries()
      .then(({ google, maps, geometry }) => {
        if (cancelled || !mapDivRef.current) return

        const { Map, Polygon, Polyline } = maps
        const { spherical } = geometry
        libRef.current = { Polygon, Polyline, spherical }

        const map = new Map(mapDivRef.current, {
          center: { lat: 46.5, lng: 24.5 }, // Transylvania
          zoom: 8,
          minZoom: 6,
          maxZoom: 16,
          mapTypeId: 'hybrid',
          streetViewControl: false,
          fullscreenControl: false,
          disableDoubleClickZoom: true, // double-click finishes the polygon
          draggableCursor: 'crosshair',
        })
        mapRef.current = map

        // Each click while drawing drops a vertex; double-click finishes.
        map.addListener('click', (e) => {
          if (isDrawingRef.current && e.latLng) addPoint(e.latLng)
        })
        map.addListener('dblclick', () => {
          if (isDrawingRef.current) finishDrawing()
        })

        polylineRef.current = new Polyline({
          path: [],
          strokeColor: POLYGON_STYLE.strokeColor,
          strokeWeight: POLYGON_STYLE.strokeWeight,
          map,
        })

        setStatus(`Click the map to drop polygon points (max ${MAX_AREA_KM2} km²). Add at least 3, then double-click or press Finish.`)
      })
      .catch((err) => {
        if (!cancelled) setStatus(`Could not load map: ${err.message}`)
      })

    return () => {
      cancelled = true
      if (polygonRef.current) {
        polygonRef.current.setMap(null)
        polygonRef.current = null
      }
      if (polylineRef.current) {
        polylineRef.current.setMap(null)
        polylineRef.current = null
      }
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleAnalyze = () => {
    if (!canSubmit || !polygonRef.current) return
    onAnalyze(polygonToGeoJSON(polygonRef.current))
  }

  const handleUndo = () => {
    pointsRef.current.pop()
    updatePreview()
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-shrink-0 bg-gray-900/80 backdrop-blur border-b border-gray-800 px-6 py-3">
        <p className="text-sm text-gray-400">{status}</p>
      </div>

      <div ref={mapDivRef} className="flex-1 min-h-0" />

      <div className="flex-shrink-0 bg-gray-900/80 backdrop-blur border-t border-gray-800 px-6 py-4 flex items-center justify-between gap-3">
        <div className="text-sm">
          {hasPolygon ? (
            <span className={areaTooLarge ? 'text-red-400' : areaTooSmall ? 'text-yellow-400' : 'text-emerald-300'}>
              Area: <span className="font-mono">{areaKm2.toFixed(areaKm2 < 1 ? 3 : 1)} km²</span>
              {areaTooLarge && ` — too large (max ${MAX_AREA_KM2} km²). Reset and pick a smaller area.`}
              {areaTooSmall && ` — too small (min ${(minAreaKm2 * 100).toFixed(0)} ha).`}
            </span>
          ) : isDrawing ? (
            <span className="text-gray-500">
              {pointCount === 0
                ? 'Click the map to start drawing.'
                : `${pointCount} point${pointCount === 1 ? '' : 's'} added${pointCount >= 3 ? ` · ${areaKm2.toFixed(areaKm2 < 1 ? 3 : 1)} km²` : ' (need ≥ 3)'}.`}
            </span>
          ) : (
            <span className="text-gray-500">No polygon yet.</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isDrawing && (
            <>
              <button
                onClick={handleUndo}
                disabled={pointCount === 0 || disabled}
                className="px-4 py-2 text-sm rounded-md border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Undo point
              </button>
              <button
                onClick={finishDrawing}
                disabled={!canFinish || disabled}
                className="px-4 py-2 text-sm rounded-md border border-emerald-600 text-emerald-300 hover:bg-emerald-600/10 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Finish polygon
              </button>
            </>
          )}
          <button
            onClick={startDrawing}
            disabled={(!hasPolygon && pointCount === 0) || disabled}
            className="px-4 py-2 text-sm rounded-md border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Reset
          </button>
          <button
            onClick={handleAnalyze}
            disabled={!canSubmit}
            className="px-6 py-2 text-sm rounded-md bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-700 hover:to-teal-600 text-white font-medium shadow-md disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            Check for deforestation →
          </button>
        </div>
      </div>
    </div>
  )
}
