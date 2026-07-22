import { memo, useCallback, useEffect, useState } from 'react'
import type { NodeProps } from '@xyflow/react'
import { Check, Copy, Globe, PlugZap, Server } from 'lucide-react'
import { formatMs, formatNumber, successRate, type ProxyEntity } from '@kpa/shared'

import {
  Badge,
  ConfirmDialog,
  MetricBar,
  Sparkline,
  Stat,
  proxyDisableCasualties,
  proxyDisableMessage,
  proxyEnableMessage,
  proxyEnableRevivals,
} from '@/components'
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
  const updateEntity = useConsole((s) => s.updateEntity)

  const [copied, setCopied] = useState(false)
  // Feature 10: flipping the card switch first confirms the cascade onto the
  // in-pool accounts behind this proxy. `null` = no dialog open.
  const [pendingToggle, setPendingToggle] = useState<{ next: boolean; message: string } | null>(null)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1200)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copyIp = useCallback(() => {
    void navigator.clipboard?.writeText(entity.ip).catch(() => undefined)
    setCopied(true)
  }, [entity.ip])

  const onToggleEnabled = useCallback(
    (next: boolean) => {
      const state = useConsole.getState().state
      if (next) {
        const revivals = proxyEnableRevivals(state, entity)
        if (revivals.length > 0) {
          setPendingToggle({ next, message: proxyEnableMessage(entity, revivals) })
          return
        }
      } else {
        const casualties = proxyDisableCasualties(state, entity)
        if (casualties.length > 0) {
          setPendingToggle({ next, message: proxyDisableMessage(entity, casualties) })
          return
        }
      }
      void updateEntity('proxy', entity.id, { enabled: next })
    },
    [entity, updateEntity],
  )

  const concurrencyMax =
    entity.maxConcurrency > 0 ? entity.maxConcurrency : Math.max(1, metrics.inFlight)
  const rate = successRate(metrics)

  return (
    <>
      <NodeShell
        entity={entity}
        selected={selected}
        dimmed={data.dimmed}
        traced={data.traced}
        detached={Boolean(data.detached)}
        onToggleEnabled={onToggleEnabled}
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
            {/* Geo identity first: the country the egress IP resolves to is what
                an operator actually cares about. */}
            <span className="kpa-proxy-geo" title={`${entity.country} · ${entity.region}`}>
              <span className="kpa-node__flag">{countryFlag(entity.countryCode)}</span>
              <span className="kpa-proxy-geo__country">{entity.country}</span>
              <span className="kpa-proxy-geo__region">{entity.region}</span>
            </span>
            <span className="kpa-node__detail-aside" title={`延迟 ${formatMs(health.latencyMs)}`}>
              <span className="kpa-node__detail-aside-text" data-tone={latencyTone(health.latencyMs)}>
                {formatMs(health.latencyMs)}
              </span>
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
            <span
              className="kpa-node__foot-item kpa-node__mono"
              title={`丢包率 ${(health.packetLoss * 100).toFixed(1)}%`}
            >
              丢包 {(health.packetLoss * 100).toFixed(1)}%
            </span>
          </>
        }
      >
        {/*
         * Two different addresses, deliberately kept apart:
         *  - `ip` is the EGRESS IP — what the upstream provider sees; the thing
         *    that gets a provider account flagged.
         *  - `host:port` is the DIAL ENDPOINT — what the gateway connects to.
         * Conflating them is the bug this layout exists to prevent.
         */}
        <button
          type="button"
          className="kpa-node__secret nodrag nopan"
          onClick={copyIp}
          title="出口 IP（上游看到的地址），点击复制"
        >
          <span className="kpa-node__secret-text">{entity.ip}</span>
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
        <div className="kpa-proxy-endpoint" title="接入端点（拨号地址），区别于出口 IP">
          <PlugZap size={10} />
          <span className="kpa-proxy-endpoint__text kpa-node__mono">
            {entity.host}:{entity.port}
          </span>
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

      <ConfirmDialog
        open={pendingToggle !== null}
        title={pendingToggle?.next ? `启用代理「${entity.name}」？` : `停用代理「${entity.name}」？`}
        body={<p>{pendingToggle?.message}</p>}
        confirmLabel={pendingToggle?.next ? '启用' : '停用'}
        tone={pendingToggle?.next ? 'default' : 'danger'}
        onConfirm={() => {
          const next = pendingToggle?.next
          setPendingToggle(null)
          if (next !== undefined) void updateEntity('proxy', entity.id, { enabled: next })
        }}
        onCancel={() => setPendingToggle(null)}
      />
    </>
  )
})
