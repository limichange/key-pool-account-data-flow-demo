import clsx from 'clsx'
import type { ReactNode } from 'react'

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info'

export interface BadgeProps {
  children: ReactNode
  tone?: BadgeTone
  icon?: ReactNode
  mono?: boolean
  title?: string
  className?: string
}

/** Compact pill label. Tone "accent" inherits --accent from the nearest data-kind wrapper. */
export function Badge({ children, tone = 'neutral', icon, mono = false, title, className }: BadgeProps) {
  return (
    <span
      className={clsx('kpa-badge', mono && 'kpa-badge--mono', className)}
      data-tone={tone}
      title={title}
    >
      {icon ? <span className="kpa-badge__icon">{icon}</span> : null}
      <span className="kpa-badge__label">{children}</span>
    </span>
  )
}
