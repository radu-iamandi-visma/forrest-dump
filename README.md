# 🌲 Timbr — browser-only deforestation detection

Timbr detects forest loss **and** regrowth inside a user-drawn map polygon, then
estimates whether the clearing is likely legal — all **entirely in the browser**.
No backend, no LLM, no API key beyond Google Maps.

**Live demo:** <https://timbr-pi.vercel.app/>

## How it works

1. **Draw** a polygon on a satellite map.
2. Timbr fetches "before" and "after" satellite imagery for that area from
   free, CORS-open tile sources:
   - **Sentinel-2 cloudless** (EOX, 10 m) — default, 2018–2024
   - **MODIS Terra** (NASA GIBS, 250 m) — 2004–2024, with multi-date
     max-greenness compositing for cloud-free frames
3. **TensorFlow.js** classifies each pixel per year as **forest / not-forest**
   (dark relative to the scene *and* green — closed canopy is both, while
   grass and crops are green but bright), then flags classification
   transitions: **loss** (red) and **regrowth / reforestation** (green). A
   transition only counts if the underlying scene-normalized brightness or
   greenness also moved decisively. The pipeline adds cloud masking,
   haze-adaptive thresholds, edge-jitter suppression, and speckle removal to
   cut false positives.
4. It reports **deforestation %, reforestation %, and net change**, with a
   net-aware verdict (it won't call balanced loss/regrowth "severe loss").
5. A **knowledge-grounded legality assessment** turns the cleared percentage
   into a legal-risk flag using published, percentage-based forest law —
   Brazil's Forest Code Legal Reserve inside Brazil, the EU Deforestation
   Regulation / FAO frame elsewhere. It is a risk flag, **not legal advice**.

## Quick start

```bash
cd frontend
cp .env.example .env          # set VITE_GOOGLE_MAPS_API_KEY
npm install
npm run dev                   # http://localhost:3000
```

## Deploy

The repo ships a root `vercel.json` that builds the Vite app from `frontend/`
with an SPA rewrite — import the repo into Vercel, add the
`VITE_GOOGLE_MAPS_API_KEY` environment variable, and deploy.

## More

The app lives in [`frontend/`](frontend/). See
[`frontend/README.md`](frontend/README.md) for the full pipeline, accuracy
controls, legality logic, project structure, and configuration details.
