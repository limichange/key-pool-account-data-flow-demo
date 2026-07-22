import { memo, useEffect, useState } from 'react'
import type { NodeProps } from '@xyflow/react'
import { Flame, Layers, MapPin, PowerOff, ShieldAlert, Unplug } from 'lucide-react'
import {
  ACCOUNT_TYPE_LABEL_CN,
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
import { useConsole, useEntity } from '@/lib/store'
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
  // most one pool, `null` means 未接入 and the account receives no traffic.
  const pool = useEntity(entity.poolId)
  // Feature 10: the proxy that auto-disabled this account, so a mysteriously
  // disabled account always explains itself right on the card.
  const disabledBy = useEntity(entity.autoDisabledBy)
  const select = useConsole((s) => s.select)

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

  const poolName = typedPool?.name ?? '未接入'
  // The compact card drops the footer, so the owning pool rides in the headline.
  const headline = `${formatMs(health.latencyMs)} · ${Math.round(rate * 100)}% · ${poolName}`

  // Feature 9: an account without a proxy is a parked account — it may not
  // join any pool until an egress proxy is bound.
  const noProxy = entity.proxyId === null

  return (
    <NodeShell
      entity={entity}
      selected={selected}
      dimmed={data.dimmed}
      traced={data.traced}
      detached={Boolean(data.detached)}
      handles="in-out"
      icon={<ProviderIcon size={14} />}
      subtitle={<span className="kpa-node__mono">{entity.id}</span>}
      headline={headline}
      badges={
        <>
          <Badge tone="accent">{providerLabel(entity.provider)}</Badge>
          <span
            className="kpa-type-badge"
            data-type={entity.accountType}
            title={`账号类型：${ACCOUNT_TYPE_LABEL_CN[entity.accountType]}`}
          >
            {ACCOUNT_TYPE_LABEL_CN[entity.accountType]}
          </span>
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
              title="未接入任何池，不会收到流量"
            >
              <Layers size={10} />
              <span className="kpa-pool-chip__name">未接入</span>
            </span>
          )}
          {typedProxy ? (
            <span
              className="kpa-proxy-chip"
              title={`${typedProxy.name} · ${typedProxy.country} · 出口 IP ${typedProxy.ip}`}
            >
              <span className="kpa-proxy-chip__flag">{countryFlag(typedProxy.countryCode)}</span>
              <span className="kpa-proxy-chip__name">{typedProxy.name}</span>
              <span className="kpa-proxy-chip__country">{typedProxy.country}</span>
            </span>
          ) : (
            <span className="kpa-node__foot-item kpa-node__foot-item--muted" title="未配置出口代理">
              <Unplug size={10} /> 未配置代理
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

      {/* Mutually exclusive strips: auto-disabled implies a proxy is bound. */}
      {noProxy ? (
        <button
          type="button"
          className="kpa-node__alert nodrag nopan"
          onClick={() => select(entity.id)}
          title="点击打开详情面板绑定出口代理"
        >
          <ShieldAlert size={11} />
          <span className="kpa-node__alert-text">未绑定代理 · 无法加入池</span>
          <span className="kpa-node__alert-cta">去绑定</span>
        </button>
      ) : null}
      {disabledBy && disabledBy.kind === 'proxy' ? (
        <div
          className="kpa-node__alert kpa-node__alert--info"
          title={`代理「${disabledBy.name}」已停用；代理恢复后该账号会自动重新启用`}
        >
          <PowerOff size={11} />
          <span className="kpa-node__alert-text">因代理「{disabledBy.name}」停用被自动停用</span>
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
