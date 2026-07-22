import clsx from 'clsx'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

export interface SectionProps {
  title: ReactNode
  children: ReactNode
  action?: ReactNode
  dense?: boolean
  collapsible?: boolean
  defaultOpen?: boolean
  className?: string
  /** `hide` drops the whole section (wrapper included) in the icon rail. */
  rail?: 'hide'
}

/** Card section with a tiny uppercase caption, optional action slot and collapse chevron. */
export function Section({
  title,
  children,
  action,
  dense = false,
  collapsible = false,
  defaultOpen = true,
  className,
  rail,
}: SectionProps) {
  const [open, setOpen] = useState(defaultOpen)
  const isOpen = collapsible ? open : true

  return (
    <section
      className={clsx('kpa-section', dense && 'kpa-section--dense', className)}
      data-open={isOpen}
      data-rail={rail}
    >
      <header className="kpa-section__head">
        {collapsible ? (
          <button
            type="button"
            className="kpa-section__toggle"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={isOpen}
          >
            <ChevronDown size={12} className="kpa-section__chevron" />
            <span className="kpa-caption kpa-truncate">{title}</span>
          </button>
        ) : (
          <span className="kpa-section__title kpa-caption kpa-truncate">{title}</span>
        )}
        {action ? <div className="kpa-section__action">{action}</div> : null}
      </header>
      {isOpen ? <div className="kpa-section__body">{children}</div> : null}
    </section>
  )
}
