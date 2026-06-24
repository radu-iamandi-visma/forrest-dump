# ForestWatch — browser-only deforestation detection

A React + Vite app that detects forest loss inside a user-drawn polygon **entirely
in the browser**. No backend, no LLM, no API key beyond Google Maps.

The pipeline:

1. User draws a polygon by clicking vertices on a Google Maps satellite layer
   (`MapPicker`). Drawing is implemented manually with map click listeners and a
   plain `google.maps.Polygon` — the old `DrawingManager` was removed from the
   Maps JS API in v3.65.
2. `src/ml/deforestation.js` computes a tile range covering the polygon and
   fetches imagery for a "before" and "after" year from one of two CORS-open,
   key-free XYZ sources, stitched into a canvas clipped to the polygon:
   - **Sentinel-2 cloudless (EOX, 10 m)** — the default. A server-side
     cloud-free yearly mosaic, 2018–2024.
   - **MODIS Terra TrueColor (NASA GIBS, 250 m)** — 2004–2024. For MODIS we
     fetch **5 dates per year** and keep, per pixel, the greenest observation
     (max-greenness compositing), which rejects clouds/shadows client-side.
3. TensorFlow.js computes a greenness index per pixel
   `GI = (2G - R - B) / (G + R + B)` for each year and detects change — see
   **Accuracy pipeline** below. It flags both **loss** (red) and **regrowth /
   reforestation** (green) pixels.
4. Pixels are converted to hectares using the Web Mercator meters-per-pixel
   formula at the polygon's centroid latitude, giving loss %, regrowth %, and
   net change.
5. A **net-aware verdict** and a **knowledge-grounded legality assessment** are
   computed (see below). `ResultView` renders a stats panel, the legality panel,
   a narrative, and the after-image with the red/green change overlay.

## Accuracy pipeline

`detectChange()` in `src/ml/deforestation.js` applies, in order:

- **Cloud / snow / glare masking** — a pixel bright in *all three* channels in
  either year is excluded from both loss and gain. The test uses the *minimum*
  channel, so white clouds (bright everywhere) are dropped while tan/brown bare
  soil (low blue) survives and still counts as real clearing.
- **Illumination normalization** — aligns the after-year mean GI to the
  before-year mean over stable, in-polygon, cloud-free pixels, removing
  year-to-year brightness/atmosphere drift before differencing.
- **Edge-jitter suppression** — drops any loss pixel sitting within a 5×5 window
  of a gain pixel (and vice-versa). Slight mosaic mis-registration or seasonal
  mismatch otherwise registers a tree edge as a band of "loss" backing onto a
  band of "gain"; this collapses those mirror-image artifacts that inflate both
  numbers.
- **Speckle removal** — a flagged pixel survives only if ≥4 of its 3×3
  neighbours are also flagged, killing isolated single-pixel noise.

The headline verdict is **net-aware**: when loss and gain are comparable
(neither exceeds the other by >34% of total activity) it reads *"Mixed change
(loss ≈ regrowth)"* rather than grading severity on gross loss; when loss
clearly dominates, severity is graded on **net** loss.

## Legal assessment

`assessLegality()` turns the cleared **percentage** into a legal-risk call using
published, percentage-based forest law, auto-selecting the framework from the
polygon's centroid:

- **Inside Brazil** — the **Forest Code (Lei 12.651/2012) Legal Reserve**: a
  rural property must keep 80% forested in the Amazon biome (so >20% cleared is
  likely illegal), 20% elsewhere (up to 80% clearable). Clearing past that share
  is flagged "Likely illegal".
- **Outside Brazil** — no single statutory %-rule exists, so the result is
  framed against the **EU Deforestation Regulation (EU 2023/1115)** / FAO forest
  definition and can only be "Flag for review" or "Indeterminate" — never
  "Likely illegal".

This is a **risk flag, not legal advice**: the percentage is of the *drawn
polygon* (treated as a proxy for one legal property) and imagery cannot confirm
a permit or prove intent.

## Quick start

```bash
cp .env.example .env
# Set VITE_GOOGLE_MAPS_API_KEY (Maps JavaScript API enabled, restricted to your origin).
make dev
```

App is at <http://localhost:3000>.

## Configuration

| Variable | Purpose |
|---|---|
| `VITE_GOOGLE_MAPS_API_KEY` | Used for the polygon-picker map and the historic-imagery viewer |

That's it. Everything else (imagery, ML, verdict) is computed in-browser from
public, CORS-open sources.

## Project structure

```
frontend/
├── src/
│   ├── App.jsx                       # Stage machine: map → analyzing → result
│   ├── main.jsx
│   ├── ml/
│   │   └── deforestation.js          # The browser ML pipeline (TF.js)
│   ├── components/
│   │   ├── MapPicker.jsx             # Polygon-draw map
│   │   ├── AnalysisCarousel.jsx      # Progress UI during inference
│   │   ├── ResultView.jsx            # Verdict markdown + historic viewer
│   │   └── HistoricMapViewer.jsx     # Year slider over Sentinel-2 + GFW tiles
│   └── lib/
│       └── googleMaps.js             # Google Maps JS loader
└── public/
```

## Commands

```bash
make install   # npm install
make dev       # npm run dev  → http://localhost:3000
make build     # npm run build → ./dist
make clean     # rm -rf node_modules dist
```

## Notes / limitations

- Both sources are RGB-only — no NIR — so we use a greenness index rather than
  NDVI. Reasonable for visible-light vegetation change but less robust to
  seasonal phenology than NIR-based change detection.
- The change-detection heuristic in `src/ml/deforestation.js` is unsupervised
  (a thresholded delta on the greenness index plus the masking/denoising steps
  above, computed via `tf.tidy`). You can swap in a trained Keras → TFJS model
  by replacing `detectChange()` with `tf.loadLayersModel(...)` and feeding the
  same before+after tensor pair.
- Accuracy controls live in the `DEFAULTS` object at the top of
  `src/ml/deforestation.js` (greenness thresholds, `cloudBrightnessThreshold`,
  `normalizeIllumination`, `minNeighbors`, `suppressEdgeJitter`/`jitterKernel`).
- The legality jurisdiction gates are coarse lat/lon bounding boxes, not the
  true (irregular) biome boundaries — they only pick the right rule-of-thumb.
- Clearings smaller than a source's native resolution (Sentinel-2 10 m, MODIS
  250 m) are not detectable.
- Polygons larger than ~200 km² are rejected by the picker so the stitched
  canvas stays small enough for browser inference to stay snappy.
