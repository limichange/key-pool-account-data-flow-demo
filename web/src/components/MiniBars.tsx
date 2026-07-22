import clsx from 'clsx'

export type MiniBarsTone = 'accent' | 'ok' | 'warn' | 'danger'

export interface MiniBarsProps {
  data: number[]
  width?: number
  height?: number
  tone?: MiniBarsTone
  className?: string
}

/**
 * Micro bar chart used inside edge chips and inspector relation rows.
 *
 * Pure and dumb by design: bars are normalised to the max bucket, every bar
 * keeps a >= 1px baseline so an idle-but-alive series still reads as alive,
 * and the newest (right-most) bar renders brighter. Handles empty, all-zero
 * and constant series without ever producing NaN geometry.
 */
export function MiniBars({
  data,
  width = 38,
  height = 14,
  tone = 'accent',
  className,
}: MiniBarsProps): JSX.Element {
  const values = data.map((v) => (Number.isFinite(v) && v > 0 ? v : 0))
  const count = values.length

  let max = 0
  for (const v of values) if (v > max) max = v

  const gap = count > 1 ? 1 : 0
  const barW = count > 0 ? Math.max(1, (width - gap * (count - 1)) / count) : 0

  return (
    <svg
      className={clsx('kpa-minibars', className)}
      data-tone={tone}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      role="img"
      aria-hidden="true"
    >
      {values.map((v, i) => {
        const h = max > 0 ? Math.max(1, (v / max) * (height - 1)) : 1
        return (
          <rect
            key={i}
            className={clsx('kpa-minibars__bar', i === count - 1 && 'kpa-minibars__bar--newest')}
            x={i * (barW + gap)}
            y={height - h}
            width={barW}
            height={h}
          />
        )
      })}
    </svg>
  )
}
