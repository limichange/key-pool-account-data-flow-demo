import clsx from 'clsx'
import type { SyntheticEvent } from 'react'

export interface SwitchProps {
  checked: boolean
  onChange(next: boolean): void
  /** Accessible name; also doubles as the tooltip. */
  label: string
  size?: 'sm' | 'md'
  disabled?: boolean
  className?: string
}

/**
 * Tiny standalone switch for dense surfaces (node card headers). Same visual
 * language as `ToggleField` but without the label row, sized for a 12px header
 * and safe inside a React Flow node (`nodrag nopan` + stopPropagation so a
 * toggle never starts a drag or changes the selection).
 */
export function Switch({
  checked,
  onChange,
  label,
  size = 'sm',
  disabled = false,
  className,
}: SwitchProps): JSX.Element {
  const stop = (e: SyntheticEvent): void => {
    e.stopPropagation()
  }
  return (
    <button
      type="button"
      className={clsx('kpa-switch', size === 'sm' && 'kpa-switch--sm', 'nodrag', 'nopan', className)}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
      onPointerDown={stop}
      onMouseDown={stop}
      onDoubleClick={stop}
    >
      <span className="kpa-switch__knob" />
    </button>
  )
}
