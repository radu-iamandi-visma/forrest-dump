import { useState } from 'react'
import MapPicker from './components/MapPicker'
import AnalysisCarousel from './components/AnalysisCarousel'
import ResultView from './components/ResultView'
import UsageWidget from './components/UsageWidget'
import useAuth from './hooks/useAuth'
import useStreaming from './hooks/useStreaming'

const LOCAL_BACKEND_URL = import.meta.env.VITE_LOCAL_BACKEND_URL
const DEPLOYED_BACKEND_URL = import.meta.env.VITE_DEPLOYED_BACKEND_URL

const getAvailableBackends = () => {
  const backends = []
  if (LOCAL_BACKEND_URL) backends.push({ id: 'local', label: 'Local Agent', url: LOCAL_BACKEND_URL })
  if (DEPLOYED_BACKEND_URL) backends.push({ id: 'deployed', label: 'Deployed Agent', url: DEPLOYED_BACKEND_URL })
  return backends
}

const AVAILABLE_BACKENDS = getAvailableBackends()

const getInitialBackend = () => {
  const stored = localStorage.getItem('selectedBackend')
  const found = AVAILABLE_BACKENDS.find((b) => b.id === stored)
  return found || AVAILABLE_BACKENDS[0] || { id: 'none', label: 'No Backend', url: '' }
}

export default function App() {
  const { accessToken, loading, logout, isAuthenticated, getValidAccessToken } = useAuth()
  const { streamMessage, isStreaming } = useStreaming()

  const [stage, setStage] = useState('map') // 'map' | 'analyzing' | 'result'
  const [resultMarkdown, setResultMarkdown] = useState('')
  const [resultError, setResultError] = useState(null)
  const [progressText, setProgressText] = useState('')
  const [analyzedGeometry, setAnalyzedGeometry] = useState(null)
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID())
  const [selectedBackend, setSelectedBackend] = useState(getInitialBackend)
  const [sessionUsage, setSessionUsage] = useState({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })

  const BACKEND_URL = selectedBackend.url

  const handleBackendChange = (backendId) => {
    const backend = AVAILABLE_BACKENDS.find((b) => b.id === backendId)
    if (backend) {
      setSelectedBackend(backend)
      localStorage.setItem('selectedBackend', backendId)
    }
  }

  const handleAnalyze = async (geojson) => {
    setStage('analyzing')
    setResultMarkdown('')
    setResultError(null)
    setProgressText('Sending area to agent…')
    setAnalyzedGeometry(geojson)

    const prompt = `Please check this area for signs of illegal deforestation over the past 10 years.\n\n\`\`\`geojson\n${JSON.stringify(geojson)}\n\`\`\``

    let textBuffer = ''

    try {
      await streamMessage(
        BACKEND_URL,
        prompt,
        accessToken,
        sessionId,
        (event) => {
          if (event.type === 'text') {
            textBuffer += event.content
            setProgressText(textBuffer.slice(-120).replace(/\s+/g, ' '))
          } else if (event.type === 'tool_start') {
            setProgressText(`Calling ${event.name}…`)
          } else if (event.type === 'tool') {
            setProgressText(`${event.name} returned`)
          } else if (event.type === 'usage') {
            setSessionUsage((prev) => ({
              inputTokens: prev.inputTokens + (event.inputTokens || 0),
              outputTokens: prev.outputTokens + (event.outputTokens || 0),
              totalTokens: prev.totalTokens + (event.totalTokens || 0),
            }))
          } else if (event.type === 'error') {
            setResultError(event.error)
          } else if (event.type === 'result') {
            setResultMarkdown(textBuffer)
            setStage('result')
          }
        },
        getValidAccessToken,
      )
    } catch (err) {
      console.error('Analysis error:', err)
      setResultError(err.message)
      setResultMarkdown(textBuffer)
      setStage('result')
    }
  }

  const handleReset = () => {
    setResultMarkdown('')
    setResultError(null)
    setProgressText('')
    setAnalyzedGeometry(null)
    setSessionId(crypto.randomUUID())
    setStage('map')
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-gray-950 to-gray-900">
        <div className="text-center">
          <div className="animate-spin h-12 w-12 border-4 border-emerald-500 border-t-transparent rounded-full mx-auto mb-4"></div>
          <p className="text-gray-400">Loading…</p>
        </div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-gray-950 to-gray-900">
        <div className="text-center">
          <p className="text-gray-400">Redirecting to login…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen bg-gradient-to-br from-gray-950 to-gray-900 text-gray-100">
      <div className="bg-gray-900/80 backdrop-blur border-b border-gray-800 shadow-sm flex-shrink-0">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-100">🌲 Forest Watch</h1>
            <p className="text-sm text-gray-400">Detect illegal deforestation from satellite data</p>
          </div>
          <div className="flex items-center gap-4">
            <UsageWidget
              inputTokens={sessionUsage.inputTokens}
              outputTokens={sessionUsage.outputTokens}
              totalTokens={sessionUsage.totalTokens}
            />
            {AVAILABLE_BACKENDS.length > 1 && (
              <select
                value={selectedBackend.id}
                onChange={(e) => handleBackendChange(e.target.value)}
                disabled={stage === 'analyzing'}
                className="px-3 py-2 text-sm border border-gray-700 rounded-md bg-gray-800 text-gray-200 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent disabled:opacity-40"
                title={selectedBackend.url}
              >
                {AVAILABLE_BACKENDS.map((backend) => (
                  <option key={backend.id} value={backend.id}>
                    {backend.label}
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={logout}
              className="px-4 py-2 text-sm text-gray-400 hover:text-gray-100 transition-colors"
            >
              Logout
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {stage === 'map' && (
          <MapPicker onAnalyze={handleAnalyze} disabled={isStreaming} />
        )}
        {stage === 'analyzing' && (
          <AnalysisCarousel progressText={progressText} />
        )}
        {stage === 'result' && (
          <ResultView
            markdown={resultMarkdown}
            error={resultError}
            geometry={analyzedGeometry}
            onReset={handleReset}
          />
        )}
      </div>
    </div>
  )
}
