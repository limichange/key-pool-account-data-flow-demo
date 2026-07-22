import clsx from 'clsx'
import type { ReactNode } from 'react'

export interface IconButtonProps {
  icon: ReactNode
  label: string
  onClick?: () => void
  active?: boolean
  tone?: 'neutral' | 'danger' | 'accent'
  disabled?: boolean
  size?: 'sm' | 'md'
  className?: string
}

/** Square icon-only button. `label` doubles as the tooltip and the accessible name. */
export function IconButton({
  icon,
  label,
  onClick,
  active = false,
  tone = 'neutral',
  disabled = false,
  size = 'sm',
  className,
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={clsx('kpa-iconbtn', className)}
      data-tone={tone}
      data-size={size}
      data-active={active}
      aria-pressed={active}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
    </button>
  )
}
