# ForestWatch — browser-only deforestation detection

A React + Vite app that detects forest loss inside a user-drawn polygon **entirely
in the browser**. No backend, no LLM, no API key beyond Google Maps.

The pipeline:

1. User draws a polygon on a Google Maps satellite layer (`MapPicker`).
2. `src/ml/deforestation.js` computes a tile range covering the polygon,
   fetches ESA Sentinel-2 cloudless yearly mosaics from EOX (free, CORS-open
   XYZ tiles) for a "before" and "after" year, and stitches each year into a
   canvas clipped to the polygon.
3. TensorFlow.js computes a greenness index per pixel
   `GI = (2G - R - B) / (G + R + B)` for each year, takes the delta, and
   thresholds it to flag forest-loss pixels.
4. Pixels are converted to hectares using the Web Mercator meters-per-pixel
   formula at the polygon's centroid latitude.
5. `ResultView` renders the deterministic verdict markdown plus the after image
   with the loss mask in red.

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

- EOX cloudless mosaics are RGB-only — no NIR — so we use a greenness index
  rather than NDVI. Reasonable for visible-light vegetation change but less
  robust to seasonal phenology than NIR-based change detection.
- The change-detection heuristic in `src/ml/deforestation.js` is unsupervised
  (a thresholded delta on the greenness index, computed via `tf.tidy`). You can
  swap in a trained Keras → TFJS model by replacing `detectChange()` with
  `tf.loadLayersModel(...)` and feeding the same before+after tensor pair.
- Polygons larger than ~200 km² are rejected by the picker so the stitched
  canvas stays small enough for browser inference to stay snappy.
