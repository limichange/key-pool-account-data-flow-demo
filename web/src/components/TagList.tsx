import clsx from 'clsx'
import { useState } from 'react'
import { Plus, X } from 'lucide-react'

export interface TagListProps {
  tags: string[]
  onRemove?: (t: string) => void
  onAdd?: (t: string) => void
  max?: number
  className?: string
}

/** Row of small pills with optional inline add input and per-tag remove affordance. */
export function TagList({ tags, onRemove, onAdd, max, className }: TagListProps) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  const visible = max !== undefined ? tags.slice(0, max) : tags
  const overflow = tags.length - visible.length

  const submit = () => {
    const value = draft.trim()
    if (value && onAdd) onAdd(value)
    setDraft('')
    setAdding(false)
  }

  return (
    <div className={clsx('kpa-taglist', className)}>
      {visible.map((tag) => (
        <span key={tag} className="kpa-tag">
          <span className="kpa-tag__label kpa-truncate">{tag}</span>
          {onRemove ? (
            <button
              type="button"
              className="kpa-tag__remove"
              aria-label={`移除 ${tag}`}
              title={`移除 ${tag}`}
              onClick={() => onRemove(tag)}
            >
              <X size={9} />
            </button>
          ) : null}
        </span>
      ))}

      {overflow > 0 ? <span className="kpa-tag kpa-tag--more">+{overflow}</span> : null}

      {onAdd ? (
        adding ? (
          <input
            className="kpa-tag__input kpa-mono"
            autoFocus
            value={draft}
            placeholder="标签…"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={submit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') {
                setDraft('')
                setAdding(false)
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="kpa-tag kpa-tag--add"
            aria-label="添加标签"
            title="添加标签"
            onClick={() => setAdding(true)}
          >
            <Plus size={10} />
          </button>
        )
      ) : null}
    </div>
  )
}
