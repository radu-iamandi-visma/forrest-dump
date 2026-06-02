const ENERGY_WH_PER_TOKEN = 0.0003

const formatNumber = (n) => n.toLocaleString('en-US')

const formatEnergy = (wh) => {
  if (wh >= 1) return `${wh.toFixed(2)} Wh`
  return `${(wh * 1000).toFixed(1)} mWh`
}

export default function UsageWidget({ inputTokens, outputTokens, totalTokens }) {
  const energyWh = totalTokens * ENERGY_WH_PER_TOKEN

  return (
    <div
      className="flex items-center gap-3 px-3 py-1.5 rounded-md bg-gray-800 border border-gray-700 text-xs text-gray-300"
      title={`Session usage — input ${formatNumber(inputTokens)} · output ${formatNumber(outputTokens)}\nEnergy estimate at ${ENERGY_WH_PER_TOKEN} Wh/token`}
    >
      <span className="flex items-center gap-1">
        <span className="text-gray-500">tokens</span>
        <span className="font-mono font-medium text-gray-100">{formatNumber(totalTokens)}</span>
      </span>
      <span className="text-gray-700">|</span>
      <span className="flex items-center gap-1">
        <span className="text-gray-500">energy</span>
        <span className="font-mono font-medium text-gray-100">{formatEnergy(energyWh)}</span>
      </span>
    </div>
  )
}
