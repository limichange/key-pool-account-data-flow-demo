/**
 * Operator event log.
 *
 * The store has always collected two kinds of narrative the console never
 * showed: every failed mutation (`fail(...)`) and every `log` event the
 * simulator emits (circuit breaker trips, quota exhaustion, proxy health
 * checks, spill-over). Without a surface for them a rejected bind looks like
 * "nothing happened" and the whole failure story is only inferable from node
 * colours. This renders them, and pops errors as transient toasts.
 */
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Info, ScrollText, TriangleAlert } from 'lucide-react'

import { formatClock } from '@kpa/shared'
import { useConsole, type LogLine } from '@/lib/store'

const VISIBLE_LOGS = 40
const TOAST_MS = 6000
const MAX_TOASTS = 3

function LevelIcon({ level }: { level: LogLine['level'] }): JSX.Element {
  if (level === 'error') return <AlertTriangle size={10} />
  if (level === 'warn') return <TriangleAlert size={10} />
  return <Info size={10} />
}

export function EventLog(): JSX.Element {
  const logs = useConsole((s) => s.logs)
  const visible = logs.slice(0, VISIBLE_LOGS)

  return (
    <section className="kpa-events" aria-label="事件日志">
      <header className="kpa-events__head">
        <ScrollText size={11} />
        事件日志
        <span className="kpa-events__count">{logs.length}</span>
      </header>
      <div className="kpa-events__list kpa-scroll">
        {visible.length === 0 ? (
          <p className="kpa-events__empty">暂无事件。熔断、配额耗尽、代理摘除与操作失败都会记录在这里。</p>
        ) : (
          visible.map((line) => (
            <div className="kpa-events__row" data-level={line.level} key={line.id}>
              <span className="kpa-events__icon">
                <LevelIcon level={line.level} />
              </span>
              <span className="kpa-events__msg" title={line.message}>
                {line.message}
              </span>
              <time className="kpa-events__time">{formatClock(line.at)}</time>
            </div>
          ))
        )}
      </div>
    </section>
  )
}

/** Errors must not wait for the operator to look at the log panel. */
export function LogToasts(): JSX.Element | null {
  const logs = useConsole((s) => s.logs)
  const [toasts, setToasts] = useState<LogLine[]>([])
  const seen = useRef<string | null>(logs.length > 0 ? logs[0].id : null)

  useEffect(() => {
    const newest = logs.length > 0 ? logs[0].id : null
    if (newest === seen.current) return
    const fresh: LogLine[] = []
    for (const line of logs) {
      if (line.id === seen.current) break
      if (line.level === 'error') fresh.push(line)
    }
    seen.current = newest
    if (fresh.length === 0) return
    setToasts((prev) => [...fresh.reverse(), ...prev].slice(0, MAX_TOASTS))
  }, [logs])

  useEffect(() => {
    if (toasts.length === 0) return
    const timer = window.setTimeout(() => setToasts((prev) => prev.slice(0, -1)), TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [toasts])

  if (toasts.length === 0) return null

  return (
    <div className="kpa-toasts" role="status" aria-live="polite">
      {toasts.map((line) => (
        <div className="kpa-toast" key={line.id}>
          <AlertTriangle size={13} />
          <span className="kpa-toast__msg">{line.message}</span>
        </div>
      ))}
    </div>
  )
}
