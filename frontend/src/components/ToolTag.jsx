import { useState } from 'react'

export default function ToolTag({ toolBlock }) {
  const [isExpanded, setIsExpanded] = useState(false)

  const hasInput = toolBlock.input && Object.keys(toolBlock.input).length > 0
  const isSubAgent = toolBlock.isSubAgent || false

  return (
    <div className="flex flex-col my-2">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors text-sm w-fit ${
          isSubAgent
            ? 'bg-blue-950/50 border border-blue-800/60 hover:bg-blue-900/50'
            : 'bg-amber-950/40 border border-amber-800/50 hover:bg-amber-900/40'
        }`}
      >
        <span className={isSubAgent ? 'text-blue-300' : 'text-amber-300'}>
          {isSubAgent ? '↳' : '🔧'}
        </span>
        <span className={`font-medium ${isSubAgent ? 'text-blue-200' : 'text-amber-200'}`}>
          {toolBlock.name}
        </span>
        {hasInput && (
          <span className={`text-xs ${isSubAgent ? 'text-blue-400' : 'text-amber-400'}`}>
            ({Object.keys(toolBlock.input).length} {Object.keys(toolBlock.input).length === 1 ? 'arg' : 'args'})
          </span>
        )}
        <span className={`text-xs ${isSubAgent ? 'text-blue-400' : 'text-amber-400'}`}>
          {isExpanded ? '▼' : '▶'}
        </span>
      </button>

      {isExpanded && hasInput && (
        <div className="mt-2 ml-4 p-2 bg-gray-900 border border-gray-700 rounded text-xs">
          <pre className="text-gray-300 overflow-x-auto">
            {JSON.stringify(toolBlock.input, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
