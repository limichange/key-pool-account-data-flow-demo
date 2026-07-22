import clsx from 'clsx'
import type { CSSProperties } from 'react'
import type { HealthStatus } from '@kpa/shared'

export interface StatusDotProps {
  status: HealthStatus
  size?: number
  pulse?: boolean
  title?: string
  className?: string
}

/**
 * Redundant encoding of health: colour *and* shape.
 *  - `solid`  nothing to report (healthy) / parked (disabled)
 *  - `ring`   needs attention but still serving (degraded, throttled, cooldown)
 *  - `alert`  filled core plus a halo ring: not serving (exhausted, offline)
 *
 * The shape survives at 12px and for viewers who cannot separate the hues.
 */
export type StatusShape = 'solid' | 'ring' | 'alert'

const STATUS_SHAPE: Record<HealthStatus, StatusShape> = {
  healthy: 'solid',
  degraded: 'ring',
  throttled: 'ring',
  cooldown: 'ring',
  exhausted: 'alert',
  offline: 'alert',
  disabled: 'solid',
}

export function StatusDot({ status, size = 8, pulse = false, title, className }: StatusDotProps) {
  const shape = STATUS_SHAPE[status] ?? 'solid'
  // A quiet "all good" marker must not pulse: motion is reserved for trouble.
  const animated = pulse && shape !== 'solid'
  return (
    <span
      className={clsx('kpa-status-dot', animated && 'kpa-status-dot--pulse', className)}
      data-status={status}
      data-shape={shape}
      title={title}
      style={{ '--dot-size': `${size}px` } as CSSProperties}
    >
      <span className="kpa-status-dot__core" />
      {animated ? <span className="kpa-status-dot__halo kpa-pulse" /> : null}
    </span>
  )
}
