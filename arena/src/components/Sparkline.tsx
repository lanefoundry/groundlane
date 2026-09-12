interface SparklineProps {
  data: number[]
  width?: number
  height?: number
  color?: string
}

export function Sparkline({ data, width = 80, height = 24, color = 'var(--accent)' }: SparklineProps) {
  if (data.length === 0) return null

  const padding = 3
  const drawW = width - padding * 2
  const drawH = height - padding * 2

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min

  const points = data.map((v, i) => {
    const x = padding + (data.length === 1 ? drawW / 2 : (i / (data.length - 1)) * drawW)
    const y = range === 0
      ? padding + drawH / 2
      : padding + drawH - ((v - min) / range) * drawH
    return { x, y }
  })

  const polyline = points.map((p) => `${p.x},${p.y}`).join(' ')
  const last = points[points.length - 1]!

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      style={{ display: 'block' }}
    >
      <polyline
        points={polyline}
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <circle cx={last.x} cy={last.y} r={2.5} fill={color} />
    </svg>
  )
}
