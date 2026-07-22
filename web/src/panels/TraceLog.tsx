import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, ChevronUp, Eraser, Inbox, Radio, RotateCw } from 'lucide-react'
import { formatClock, formatMs, formatNumber } from '@kpa/shared'
import type { EntityKind, RequestOutcome, RequestTrace } from '@kpa/shared'

import { Badge, Button, Empty, IconButton, Stat } from '@/components'
import { kindIcon, outcomeLabel, outcomeTone } from '@/lib/format'
import { useConsole } from '@/lib/store'
import { EventLog } from './EventLog'

const MAX_ROWS = 60

interface Crumb {
  kind: EntityKind
  name: string
  ok: boolean
}

/**
 * Crumbs come from the trace alone. `trace.path` is populated on every route,
 * so the id-resolving fallback only has to cover the degenerate case, and this
 * component no longer needs a map of every entity in the graph — which used to
 * be rebuilt for all 60 rows on every 100ms trace flush.
 */
function buildCrumbs(trace: RequestTrace): Crumb[] {
  if (trace.path.length > 0) {
    return trace.path.map((hop) => ({ kind: hop.kind, name: hop.name, ok: hop.ok }))
  }
  const crumbs: Crumb[] = [{ kind: 'key', name: trace.keyName, ok: trace.ok }]
  const tail: { kind: EntityKind; id: string | null }[] = [
    { kind: 'pool', id: trace.poolId },
    { kind: 'account', id: trace.accountId },
    { kind: 'proxy', id: trace.proxyId },
  ]
  for (const item of tail) {
    if (!item.id) continue
    crumbs.push({ kind: item.kind, name: item.id, ok: trace.ok })
  }
  return crumbs
}

const Crumbs = memo(function Crumbs({ crumbs }: { crumbs: Crumb[] }): JSX.Element {
  const last = crumbs.length - 1
  return (
    <span className="kpa-tl-crumbs">
      {crumbs.map((crumb, i) => (
        <span
          className="kpa-tl-crumb"
          data-kind={crumb.kind}
          data-ok={crumb.ok ? 'true' : 'false'}
          data-last={i === last ? 'true' : undefined}
          key={`${crumb.kind}-${i}`}
          title={crumb.name}
        >
          {i > 0 ? <i className="kpa-tl-arrow">›</i> : null}
          <span className="kpa-tl-crumb-name">{crumb.name}</span>
        </span>
      ))}
    </span>
  )
})

const TraceRow = memo(function TraceRow(props: {
  trace: RequestTrace
  active: boolean
  onSelect: (id: string) => void
}): JSX.Element {
  const { trace, active, onSelect } = props
  const tone = outcomeTone(trace.outcome)
  // Traces are immutable once created, so this is a one-time cost per row.
  const crumbs = useMemo(() => buildCrumbs(trace), [trace])
  return (
    <button
      type="button"
      className="kpa-tl-row"
      data-tone={tone}
      data-active={active ? 'true' : 'false'}
      onClick={() => onSelect(trace.id)}
      title={trace.message}
    >
      <time className="kpa-tl-time">{formatClock(trace.startedAt)}</time>
      <span className="kpa-tl-dot" data-tone={tone} />
      <Crumbs crumbs={crumbs} />
      <span className="kpa-tl-model">{trace.model}</span>
      <span className="kpa-tl-retry">
        {trace.retries > 0 ? (
          <>
            <RotateCw size={9} />
            {trace.retries}
          </>
        ) : null}
      </span>
      <span className="kpa-tl-tokens">{formatNumber(trace.tokensIn + trace.tokensOut)}</span>
      <span className="kpa-tl-latency">{formatMs(trace.durationMs)}</span>
    </button>
  )
})

function TraceDetail({
  trace,
  fallback,
}: {
  trace: RequestTrace | undefined
  fallback: boolean
}): JSX.Element {
  if (!trace) {
    return (
      <Empty
        icon={<Inbox size={20} />}
        title="未选中请求"
        hint="点击左侧任意一条请求，查看它在链路上的完整轨迹。"
      />
    )
  }
  const tone = outcomeTone(trace.outcome)
  return (
    <div className="kpa-tl-detail-body">
      {fallback ? (
        <div className="kpa-tl-detail-hint">最近一次失败的链路（点击左侧任意请求可切换）</div>
      ) : null}
      <div className="kpa-tl-detail-head">
        <Badge tone={tone}>{outcomeLabel(trace.outcome)}</Badge>
        <Badge tone="neutral" mono>
          HTTP {trace.statusCode}
        </Badge>
        <Badge tone="info" mono>
          {trace.model}
        </Badge>
        <span className="kpa-tl-detail-time">{formatClock(trace.startedAt)}</span>
      </div>
      <p className="kpa-tl-detail-msg" data-tone={tone}>
        {trace.message}
      </p>
      <div className="kpa-tl-detail-stats">
        <Stat label="耗时" value={formatMs(trace.durationMs)} />
        <Stat label="输入" value={formatNumber(trace.tokensIn)} unit="tok" />
        <Stat label="输出" value={formatNumber(trace.tokensOut)} unit="tok" />
        <Stat label="重试" value={trace.retries} tone={trace.retries > 0 ? 'warn' : 'default'} />
      </div>

      <div className="kpa-tl-caption">链路轨迹</div>
      <ol className="kpa-tl-timeline">
        {trace.path.map((hop, i) => {
          const Icon = kindIcon(hop.kind)
          return (
            <li
              className="kpa-tl-hop"
              data-kind={hop.kind}
              data-ok={hop.ok ? 'true' : 'false'}
              key={`${hop.id}-${i}`}
            >
              <span className="kpa-tl-hop-mark">
                <Icon size={11} />
              </span>
              <span className="kpa-tl-hop-body">
                <span className="kpa-tl-hop-name">{hop.name}</span>
                <span className="kpa-tl-hop-reason">{hop.reason}</span>
              </span>
              <span className="kpa-tl-hop-latency">{formatMs(hop.latencyMs)}</span>
            </li>
          )
        })}
      </ol>

      {/* The interesting failover case — failed on A, succeeded on B — has
          exactly one recorded failure plus the winning attempt, so gating on
          `> 1` hid it precisely when it mattered. */}
      {trace.attempts.length > 0 ? (
        <>
          <div className="kpa-tl-caption">尝试记录</div>
          <ol className="kpa-tl-attempts">
            {trace.attempts.map((attempt, i) => {
              const aTone = outcomeTone(attempt.outcome)
              return (
                <li className="kpa-tl-attempt" data-tone={aTone} key={`${attempt.accountId}-${i}`}>
                  <span className="kpa-tl-attempt-idx">#{i + 1}</span>
                  <span className="kpa-tl-attempt-name">{attempt.accountName}</span>
                  <span className="kpa-tl-attempt-outcome">{outcomeLabel(attempt.outcome)}</span>
                  <span className="kpa-tl-attempt-latency">{formatMs(attempt.latencyMs)}</span>
                </li>
              )
            })}
          </ol>
        </>
      ) : null}
    </div>
  )
}

export function TraceLog(): JSX.Element {
  const traces = useConsole((s) => s.traces)
  const activeTraceId = useConsole((s) => s.activeTraceId)
  const setActiveTrace = useConsole((s) => s.setActiveTrace)
  const collapsed = useConsole((s) => s.logCollapsed)
  const toggleLog = useConsole((s) => s.toggleLog)
  const outcomes = useConsole((s) => s.stats.outcomes)

  const [clearedAt, setClearedAt] = useState(0)
  const [pinned, setPinned] = useState(true)
  const listRef = useRef<HTMLDivElement | null>(null)

  const visible = useMemo(
    () => traces.filter((t) => t.startedAt > clearedAt).slice(0, MAX_ROWS),
    [clearedAt, traces],
  )

  const active = useMemo(
    () => (activeTraceId ? traces.find((t) => t.id === activeTraceId) : undefined),
    [activeTraceId, traces],
  )

  // Nothing selected: show the most recent failure rather than an empty pane —
  // that is what an operator would have gone looking for anyway.
  const lastFailure = useMemo(() => traces.find((t) => !t.ok), [traces])
  const shown = active ?? lastFailure

  const topId = visible.length > 0 ? visible[0].id : ''

  useEffect(() => {
    if (!pinned || collapsed) return
    const el = listRef.current
    if (el) el.scrollTop = 0
  }, [collapsed, pinned, topId])

  const onScroll = useCallback(() => {
    const el = listRef.current
    if (!el) return
    setPinned(el.scrollTop <= 8)
  }, [])

  const backToLatest = useCallback(() => {
    const el = listRef.current
    if (el) el.scrollTop = 0
    setPinned(true)
  }, [])

  const onClear = useCallback(() => {
    setClearedAt(Date.now())
    setActiveTrace(null)
  }, [setActiveTrace])

  const tallies = useMemo<[string, number][]>(() => {
    const entries: [string, number][] = Object.keys(outcomes).map((key) => [key, outcomes[key] ?? 0])
    return entries
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
  }, [outcomes])

  return (
    <section className="kpa-tracelog" data-collapsed={collapsed ? 'true' : 'false'}>
      <header className="kpa-tl-head">
        <span className="kpa-tl-title">
          <Radio size={12} />
          实时请求流
        </span>
        <span className="kpa-tl-tallies">
          {tallies.map(([outcome, count]) => (
            <Badge key={outcome} tone={outcomeTone(outcome as RequestOutcome)} mono>
              {outcomeLabel(outcome as RequestOutcome)} {formatNumber(count)}
            </Badge>
          ))}
        </span>
        <span className="kpa-tl-head-actions">
          <span className="kpa-tl-count">{visible.length} 条</span>
          <Button variant="ghost" size="sm" icon={<Eraser size={12} />} onClick={onClear}>
            清空
          </Button>
          <IconButton
            icon={collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            label={collapsed ? '展开请求流 (L)' : '收起请求流 (L)'}
            onClick={toggleLog}
            size="sm"
          />
        </span>
      </header>

      {collapsed ? null : (
        <div className="kpa-tl-body">
          <div className="kpa-tl-listwrap">
            <div className="kpa-tl-list kpa-scroll" ref={listRef} onScroll={onScroll}>
              {visible.length === 0 ? (
                <Empty
                  icon={<Inbox size={20} />}
                  title="还没有请求"
                  hint="打开模拟器或点击「注入请求」即可看到流量。"
                />
              ) : (
                visible.map((trace) => (
                  <TraceRow
                    key={trace.id}
                    trace={trace}
                    active={trace.id === activeTraceId}
                    onSelect={setActiveTrace}
                  />
                ))
              )}
            </div>
            {!pinned ? (
              <button type="button" className="kpa-tl-resume" onClick={backToLatest}>
                <ArrowUp size={11} />
                回到最新
              </button>
            ) : null}
          </div>
          <div className="kpa-tl-detail kpa-scroll">
            <TraceDetail trace={shown} fallback={!active && Boolean(shown)} />
          </div>
          <EventLog />
        </div>
      )}
    </section>
  )
}
