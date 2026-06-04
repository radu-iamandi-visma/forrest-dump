import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import HistoricMapViewer from './HistoricMapViewer'
import { SOURCES } from '../ml/deforestation'

const markdownComponents = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  img: ({ node, ...props }) => (
    <img {...props} className="rounded-md border border-gray-800 my-3 max-w-full" alt={props.alt || 'satellite area'} />
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
  no_loss:          { label: 'No detectable loss',      accent: 'from-emerald-500 to-teal-400', ring: 'ring-emerald-500/40' },
}
const UNKNOWN_DISPLAY = { label: 'Analysis complete', accent: 'from-gray-600 to-gray-500', ring: 'ring-gray-500/40' }
const ERROR_DISPLAY   = { label: 'Analysis failed',   accent: 'from-red-700 to-rose-600',   ring: 'ring-red-500/40' }

export default function ResultView({ markdown, verdict, error, geometry, sourceId = 'modis-terra', yearRangeOverride, onReset, onRetry }) {
  const display = error
    ? ERROR_DISPLAY
    : (verdict?.verdict && VERDICT_DISPLAY[verdict.verdict]) || UNKNOWN_DISPLAY
  const source = SOURCES[sourceId]

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
              <div className="prose prose-invert prose-sm max-w-none prose-p:my-2 prose-headings:my-3 prose-img:my-3">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents} urlTransform={urlTransform}>
                  {markdown || '_No response received._'}
                </ReactMarkdown>
              </div>
            )}
          </div>

          <div className="px-6 py-4 border-t border-gray-800 flex justify-end gap-2">
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

        {geometry && !error && (
          <HistoricMapViewer
            geometry={geometry}
            sourceId={sourceId}
            yearRangeOverride={yearRangeOverride}
          />
        )}

        <p className="text-[11px] text-gray-600 text-center max-w-xl mx-auto">
          Forest loss estimated entirely in your browser by a TensorFlow.js greenness-delta pipeline,
          comparing {source.attribution}. Detected change can result from logging, fire, storm, or seasonal
          phenology — illegality cannot be proven from imagery alone, and clearings smaller than the source's
          native resolution ({source.nativeResolutionM} m) are not detectable.
        </p>
      </div>
    </div>
  )
}
