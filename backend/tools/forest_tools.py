import os
import json
import logging
import time
from datetime import datetime
from typing import Any, Dict, List, Union

import httpx
from strands import tool

logger = logging.getLogger("forest-tools")

GFW_DATA_API = "https://data-api.globalforestwatch.org"
HANSEN_DATASET = "umd_tree_cover_loss"
HANSEN_VERSION = "v1.11"

# Optional GFW Data API key. Anonymous calls work for small polygons today but the
# rate limits are tight; set GFW_API_KEY to get higher quotas and future-proof
# against GFW disabling anonymous access. Obtain from https://www.globalforestwatch.org/my-gfw/.
GFW_API_KEY = os.getenv("GFW_API_KEY")

GOOGLE_STATIC_MAPS = "https://maps.googleapis.com/maps/api/staticmap"


def _parse_geometry(geometry: Union[str, dict]) -> dict:
    if isinstance(geometry, str):
        try:
            geometry = json.loads(geometry)
        except json.JSONDecodeError as e:
            raise ValueError(f"geometry is not valid JSON: {e}") from e

    if not isinstance(geometry, dict):
        raise ValueError("geometry must be a GeoJSON Feature, FeatureCollection, or Geometry object")

    if geometry.get("type") == "FeatureCollection":
        features = geometry.get("features") or []
        if not features:
            raise ValueError("FeatureCollection has no features")
        geometry = features[0].get("geometry")
    elif geometry.get("type") == "Feature":
        geometry = geometry.get("geometry")

    if not geometry or geometry.get("type") not in ("Polygon", "MultiPolygon"):
        raise ValueError("geometry must resolve to a Polygon or MultiPolygon")

    return geometry


def _polygon_centroid(geometry: dict) -> tuple[float, float]:
    """Cheap centroid of the first ring; good enough for thumbnails."""
    if geometry["type"] == "Polygon":
        ring = geometry["coordinates"][0]
    else:
        ring = geometry["coordinates"][0][0]
    lon = sum(p[0] for p in ring) / len(ring)
    lat = sum(p[1] for p in ring) / len(ring)
    return lat, lon


@tool
def analyze_deforestation(geometry: Union[str, dict], start_year: int = 2014, end_year: int = 2024) -> Dict[str, Any]:
    """Quantify forest loss inside a polygon, year by year, using the Hansen Global Forest Change dataset.

    The Hansen UMD dataset (hosted by Global Forest Watch) measures tree cover loss
    globally at 30 m resolution since 2001. Pass a GeoJSON polygon and the year range
    you want to analyze; the tool returns hectares of tree cover lost per year.

    Args:
        geometry: GeoJSON Polygon / MultiPolygon / Feature / FeatureCollection — either a
                  dict or a JSON string. WGS84 coordinates (lon, lat).
        start_year: First year to include (inclusive). Defaults to 10 years before 2024.
        end_year: Last year to include (inclusive). Defaults to 2024.

    Returns:
        Dict with:
          - total_loss_ha: total hectares lost over the range
          - per_year: list of {year, loss_ha}
          - peak_year: year with the highest loss (or None)
          - threshold_pct: tree-cover canopy threshold used (30%)
          - dataset: the data source identifier
    """
    logger.info(f"▶ analyze_deforestation: years={start_year}-{end_year}")
    geom = _parse_geometry(geometry)

    # Polygon size quick estimate (bbox area) — useful when debugging slow queries.
    coords_iter = geom["coordinates"][0] if geom["type"] == "Polygon" else geom["coordinates"][0][0]
    lons = [p[0] for p in coords_iter]
    lats = [p[1] for p in coords_iter]
    bbox_deg2 = (max(lons) - min(lons)) * (max(lats) - min(lats))
    logger.info(f"  polygon vertices={len(coords_iter)} bbox≈{bbox_deg2:.4f} deg²")

    sql = (
        "SELECT umd_tree_cover_loss__year AS year, "
        "SUM(area__ha) AS loss_ha "
        f"FROM {HANSEN_DATASET} "
        "WHERE umd_tree_cover_density_2000__threshold = 30 "
        f"AND umd_tree_cover_loss__year >= {int(start_year)} "
        f"AND umd_tree_cover_loss__year <= {int(end_year)} "
        "GROUP BY umd_tree_cover_loss__year "
        "ORDER BY umd_tree_cover_loss__year"
    )

    url = f"{GFW_DATA_API}/dataset/{HANSEN_DATASET}/{HANSEN_VERSION}/query/json"
    payload = {"sql": sql, "geometry": geom}
    headers = {"x-api-key": GFW_API_KEY} if GFW_API_KEY else {}

    logger.info(f"  → POST {url} (auth={'yes' if GFW_API_KEY else 'anonymous'})")
    t0 = time.monotonic()
    try:
        resp = httpx.post(url, json=payload, headers=headers, timeout=60.0, follow_redirects=True)
        resp.raise_for_status()
    except httpx.HTTPStatusError as e:
        dur = time.monotonic() - t0
        logger.error(f"  ✗ GFW HTTP {e.response.status_code} after {dur:.1f}s: {e.response.text[:400]}")
        raise RuntimeError(f"GFW API error {e.response.status_code}: {e.response.text[:200]}") from e
    except httpx.HTTPError as e:
        dur = time.monotonic() - t0
        logger.error(f"  ✗ GFW request failed after {dur:.1f}s: {e}")
        raise RuntimeError(f"GFW API request failed: {e}") from e

    dur = time.monotonic() - t0
    rows = resp.json().get("data", [])
    logger.info(f"  ← GFW responded in {dur:.1f}s with {len(rows)} rows")
    per_year = [{"year": int(r["year"]), "loss_ha": round(float(r["loss_ha"]), 3)} for r in rows]

    # Fill missing years with 0 so the LLM sees a complete time series.
    seen = {y["year"] for y in per_year}
    for y in range(int(start_year), int(end_year) + 1):
        if y not in seen:
            per_year.append({"year": y, "loss_ha": 0.0})
    per_year.sort(key=lambda x: x["year"])

    total = round(sum(y["loss_ha"] for y in per_year), 3)
    peak = max(per_year, key=lambda x: x["loss_ha"]) if per_year else None

    logger.info(f"  ■ total_loss={total} ha, peak_year={peak['year'] if peak else None}")

    return {
        "total_loss_ha": total,
        "per_year": per_year,
        "peak_year": peak["year"] if peak and peak["loss_ha"] > 0 else None,
        "threshold_pct": 30,
        "dataset": f"{HANSEN_DATASET} {HANSEN_VERSION} (Hansen et al. / UMD via Global Forest Watch)",
    }


@tool
def get_area_satellite_thumbnail(geometry: Union[str, dict], zoom: int = 13) -> Dict[str, Any]:
    """Return a Google Maps satellite-imagery thumbnail URL centered on the given polygon.

    Note: Google Maps Static API only serves the *current* basemap — it cannot show
    imagery from past years. Use this purely to show the user where the analyzed
    area is, not to detect historical change.

    Args:
        geometry: GeoJSON Polygon / Feature / FeatureCollection (dict or JSON string).
        zoom: Google Maps zoom level (1-21). Defaults to 13.

    Returns:
        Dict with `url` (markdown-embeddable PNG URL) and `center` (lat, lon).
    """
    api_key = os.getenv("GOOGLE_MAPS_API_KEY")
    if not api_key:
        return {"error": "GOOGLE_MAPS_API_KEY not configured"}

    geom = _parse_geometry(geometry)
    lat, lon = _polygon_centroid(geom)

    # Encode polygon as a Static Maps path (red outline, semi-transparent fill).
    if geom["type"] == "Polygon":
        ring = geom["coordinates"][0]
    else:
        ring = geom["coordinates"][0][0]
    path_points = "|".join(f"{p[1]},{p[0]}" for p in ring)

    params = {
        "center": f"{lat},{lon}",
        "zoom": str(zoom),
        "size": "640x400",
        "maptype": "satellite",
        "path": f"color:0xff0000ff|weight:2|fillcolor:0xff000033|{path_points}",
        "key": api_key,
    }
    query = "&".join(f"{k}={v}" for k, v in params.items())
    return {
        "url": f"{GOOGLE_STATIC_MAPS}?{query}",
        "center": {"lat": lat, "lon": lon},
        "note": "Current satellite basemap only — does not reflect historical state.",
    }
