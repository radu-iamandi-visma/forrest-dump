import { useEffect, useRef, useState } from 'react'
import { loadGoogleMapsLibraries } from '../lib/googleMaps'

// Browser-side TF.js inference stays responsive up to a stitched mosaic of
// ~768×768 px (set in src/ml/deforestation.js). The minimum polygon depends
// on the imagery source's native resolution and is passed in as a prop.
const MAX_AREA_KM2 = 200

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
  const drawingManagerRef = useRef(null)
  const currentPolygonRef = useRef(null)
  const drawingLibRef = useRef(null) // { DrawingManager, OverlayType }
  const [status, setStatus] = useState('Loading map…')
  const [hasPolygon, setHasPolygon] = useState(false)
  const [areaKm2, setAreaKm2] = useState(0)

  const areaTooLarge = areaKm2 > MAX_AREA_KM2
  const areaTooSmall = hasPolygon && areaKm2 < minAreaKm2
  const canSubmit = hasPolygon && !areaTooLarge && !areaTooSmall && !disabled

  useEffect(() => {
    let cancelled = false

    loadGoogleMapsLibraries()
      .then(({ google, core, maps, drawing, geometry }) => {
        if (cancelled || !mapDivRef.current) return

        const { ControlPosition } = core
        const { Map } = maps
        const { DrawingManager, OverlayType } = drawing
        const { spherical } = geometry
        drawingLibRef.current = { DrawingManager, OverlayType }

        const map = new Map(mapDivRef.current, {
          center: { lat: 46.5, lng: 24.5 }, // Transylvania
          zoom: 8,
          minZoom: 6,
          maxZoom: 16,
          mapTypeId: 'hybrid',
          streetViewControl: false,
          fullscreenControl: false,
        })
        mapRef.current = map

        const drawingManager = new DrawingManager({
          drawingMode: OverlayType.POLYGON,
          drawingControl: true,
          drawingControlOptions: {
            position: ControlPosition.TOP_CENTER,
            drawingModes: [OverlayType.POLYGON],
          },
          polygonOptions: {
            fillColor: '#10b981',
            fillOpacity: 0.25,
            strokeColor: '#10b981',
            strokeWeight: 2,
            editable: true,
            draggable: false,
          },
        })
        drawingManager.setMap(map)
        drawingManagerRef.current = drawingManager

        const recomputeArea = (poly) => {
          const m2 = spherical.computeArea(poly.getPath())
          setAreaKm2(m2 / 1_000_000)
        }

        google.maps.event.addListener(drawingManager, 'polygoncomplete', (poly) => {
          if (currentPolygonRef.current) currentPolygonRef.current.setMap(null)
          currentPolygonRef.current = poly
          setHasPolygon(true)
          recomputeArea(poly)
          const path = poly.getPath()
          path.addListener('set_at', () => recomputeArea(poly))
          path.addListener('insert_at', () => recomputeArea(poly))
          path.addListener('remove_at', () => recomputeArea(poly))
          drawingManager.setDrawingMode(null)
        })

        setStatus(`Draw a polygon (max ${MAX_AREA_KM2} km²) around the area you want to analyze.`)
      })
      .catch((err) => {
        if (!cancelled) setStatus(`Could not load map: ${err.message}`)
      })

    return () => {
      cancelled = true
      if (currentPolygonRef.current) {
        currentPolygonRef.current.setMap(null)
        currentPolygonRef.current = null
      }
      if (drawingManagerRef.current) {
        drawingManagerRef.current.setMap(null)
        drawingManagerRef.current = null
      }
      mapRef.current = null
      setHasPolygon(false)
    }
  }, [])

  const handleAnalyze = () => {
    if (!canSubmit || !currentPolygonRef.current) return
    const geojson = polygonToGeoJSON(currentPolygonRef.current)
    onAnalyze(geojson)
  }

  const handleReset = () => {
    if (currentPolygonRef.current) {
      currentPolygonRef.current.setMap(null)
      currentPolygonRef.current = null
    }
    setHasPolygon(false)
    setAreaKm2(0)
    if (drawingManagerRef.current && drawingLibRef.current) {
      drawingManagerRef.current.setDrawingMode(drawingLibRef.current.OverlayType.POLYGON)
    }
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
          ) : (
            <span className="text-gray-500">No polygon yet.</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleReset}
            disabled={!hasPolygon || disabled}
            className="px-4 py-2 text-sm rounded-md border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Reset polygon
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
