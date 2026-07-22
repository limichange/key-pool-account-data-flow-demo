import { memo } from 'react'
import type { NodeProps } from '@xyflow/react'
import { Globe, Server } from 'lucide-react'
import { formatMs, formatNumber, successRate, type ProxyEntity } from '@kpa/shared'

import { Badge, MetricBar, Sparkline, Stat } from '@/components'
import type { KpaNode } from '@/lib/graph'
import { countryFlag } from '@/lib/format'
import { useConsole } from '@/lib/store'
import { NodeShell, nodeInnerWidth } from './NodeShell'

const POOL_TYPE_LABEL: Record<ProxyEntity['poolType'], string> = {
  residential: '住宅',
  datacenter: '机房',
  mobile: '移动',
}

function latencyTone(ms: number): 'default' | 'ok' | 'warn' | 'danger' {
  if (ms <= 0) return 'default'
  if (ms < 300) return 'ok'
  if (ms < 900) return 'warn'
  return 'danger'
}

function lossTone(loss: number): 'default' | 'ok' | 'warn' | 'danger' {
  if (loss <= 0.005) return 'ok'
  if (loss <= 0.05) return 'warn'
  return 'danger'
}

function rateTone(rate: number): 'default' | 'ok' | 'warn' | 'danger' {
  if (rate >= 0.98) return 'ok'
  if (rate >= 0.9) return 'warn'
  return 'danger'
}

export const ProxyNode = memo(function ProxyNode({
  data,
  selected,
}: NodeProps<KpaNode>): JSX.Element {
  const entity = data.entity as ProxyEntity
  const metrics = entity.metrics
  const health = entity.health
  // Primitive selector: only the count matters, so a patch to an unrelated
  // account must not re-render this card.
  const boundAccounts = useConsole(
    (s) => s.state.accounts.filter((a) => a.proxyId === entity.id).length,
  )

  const concurrencyMax =
    entity.maxConcurrency > 0 ? entity.maxConcurrency : Math.max(1, metrics.inFlight)
  const rate = successRate(metrics)

  return (
    <NodeShell
      entity={entity}
      selected={selected}
      dimmed={data.dimmed}
      traced={data.traced}
      handles="in"
      icon={<Globe size={14} />}
      subtitle={<span className="kpa-node__mono">{entity.id}</span>}
      headline={`${formatMs(health.latencyMs)} · ${Math.round(rate * 100)}%`}
      badges={
        <>
          <Badge tone="accent" mono>
            {entity.protocol.toUpperCase()}
          </Badge>
          <Badge tone="neutral">{POOL_TYPE_LABEL[entity.poolType]}</Badge>
          {health.alive ? null : <Badge tone="danger">不可达</Badge>}
        </>
      }
      detail={
        <>
          <span
            className="kpa-node__secret kpa-node__secret--static"
            title={`${entity.host}:${entity.port}`}
          >
            <span className="kpa-node__secret-text">
              {entity.host}:{entity.port}
            </span>
          </span>
          <span className="kpa-node__detail-aside" title={`${entity.region} · ${entity.countryCode}`}>
            <span className="kpa-node__flag">{countryFlag(entity.countryCode)}</span>
            <span className="kpa-node__detail-aside-text">{entity.region}</span>
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
            <Server size={10} /> 绑定账号 {boundAccounts}
          </span>
          <span className="kpa-node__foot-item kpa-node__mono">
            {formatMs(health.latencyMs)} RTT
          </span>
        </>
      }
    >
      <div className="kpa-node__stats kpa-node__stats--2">
        <Stat label="延迟" value={formatMs(health.latencyMs)} tone={latencyTone(health.latencyMs)} />
        <Stat
          label="丢包"
          value={(health.packetLoss * 100).toFixed(1)}
          unit="%"
          tone={lossTone(health.packetLoss)}
          align="right"
        />
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
        width={nodeInnerWidth('proxy')}
        height={24}
        tone="accent"
        fill
        className="kpa-node__spark"
      />
    </NodeShell>
  )
})
