import clsx from 'clsx'
import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { clamp } from '@kpa/shared'

/**
 * Idle delay before a typed number is written to the server. Every commit runs
 * `refreshStatuses` over the whole graph and broadcasts a patch to every
 * console, so one keystroke per PATCH is not an option.
 */
const NUMBER_COMMIT_MS = 300
/** Slider drags coalesce faster: the value is already visible locally. */
const SLIDER_COMMIT_MS = 150

/* ------------------------------------------------------------- wrapper -- */

interface FieldShellProps {
  label: string
  hint?: string
  htmlFor?: string
  children: ReactNode
  className?: string
  inline?: boolean
  right?: ReactNode
}

function FieldShell({ label, hint, htmlFor, children, className, inline = false, right }: FieldShellProps) {
  return (
    <div className={clsx('kpa-field', inline && 'kpa-field--inline', className)}>
      <div className="kpa-field__head">
        <label className="kpa-field__label" htmlFor={htmlFor}>
          {label}
        </label>
        {right ? <span className="kpa-field__right kpa-mono">{right}</span> : null}
      </div>
      {children}
      {hint ? <p className="kpa-field__hint">{hint}</p> : null}
    </div>
  )
}

/* ----------------------------------------------------------- TextField -- */

export interface TextFieldProps {
  label: string
  value: string
  onChange(v: string): void
  mono?: boolean
  placeholder?: string
  disabled?: boolean
  hint?: string
  className?: string
}

export function TextField({
  label,
  value,
  onChange,
  mono = false,
  placeholder,
  disabled = false,
  hint,
  className,
}: TextFieldProps) {
  const id = useId()
  return (
    <FieldShell label={label} hint={hint} htmlFor={id} className={className}>
      <input
        id={id}
        className={clsx('kpa-input', mono && 'kpa-mono')}
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </FieldShell>
  )
}

/* --------------------------------------------------------- NumberField -- */

export interface NumberFieldProps {
  label: string
  value: number
  onChange(v: number): void
  min?: number
  max?: number
  step?: number
  suffix?: string
  hint?: string
  className?: string
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  hint,
  className,
}: NumberFieldProps) {
  const id = useId()
  const lo = min ?? Number.NEGATIVE_INFINITY
  const hi = max ?? Number.POSITIVE_INFINITY

  // Local draft so the field can be cleared and retyped without every
  // intermediate state being written to the server.
  const [draft, setDraft] = useState(() => String(Number.isFinite(value) ? value : (min ?? 0)))
  const dirty = useRef(false)
  const timer = useRef<number | null>(null)
  const commit = useRef(onChange)
  commit.current = onChange

  useEffect(() => {
    if (!dirty.current) setDraft(String(Number.isFinite(value) ? value : (min ?? 0)))
  }, [value, min])

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  const write = (raw: string) => {
    // An empty box is a user mid-edit, not a value: `Number('') === 0`, and 0
    // means "unlimited" for RPM and quota — committing it would silently flip
    // the semantics while they are still typing.
    const trimmed = raw.trim()
    if (trimmed === '') return
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) return
    dirty.current = false
    commit.current(clamp(parsed, lo, hi))
  }

  const schedule = (raw: string) => {
    setDraft(raw)
    dirty.current = true
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = null
      write(raw)
    }, NUMBER_COMMIT_MS)
  }

  const flush = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    if (draft.trim() === '') {
      // Restore the last committed value rather than leaving an empty box.
      dirty.current = false
      setDraft(String(Number.isFinite(value) ? value : (min ?? 0)))
      return
    }
    write(draft)
  }

  return (
    <FieldShell label={label} hint={hint} htmlFor={id} className={className}>
      <div className="kpa-input kpa-input--group">
        <input
          id={id}
          className="kpa-input__inner kpa-mono"
          type="number"
          value={draft}
          min={min}
          max={max}
          step={step}
          onChange={(e) => schedule(e.target.value)}
          onBlur={flush}
          onKeyDown={(e) => {
            if (e.key === 'Enter') flush()
          }}
        />
        {suffix ? <span className="kpa-input__suffix">{suffix}</span> : null}
      </div>
    </FieldShell>
  )
}

/* --------------------------------------------------------- SelectField -- */

export interface SelectFieldProps<T extends string> {
  label: string
  value: T
  onChange(v: T): void
  options: { value: T; label: string }[]
  hint?: string
  className?: string
}

export function SelectField<T extends string>({
  label,
  value,
  onChange,
  options,
  hint,
  className,
}: SelectFieldProps<T>) {
  const id = useId()
  return (
    <FieldShell label={label} hint={hint} htmlFor={id} className={className}>
      <div className="kpa-select">
        <select
          id={id}
          className="kpa-select__control"
          value={value}
          onChange={(e) => onChange(e.target.value as T)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown size={12} className="kpa-select__chevron" />
      </div>
    </FieldShell>
  )
}

/* --------------------------------------------------------- ToggleField -- */

export interface ToggleFieldProps {
  label: string
  value: boolean
  onChange(v: boolean): void
  hint?: string
  className?: string
}

export function ToggleField({ label, value, onChange, hint, className }: ToggleFieldProps) {
  const id = useId()
  return (
    <div className={clsx('kpa-field', 'kpa-field--toggle', className)}>
      <div className="kpa-field__head">
        <label className="kpa-field__label" htmlFor={id}>
          {label}
        </label>
        <button
          id={id}
          type="button"
          className="kpa-switch"
          role="switch"
          aria-checked={value}
          aria-label={label}
          onClick={() => onChange(!value)}
        >
          <span className="kpa-switch__knob" />
        </button>
      </div>
      {hint ? <p className="kpa-field__hint">{hint}</p> : null}
    </div>
  )
}

/* --------------------------------------------------------- SliderField -- */

export interface SliderFieldProps {
  label: string
  value: number
  onChange(v: number): void
  min: number
  max: number
  step?: number
  format?: (v: number) => string
  hint?: string
  className?: string
}

export function SliderField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  format,
  hint,
  className,
}: SliderFieldProps) {
  const id = useId()
  const settled = Number.isFinite(value) ? clamp(value, min, max) : min

  // Drag locally, write once the drag settles: a full-range drag at step 0.01
  // used to fire ~100 PATCHes, each one re-deriving the whole graph server-side
  // and broadcasting to every connected console.
  const [draft, setDraft] = useState(settled)
  const dragging = useRef(false)
  const timer = useRef<number | null>(null)
  const commit = useRef(onChange)
  commit.current = onChange

  useEffect(() => {
    if (!dragging.current) setDraft(settled)
  }, [settled])

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  const flush = (next: number) => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    dragging.current = false
    commit.current(next)
  }

  const safe = draft
  const ratio = max > min ? (safe - min) / (max - min) : 0

  return (
    <FieldShell
      label={label}
      hint={hint}
      htmlFor={id}
      className={clsx('kpa-field--slider', className)}
      right={format ? format(safe) : String(safe)}
    >
      <input
        id={id}
        className="kpa-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={safe}
        style={{ '--slider-ratio': `${ratio * 100}%` } as CSSProperties}
        onChange={(e) => {
          const parsed = Number(e.target.value)
          const next = Number.isFinite(parsed) ? clamp(parsed, min, max) : min
          setDraft(next)
          dragging.current = true
          if (timer.current !== null) window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => {
            timer.current = null
            dragging.current = false
            commit.current(next)
          }, SLIDER_COMMIT_MS)
        }}
        onPointerUp={() => flush(draft)}
        onKeyUp={() => flush(draft)}
        onBlur={() => flush(draft)}
      />
    </FieldShell>
  )
}
