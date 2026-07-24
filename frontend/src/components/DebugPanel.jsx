import { useState } from 'react'

function fmtBytes(n) {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function Row({ k, v }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-2 py-0.5 text-[11px] font-mono">
      <div className="text-gray-500 truncate">{k}</div>
      <div className="text-gray-200 break-all">{String(v ?? '—')}</div>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div className="mt-3 first:mt-0">
      <div className="text-[10px] uppercase tracking-widest text-emerald-400/80 border-b border-gray-800 pb-1 mb-1">
        {title}
      </div>
      {children}
    </div>
  )
}

export default function DebugPanel({ info }) {
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-50 px-3 py-2 rounded-md bg-gray-900/90 border border-gray-700 text-emerald-300 text-xs font-mono hover:bg-gray-800 shadow-lg"
        title="Show pipeline internals"
      >
        🧪 Debug
      </button>
    )
  }

  const empty = !info || Object.keys(info).length === 0
  const json = JSON.stringify(info ?? {}, null, 2)

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[28rem] max-h-[80vh] flex flex-col rounded-lg bg-gray-950/95 border border-gray-700 shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
        <div className="text-sm font-semibold text-emerald-300">🧪 Pipeline internals</div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigator.clipboard?.writeText(json)}
            className="text-[10px] uppercase tracking-widest text-gray-400 hover:text-gray-100 px-2 py-1 rounded border border-gray-700"
            title="Copy as JSON"
          >
            Copy JSON
          </button>
          <button
            onClick={() => setOpen(false)}
            className="text-gray-400 hover:text-gray-100 px-2"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="overflow-y-auto px-3 py-3">
        {empty ? (
          <div className="text-xs text-gray-500 italic">
            Run an analysis to populate. Updates live as each stage completes.
          </div>
        ) : (
          <>
            {info.source && (
              <Section title="Source">
                <Row k="id" v={info.source.id} />
                <Row k="label" v={info.source.label} />
                <Row k="native res (m)" v={info.source.nativeResolutionM} />
                <Row k="max zoom" v={info.source.maxZoom} />
              </Section>
            )}

            {info.config && (
              <Section title="Config">
                <Row k="before year" v={info.config.beforeYear} />
                <Row k="after year" v={info.config.afterYear} />
                <Row k="month-day" v={info.config.monthDay ?? 'yearly mosaic'} />
                <Row k="forest darkness cap" v={info.config.forestDarknessCap} />
                <Row k="dark anchor pctile" v={info.config.darkAnchorPercentile} />
                <Row k="forest GI fraction" v={info.config.forestGIFraction} />
                <Row k="loss hysteresis" v={info.config.lossHysteresis} />
                <Row k="min vegetated GI" v={info.config.minVegetatedGI} />
                <Row k="target canvas px" v={info.config.targetCanvasMaxPx} />
              </Section>
            )}

            {info.polygon && (
              <Section title="Polygon">
                <Row k="vertices" v={info.polygon.vertices} />
                <Row k="bbox area km²" v={info.polygon.bboxAreaKm2} />
                <Row k="centroid lat" v={info.polygon.centroid?.lat} />
                <Row k="centroid lon" v={info.polygon.centroid?.lon} />
                {info.polygon.bbox && (
                  <>
                    <Row k="bbox lat" v={`${info.polygon.bbox.minLat.toFixed(4)} → ${info.polygon.bbox.maxLat.toFixed(4)}`} />
                    <Row k="bbox lon" v={`${info.polygon.bbox.minLon.toFixed(4)} → ${info.polygon.bbox.maxLon.toFixed(4)}`} />
                  </>
                )}
              </Section>
            )}

            {info.tiles && (
              <Section title="Tiles / canvas">
                <Row k="zoom" v={info.tiles.zoom} />
                <Row k="canvas (px)" v={info.tiles.canvasW ? `${info.tiles.canvasW} × ${info.tiles.canvasH}` : '—'} />
                <Row k="m / pixel" v={info.tiles.metersPerPixel} />
              </Section>
            )}

            {info.pixels && (
              <Section title="Pixels & area">
                <Row k="polygon px" v={info.pixels.polyPx?.toLocaleString()} />
                <Row k="loss px" v={info.pixels.lossPx?.toLocaleString()} />
                <Row k="loss fraction" v={info.pixels.lossFraction} />
                <Row k="forest px (before → after)" v={info.pixels.forestPxBefore != null ? `${info.pixels.forestPxBefore.toLocaleString()} → ${info.pixels.forestPxAfter?.toLocaleString()}` : '—'} />
                <Row k="scene contrast (before / after)" v={info.pixels.sceneBefore ? `${info.pixels.sceneBefore.contrast} / ${info.pixels.sceneAfter?.contrast}` : '—'} />
                <Row k="ha / pixel" v={info.pixels.hectaresPerPixel} />
                <Row k="loss (ha)" v={info.pixels.lossHa} />
                <Row k="polygon area km² (pixel-derived)" v={info.pixels.pxAreaImpliedKm2} />
              </Section>
            )}

            {info.tf && (
              <Section title="TensorFlow.js">
                <Row k="backend" v={info.tf.backend} />
                <Row k="tensors at start" v={info.tf.memoryStart?.numTensors} />
                <Row k="bytes at start" v={fmtBytes(info.tf.memoryStart?.numBytes)} />
                <Row k="tensors at peak" v={info.tf.memoryPeak?.numTensors} />
                <Row k="bytes at peak" v={fmtBytes(info.tf.memoryPeak?.numBytes)} />
                <Row k="tensors at end" v={info.tf.memoryEnd?.numTensors} />
                <Row k="bytes at end" v={fmtBytes(info.tf.memoryEnd?.numBytes)} />
              </Section>
            )}

            {info.timings && Object.keys(info.timings).length > 0 && (
              <Section title="Timings (ms)">
                {Object.entries(info.timings).map(([k, v]) => <Row key={k} k={k} v={v} />)}
              </Section>
            )}

            {info.userAgent && (
              <Section title="Browser">
                <Row k="userAgent" v={info.userAgent} />
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
