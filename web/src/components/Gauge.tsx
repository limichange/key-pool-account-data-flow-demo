import clsx from 'clsx'
import type { ReactNode } from 'react'
import { percent } from '@kpa/shared'

export type GaugeTone = 'accent' | 'ok' | 'warn' | 'danger' | 'auto'

export interface GaugeProps {
  value: number
  max: number
  label?: string
  size?: number
  tone?: GaugeTone
  /**
   * What the centre of the gauge reads. `value / max` only ever drives the arc
   * geometry: a gauge labelled 延迟 must print a latency, not a ratio.
   * Defaults to the fill percentage for genuinely unitless gauges.
   */
  display?: ReactNode
  className?: string
}

const START_DEG = 135
const SWEEP_DEG = 270

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

function resolveTone(tone: GaugeTone, pct: number): Exclude<GaugeTone, 'auto'> {
  if (tone !== 'auto') return tone
  if (pct > 90) return 'danger'
  if (pct > 70) return 'warn'
  return 'ok'
}

/** 270-degree circular arc gauge with a centred value readout. */
export function Gauge({
  value,
  max,
  label,
  size = 64,
  tone = 'accent',
  display,
  className,
}: GaugeProps) {
  const pct = percent(value, max)
  const resolved = resolveTone(tone, pct)

  const stroke = Math.max(3, Math.round(size * 0.09))
  const c = size / 2
  const r = c - stroke
  const start = polar(c, c, r, START_DEG)
  const end = polar(c, c, r, START_DEG + SWEEP_DEG)
  const d = `M${start.x.toFixed(2)} ${start.y.toFixed(2)} A${r} ${r} 0 1 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`
  const arcLength = 2 * Math.PI * r * (SWEEP_DEG / 360)

  return (
    <div className={clsx('kpa-gauge', className)} data-tone={resolved} style={{ width: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label ?? '仪表'}>
        <path className="kpa-gauge__track" d={d} strokeWidth={stroke} />
        <path
          className="kpa-gauge__value"
          d={d}
          strokeWidth={stroke}
          strokeDasharray={arcLength}
          strokeDashoffset={arcLength * (1 - pct / 100)}
        />
      </svg>
      <div className="kpa-gauge__center">
        <span className="kpa-gauge__pct kpa-mono">{display ?? Math.round(pct)}</span>
        {label ? <span className="kpa-gauge__label kpa-truncate">{label}</span> : null}
      </div>
    </div>
  )
}
