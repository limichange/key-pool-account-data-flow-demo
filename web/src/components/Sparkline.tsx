import clsx from 'clsx'
import { useId } from 'react'

export type SparklineTone = 'accent' | 'ok' | 'warn' | 'danger'

export interface SparklineProps {
  data: number[]
  width?: number
  height?: number
  tone?: SparklineTone
  fill?: boolean
  className?: string
}

const VIEW_W = 100
const VIEW_H = 32

/**
 * Inline SVG sparkline drawn in a normalised 100x32 viewBox and stretched to the
 * requested pixel size with preserveAspectRatio="none".
 */
export function Sparkline({
  data,
  width = 120,
  height = 28,
  tone = 'accent',
  fill = true,
  className,
}: SparklineProps) {
  // useId() contains colons, which are illegal inside an SVG url(#...) reference.
  const gradientId = `spark${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const points = data.filter((n) => Number.isFinite(n))
  const count = points.length

  let max = Number.NEGATIVE_INFINITY
  let min = Number.POSITIVE_INFINITY
  for (const value of points) {
    if (value > max) max = value
    if (value < min) min = value
  }
  // Anchor to zero when the series is non-negative so magnitude stays readable.
  if (count > 0 && min > 0) min = 0
  const flat = !(max > min)
  const span = flat ? 1 : max - min

  const toX = (index: number) => (count <= 1 ? VIEW_W / 2 : (index / (count - 1)) * VIEW_W)
  const toY = (value: number) =>
    flat ? VIEW_H / 2 : VIEW_H - ((value - min) / span) * (VIEW_H - 2) - 1

  const coords = points.map((value, index) => ({ x: toX(index), y: toY(value) }))
  const line = coords.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ')
  const area =
    coords.length > 0
      ? `${line} L${coords[coords.length - 1].x.toFixed(2)} ${VIEW_H} L${coords[0].x.toFixed(2)} ${VIEW_H} Z`
      : ''
  const last = coords[coords.length - 1]

  return (
    <svg
      className={clsx('kpa-sparkline', className)}
      data-tone={tone}
      width={width}
      height={height}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="none"
      role="img"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="kpa-sparkline__stop-a" />
          <stop offset="100%" className="kpa-sparkline__stop-b" />
        </linearGradient>
      </defs>
      <line className="kpa-sparkline__baseline" x1="0" y1={VIEW_H - 1} x2={VIEW_W} y2={VIEW_H - 1} />
      {fill && area ? <path className="kpa-sparkline__area" d={area} fill={`url(#${gradientId})`} /> : null}
      {line ? <path className="kpa-sparkline__line" d={line} /> : null}
      {last ? <circle className="kpa-sparkline__dot" cx={last.x} cy={last.y} r="1.6" /> : null}
    </svg>
  )
}
