import { memo, useMemo } from 'react'
import type { NodeProps } from '@xyflow/react'
import { Layers, Pin, Repeat, ShieldAlert, ShieldOff } from 'lucide-react'
import {
  formatMs,
  formatNumber,
  isServing,
  percent,
  successRate,
  type AccountEntity,
  type HealthStatus,
  type PoolEntity,
  type PoolMember,
} from '@kpa/shared'

import { Badge, MetricBar, Sparkline, Stat, StatusDot } from '@/components'
import type { KpaNode } from '@/lib/graph'
import { strategyLabel } from '@/lib/format'
import { useConsole } from '@/lib/store'
import { NodeShell, nodeInnerWidth } from './NodeShell'

const VISIBLE_MEMBERS = 4

interface ResolvedMember {
  member: PoolMember
  name: string
  status: HealthStatus
  serving: boolean
}

function rateTone(rate: number): 'default' | 'ok' | 'warn' | 'danger' {
  if (rate >= 0.98) return 'ok'
  if (rate >= 0.9) return 'warn'
  return 'danger'
}

export const PoolNode = memo(function PoolNode({ data, selected }: NodeProps<KpaNode>): JSX.Element {
  const entity = data.entity as PoolEntity
  const metrics = entity.metrics
  // Narrow selectors only: a pool card needs member accounts and (maybe) one
  // other pool, never the whole graph.
  const accounts = useConsole((s) => s.state.accounts)
  const failoverName = useConsole((s) =>
    entity.failoverPoolId
      ? (s.state.pools.find((p) => p.id === entity.failoverPoolId)?.name ?? entity.failoverPoolId)
      : null,
  )

  const resolved: ResolvedMember[] = useMemo(() => {
    const byId = new Map<string, AccountEntity>(accounts.map((a) => [a.id, a]))
    return entity.members.map((member) => {
      const typed = byId.get(member.accountId)
      const status: HealthStatus = typed ? typed.status : 'offline'
      return {
        member,
        name: typed ? typed.name : member.accountId,
        status,
        serving: Boolean(typed) && member.enabled && isServing(status),
      }
    })
  }, [accounts, entity.members])

  const totalWeight = resolved.reduce((sum, r) => sum + Math.max(0, r.member.weight), 0) || 1
  const healthy = resolved.filter((r) => r.serving).length
  const shown = resolved.slice(0, VISIBLE_MEMBERS)
  const overflow = resolved.length - shown.length
  const rate = successRate(metrics)
  const concurrencyMax =
    entity.maxConcurrency > 0 ? entity.maxConcurrency : Math.max(1, metrics.inFlight)

  return (
    <NodeShell
      entity={entity}
      selected={selected}
      dimmed={data.dimmed}
      traced={data.traced}
      handles="in-out"
      icon={<Layers size={14} />}
      subtitle={<span className="kpa-node__mono">{entity.id}</span>}
      headline={`可用 ${healthy}/${resolved.length} · ${Math.round(rate * 100)}%`}
      badges={
        <>
          <Badge tone="accent">{strategyLabel(entity.strategy)}</Badge>
          {entity.stickySession ? (
            <Badge tone="info" icon={<Pin size={9} />} title="会话粘滞">
              粘滞
            </Badge>
          ) : null}
          <Badge tone="neutral" icon={<Repeat size={9} />} title="最大重试次数">
            重试 {entity.maxRetries}
          </Badge>
          {entity.failoverPoolId ? (
            <Badge
              tone="warn"
              icon={<ShieldAlert size={9} />}
              title={`故障转移到 ${failoverName ?? entity.failoverPoolId}`}
            >
              转移
            </Badge>
          ) : null}
        </>
      }
      detail={
        <>
          <span className="kpa-node__secret kpa-node__secret--static" title="路由策略">
            <span className="kpa-node__secret-text">{entity.strategy}</span>
            <span className="kpa-node__secret-hint">cursor {entity.cursor}</span>
          </span>
          <span
            className="kpa-node__detail-aside"
            title={failoverName ? `备用池 ${failoverName}` : '未配置备用池'}
          >
            {failoverName ? <ShieldAlert size={10} /> : <ShieldOff size={10} />}
            <span className="kpa-node__detail-aside-text">{failoverName ?? '无备用池'}</span>
          </span>
        </>
      }
      rail={
        <>
          <Stat label="请求数" value={formatNumber(metrics.requests)} />
          <Stat
            label="成功率"
            value={Math.round(rate * 100)}
            unit="%"
            tone={rateTone(rate)}
            align="right"
          />
          <Stat label="p95" value={formatMs(metrics.p95LatencyMs)} align="right" />
        </>
      }
      footer={
        <>
          <span className="kpa-node__foot-item">
            可用成员 {healthy}/{resolved.length}
          </span>
          <span className="kpa-node__foot-item kpa-node__mono">
            在途 {metrics.inFlight}
          </span>
        </>
      }
    >
      <div className="kpa-members">
        {shown.length === 0 ? (
          <div className="kpa-members__empty">未绑定账号</div>
        ) : (
          shown.map((row) => {
            const share = percent(Math.max(0, row.member.weight), totalWeight)
            return (
              <div
                key={row.member.accountId}
                className="kpa-member"
                data-status={row.status}
                data-off={row.member.enabled ? undefined : 'true'}
                title={`${row.name} · 权重 ${row.member.weight} · 优先级 ${row.member.priority}`}
              >
                <StatusDot status={row.status} size={6} />
                <span className="kpa-member__name">{row.name}</span>
                <span className="kpa-member__bar">
                  <span className="kpa-member__bar-fill" style={{ width: `${share}%` }} />
                </span>
                <span className="kpa-member__weight">{row.member.weight}</span>
              </div>
            )
          })
        )}
        {overflow > 0 ? <div className="kpa-members__more">+{overflow} 个成员</div> : null}
      </div>

      <MetricBar
        value={metrics.inFlight}
        max={concurrencyMax}
        label="并发"
        right={
          entity.maxConcurrency > 0
            ? `${metrics.inFlight}/${entity.maxConcurrency}`
            : `${metrics.inFlight} · 不限`
        }
        tone="auto"
        height={4}
      />

      <Sparkline
        data={metrics.history}
        width={nodeInnerWidth('pool')}
        height={24}
        tone="accent"
        fill
        className="kpa-node__spark"
      />
    </NodeShell>
  )
})
