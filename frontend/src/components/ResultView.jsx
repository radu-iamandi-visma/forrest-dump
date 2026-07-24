import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import HistoricMapViewer from './HistoricMapViewer'
import { SOURCES } from '../ml/deforestation'

const markdownComponents = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  img: ({ node, ...props }) => (
    // The overlay PNG is only as wide as the analyzed polygon's pixels (often
    // tiny). Stretch it to the full column width and keep pixels crisp when
    // upscaled so the red/green change map is actually legible.
    <img
      {...props}
      className="rounded-md border border-gray-800 my-3 w-full"
      style={{ imageRendering: 'pixelated', maxHeight: '70vh', objectFit: 'contain' }}
      alt={props.alt || 'satellite area'}
    />
  ),
}

// react-markdown's defaultUrlTransform strips any non-http(s)/mailto/tel URL as
// an XSS guard, including data: URIs — which kills our inline base64 overlay
// PNG. We generate this markdown ourselves from a fully trusted pipeline, so
// allow data:image/* through. Everything else still goes through the default.
function urlTransform(url) {
  if (typeof url === 'string' && url.startsWith('data:image/')) return url
  const colon = url.indexOf(':')
  if (colon < 0) return url
  return /^https?$|^mailto$|^tel$/.test(url.slice(0, colon)) ? url : ''
}

// Maps the pipeline's structured verdict code to header label + colour palette.
// Keys match the strings emitted by classify() in src/ml/deforestation.js.
const VERDICT_DISPLAY = {
  severe_loss:      { label: 'Severe forest loss',      accent: 'from-red-600 to-rose-500',     ring: 'ring-red-500/40' },
  significant_loss: { label: 'Significant forest loss', accent: 'from-orange-500 to-amber-500', ring: 'ring-orange-500/40' },
  minor_loss:       { label: 'Minor forest loss',       accent: 'from-yellow-500 to-amber-400', ring: 'ring-yellow-500/40' },
  mixed_change:     { label: 'Mixed change (loss ≈ regrowth)', accent: 'from-slate-500 to-gray-400', ring: 'ring-slate-500/40' },
  net_regrowth:     { label: 'Net regrowth / reforestation',   accent: 'from-emerald-500 to-green-400', ring: 'ring-emerald-500/40' },
  no_loss:          { label: 'No detectable change',    accent: 'from-emerald-500 to-teal-400', ring: 'ring-emerald-500/40' },
}
const UNKNOWN_DISPLAY = { label: 'Analysis complete', accent: 'from-gray-600 to-gray-500', ring: 'ring-gray-500/40' }
const ERROR_DISPLAY   = { label: 'Analysis failed',   accent: 'from-red-700 to-rose-600',   ring: 'ring-red-500/40' }

// Legality status → badge palette + human label. Keys match assessLegality().
const LEGALITY_DISPLAY = {
  likely_illegal:     { label: 'Likely illegal', cls: 'bg-red-500/15 text-red-300 border-red-500/40' },
  within_legal_limit: { label: 'Within legal limit', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' },
  review:             { label: 'Flag for review', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40' },
  indeterminate:      { label: 'Indeterminate', cls: 'bg-gray-500/15 text-gray-300 border-gray-500/40' },
}

function pct(fraction) {
  return `${(fraction * 100).toFixed(1)}%`
}

// Big percentage stat tile (loss / regrowth / net).
function Stat({ label, value, sub, color }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-950/60 px-4 py-3">
      <div className="text-[10px] uppercase tracking-widest text-gray-500">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-gray-500 mt-0.5">{sub}</div>}
    </div>
  )
}

function MetricsPanel({ metrics }) {
  if (!metrics) return null
  const { stats, gainStats, legality, netFraction, beforeYear, afterYear } = metrics
  const leg = LEGALITY_DISPLAY[legality?.status] || LEGALITY_DISPLAY.indeterminate
  const netColor = netFraction >= 0 ? 'text-emerald-400' : 'text-red-400'

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Stat
          label="Deforestation"
          value={pct(stats.lossFraction)}
          sub={`${stats.lossHa.toFixed(2)} ha lost`}
          color="text-red-400"
        />
        <Stat
          label="Reforestation"
          value={pct(gainStats.gainFraction)}
          sub={`${gainStats.gainHa.toFixed(2)} ha regrown`}
          color="text-emerald-400"
        />
        <Stat
          label="Net change"
          value={`${netFraction >= 0 ? '+' : ''}${pct(netFraction)}`}
          sub={`${beforeYear} → ${afterYear}`}
          color={netColor}
        />
      </div>

      {legality && (
        <div className="rounded-xl border border-gray-800 bg-gray-950/60 px-4 py-4">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="text-[10px] uppercase tracking-widest text-gray-500">Legal assessment</div>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${leg.cls}`}>{leg.label}</span>
          </div>
          <div className="text-sm font-medium text-gray-200">{legality.headline}</div>
          {legality.legalClearLimitPct != null && (
            <div className="mt-3">
              {/* Cleared-vs-legal-limit bar: marker shows the statutory limit. */}
              <div className="relative h-2.5 rounded-full bg-gray-800 overflow-hidden">
                <div
                  className={`h-full ${legality.status === 'likely_illegal' ? 'bg-red-500' : 'bg-emerald-500'}`}
                  style={{ width: `${Math.min(100, legality.clearedPct)}%` }}
                />
                <div
                  className="absolute top-[-3px] bottom-[-3px] w-0.5 bg-yellow-300"
                  style={{ left: `${Math.min(100, legality.legalClearLimitPct)}%` }}
                  title={`Legal clearing limit: ${legality.legalClearLimitPct}%`}
                />
              </div>
              <div className="flex justify-between text-[10px] text-gray-500 mt-1">
                <span>cleared {legality.clearedPct}%</span>
                <span>legal limit {legality.legalClearLimitPct}% (keep {legality.reservePct}% forested)</span>
              </div>
            </div>
          )}
          <p className="text-xs text-gray-400 mt-3">{legality.rationale}</p>
          <p className="text-[11px] text-gray-600 mt-2 italic">{legality.assumption}</p>
          <div className="text-[10px] text-gray-500 mt-2">
            <span className="text-gray-400">Region:</span> {legality.region}
          </div>
          {legality.citations?.length > 0 && (
            <details className="mt-2 text-[11px] text-gray-500">
              <summary className="cursor-pointer hover:text-gray-300">Sources &amp; thresholds</summary>
              <ul className="list-disc pl-4 mt-1 space-y-1">
                {legality.citations.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

export default function ResultView({ markdown, verdict, metrics, error, geometry, sourceId = 'modis-terra', yearRangeOverride, shareUrl, onReset, onRetry }) {
  const display = error
    ? ERROR_DISPLAY
    : (verdict?.verdict && VERDICT_DISPLAY[verdict.verdict]) || UNKNOWN_DISPLAY
  const source = SOURCES[sourceId]
  const [copied, setCopied] = useState(false)

  const handleCopyShareLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API unavailable (http, permissions): let the user copy manually.
      window.prompt('Copy this share link:', shareUrl)
    }
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-gradient-to-br from-gray-950 to-gray-900">
      <div className="max-w-3xl w-full mx-auto px-6 py-10 space-y-6">
        <div className={`rounded-2xl border border-gray-800 bg-gray-900/70 backdrop-blur shadow-xl ring-1 ${display.ring}`}>
          <div className={`rounded-t-2xl px-6 py-4 bg-gradient-to-r ${display.accent} text-white`}>
            <div className="text-xs uppercase tracking-widest opacity-80">Verdict</div>
            <div className="text-2xl font-bold">{display.label}</div>
          </div>

          <div className="px-6 py-5">
            {error ? (
              <div className="text-red-400 text-sm">
                <div className="font-semibold mb-1">Analysis failed</div>
                <div className="font-mono break-words">{error}</div>
              </div>
            ) : (
              <div className="space-y-5">
                <MetricsPanel metrics={metrics} />
                <div className="prose prose-invert prose-sm max-w-none prose-p:my-2 prose-headings:my-3 prose-img:my-3">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents} urlTransform={urlTransform}>
                    {markdown || '_No response received._'}
                  </ReactMarkdown>
                </div>
              </div>
            )}
          </div>

          <div className="px-6 py-4 border-t border-gray-800 flex items-center justify-between gap-2">
            <div>
              {shareUrl && (
                <button
                  onClick={handleCopyShareLink}
                  className={`px-5 py-2 text-sm rounded-md border font-medium transition-all ${
                    copied
                      ? 'border-emerald-500/60 text-emerald-300 bg-emerald-500/10'
                      : 'border-gray-700 text-gray-300 hover:bg-gray-800'
                  }`}
                  title="Copy a link that re-runs this exact analysis"
                >
                  {copied ? 'Link copied ✓' : '🔗 Copy share link'}
                </button>
              )}
            </div>
            <div className="flex gap-2">
            {error && onRetry && (
              <button
                onClick={onRetry}
                className="px-5 py-2 text-sm rounded-md border border-emerald-500/60 text-emerald-300 hover:bg-emerald-500/10 font-medium transition-all"
              >
                Retry analysis
              </button>
            )}
            <button
              onClick={onReset}
              className="px-5 py-2 text-sm rounded-md bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-700 hover:to-teal-600 text-white font-medium shadow-md transition-all"
            >
              Analyze another area
            </button>
            </div>
          </div>
        </div>

        {geometry && !error && (
          <HistoricMapViewer
            geometry={geometry}
            sourceId={sourceId}
            yearRangeOverride={yearRangeOverride}
          />
        )}

        <p className="text-[11px] text-gray-600 text-center max-w-xl mx-auto">
          Forest loss and regrowth estimated entirely in your browser by a TensorFlow.js greenness-delta
          pipeline (cloud-masked, speckle-filtered, brightness-normalized), comparing {source.attribution}.
          Detected change can result from logging, fire, storm, or seasonal phenology, and clearings smaller
          than the source's native resolution ({source.nativeResolutionM} m) are not detectable. The legal
          assessment compares the cleared percentage against published statutory thresholds as a risk flag
          only — it is not legal advice and cannot prove illegality or the absence of a permit.
        </p>
      </div>
    </div>
  )
}
