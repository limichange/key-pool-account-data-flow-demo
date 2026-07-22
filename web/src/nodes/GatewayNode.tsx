import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import type { NodeProps } from '@xyflow/react'
import { Handle, Position, useStore } from '@xyflow/react'
import clsx from 'clsx'
import { Check, Copy, Power, Router } from 'lucide-react'
import {
  COMPACT_ZOOM,
  LAYOUT,
  edgeId,
  formatMs,
  formatNumber,
  type GatewayEntity,
  type RequestOutcome,
  type TimelinePoint,
} from '@kpa/shared'

import { Badge, InlineName, StatusDot, Stat, Switch } from '@/components'
import type { KpaNode } from '@/lib/graph'
import { outcomeLabel, outcomeTone, statusLabel } from '@/lib/format'
import { useConsole, useEdgeMetrics } from '@/lib/store'

/**
 * The gateway is the singleton entry in front of every key — the graph
 * read-out of TOTAL traffic — so its card is a summary, not a fifth peer:
 * platinum chrome, a four-colour gradient accent bar instead of a fifth hue,
 * and the only card with a real area chart.
 */

const TOP_KEYS = 4
const TOP_OUTCOMES = 3

/* -------------------------------------------------------- timeline chart -- */

interface TimelineChartProps {
  points: TimelinePoint[]
  width: number
  height: number
}

/** Wide area chart of the global timeline: total requests filled, errors overlaid. */
function TimelineChart({ points, width, height }: TimelineChartProps): JSX.Element {
  const { totalArea, errArea } = useMemo(() => {
    const count = points.length
    if (count === 0) return { totalArea: '', errArea: '' }
    let max = 1
    for (const p of points) max = Math.max(max, p.ok + p.err)
    const toX = (i: number) => (count <= 1 ? width / 2 : (i / (count - 1)) * width)
    const toY = (v: number) => height - (v / max) * (height - 2) - 1
    const area = (value: (p: TimelinePoint) => number): string => {
      const line = points
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)} ${toY(value(p)).toFixed(1)}`)
        .join(' ')
      return `${line} L${width} ${height} L0 ${height} Z`
    }
    return { totalArea: area((p) => p.ok + p.err), errArea: area((p) => p.err) }
  }, [points, width, height])

  return (
    <svg
      className="kpa-gw-chart"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-hidden="true"
    >
      <line className="kpa-gw-chart__baseline" x1="0" y1={height - 1} x2={width} y2={height - 1} />
      {totalArea ? <path className="kpa-gw-chart__total" d={totalArea} /> : null}
      {errArea ? <path className="kpa-gw-chart__err" d={errArea} /> : null}
    </svg>
  )
}

/* -------------------------------------------------------- key share rows -- */

function KeyShareRow(props: {
  gatewayId: string
  keyId: string
  name: string
  share: number
}): JSX.Element {
  const { gatewayId, keyId, name, share } = props
  // Per-edge metrics for the gateway->key edge this row describes.
  const metrics = useEdgeMetrics(edgeId(gatewayId, keyId))
  const requests = metrics?.requests ?? 0
  return (
    <div className="kpa-gw-share-row" title={`${name} · ${formatNumber(requests)} 请求`}>
      <span className="kpa-gw-share-name">{name}</span>
      <span className="kpa-gw-share-count kpa-mono">{formatNumber(requests)}</span>
      <span className="kpa-gw-share-pct kpa-mono">{Math.round(share * 100)}%</span>
    </div>
  )
}

/* ------------------------------------------------------------------ card -- */

export const GatewayNode = memo(function GatewayNode({
  data,
  selected,
}: NodeProps<KpaNode>): JSX.Element {
  const entity = data.entity as GatewayEntity
  const stats = useConsole((s) => s.stats)
  const keys = useConsole((s) => s.state.keys)
  const edgeMetrics = useConsole((s) => s.edgeMetrics)
  const updateEntity = useConsole((s) => s.updateEntity)
  const compact = useStore((s) => s.transform[2] < COMPACT_ZOOM)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1200)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copyEndpoint = useCallback(() => {
    void navigator.clipboard?.writeText(entity.endpoint).catch(() => undefined)
    setCopied(true)
  }, [entity.endpoint])

  const commitName = useCallback(
    (name: string) => {
      void updateEntity('gateway', entity.id, { name })
    },
    [updateEntity, entity.id],
  )

  const toggleEnabled = useCallback(
    (next: boolean) => {
      void updateEntity('gateway', entity.id, { enabled: next })
    },
    [updateEntity, entity.id],
  )

  const successRatio = stats.totalRequests > 0 ? stats.success / stats.totalRequests : 1
  const rateTone = successRatio >= 0.98 ? 'ok' : successRatio >= 0.9 ? 'warn' : 'danger'
  const tokens = stats.tokensIn + stats.tokensOut
  const width = LAYOUT.nodeWidth[entity.kind]
  const innerWidth = width - 24

  /** Per-key traffic share, derived from the gateway->key edge metrics. */
  const shares = useMemo(() => {
    const rows = keys.map((key) => ({
      id: key.id,
      name: key.name,
      requests: edgeMetrics[edgeId(entity.id, key.id)]?.requests ?? 0,
    }))
    rows.sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name))
    const total = rows.reduce((sum, row) => sum + row.requests, 0)
    return { rows, total }
  }, [keys, edgeMetrics, entity.id])

  const topShares = shares.rows.slice(0, TOP_KEYS)
  const restRequests = shares.rows.slice(TOP_KEYS).reduce((sum, row) => sum + row.requests, 0)

  const topOutcomes = useMemo<[RequestOutcome, number][]>(
    () =>
      (Object.keys(stats.outcomes) as RequestOutcome[])
        .map((key): [RequestOutcome, number] => [key, stats.outcomes[key] ?? 0])
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_OUTCOMES),
    [stats.outcomes],
  )

  const killed = !entity.enabled

  return (
    <div
      className={clsx('kpa-node', 'kpa-node--gateway', compact && 'kpa-node--compact')}
      data-kind="gateway"
      data-status={entity.status}
      data-selected={selected || undefined}
      data-dimmed={data.dimmed || undefined}
      data-traced={data.traced || undefined}
      data-enabled={entity.enabled ? undefined : 'false'}
      data-killed={killed || undefined}
      style={{ width }}
    >
      {/* Feature 13: animated four-hue gradient border (see nodes.css). */}
      <span className="kpa-gw-border" aria-hidden="true" />
      <header className="kpa-node__header">
        <span className="kpa-node__icon">
          <Router size={14} />
        </span>
        <span className="kpa-node__ident">
          <InlineName value={entity.name} onCommit={commitName} className="kpa-node__name" />
          {compact ? null : <span className="kpa-node__subtitle kpa-node__mono">{entity.version}</span>}
        </span>
        <Switch
          checked={entity.enabled}
          onChange={toggleEnabled}
          label={entity.enabled ? '总开关：停用后全部请求在入口被拒绝' : '恢复网关，重新接收请求'}
          className="kpa-node__switch"
        />
        <span className="kpa-node__status" title={statusLabel(entity.status)}>
          <StatusDot status={entity.status} pulse={entity.status !== 'disabled'} />
          <span className="kpa-node__status-text">{statusLabel(entity.status)}</span>
        </span>
      </header>

      {compact ? (
        <div className="kpa-node__headline">
          {killed
            ? '网关已停用 · 全部请求被拒绝'
            : `${stats.rps.toFixed(1)} RPS · ${Math.round(successRatio * 100)}%`}
        </div>
      ) : (
        <>
          <div className="kpa-node__detail">
            <button
              type="button"
              className="kpa-node__secret nodrag nopan"
              onClick={copyEndpoint}
              title="点击复制入口地址"
            >
              <span className="kpa-node__secret-text">{entity.endpoint}</span>
              {copied ? (
                <span className="kpa-node__secret-hint" data-copied="true">
                  <Check size={10} /> 已复制
                </span>
              ) : (
                <span className="kpa-node__secret-hint">
                  <Copy size={10} />
                </span>
              )}
            </button>
            {entity.rateLimit.rpm > 0 ? (
              <Badge tone="warn" mono title="全局速率限制">
                限 {formatNumber(entity.rateLimit.rpm)}/min
              </Badge>
            ) : (
              <Badge tone="neutral" title="全局速率限制未启用">
                不限速
              </Badge>
            )}
          </div>

          <div className="kpa-node__body">
            {killed ? (
              <div className="kpa-gw-killed" role="alert">
                <Power size={14} />
                <span className="kpa-gw-killed__text">网关已停用 · 全部请求被拒绝</span>
              </div>
            ) : (
              <>
                <div className="kpa-gw-hero">
                  <div className="kpa-gw-hero-main">
                    {/* key= retriggers the tick-flash animation on every change. */}
                    <span className="kpa-gw-rps kpa-mono" key={stats.rps.toFixed(1)}>
                      {stats.rps.toFixed(1)}
                    </span>
                    <span className="kpa-gw-rps-unit">RPS</span>
                  </div>
                  <div className="kpa-gw-hero-side">
                    <Stat label="总请求数" value={formatNumber(stats.totalRequests)} align="right" />
                    <Stat
                      label="成功率"
                      value={Math.round(successRatio * 100)}
                      unit="%"
                      tone={rateTone}
                      align="right"
                    />
                  </div>
                </div>

                <TimelineChart points={stats.timeline} width={innerWidth} height={52} />

                <div className="kpa-node__stats kpa-node__stats--2">
                  <Stat label="p95 延迟" value={formatMs(stats.p95LatencyMs)} />
                  <Stat label="Token 吞吐" value={formatNumber(tokens)} align="right" />
                </div>

                <div className="kpa-gw-shares">
                  <div className="kpa-caption">密钥流量份额</div>
                  {shares.total > 0 ? (
                    <div className="kpa-gw-share-bar" aria-hidden="true">
                      {topShares.map((row, index) => (
                        <span
                          key={row.id}
                          className="kpa-gw-share-seg"
                          data-rank={index}
                          style={{ width: `${(row.requests / shares.total) * 100}%` }}
                        />
                      ))}
                      {restRequests > 0 ? (
                        <span
                          className="kpa-gw-share-seg"
                          data-rank="rest"
                          style={{ width: `${(restRequests / shares.total) * 100}%` }}
                        />
                      ) : null}
                    </div>
                  ) : (
                    <div className="kpa-gw-share-empty">暂无流量</div>
                  )}
                  {topShares.map((row) => (
                    <KeyShareRow
                      key={row.id}
                      gatewayId={entity.id}
                      keyId={row.id}
                      name={row.name}
                      share={shares.total > 0 ? row.requests / shares.total : 0}
                    />
                  ))}
                </div>

                {topOutcomes.length > 0 ? (
                  <div className="kpa-gw-outcomes">
                    {topOutcomes.map(([outcome, count]) => (
                      <Badge key={outcome} tone={outcomeTone(outcome)} mono>
                        {outcomeLabel(outcome)} {formatNumber(count)}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </>
      )}

      <Handle
        id="out"
        type="source"
        position={Position.Right}
        className="kpa-node__handle kpa-node__handle--out"
      />
    </div>
  )
})
