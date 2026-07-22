import clsx from 'clsx'
import type { ReactNode } from 'react'

export interface StatProps {
  label: ReactNode
  value: ReactNode
  unit?: string
  tone?: 'default' | 'ok' | 'warn' | 'danger'
  align?: 'left' | 'right'
  className?: string
}

/** Compact label-over-value readout; the value renders in the mono face. */
export function Stat({ label, value, unit, tone = 'default', align = 'left', className }: StatProps) {
  return (
    <div className={clsx('kpa-stat', className)} data-tone={tone} data-align={align}>
      <div className="kpa-stat__label kpa-caption kpa-truncate">{label}</div>
      <div className="kpa-stat__value kpa-mono">
        {value}
        {unit ? <span className="kpa-stat__unit">{unit}</span> : null}
      </div>
    </div>
  )
}
