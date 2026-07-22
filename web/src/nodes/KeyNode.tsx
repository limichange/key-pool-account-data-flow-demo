import { memo, useCallback, useEffect, useState } from 'react'
import type { NodeProps } from '@xyflow/react'
import { Check, Copy, KeyRound, Package, User } from 'lucide-react'
import {
  formatMs,
  formatNumber,
  successRate,
  type KeyEntity,
  type KeyTier,
} from '@kpa/shared'

import { Badge, MetricBar, Sparkline, Stat } from '@/components'
import type { KpaNode } from '@/lib/graph'
import { NodeShell, nodeInnerWidth } from './NodeShell'

const TIER_LABEL: Record<KeyTier, string> = {
  free: '免费',
  pro: '专业',
  team: '团队',
  enterprise: '企业',
}

const TIER_TONE: Record<KeyTier, 'neutral' | 'info' | 'accent' | 'ok'> = {
  free: 'neutral',
  pro: 'info',
  team: 'accent',
  enterprise: 'ok',
}

function rateTone(rate: number): 'default' | 'ok' | 'warn' | 'danger' {
  if (rate >= 0.98) return 'ok'
  if (rate >= 0.9) return 'warn'
  return 'danger'
}

export const KeyNode = memo(function KeyNode({ data, selected }: NodeProps<KpaNode>): JSX.Element {
  const entity = data.entity as KeyEntity
  const metrics = entity.metrics
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1200)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copySecret = useCallback(() => {
    void navigator.clipboard?.writeText(entity.secret).catch(() => undefined)
    setCopied(true)
  }, [entity.secret])

  const rpmMax = entity.rateLimit.rpm > 0 ? entity.rateLimit.rpm : Math.max(60, metrics.rpm)
  const quotaLimit = entity.quota.limitTokens
  const rate = successRate(metrics)
  const modelCount = entity.allowedModels.length

  return (
    <NodeShell
      entity={entity}
      selected={selected}
      dimmed={data.dimmed}
      traced={data.traced}
      handles="in-out"
      icon={<KeyRound size={14} />}
      subtitle={<span className="kpa-node__mono">{entity.id}</span>}
      headline={`${Math.round(metrics.rpm)} RPM · ${Math.round(rate * 100)}%`}
      badges={
        <>
          <Badge tone={TIER_TONE[entity.tier]}>{TIER_LABEL[entity.tier]}</Badge>
          <Badge tone="neutral" mono title="流量权重">
            ×{entity.trafficWeight}
          </Badge>
          {entity.enabled ? null : <Badge tone="danger">已停用</Badge>}
        </>
      }
      detail={
        <>
          <button
            type="button"
            className="kpa-node__secret nodrag nopan"
            onClick={copySecret}
            title="点击复制密钥"
          >
            <span className="kpa-node__secret-text">{entity.secret}</span>
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
          <span className="kpa-node__detail-aside" title={entity.owner}>
            <User size={10} />
            <span className="kpa-node__detail-aside-text">{entity.owner}</span>
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
            <Package size={10} /> 池 {entity.bindings.length}
          </span>
          <span className="kpa-node__foot-item">
            模型 {modelCount === 0 ? '全部' : modelCount}
          </span>
          <span className="kpa-node__foot-tags">
            {entity.tags.slice(0, 2).map((tag) => (
              <span key={tag} className="kpa-node__tag">
                {tag}
              </span>
            ))}
            {entity.tags.length > 2 ? (
              <span className="kpa-node__tag">+{entity.tags.length - 2}</span>
            ) : null}
          </span>
        </>
      }
    >
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

      <Sparkline
        data={metrics.history}
        width={nodeInnerWidth('key')}
        height={24}
        tone="accent"
        fill
        className="kpa-node__spark"
      />
    </NodeShell>
  )
})
