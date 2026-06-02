"""Local Hansen Global Forest Change raster analysis.

Replaces the GFW Data API call with a direct read of the public Hansen GeoTIFFs.
Granules are 10°×10°, named by their TOP-LEFT corner in latitude/longitude
(e.g. `50N_020E` covers 40-50°N, 20-30°E). Each lossyear pixel encodes the year
of forest loss as (year - 2000); 0 means no loss.

The dataset is licensed for public use; download a granule once and analysis is
offline, fast, and not rate-limited.
"""

import logging
import math
import os
import time
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

logger = logging.getLogger("forest-tools-local")

# Hansen GFC publishes at 1/40000° per pixel = ~30 m at the equator.
HANSEN_LOSS_BASE_YEAR = 2000


def granule_code_for_point(lat: float, lon: float) -> str:
    """Return the Hansen granule code (e.g. '50N_020E') containing the point.

    Granules are named by their TOP-LEFT corner. For a lat L, the top-left
    latitude is the smallest multiple of 10 >= L. For a lon, it's the largest
    multiple of 10 <= L.
    """
    tl_lat = math.ceil(lat / 10) * 10
    tl_lon = math.floor(lon / 10) * 10
    lat_str = f"{tl_lat:02d}N" if tl_lat >= 0 else f"{abs(tl_lat):02d}S"
    lon_str = f"{tl_lon:03d}E" if tl_lon >= 0 else f"{abs(tl_lon):03d}W"
    return f"{lat_str}_{lon_str}"


def find_granule_file(data_dir: Path, granule_code: str) -> Optional[Path]:
    """Look for *lossyear*<granule_code>.tif inside data_dir."""
    if not data_dir.is_dir():
        return None
    candidates = list(data_dir.glob(f"*lossyear*{granule_code}.tif"))
    return candidates[0] if candidates else None


def analyze_local(
    geometry: dict,
    start_year: int,
    end_year: int,
    data_dir: str,
    treecover_threshold: int = 0,
) -> Dict[str, Any]:
    """Compute per-year tree-cover loss inside `geometry` using local Hansen rasters.

    Args:
        geometry: GeoJSON Polygon or MultiPolygon (already parsed dict).
        start_year, end_year: inclusive year range to report.
        data_dir: directory containing Hansen lossyear GeoTIFFs.
        treecover_threshold: 0 to count every loss pixel, or a 0-100 value to
            apply the canopy threshold (matches GFW API's behavior). Requires a
            parallel `treecover2000` GeoTIFF to be present.

    Returns:
        Same shape as the API tool: total_loss_ha, per_year list, peak_year, etc.
    """
    # Import heavy deps lazily so the rest of the backend doesn't pay the cost
    # when local analysis is disabled.
    import numpy as np
    import rasterio
    from rasterio.mask import mask as rio_mask
    from shapely.geometry import shape

    data_path = Path(data_dir)
    shp = shape(geometry)
    centroid = shp.centroid
    granule_code = granule_code_for_point(centroid.y, centroid.x)

    lossyear_file = find_granule_file(data_path, granule_code)
    if lossyear_file is None:
        raise FileNotFoundError(
            f"No Hansen lossyear granule for {granule_code} in {data_dir}. "
            f"Download one with scripts/download_hansen.sh {granule_code}."
        )

    logger.info(f"▶ analyze_local: using {lossyear_file.name}")
    t0 = time.monotonic()

    with rasterio.open(lossyear_file) as src:
        out, transform = rio_mask(
            src, [geometry], crop=True, all_touched=True, filled=True, nodata=0
        )
    data = out[0]  # uint8, values 0 (no loss) or 1..N (loss year offset)

    # Optionally apply canopy threshold by masking loss pixels through treecover2000.
    threshold_note = "no canopy threshold"
    if treecover_threshold > 0:
        tc_file = next(data_path.glob(f"*treecover2000*{granule_code}.tif"), None)
        if tc_file is None:
            logger.warning(
                f"  treecover_threshold={treecover_threshold} requested but no "
                f"treecover2000 granule for {granule_code} — ignoring."
            )
        else:
            with rasterio.open(tc_file) as src_tc:
                tc_out, _ = rio_mask(
                    src_tc, [geometry], crop=True, all_touched=True, filled=True, nodata=0
                )
            tc = tc_out[0]
            # Some Hansen tiles can have slightly different shapes after mask;
            # if so, fall back to no-threshold rather than crashing.
            if tc.shape == data.shape:
                data = np.where(tc >= treecover_threshold, data, 0)
                threshold_note = f"{treecover_threshold}% canopy threshold"
            else:
                logger.warning(
                    f"  treecover and lossyear shapes differ {tc.shape} vs {data.shape}; "
                    "skipping threshold."
                )

    # Pixel area at the polygon's centroid latitude. Hansen rasters are in EPSG:4326
    # so we convert degrees → meters via the WGS84 sphere approximation, factoring
    # the cos(lat) shrinkage on the EW axis.
    R = 6378137.0  # WGS84 equatorial radius (m)
    res_y_deg = abs(transform.e)
    res_x_deg = abs(transform.a)
    pixel_h_m = res_y_deg * math.pi / 180.0 * R
    pixel_w_m = res_x_deg * math.pi / 180.0 * R * math.cos(math.radians(centroid.y))
    pixel_area_ha = (pixel_h_m * pixel_w_m) / 10_000.0

    per_year = []
    for year in range(int(start_year), int(end_year) + 1):
        offset = year - HANSEN_LOSS_BASE_YEAR
        if offset < 1:
            per_year.append({"year": year, "loss_ha": 0.0})
            continue
        # Hansen's max year value reflects the dataset release; values beyond it
        # are just absent (always 0 in `data`), so we don't need an upper bound.
        count = int(np.count_nonzero(data == offset))
        per_year.append({"year": year, "loss_ha": round(count * pixel_area_ha, 3)})

    total = round(sum(y["loss_ha"] for y in per_year), 3)
    peak = max(per_year, key=lambda x: x["loss_ha"]) if per_year else None

    dur = time.monotonic() - t0
    logger.info(
        f"  ■ total_loss={total} ha, peak_year={peak['year'] if peak else None}, "
        f"pixel_area={pixel_area_ha*10000:.0f} m², elapsed={dur:.2f}s"
    )

    return {
        "total_loss_ha": total,
        "per_year": per_year,
        "peak_year": peak["year"] if peak and peak["loss_ha"] > 0 else None,
        "threshold_pct": treecover_threshold if treecover_threshold > 0 else None,
        "dataset": f"Hansen GFC local raster ({lossyear_file.name}, {threshold_note})",
    }
