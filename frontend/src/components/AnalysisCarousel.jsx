import { useEffect, useState } from 'react'

const stepsFor = (source) => [
  { label: 'Fetching before image', sub: source?.label || 'Imagery source' },
  { label: 'Fetching after image', sub: source?.label || 'Imagery source' },
  { label: 'Running change detection', sub: 'TensorFlow.js greenness-delta inference in the browser' },
  { label: 'Computing verdict', sub: 'Estimating hectares lost and flagging patterns' },
]

export default function AnalysisCarousel({ progressText, source }) {
  const STEPS = stepsFor(source)
  const [yearStart, yearEnd] = source?.yearRange || [2004, 2024]
  const [index, setIndex] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      // Walk through steps and STAY on the last one — the bar must not wrap back
      // to 0 while we're still waiting for the model to finish writing.
      setIndex((i) => (i < STEPS.length - 1 ? i + 1 : i))
    }, 700)
    return () => clearInterval(interval)
  }, [])

  const step = STEPS[index]

  return (
    <div className="flex flex-col h-full items-center justify-center bg-gradient-to-br from-emerald-950/40 via-gray-950 to-teal-950/40">
      <div className="relative w-full max-w-2xl px-8 text-center">
        <div className="mb-8">
          <div className="inline-flex relative">
            <div className="w-24 h-24 rounded-full border-4 border-emerald-500/30 border-t-emerald-400 animate-spin" />
            <div className="absolute inset-0 flex items-center justify-center text-3xl">🌳</div>
          </div>
        </div>

        <div className="h-32 flex flex-col items-center justify-center overflow-hidden">
          <div
            key={index}
            className="animate-[fadeSlide_700ms_ease-out]"
          >
            <div className="text-5xl font-bold text-emerald-300 tracking-wide mb-2">
              {step.label}
            </div>
            <div className="text-sm text-gray-400">{step.sub}</div>
          </div>
        </div>

        <div className="mt-10 max-w-md mx-auto">
          <div className="flex justify-between text-[10px] text-gray-500 mb-2 font-mono">
            <span>{yearStart}</span>
            <span>{yearEnd}</span>
          </div>
          <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-700"
              style={{ width: `${((index + 1) / STEPS.length) * 100}%` }}
            />
          </div>
        </div>

        {progressText && (
          <div className="mt-8 text-xs text-gray-500 font-mono max-w-lg mx-auto truncate">
            {progressText}
          </div>
        )}
      </div>

      <style>{`
        @keyframes fadeSlide {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
