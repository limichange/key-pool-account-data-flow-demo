import { useEffect, useId, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  body: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'danger' | 'default'
  onConfirm(): void
  onCancel(): void
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * Blocking confirmation dialog rendered through a portal into document.body.
 *
 * Behaviour contract (feature 6):
 *  - Escape and a backdrop click cancel; Enter confirms.
 *  - Focus moves to the cancel button on open and is restored on close.
 *  - Tab focus is trapped while open.
 *  - aria-modal with a labelled title.
 *  - Confirming is the only path that runs the destructive action.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element | null {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)

  // Focus the cancel button on open; restore the previous focus on close.
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelRef.current?.focus()
    return () => {
      previous?.focus?.()
    }
  }, [open])

  if (!open) return null

  const onBackdropMouseDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) onCancel()
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    // The dialog is modal: nothing may leak to canvas or app shortcuts.
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      onConfirm()
      return
    }
    if (e.key === 'Tab') {
      const root = dialogRef.current
      if (!root) return
      const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !el.hasAttribute('disabled'),
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last || !root.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  return createPortal(
    <div className="kpa-dialog-backdrop" onMouseDown={onBackdropMouseDown} onKeyDown={onKeyDown}>
      <div
        ref={dialogRef}
        className="kpa-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-tone={tone}
      >
        <h2 id={titleId} className="kpa-dialog__title">
          {title}
        </h2>
        <div className="kpa-dialog__body">{body}</div>
        <div className="kpa-dialog__actions">
          <button
            ref={cancelRef}
            type="button"
            className="kpa-btn"
            data-variant="subtle"
            data-size="sm"
            onClick={onCancel}
          >
            <span className="kpa-btn__label">{cancelLabel}</span>
          </button>
          <button
            type="button"
            className="kpa-btn"
            data-variant={tone === 'danger' ? 'danger' : 'primary'}
            data-size="sm"
            onClick={onConfirm}
          >
            <span className="kpa-btn__label">{confirmLabel}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
