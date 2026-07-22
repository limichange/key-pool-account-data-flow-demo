import clsx from 'clsx'
import type { ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'ghost' | 'subtle' | 'danger'

export interface ButtonProps {
  children: ReactNode
  onClick?: () => void
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  icon?: ReactNode
  disabled?: boolean
  title?: string
  full?: boolean
  type?: 'button' | 'submit'
  className?: string
}

export function Button({
  children,
  onClick,
  variant = 'subtle',
  size = 'sm',
  icon,
  disabled = false,
  title,
  full = false,
  type = 'button',
  className,
}: ButtonProps) {
  return (
    <button
      type={type}
      className={clsx('kpa-btn', full && 'kpa-btn--full', className)}
      data-variant={variant}
      data-size={size}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon ? <span className="kpa-btn__icon">{icon}</span> : null}
      <span className="kpa-btn__label kpa-truncate">{children}</span>
    </button>
  )
}
