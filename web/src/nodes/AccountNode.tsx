import { memo, useEffect, useState } from 'react'
import type { NodeProps } from '@xyflow/react'
import { Flame, Globe2, Layers, MapPin, Unplug } from 'lucide-react'
import {
  LATENCY_SCALE_MS,
  formatMs,
  formatNumber,
  type AccountEntity,
  type CredentialType,
  type PoolEntity,
  type ProxyEntity,
} from '@kpa/shared'

import { Badge, Gauge, MetricBar, Sparkline, Stat } from '@/components'
import type { KpaNode } from '@/lib/graph'
import { countryFlag, providerIcon, providerLabel } from '@/lib/format'
import { useEntity } from '@/lib/store'
import { NodeShell, nodeInnerWidth } from './NodeShell'

const COOLDOWN_TICK_MS = 100

const CREDENTIAL_LABEL: Record<CredentialType, string> = {
  'api-key': 'API Key',
  oauth: 'OAuth',
  session: 'Session',
}

function rateTone(rate: number): 'default' | 'ok' | 'warn' | 'danger' {
  if (rate >= 0.98) return 'ok'
  if (rate >= 0.9) return 'warn'
  return 'danger'
}

export const AccountNode = memo(function AccountNode({
  data,
  selected,
}: NodeProps<KpaNode>): JSX.Element {
  const entity = data.entity as AccountEntity
  const metrics = entity.metrics
  const health = entity.health
  const proxy = useEntity(entity.proxyId)
  // Derived back-reference maintained by the server: an account belongs to at
  // most one pool, `null` means 未分配 and the account receives no traffic.
  const pool = useEntity(entity.poolId)

  const cooldownUntil = health.cooldownUntil ?? 0
  const cooling = entity.status === 'cooldown' || cooldownUntil > Date.now()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!cooling) return
    const timer = window.setInterval(() => setNow(Date.now()), COOLDOWN_TICK_MS)
    return () => window.clearInterval(timer)
  }, [cooling])

  const remainingMs = Math.max(0, cooldownUntil - now)
  const ProviderIcon = providerIcon(entity.provider)

  const typedProxy = proxy && proxy.kind === 'proxy' ? (proxy as ProxyEntity) : undefined
  const typedPool = pool && pool.kind === 'pool' ? (pool as PoolEntity) : undefined

  const quotaLimit = entity.quota.limitTokens
  const rpmMax = entity.rateLimit.rpm > 0 ? entity.rateLimit.rpm : Math.max(60, metrics.rpm)
  // Same vocabulary as every other card: a success rate, not its inverse.
  const rate = 1 - health.errorRate

  const poolName = typedPool?.name ?? '未分配'
  // The compact card drops the footer, so the owning pool rides in the headline.
  const headline = `${formatMs(health.latencyMs)} · ${Math.round(rate * 100)}% · ${poolName}`

  return (
    <NodeShell
      entity={entity}
      selected={selected}
      dimmed={data.dimmed}
      traced={data.traced}
      handles="in-out"
      icon={<ProviderIcon size={14} />}
      subtitle={<span className="kpa-node__mono">{entity.id}</span>}
      headline={headline}
      badges={
        <>
          <Badge tone="accent">{providerLabel(entity.provider)}</Badge>
          <Badge tone="neutral">{CREDENTIAL_LABEL[entity.credentialType]}</Badge>
          {entity.models.length > 0 ? (
            <Badge tone="neutral" title={entity.models.join(', ')}>
              模型 {entity.models.length}
            </Badge>
          ) : null}
        </>
      }
      detail={
        <>
          <span className="kpa-node__secret kpa-node__secret--static" title={entity.credentialMask}>
            <span className="kpa-node__secret-text">{entity.credentialMask}</span>
          </span>
          <span className="kpa-node__detail-aside" title={entity.region}>
            <MapPin size={10} />
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
          {typedPool ? (
            <span className="kpa-pool-chip" title={`所属池：${typedPool.name}`}>
              <Layers size={10} />
              <span className="kpa-pool-chip__name">{typedPool.name}</span>
            </span>
          ) : (
            <span
              className="kpa-pool-chip kpa-pool-chip--none"
              title="未分配到任何池，不会收到流量"
            >
              <Layers size={10} />
              <span className="kpa-pool-chip__name">未分配</span>
            </span>
          )}
          {typedProxy ? (
            <span className="kpa-proxy-chip" title={`${typedProxy.host}:${typedProxy.port}`}>
              <Globe2 size={10} />
              <span className="kpa-proxy-chip__name">{typedProxy.name}</span>
              <span className="kpa-proxy-chip__flag">{countryFlag(typedProxy.countryCode)}</span>
            </span>
          ) : (
            <span className="kpa-node__foot-item kpa-node__foot-item--muted">
              <Unplug size={10} /> 直连
            </span>
          )}
        </>
      }
    >
      {cooling ? (
        <div className="kpa-cooldown">
          <Flame size={11} />
          <span className="kpa-cooldown__text">熔断中</span>
          <span className="kpa-cooldown__count">{(remainingMs / 1000).toFixed(1)}s</span>
        </div>
      ) : null}

      <div className="kpa-node__gauge-row">
        <Gauge
          value={health.latencyMs}
          max={LATENCY_SCALE_MS}
          display={formatMs(health.latencyMs)}
          label="延迟"
          size={58}
          tone="auto"
        />
        <div className="kpa-node__gauge-stats">
          <MetricBar
            value={entity.quota.usedTokens}
            max={quotaLimit > 0 ? quotaLimit : entity.quota.usedTokens || 1}
            label="Token 配额"
            right={
              quotaLimit > 0
                ? `${formatNumber(entity.quota.usedTokens)}/${formatNumber(quotaLimit)}`
                : `${formatNumber(entity.quota.usedTokens)} · 不限`
            }
            tone="auto"
            height={4}
          />
          <MetricBar
            value={metrics.rpm}
            max={rpmMax}
            label="RPM"
            right={
              entity.rateLimit.rpm > 0
                ? `${Math.round(metrics.rpm)}/${entity.rateLimit.rpm}`
                : `${Math.round(metrics.rpm)} · 不限`
            }
            tone="auto"
            height={4}
          />
        </div>
      </div>

      <div className="kpa-node__stats kpa-node__stats--2">
        <Stat
          label="连续失败"
          value={health.consecutiveFailures}
          tone={health.consecutiveFailures > 0 ? 'danger' : 'default'}
        />
        <Stat
          label="在途"
          value={formatNumber(metrics.inFlight)}
          align="right"
        />
      </div>

      <Sparkline
        data={metrics.history}
        width={nodeInnerWidth('account')}
        height={24}
        tone="accent"
        fill
        className="kpa-node__spark"
      />
    </NodeShell>
  )
})
