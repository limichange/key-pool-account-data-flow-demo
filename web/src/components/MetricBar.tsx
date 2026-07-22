import clsx from 'clsx'
import type { CSSProperties, ReactNode } from 'react'
import { clamp, percent } from '@kpa/shared'

export type MetricBarTone = 'accent' | 'ok' | 'warn' | 'danger' | 'auto'

export interface MetricBarProps {
  value: number
  max: number
  label?: ReactNode
  right?: ReactNode
  tone?: MetricBarTone
  height?: number
  showPct?: boolean
  className?: string
}

function resolveTone(tone: MetricBarTone, pct: number): Exclude<MetricBarTone, 'auto'> {
  if (tone !== 'auto') return tone
  if (pct > 90) return 'danger'
  if (pct > 70) return 'warn'
  return 'ok'
}

/** Label row plus a rounded track with an animated filled bar. */
export function MetricBar({
  value,
  max,
  label,
  right,
  tone = 'accent',
  height = 4,
  showPct = false,
  className,
}: MetricBarProps) {
  const pct = percent(value, max)
  const resolved = resolveTone(tone, pct)
  const hasHeader = label !== undefined || right !== undefined || showPct

  return (
    <div className={clsx('kpa-metricbar', className)} data-tone={resolved}>
      {hasHeader ? (
        <div className="kpa-metricbar__head">
          <span className="kpa-metricbar__label kpa-truncate">{label}</span>
          <span className="kpa-metricbar__right kpa-mono">
            {right}
            {showPct ? <span className="kpa-metricbar__pct">{Math.round(pct)}%</span> : null}
          </span>
        </div>
      ) : null}
      <div
        className="kpa-metricbar__track"
        style={{ '--bar-height': `${clamp(height, 2, 24)}px` } as CSSProperties}
      >
        <div className="kpa-metricbar__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
