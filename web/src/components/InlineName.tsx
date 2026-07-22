import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, SyntheticEvent } from 'react'
import { Pencil } from 'lucide-react'

export interface InlineNameProps {
  value: string
  onCommit(v: string): void
  className?: string
}

/**
 * Double-click-to-rename control used as the title of every node card.
 *
 * Display mode renders the name with a faint pencil affordance on hover;
 * double-click swaps in an input. Enter or blur commits, Escape cancels, and
 * empty / whitespace-only drafts revert to the previous name.
 *
 * Every interactive event stops propagation so React Flow never starts a node
 * drag, changes the selection or fires canvas shortcuts while renaming; the
 * `nodrag nopan` classes are the ones React Flow expects on interactive
 * content inside a node.
 */
export function InlineName({ value, onCommit, className }: InlineNameProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // Set when Enter/Escape already resolved the edit, so the input's blur
  // (which fires right after) must not commit a second time.
  const settled = useRef(false)

  useEffect(() => {
    if (!editing) return
    const input = inputRef.current
    if (input) {
      input.focus()
      input.select()
    }
  }, [editing])

  const stop = (e: SyntheticEvent): void => {
    e.stopPropagation()
  }

  const startEdit = (e: SyntheticEvent): void => {
    e.stopPropagation()
    settled.current = false
    setDraft(value)
    setEditing(true)
  }

  const commit = (): void => {
    setEditing(false)
    const next = draft.trim()
    // Empty or whitespace-only names are rejected: revert to the previous name.
    if (next.length === 0 || next === value) return
    onCommit(next)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    // Never let Delete/Backspace/shortcut keys reach React Flow or the app.
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      settled.current = true
      commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      settled.current = true
      setEditing(false)
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={clsx('kpa-inline-name__input', 'nodrag', 'nopan', className)}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (settled.current) return
          commit()
        }}
        onPointerDown={stop}
        onMouseDown={stop}
        onClick={stop}
        onDoubleClick={stop}
        aria-label="重命名"
        spellCheck={false}
      />
    )
  }

  return (
    <span
      className={clsx('kpa-inline-name', className)}
      onDoubleClick={startEdit}
      title={`${value}（双击重命名）`}
    >
      <span className="kpa-inline-name__text">{value}</span>
      <Pencil size={10} className="kpa-inline-name__pencil" aria-hidden="true" />
    </span>
  )
}
