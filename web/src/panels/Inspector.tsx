import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Gauge as Gauge2, Link2, Trash2, Unlink } from 'lucide-react'
import {
  ENTITY_KINDS,
  LATENCY_SCALE_MS,
  MODELS,
  PROVIDERS,
  PROXY_PROTOCOLS,
  ROUTING_STRATEGIES,
  allEntities,
  formatMs,
  formatNumber,
  formatRelativeTime,
  isServing,
  percent,
} from '@kpa/shared'
import type {
  AccountEntity,
  CredentialType,
  Entity,
  EntityKind,
  HealthStatus,
  KeyEntity,
  KeyTier,
  PoolBinding,
  PoolEntity,
  PoolMember,
  Provider,
  ProxyEntity,
  ProxyProtocol,
  RequestOutcome,
  RoutingStrategy,
} from '@kpa/shared'

import {
  Badge,
  Button,
  Gauge,
  IconButton,
  MetricBar,
  NumberField,
  Section,
  SelectField,
  SliderField,
  Sparkline,
  Stat,
  StatusDot,
  TagList,
  TextField,
  ToggleField,
} from '@/components'
import {
  countryFlag,
  kindIcon,
  kindLabel,
  outcomeLabel,
  outcomeTone,
  providerLabel,
  statusLabel,
  statusTone,
  strategyLabel,
} from '@/lib/format'
import { useConsole, useEntity } from '@/lib/store'

/* --------------------------------------------------------------- helpers -- */

type Patch = Record<string, unknown>
type Updater = (patch: Patch) => void

const STRATEGY_HINT: Record<RoutingStrategy, string> = {
  'round-robin': '依次轮流选择成员账号，负载均匀但不感知实际压力。',
  weighted: '按成员权重比例随机命中，权重越高承接的流量越多。',
  'least-latency': '优先选择近期平均延迟最低的账号，适合对时延敏感的流量。',
  'least-used': '优先选择累计请求数最少的账号，用于长期均摊配额消耗。',
  'priority-failover': '始终使用优先级最高的可用账号，故障时按优先级向下顺延。',
  random: '在可用成员中完全随机选择，用于打散热点。',
}

const TIER_OPTIONS: { value: KeyTier; label: string }[] = [
  { value: 'free', label: '免费版' },
  { value: 'pro', label: '专业版' },
  { value: 'team', label: '团队版' },
  { value: 'enterprise', label: '企业版' },
]

const CREDENTIAL_OPTIONS: { value: CredentialType; label: string }[] = [
  { value: 'api-key', label: 'API Key' },
  { value: 'oauth', label: 'OAuth' },
  { value: 'session', label: 'Session' },
]

/** Ordering used by the 需要关注 list: worst first. */
const STATUS_SEVERITY: Record<HealthStatus, number> = {
  offline: 6,
  exhausted: 5,
  cooldown: 4,
  throttled: 3,
  degraded: 2,
  disabled: 1,
  healthy: 0,
}

const POOL_TYPE_OPTIONS: { value: ProxyEntity['poolType']; label: string }[] = [
  { value: 'residential', label: '住宅 IP' },
  { value: 'datacenter', label: '机房 IP' },
  { value: 'mobile', label: '移动 IP' },
]

/** Text input that commits to the server ~300ms after the user stops typing. */
function DebouncedTextField(props: {
  label: string
  value: string
  onCommit: (v: string) => void
  mono?: boolean
  placeholder?: string
  hint?: string
  disabled?: boolean
}): JSX.Element {
  const { label, value, onCommit, mono, placeholder, hint, disabled } = props
  const [draft, setDraft] = useState(value)
  const dirty = useRef(false)
  const timer = useRef<number | null>(null)
  const commit = useRef(onCommit)
  commit.current = onCommit

  useEffect(() => {
    if (!dirty.current) setDraft(value)
  }, [value])

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  const onChange = (next: string) => {
    setDraft(next)
    dirty.current = true
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      dirty.current = false
      commit.current(next)
    }, 300)
  }

  return (
    <TextField
      label={label}
      value={draft}
      onChange={onChange}
      mono={mono}
      placeholder={placeholder}
      hint={hint}
      disabled={disabled}
    />
  )
}

function Countdown({ until }: { until: number | null }): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!until || until <= Date.now()) return
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [until])
  const left = until ? until - now : 0
  if (left <= 0) return <span className="kpa-insp-quiet">无</span>
  return <span className="kpa-insp-countdown">{(left / 1000).toFixed(1)}s</span>
}

function RelationRow(props: {
  kind: EntityKind
  name: string
  status?: Entity['status']
  children?: ReactNode
  onUnbind: () => void
}): JSX.Element {
  const { kind, name, status, children, onUnbind } = props
  const Icon = kindIcon(kind)
  return (
    <div className="kpa-insp-rel" data-kind={kind}>
      <div className="kpa-insp-rel-head">
        <Icon size={12} className="kpa-insp-rel-icon" />
        {status ? <StatusDot status={status} size={7} /> : null}
        <span className="kpa-insp-rel-name" title={name}>
          {name}
        </span>
        <IconButton icon={<Unlink size={12} />} label="解绑" tone="danger" size="sm" onClick={onUnbind} />
      </div>
      {children ? <div className="kpa-insp-rel-body">{children}</div> : null}
    </div>
  )
}

function AddRelation(props: {
  label: string
  placeholder: string
  options: { value: string; label: string }[]
  onPick: (id: string) => void
}): JSX.Element {
  const { label, placeholder, options, onPick } = props
  if (options.length === 0) {
    return <div className="kpa-insp-quiet kpa-insp-addnone">没有可绑定的对象了</div>
  }
  return (
    <div className="kpa-insp-add">
      <SelectField
        label={label}
        value=""
        options={[{ value: '', label: placeholder }, ...options]}
        onChange={(v) => {
          if (v) onPick(v)
        }}
      />
      <Link2 size={12} className="kpa-insp-add-icon" />
    </div>
  )
}

/* ------------------------------------------------------------------- key -- */

function KeySections({ entity, update }: { entity: KeyEntity; update: Updater }): JSX.Element {
  const pools = useConsole((s) => s.state.pools)
  const bind = useConsole((s) => s.bind)
  const unbind = useConsole((s) => s.unbind)

  const bound = new Set(entity.bindings.map((b) => b.poolId))
  const free = pools.filter((p) => !bound.has(p.id))

  // Send only the row that changed; the server merges it into the live array.
  const setBinding = (poolId: string, patch: Partial<PoolBinding>) => {
    update({ binding: { poolId, ...patch } })
  }

  const toggleModel = (model: string) => {
    const has = entity.allowedModels.includes(model)
    update({
      allowedModels: has
        ? entity.allowedModels.filter((m) => m !== model)
        : [...entity.allowedModels, model],
    })
  }

  const quotaPct = percent(entity.quota.usedTokens, entity.quota.limitTokens)

  return (
    <>
      <Section title="凭证" dense>
        <TextField label="Secret" value={entity.secret} onChange={() => undefined} mono disabled />
        <DebouncedTextField
          key={`${entity.id}-owner`}
          label="所属方"
          value={entity.owner}
          onCommit={(v) => update({ owner: v })}
          placeholder="团队 / 客户名"
        />
        <SelectField<KeyTier>
          label="套餐等级"
          value={entity.tier}
          options={TIER_OPTIONS}
          onChange={(v) => update({ tier: v })}
        />
      </Section>

      <Section title="流量与限流" dense>
        <SliderField
          label="流量权重"
          value={entity.trafficWeight}
          min={0}
          max={5}
          step={0.1}
          format={(v) => `${v.toFixed(1)}x`}
          onChange={(v) => update({ trafficWeight: v })}
          hint="模拟器按此权重分配该密钥的请求量"
        />
        <div className="kpa-insp-grid2">
          <NumberField
            label="RPM 上限"
            value={entity.rateLimit.rpm}
            min={0}
            max={100000}
            step={10}
            onChange={(v) => update({ rateLimit: { ...entity.rateLimit, rpm: v } })}
            hint="0 = 不限"
          />
          <NumberField
            label="并发上限"
            value={entity.rateLimit.concurrency}
            min={0}
            max={2000}
            step={1}
            onChange={(v) => update({ rateLimit: { ...entity.rateLimit, concurrency: v } })}
            hint="0 = 不限"
          />
        </div>
      </Section>

      <Section title="配额" dense>
        <NumberField
          label="Token 额度"
          value={entity.quota.limitTokens}
          min={0}
          step={1000}
          onChange={(v) => update({ quota: { ...entity.quota, limitTokens: v } })}
          suffix="tok"
        />
        <MetricBar
          value={entity.quota.usedTokens}
          max={Math.max(entity.quota.limitTokens, 1)}
          tone={quotaPct > 90 ? 'danger' : quotaPct > 70 ? 'warn' : 'accent'}
          showPct
          label="已用额度"
          right={`${formatNumber(entity.quota.usedTokens)} / ${
            entity.quota.limitTokens > 0 ? formatNumber(entity.quota.limitTokens) : '∞'
          }`}
        />
      </Section>

      <Section title="模型白名单" dense>
        <div className="kpa-insp-models">
          {MODELS.map((model) => {
            const active = entity.allowedModels.length === 0 || entity.allowedModels.includes(model)
            return (
              <button
                type="button"
                key={model}
                className="kpa-insp-model"
                data-active={active ? 'true' : 'false'}
                onClick={() => toggleModel(model)}
              >
                {model}
              </button>
            )
          })}
        </div>
        <p className="kpa-insp-hint">留空表示允许调用全部模型。</p>
      </Section>

      <Section title="绑定的池" dense>
        {entity.bindings.length === 0 ? (
          <div className="kpa-insp-quiet">尚未绑定任何池，请求会以 no-pool 失败。</div>
        ) : (
          entity.bindings.map((binding) => {
            const pool = pools.find((p) => p.id === binding.poolId)
            return (
              <RelationRow
                key={binding.poolId}
                kind="pool"
                name={pool?.name ?? binding.poolId}
                status={pool?.status}
                onUnbind={() =>
                  void unbind({ kind: 'key', id: entity.id }, { kind: 'pool', id: binding.poolId })
                }
              >
                <div className="kpa-insp-grid2">
                  <NumberField
                    label="优先级"
                    value={binding.priority}
                    min={0}
                    max={99}
                    step={1}
                    onChange={(v) => setBinding(binding.poolId, { priority: v })}
                  />
                  <NumberField
                    label="权重"
                    value={binding.weight}
                    min={0}
                    max={100}
                    step={1}
                    onChange={(v) => setBinding(binding.poolId, { weight: v })}
                  />
                </div>
              </RelationRow>
            )
          })
        )}
        <AddRelation
          label="添加绑定"
          placeholder="选择一个池…"
          options={free.map((p) => ({ value: p.id, label: p.name }))}
          onPick={(id) => void bind({ kind: 'key', id: entity.id }, { kind: 'pool', id })}
        />
      </Section>
    </>
  )
}

/* ------------------------------------------------------------------ pool -- */

function PoolSections({ entity, update }: { entity: PoolEntity; update: Updater }): JSX.Element {
  const pools = useConsole((s) => s.state.pools)
  const accounts = useConsole((s) => s.state.accounts)
  const bind = useConsole((s) => s.bind)
  const unbind = useConsole((s) => s.unbind)

  const members = new Set(entity.members.map((m) => m.accountId))
  const free = accounts.filter((a) => !members.has(a.id))

  // Send only the row that changed; the server merges it into the live array.
  const setMember = (accountId: string, patch: Partial<PoolMember>) => {
    update({ member: { accountId, ...patch } })
  }

  return (
    <>
      <Section title="路由策略" dense>
        <SelectField<RoutingStrategy>
          label="策略"
          value={entity.strategy}
          options={ROUTING_STRATEGIES.map((s) => ({ value: s, label: strategyLabel(s) }))}
          onChange={(v) => update({ strategy: v })}
        />
        <p className="kpa-insp-hint">{STRATEGY_HINT[entity.strategy]}</p>
        <ToggleField
          label="会话粘性"
          value={entity.stickySession}
          onChange={(v) => update({ stickySession: v })}
          hint="同一会话尽量落到同一个账号"
        />
        <div className="kpa-insp-grid2">
          <NumberField
            label="最大重试"
            value={entity.maxRetries}
            min={0}
            max={10}
            step={1}
            onChange={(v) => update({ maxRetries: v })}
          />
          <NumberField
            label="并发上限"
            value={entity.maxConcurrency}
            min={0}
            max={5000}
            step={1}
            onChange={(v) => update({ maxConcurrency: v })}
            hint="0 = 不限"
          />
        </div>
        <SelectField<string>
          label="备用池"
          value={entity.failoverPoolId ?? ''}
          options={[
            { value: '', label: '无' },
            ...pools.filter((p) => p.id !== entity.id).map((p) => ({ value: p.id, label: p.name })),
          ]}
          onChange={(v) => update({ failoverPoolId: v === '' ? null : v })}
          hint="成员全部不可用时溢出到该池"
        />
        <div className="kpa-insp-inline">
          <span className="kpa-insp-quiet">轮询游标</span>
          <code className="kpa-insp-code">{entity.cursor}</code>
        </div>
      </Section>

      <Section title="成员账号" dense>
        {entity.members.length === 0 ? (
          <div className="kpa-insp-quiet">池内没有账号，命中该池的请求会以 no-account 失败。</div>
        ) : (
          entity.members.map((member) => {
            const account = accounts.find((a) => a.id === member.accountId)
            return (
              <RelationRow
                key={member.accountId}
                kind="account"
                name={account?.name ?? member.accountId}
                status={account?.status}
                onUnbind={() =>
                  void unbind({ kind: 'pool', id: entity.id }, { kind: 'account', id: member.accountId })
                }
              >
                <div className="kpa-insp-grid2">
                  <NumberField
                    label="权重"
                    value={member.weight}
                    min={0}
                    max={100}
                    step={1}
                    onChange={(v) => setMember(member.accountId, { weight: v })}
                  />
                  <NumberField
                    label="优先级"
                    value={member.priority}
                    min={0}
                    max={99}
                    step={1}
                    onChange={(v) => setMember(member.accountId, { priority: v })}
                  />
                </div>
                <ToggleField
                  label="启用成员"
                  value={member.enabled}
                  onChange={(v) => setMember(member.accountId, { enabled: v })}
                />
              </RelationRow>
            )
          })
        )}
        <AddRelation
          label="添加成员"
          placeholder="选择一个账号…"
          options={free.map((a) => ({ value: a.id, label: a.name }))}
          onPick={(id) => void bind({ kind: 'pool', id: entity.id }, { kind: 'account', id })}
        />
      </Section>
    </>
  )
}

/* --------------------------------------------------------------- account -- */

function AccountSections({ entity, update }: { entity: AccountEntity; update: Updater }): JSX.Element {
  const proxies = useConsole((s) => s.state.proxies)
  const bind = useConsole((s) => s.bind)
  const unbind = useConsole((s) => s.unbind)

  const quotaPct = percent(entity.quota.usedTokens, entity.quota.limitTokens)

  const onProxyChange = (next: string) => {
    const current = entity.proxyId
    if ((current ?? '') === next) return
    void (async () => {
      if (current) await unbind({ kind: 'account', id: entity.id }, { kind: 'proxy', id: current })
      if (next) await bind({ kind: 'account', id: entity.id }, { kind: 'proxy', id: next })
    })()
  }

  return (
    <>
      <Section title="凭证" dense>
        <SelectField<Provider>
          label="供应商"
          value={entity.provider}
          options={PROVIDERS.map((p) => ({ value: p, label: providerLabel(p) }))}
          onChange={(v) => update({ provider: v })}
        />
        <SelectField<CredentialType>
          label="凭证类型"
          value={entity.credentialType}
          options={CREDENTIAL_OPTIONS}
          onChange={(v) => update({ credentialType: v })}
        />
        <TextField label="凭证" value={entity.credentialMask} onChange={() => undefined} mono disabled />
        <DebouncedTextField
          key={`${entity.id}-region`}
          label="区域"
          value={entity.region}
          onCommit={(v) => update({ region: v })}
          placeholder="us-east-1"
          mono
        />
      </Section>

      <Section title="模拟参数" dense>
        <SliderField
          label="可靠性"
          value={entity.reliability}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${(v * 100).toFixed(0)}%`}
          onChange={(v) => update({ reliability: v })}
          hint="上游调用成功的固有概率"
        />
        <SliderField
          label="基础延迟"
          value={entity.baseLatencyMs}
          min={50}
          max={4000}
          step={10}
          format={(v) => formatMs(v)}
          onChange={(v) => update({ baseLatencyMs: v })}
        />
      </Section>

      <Section title="限流与配额" dense>
        <div className="kpa-insp-grid2">
          <NumberField
            label="RPM 上限"
            value={entity.rateLimit.rpm}
            min={0}
            max={100000}
            step={10}
            onChange={(v) => update({ rateLimit: { ...entity.rateLimit, rpm: v } })}
            hint="0 = 不限"
          />
          <NumberField
            label="并发上限"
            value={entity.rateLimit.concurrency}
            min={0}
            max={2000}
            step={1}
            onChange={(v) => update({ rateLimit: { ...entity.rateLimit, concurrency: v } })}
            hint="0 = 不限"
          />
        </div>
        <NumberField
          label="Token 额度"
          value={entity.quota.limitTokens}
          min={0}
          step={1000}
          onChange={(v) => update({ quota: { ...entity.quota, limitTokens: v } })}
          suffix="tok"
        />
        <MetricBar
          value={entity.quota.usedTokens}
          max={Math.max(entity.quota.limitTokens, 1)}
          tone={quotaPct > 90 ? 'danger' : quotaPct > 70 ? 'warn' : 'accent'}
          showPct
          label="已用额度"
          right={`${formatNumber(entity.quota.usedTokens)} / ${
            entity.quota.limitTokens > 0 ? formatNumber(entity.quota.limitTokens) : '∞'
          }`}
        />
      </Section>

      <Section title="健康状况" dense>
        <div className="kpa-insp-health">
          <Gauge
            value={entity.health.latencyMs}
            max={LATENCY_SCALE_MS}
            display={formatMs(entity.health.latencyMs)}
            label="延迟"
            size={72}
            tone="auto"
          />
          <div className="kpa-insp-health-stats">
            <Stat
              label="错误率"
              value={`${(entity.health.errorRate * 100).toFixed(1)}%`}
              tone={entity.health.errorRate > 0.2 ? 'danger' : entity.health.errorRate > 0.05 ? 'warn' : 'ok'}
            />
            <Stat
              label="连续失败"
              value={entity.health.consecutiveFailures}
              tone={entity.health.consecutiveFailures > 0 ? 'warn' : 'default'}
            />
            <Stat label="熔断剩余" value={<Countdown until={entity.health.cooldownUntil} />} />
          </div>
        </div>
        <div className="kpa-insp-lasterr">
          <span className="kpa-insp-caption">最近错误</span>
          {entity.health.lastError ? (
            <span className="kpa-insp-lasterr-text" title={entity.health.lastError}>
              {entity.health.lastError}
              <em>{formatRelativeTime(entity.health.lastErrorAt)}</em>
            </span>
          ) : (
            <span className="kpa-insp-quiet">暂无</span>
          )}
        </div>
      </Section>

      <Section title="支持的模型" dense>
        <TagList
          tags={entity.models}
          onRemove={(t) => update({ models: entity.models.filter((m) => m !== t) })}
          onAdd={(t) => {
            if (!entity.models.includes(t)) update({ models: [...entity.models, t] })
          }}
        />
      </Section>

      <Section title="代理绑定" dense>
        <SelectField<string>
          label="出口代理"
          value={entity.proxyId ?? ''}
          options={[
            { value: '', label: '直连（不走代理）' },
            ...proxies.map((p) => ({ value: p.id, label: `${countryFlag(p.countryCode)} ${p.name}` })),
          ]}
          onChange={onProxyChange}
          hint="决定该账号的落地 IP 与地区"
        />
      </Section>
    </>
  )
}

/* ----------------------------------------------------------------- proxy -- */

function ProxySections({ entity, update }: { entity: ProxyEntity; update: Updater }): JSX.Element {
  const accounts = useConsole((s) => s.state.accounts)
  const users = accounts.filter((a) => a.proxyId === entity.id)

  return (
    <>
      <Section title="连接" dense>
        <SelectField<ProxyProtocol>
          label="协议"
          value={entity.protocol}
          options={PROXY_PROTOCOLS.map((p) => ({ value: p, label: p.toUpperCase() }))}
          onChange={(v) => update({ protocol: v })}
        />
        <DebouncedTextField
          key={`${entity.id}-host`}
          label="主机"
          value={entity.host}
          onCommit={(v) => update({ host: v })}
          mono
          placeholder="gw-sg.example.net"
        />
        <div className="kpa-insp-grid2">
          <NumberField
            label="端口"
            value={entity.port}
            min={1}
            max={65535}
            step={1}
            onChange={(v) => update({ port: v })}
          />
          <NumberField
            label="并发上限"
            value={entity.maxConcurrency}
            min={0}
            max={5000}
            step={1}
            onChange={(v) => update({ maxConcurrency: v })}
            hint="0 = 不限"
          />
        </div>
        <div className="kpa-insp-grid2">
          <DebouncedTextField
            key={`${entity.id}-region`}
            label="区域"
            value={entity.region}
            onCommit={(v) => update({ region: v })}
            mono
          />
          <DebouncedTextField
            key={`${entity.id}-cc`}
            label={`国家 ${countryFlag(entity.countryCode)}`}
            value={entity.countryCode}
            onCommit={(v) => update({ countryCode: v.toUpperCase().slice(0, 2) })}
            mono
            placeholder="SG"
          />
        </div>
        <SelectField<ProxyEntity['poolType']>
          label="出口类型"
          value={entity.poolType}
          options={POOL_TYPE_OPTIONS}
          onChange={(v) => update({ poolType: v })}
        />
      </Section>

      <Section title="模拟参数" dense>
        <SliderField
          label="可靠性"
          value={entity.reliability}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${(v * 100).toFixed(0)}%`}
          onChange={(v) => update({ reliability: v })}
        />
        <SliderField
          label="基础延迟"
          value={entity.baseLatencyMs}
          min={0}
          max={1500}
          step={5}
          format={(v) => formatMs(v)}
          onChange={(v) => update({ baseLatencyMs: v })}
        />
        <SliderField
          label="丢包率"
          value={entity.health.packetLoss}
          min={0}
          max={0.5}
          step={0.01}
          format={(v) => `${(v * 100).toFixed(0)}%`}
          onChange={(v) => update({ health: { ...entity.health, packetLoss: v } })}
        />
        <ToggleField
          label="链路存活"
          value={entity.health.alive}
          onChange={(v) => update({ health: { ...entity.health, alive: v } })}
          hint="关闭后经过该代理的请求会以 proxy-error 失败"
        />
        <div className="kpa-insp-inline">
          <span className="kpa-insp-quiet">最近探活</span>
          <code className="kpa-insp-code">{formatRelativeTime(entity.health.lastCheckAt)}</code>
        </div>
      </Section>

      <Section title="使用中的账号" dense>
        {users.length === 0 ? (
          <div className="kpa-insp-quiet">当前没有账号使用该代理。</div>
        ) : (
          <div className="kpa-insp-users">
            {users.map((a) => (
              <div className="kpa-insp-user" data-kind="account" key={a.id}>
                <StatusDot status={a.status} size={7} />
                <span className="kpa-insp-user-name">{a.name}</span>
                <span className="kpa-insp-user-meta">{providerLabel(a.provider)}</span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  )
}

/* ------------------------------------------------------- system overview -- */

/**
 * What the inspector shows when nothing is selected.
 *
 * The column is 320px wide and full height; three lines of "click something"
 * copy left ~560px of the window empty on first paint. This fills it with the
 * three things an operator wants before they have picked a node: how healthy
 * each kind is, what is currently broken, and how requests are ending.
 */
function SystemOverview(): JSX.Element {
  const state = useConsole((s) => s.state)
  const outcomes = useConsole((s) => s.stats.outcomes)
  const totalRequests = useConsole((s) => s.stats.totalRequests)
  const select = useConsole((s) => s.select)

  const rollup = useMemo(() => {
    const acc: Record<EntityKind, { total: number; healthy: number }> = {
      key: { total: 0, healthy: 0 },
      pool: { total: 0, healthy: 0 },
      account: { total: 0, healthy: 0 },
      proxy: { total: 0, healthy: 0 },
    }
    for (const item of allEntities(state)) {
      acc[item.kind].total += 1
      if (item.enabled && isServing(item.status)) acc[item.kind].healthy += 1
    }
    return acc
  }, [state])

  const unhealthy = useMemo(
    () =>
      allEntities(state)
        .filter((item) => !item.enabled || item.status !== 'healthy')
        .sort(
          (a, b) =>
            (STATUS_SEVERITY[b.status] ?? 0) - (STATUS_SEVERITY[a.status] ?? 0) ||
            b.metrics.requests - a.metrics.requests,
        )
        .slice(0, 5),
    [state],
  )

  const breakdown = useMemo<[RequestOutcome, number][]>(
    () =>
      (Object.keys(outcomes) as RequestOutcome[])
        .map((key): [RequestOutcome, number] => [key, outcomes[key] ?? 0])
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]),
    [outcomes],
  )

  return (
    <aside className="kpa-inspector kpa-scroll">
      <header className="kpa-insp-head">
        <div className="kpa-insp-head-top">
          <span className="kpa-insp-chip">
            <Gauge2 size={13} />
            系统概览
          </span>
        </div>
        <p className="kpa-insp-hint">选中任意节点即可在此编辑。</p>
      </header>

      <Section title="健康度" dense>
        {ENTITY_KINDS.map((kind) => {
          const { total, healthy } = rollup[kind]
          const bad = total - healthy
          return (
            <div className="kpa-insp-rollup" data-kind={kind} key={kind}>
              <MetricBar
                value={healthy}
                max={Math.max(total, 1)}
                tone={bad === 0 ? 'ok' : bad * 2 > total ? 'danger' : 'warn'}
                height={4}
                label={kindLabel(kind)}
                right={`${healthy}/${total}`}
              />
            </div>
          )
        })}
      </Section>

      <Section title="需要关注" dense>
        {unhealthy.length === 0 ? (
          <div className="kpa-insp-quiet">全部节点健康。</div>
        ) : (
          <div className="kpa-insp-users">
            {unhealthy.map((item) => (
              <button
                type="button"
                className="kpa-insp-user kpa-insp-user--button"
                data-kind={item.kind}
                key={item.id}
                onClick={() => select(item.id)}
                title={`${item.name} · ${statusLabel(item.status)}`}
              >
                <StatusDot status={item.status} size={7} />
                <span className="kpa-insp-user-name">{item.name}</span>
                <span className="kpa-insp-user-meta">{statusLabel(item.status)}</span>
                <span className="kpa-insp-user-metric">{formatNumber(item.metrics.requests)}</span>
              </button>
            ))}
          </div>
        )}
      </Section>

      <Section title="请求结果分布" dense>
        {breakdown.length === 0 ? (
          <div className="kpa-insp-quiet">还没有请求，打开模拟器即可开始。</div>
        ) : (
          breakdown.map(([outcome, count]) => (
            <div className="kpa-insp-outcome" key={outcome}>
              <MetricBar
                value={count}
                max={Math.max(totalRequests, 1)}
                tone={outcomeTone(outcome) === 'ok' ? 'ok' : outcomeTone(outcome)}
                height={4}
                label={outcomeLabel(outcome)}
                right={formatNumber(count)}
              />
            </div>
          ))
        )}
      </Section>
    </aside>
  )
}

/* -------------------------------------------------------------- inspector -- */

export function Inspector(): JSX.Element {
  const selectedId = useConsole((s) => s.selectedId)
  const entity = useEntity(selectedId)
  const updateEntity = useConsole((s) => s.updateEntity)
  const deleteEntity = useConsole((s) => s.deleteEntity)
  const select = useConsole((s) => s.select)

  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    setConfirmDelete(false)
  }, [selectedId])

  const kind = entity?.kind
  const id = entity?.id
  const update = useCallback<Updater>(
    (patch) => {
      if (!kind || !id) return
      void updateEntity(kind, id, patch)
    },
    [id, kind, updateEntity],
  )

  const history = useMemo(() => entity?.metrics.history ?? [], [entity])

  if (!entity) return <SystemOverview />


  const Icon = kindIcon(entity.kind)
  const metrics = entity.metrics
  const failRate = metrics.requests > 0 ? metrics.failed / metrics.requests : 0

  const onDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setConfirmDelete(false)
    select(null)
    void deleteEntity(entity.kind, entity.id)
  }

  return (
    <aside className="kpa-inspector kpa-scroll" data-kind={entity.kind} data-status={entity.status}>
      <header className="kpa-insp-head">
        <div className="kpa-insp-head-top">
          <span className="kpa-insp-chip">
            <Icon size={13} />
            {kindLabel(entity.kind)}
          </span>
          <Badge tone={statusTone(entity.status)} icon={<StatusDot status={entity.status} size={6} />}>
            {statusLabel(entity.status)}
          </Badge>
        </div>
        <DebouncedTextField
          key={`${entity.id}-name`}
          label="名称"
          value={entity.name}
          onCommit={(v) => update({ name: v })}
        />
        <div className="kpa-insp-id" title={entity.id}>
          <code>{entity.id}</code>
        </div>
        <ToggleField
          label="启用"
          value={entity.enabled}
          onChange={(v) => update({ enabled: v })}
          hint="停用后不再参与路由"
        />
        <Button
          variant="danger"
          size="sm"
          full
          icon={<Trash2 size={13} />}
          onClick={onDelete}
          title="删除该节点并解除全部关联"
        >
          {confirmDelete ? '再次点击确认删除' : '删除'}
        </Button>
      </header>

      {entity.kind === 'key' ? <KeySections entity={entity} update={update} /> : null}
      {entity.kind === 'pool' ? <PoolSections entity={entity} update={update} /> : null}
      {entity.kind === 'account' ? <AccountSections entity={entity} update={update} /> : null}
      {entity.kind === 'proxy' ? <ProxySections entity={entity} update={update} /> : null}

      <Section title="指标" dense>
        <div className="kpa-insp-spark">
          <Sparkline
            data={history}
            width={300}
            height={40}
            tone={failRate > 0.2 ? 'danger' : failRate > 0.05 ? 'warn' : 'accent'}
            fill
          />
        </div>
        <div className="kpa-insp-metrics">
          <Stat label="请求" value={formatNumber(metrics.requests)} />
          <Stat label="成功" value={formatNumber(metrics.success)} tone="ok" />
          <Stat label="失败" value={formatNumber(metrics.failed)} tone={metrics.failed > 0 ? 'danger' : 'default'} />
          <Stat
            label="限流"
            value={formatNumber(metrics.rateLimited)}
            tone={metrics.rateLimited > 0 ? 'warn' : 'default'}
          />
          <Stat label="平均延迟" value={formatMs(metrics.avgLatencyMs)} />
          <Stat label="p95" value={formatMs(metrics.p95LatencyMs)} />
          <Stat label="RPM" value={formatNumber(metrics.rpm)} />
          <Stat label="在途" value={formatNumber(metrics.inFlight)} />
        </div>
        <div className="kpa-insp-inline">
          <span className="kpa-insp-quiet">最近使用</span>
          <code className="kpa-insp-code">{formatRelativeTime(metrics.lastUsedAt)}</code>
        </div>
      </Section>

      <Section title="备注与标签" dense>
        <DebouncedTextField
          key={`${entity.id}-note`}
          label="备注"
          value={entity.note}
          onCommit={(v) => update({ note: v })}
          placeholder="给运维同学的说明…"
        />
        <TagList
          tags={entity.tags}
          onRemove={(t) => update({ tags: entity.tags.filter((x) => x !== t) })}
          onAdd={(t) => {
            if (!entity.tags.includes(t)) update({ tags: [...entity.tags, t] })
          }}
        />
      </Section>
    </aside>
  )
}
