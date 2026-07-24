// Shareable-URL support for a drawn polygon + analysis settings.
//
// The analysis is recomputed deterministically in the recipient's browser from
// the polygon and imagery settings, so a share link only carries those inputs
// (a full result, with its inline overlay PNG, would never fit in a URL):
//
//   ?poly=<lat,lon~lat,lon~...>&src=<sourceId>&no2018=1
//
// Coordinates are rounded to 5 decimals (~1 m). `src` is omitted for the
// default source, `no2018` only applies to Sentinel-2. Both `,` and `~` are
// legal query-string characters per RFC 3986, so the links stay readable —
// they are built by hand rather than via URLSearchParams, which would
// percent-encode every separator.

import { SOURCES } from '../ml/deforestation'

const DEFAULT_SOURCE_ID = 's2cloudless'

function getRing(geojson) {
  const g = geojson?.geometry || geojson
  if (g.type === 'Polygon') return g.coordinates[0]
  if (g.type === 'MultiPolygon') return g.coordinates[0][0]
  throw new Error('geometry must be a Polygon or MultiPolygon')
}

export function buildShareUrl(geojson, { sourceId, ignoreSentinel2018 } = {}) {
  let ring = getRing(geojson)
  // Drop the closing point (GeoJSON repeats the first) — re-added on parse.
  const [fLon, fLat] = ring[0]
  const [lLon, lLat] = ring[ring.length - 1]
  if (ring.length > 1 && fLon === lLon && fLat === lLat) ring = ring.slice(0, -1)

  const poly = ring.map(([lon, lat]) => `${(+lat).toFixed(5)},${(+lon).toFixed(5)}`).join('~')
  let qs = `poly=${poly}`
  if (sourceId && sourceId !== DEFAULT_SOURCE_ID) qs += `&src=${encodeURIComponent(sourceId)}`
  if (ignoreSentinel2018 && (!sourceId || sourceId === DEFAULT_SOURCE_ID)) qs += `&no2018=1`
  return `${window.location.origin}${window.location.pathname}?${qs}`
}

// Returns { geojson, sourceId, ignoreSentinel2018 } or null when the query
// string holds no (valid) shared polygon. Malformed input is rejected as a
// whole rather than half-parsed.
export function parseShareParams(search) {
  try {
    const params = new URLSearchParams(search)
    const poly = params.get('poly')
    if (!poly) return null

    const points = poly.split('~').map((pair) => {
      const [lat, lon] = pair.split(',').map(Number)
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) {
        throw new Error(`bad coordinate: ${pair}`)
      }
      return [lon, lat]
    })
    if (points.length < 3) return null

    const sourceId = params.get('src') || DEFAULT_SOURCE_ID
    if (!SOURCES[sourceId]) return null

    return {
      geojson: {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[...points, points[0]]] },
        properties: {},
      },
      sourceId,
      ignoreSentinel2018: params.get('no2018') === '1' && sourceId === DEFAULT_SOURCE_ID,
    }
  } catch {
    return null
  }
}
