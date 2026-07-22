import clsx from 'clsx'
import type { ReactNode } from 'react'
import { Inbox } from 'lucide-react'

export interface EmptyProps {
  icon?: ReactNode
  title: string
  hint?: string
  className?: string
}

/** Centred placeholder for empty panels and lists. */
export function Empty({ icon, title, hint, className }: EmptyProps) {
  return (
    <div className={clsx('kpa-empty', className)}>
      <div className="kpa-empty__icon">{icon ?? <Inbox size={18} />}</div>
      <div className="kpa-empty__title">{title}</div>
      {hint ? <div className="kpa-empty__hint">{hint}</div> : null}
    </div>
  )
}
