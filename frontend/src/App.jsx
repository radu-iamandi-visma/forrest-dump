import { useEffect, useState } from 'react'
import MapPicker from './components/MapPicker'
import AnalysisCarousel from './components/AnalysisCarousel'
import ResultView from './components/ResultView'
import DebugPanel from './components/DebugPanel'
import { runDeforestationAnalysis, SOURCES } from './ml/deforestation'

const SOURCE_LIST = Object.values(SOURCES)

export default function App() {
  const [stage, setStage] = useState('map') // 'map' | 'analyzing' | 'result'
  const [resultMarkdown, setResultMarkdown] = useState('')
  const [resultVerdict, setResultVerdict] = useState(null)
  const [resultStats, setResultStats] = useState(null)
  const [resultError, setResultError] = useState(null)
  const [progressText, setProgressText] = useState('')
  const [analyzedGeometry, setAnalyzedGeometry] = useState(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [sourceId, setSourceId] = useState(SOURCE_LIST[0].id)
  const [ignoreSentinel2018, setIgnoreSentinel2018] = useState(false)
  const [debugInfo, setDebugInfo] = useState(null)

  const source = SOURCES[sourceId]
  const skip2018 = sourceId === 's2cloudless' && ignoreSentinel2018
  const effectiveBefore = skip2018 ? 2019 : source.defaultBefore
  const effectiveYearRange = skip2018 ? [2019, source.yearRange[1]] : source.yearRange

  const handleAnalyze = async (geojson) => {
    setStage('analyzing')
    setIsAnalyzing(true)
    setResultMarkdown('')
    setResultVerdict(null)
    setResultStats(null)
    setResultError(null)
    setProgressText('Preparing analysis…')
    setAnalyzedGeometry(geojson)

    try {
      const result = await runDeforestationAnalysis(geojson, {
        sourceId,
        beforeYear: effectiveBefore,
        onProgress: (_status, message) => setProgressText(message),
        onDebug: (info) => setDebugInfo(info),
      })
      setResultMarkdown(result.markdown)
      setResultVerdict({
        verdict: result.verdict,
        likelyIllegal: result.likelyIllegal,
        confidence: result.confidence,
      })
      setResultStats({
        stats: result.stats,
        gainStats: result.gainStats,
        legality: result.legality,
        netFraction: result.netFraction,
        beforeYear: result.beforeYear,
        afterYear: result.afterYear,
      })
      setStage('result')
    } catch (err) {
      console.error('Analysis error:', err)
      setResultError(err.message || String(err))
      setStage('result')
    } finally {
      setIsAnalyzing(false)
    }
  }

  const handleRetry = () => {
    if (analyzedGeometry) handleAnalyze(analyzedGeometry)
  }

  // When the user changes imagery source (or toggles the Sentinel "ignore 2018"
  // option) while looking at a verdict, re-run the analysis automatically so
  // the result matches the new inputs. We deliberately only auto-rerun on the
  // result stage — no point firing this on the map / analyzing stages.
  useEffect(() => {
    if (stage === 'result' && analyzedGeometry && !isAnalyzing) {
      handleAnalyze(analyzedGeometry)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, ignoreSentinel2018])

  const handleReset = () => {
    setResultMarkdown('')
    setResultVerdict(null)
    setResultStats(null)
    setResultError(null)
    setProgressText('')
    setAnalyzedGeometry(null)
    setStage('map')
  }

  return (
    <div className="flex flex-col h-screen bg-gradient-to-br from-gray-950 to-gray-900 text-gray-100">
      <div className="bg-gray-900/80 backdrop-blur border-b border-gray-800 shadow-sm flex-shrink-0">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-100">🌲 Timbr</h1>
            <p className="text-sm text-gray-400">Detect deforestation in your browser with TensorFlow.js</p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <label className="text-[10px] uppercase tracking-widest text-gray-500">Imagery source</label>
            <select
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              disabled={stage === 'analyzing'}
              className="px-3 py-2 text-sm border border-gray-700 rounded-md bg-gray-800 text-gray-200 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent disabled:opacity-40 min-w-[18rem]"
            >
              {SOURCE_LIST.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
            {sourceId === 's2cloudless' && (
              <label className="flex items-center gap-2 text-[11px] text-gray-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={ignoreSentinel2018}
                  onChange={(e) => setIgnoreSentinel2018(e.target.checked)}
                  disabled={stage === 'analyzing'}
                  className="accent-emerald-500"
                />
                Ignore 2018 (low-res cloudless mosaic)
              </label>
            )}
            <span className="text-[10px] text-gray-500 font-mono">
              window: {effectiveBefore} → {source.defaultAfter} · min area: {source.minAreaKm2} km²
            </span>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {stage === 'map' && (
          <MapPicker
            onAnalyze={handleAnalyze}
            disabled={isAnalyzing}
            minAreaKm2={source.minAreaKm2}
          />
        )}
        {stage === 'analyzing' && (
          <AnalysisCarousel progressText={progressText} source={source} />
        )}
        {stage === 'result' && (
          <ResultView
            markdown={resultMarkdown}
            verdict={resultVerdict}
            metrics={resultStats}
            error={resultError}
            geometry={analyzedGeometry}
            sourceId={sourceId}
            yearRangeOverride={effectiveYearRange}
            onReset={handleReset}
            onRetry={handleRetry}
          />
        )}
      </div>

      <DebugPanel info={debugInfo} />
    </div>
  )
}
