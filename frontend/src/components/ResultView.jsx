import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import HistoricMapViewer from './HistoricMapViewer'

const markdownComponents = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  img: ({ node, ...props }) => (
    <img {...props} className="rounded-md border border-gray-800 my-3 max-w-full" alt={props.alt || 'satellite area'} />
  ),
}

function classifyVerdict(text) {
  const t = (text || '').toLowerCase()
  if (/severe|massive|extensive|catastrophic/.test(t)) return { tone: 'severe', label: 'Severe forest loss', accent: 'from-red-600 to-rose-500', ring: 'ring-red-500/40' }
  if (/significant|substantial|notable|considerable/.test(t)) return { tone: 'significant', label: 'Significant forest loss', accent: 'from-orange-500 to-amber-500', ring: 'ring-orange-500/40' }
  if (/minor|small|limited|slight/.test(t)) return { tone: 'minor', label: 'Minor forest loss', accent: 'from-yellow-500 to-amber-400', ring: 'ring-yellow-500/40' }
  if (/no (?:detectable|measurable|tree cover|forest) loss|no loss|intact/.test(t)) return { tone: 'none', label: 'No detectable loss', accent: 'from-emerald-500 to-teal-400', ring: 'ring-emerald-500/40' }
  return { tone: 'unknown', label: 'Analysis complete', accent: 'from-gray-600 to-gray-500', ring: 'ring-gray-500/40' }
}

export default function ResultView({ markdown, error, geometry, onReset }) {
  const verdict = classifyVerdict(markdown)

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-gradient-to-br from-gray-950 to-gray-900">
      <div className="max-w-3xl w-full mx-auto px-6 py-10 space-y-6">
        <div className={`rounded-2xl border border-gray-800 bg-gray-900/70 backdrop-blur shadow-xl ring-1 ${verdict.ring}`}>
          <div className={`rounded-t-2xl px-6 py-4 bg-gradient-to-r ${verdict.accent} text-white`}>
            <div className="text-xs uppercase tracking-widest opacity-80">Verdict</div>
            <div className="text-2xl font-bold">{verdict.label}</div>
          </div>

          <div className="px-6 py-5">
            {error ? (
              <div className="text-red-400 text-sm">
                <div className="font-semibold mb-1">Analysis failed</div>
                <div className="font-mono break-words">{error}</div>
              </div>
            ) : (
              <div className="prose prose-invert prose-sm max-w-none prose-p:my-2 prose-headings:my-3 prose-img:my-3">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {markdown || '_No response received._'}
                </ReactMarkdown>
              </div>
            )}
          </div>

          <div className="px-6 py-4 border-t border-gray-800 flex justify-end">
            <button
              onClick={onReset}
              className="px-5 py-2 text-sm rounded-md bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-700 hover:to-teal-600 text-white font-medium shadow-md transition-all"
            >
              Analyze another area
            </button>
          </div>
        </div>

        {geometry && !error && <HistoricMapViewer geometry={geometry} />}

        <p className="text-[11px] text-gray-600 text-center max-w-xl mx-auto">
          Forest loss measured by the Hansen UMD Global Forest Change dataset (30 % canopy threshold).
          Tree-cover loss can result from logging, fire, storm, or disease — illegality cannot be proven from imagery alone.
        </p>
      </div>
    </div>
  )
}
