import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertTriangle, ArrowLeftRight, Gauge as Gauge2, Link2, Trash2, Unlink, Unplug } from 'lucide-react'
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_LABEL_CN,
  ACCOUNT_TYPE_PRESETS,
  KIND_ORDER,
  LATENCY_SCALE_MS,
  MODELS,
  PROVIDERS,
  PROXY_PROTOCOLS,
  ROUTING_STRATEGIES,
  canJoinPool,
  edgeId,
  formatMs,
  formatNumber,
  formatRelativeTime,
  isDetached,
  isServing,
  percent,
  poolOfAccount,
} from '@kpa/shared'
import type {
  AccountEntity,
  AccountType,
  CredentialType,
  Entity,
  EntityKind,
  GatewayEntity,
  GraphState,
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
  ConfirmDialog,
  Gauge,
  IconButton,
  MetricBar,
  MiniBars,
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
  deleteConsequences,
  proxyDisableCasualties,
  proxyDisableMessage,
  proxyEnableMessage,
  proxyEnableRevivals,
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
import { useConsole, useEdgeMetrics, useEntity } from '@/lib/store'

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

/** Every entity in the graph, gateway included (it is a singleton, not a list). */
function everyEntity(state: GraphState): Entity[] {
  const gateway = state.gateway as GatewayEntity | undefined
  return [
    ...(gateway ? [gateway as Entity] : []),
    ...state.keys,
    ...state.pools,
    ...state.accounts,
    ...state.proxies,
  ]
}

/** Loose IPv4/IPv6 shape check — tints the field, never blocks saving. */
function looksLikeIp(value: string): boolean {
  const t = value.trim()
  if (t.length === 0) return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) return t.split('.').every((p) => Number(p) <= 255)
  return t.includes(':') && /^[0-9a-fA-F:.]+$/.test(t)
}

/** Text input that commits to the server ~300ms after the user stops typing. */
function DebouncedTextField(props: {
  label: string
  value: string
  onCommit: (v: string) => void
  mono?: boolean
  placeholder?: string
  hint?: string
  disabled?: boolean
  className?: string
}): JSX.Element {
  const { label, value, onCommit, mono, placeholder, hint, disabled, className } = props
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
      className={className}
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

/* ---------------------------------------------------- per-edge metrics ---- */

function edgeRateTone(rate: number): 'ok' | 'warn' | 'danger' {
  if (rate >= 0.98) return 'ok'
  if (rate >= 0.9) return 'warn'
  return 'danger'
}

/**
 * Inline per-relation traffic read-out: request count, success rate, a
 * MiniBars chart and (optionally) this relation's share of a parent total.
 * All cells are fixed-width so a column of rows compares at a glance.
 */
function RelationMetrics(props: {
  source: string
  target: string
  /** 0..1 share of the parent's total, e.g. one member of the pool. */
  share?: number | null
}): JSX.Element {
  const { source, target, share } = props
  const metrics = useEdgeMetrics(edgeId(source, target))
  const requests = metrics?.requests ?? 0
  const rate = metrics && requests > 0 ? metrics.success / requests : null

  return (
    <div className="kpa-insp-edge" data-idle={requests === 0 ? 'true' : undefined}>
      <MiniBars
        data={metrics?.history ?? []}
        width={56}
        height={14}
        tone={rate === null ? 'accent' : edgeRateTone(rate)}
        className="kpa-insp-edge-bars"
      />
      <span className="kpa-insp-edge-req kpa-mono" title="累计请求数">
        {requests === 0 ? '0 请求' : formatNumber(requests)}
      </span>
      <span className="kpa-insp-edge-rate kpa-mono" data-tone={rate === null ? undefined : edgeRateTone(rate)} title="成功率">
        {rate === null ? '—' : `${Math.round(rate * 100)}%`}
      </span>
      {share !== undefined && share !== null ? (
        <span className="kpa-insp-edge-share kpa-mono" title="占父级流量份额">
          {Math.round(share * 100)}%
        </span>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------- detaching -- */

/**
 * Feature 5 — 从上游解绑: parks a pool / account / proxy with no upstream
 * relation at all. Legal and reversible through the existing bind selects.
 */
function DetachSection({ entity }: { entity: Entity }): JSX.Element | null {
  const state = useConsole((s) => s.state)
  const unbind = useConsole((s) => s.unbind)

  if (entity.kind !== 'pool' && entity.kind !== 'account' && entity.kind !== 'proxy') return null

  const detached = isDetached(state, entity)

  if (detached) {
    return (
      <p className="kpa-insp-warnhint">
        <Unplug size={11} />
        <span>该节点当前处于游离（未接入）状态，不会收到任何流量；通过下方的绑定选择即可重新接入。</span>
      </p>
    )
  }

  let action: (() => void) | null = null
  let disabledReason: string | null = null

  if (entity.kind === 'pool') {
    const boundKeys = state.keys.filter((k) => k.bindings.some((b) => b.poolId === entity.id))
    action = () => {
      void (async () => {
        for (const key of boundKeys) {
          await unbind({ kind: 'key', id: key.id }, { kind: 'pool', id: entity.id })
        }
      })()
    }
  } else if (entity.kind === 'account') {
    const account = entity as AccountEntity
    const owner = account.poolId
    action = owner
      ? () => {
          void unbind({ kind: 'pool', id: owner }, { kind: 'account', id: account.id })
        }
      : null
  } else {
    const users = state.accounts.filter((a) => a.proxyId === entity.id)
    const parked = users.filter((a) => a.poolId === null)
    const pooled = users.length - parked.length
    if (pooled > 0) {
      disabledReason = `${pooled} 个在池账号仍在使用该代理：请先将它们移出池，或为它们换绑其他代理。`
    }
    action =
      parked.length > 0
        ? () => {
            void (async () => {
              for (const account of parked) {
                await unbind({ kind: 'account', id: account.id }, { kind: 'proxy', id: entity.id })
              }
            })()
          }
        : null
  }

  return (
    <div className="kpa-insp-detach">
      <Button
        variant="ghost"
        size="sm"
        full
        icon={<Unplug size={12} />}
        disabled={!action}
        onClick={action ?? undefined}
        title="移除该节点的全部上游关联，使其进入游离（未接入）状态"
      >
        从上游解绑
      </Button>
      <p className="kpa-insp-hint">
        {disabledReason ?? '解绑后该节点变为未接入，不再接收流量；随时可以重新绑定接入。'}
      </p>
    </div>
  )
}

/* ---------------------------------------------------------- shared rows -- */

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

/**
 * "Add member" picker for the pool inspector.
 *
 * An account belongs to at most one pool, so the candidates fall into two very
 * different buckets: unassigned accounts are a plain add, accounts owned by
 * another pool are a *move* (the server re-parents them on `bind`). They are
 * grouped apart and the move is gated behind an inline confirmation so a
 * mis-click can never silently steal an account from another pool.
 *
 * Feature 9: an account without an egress proxy may not serve, so proxy-less
 * accounts are excluded from the candidates entirely and named in the hint —
 * the fix (bind a proxy first) is spelled out where the operator is looking.
 */
function AddPoolMember({ pool }: { pool: PoolEntity }): JSX.Element {
  const state = useConsole((s) => s.state)
  const bind = useConsole((s) => s.bind)
  const [pending, setPending] = useState<{ account: AccountEntity; from: PoolEntity } | null>(null)

  const { free, owned, blocked } = useMemo(() => {
    const members = new Set(pool.members.map((m) => m.accountId))
    const freeList: AccountEntity[] = []
    const ownedList: { account: AccountEntity; from: PoolEntity }[] = []
    const blockedList: AccountEntity[] = []
    for (const account of state.accounts) {
      if (members.has(account.id)) continue
      if (!canJoinPool(account)) {
        blockedList.push(account)
        continue
      }
      const owner = poolOfAccount(state, account.id)
      if (owner && owner.id !== pool.id) ownedList.push({ account, from: owner })
      else freeList.push(account)
    }
    return { free: freeList, owned: ownedList, blocked: blockedList }
  }, [state, pool])

  // Never carry a confirmation across a selection change.
  useEffect(() => {
    setPending(null)
  }, [pool.id])

  const runBind = (accountId: string) => {
    void bind({ kind: 'pool', id: pool.id }, { kind: 'account', id: accountId })
  }

  const onPick = (id: string) => {
    const move = owned.find((entry) => entry.account.id === id)
    if (move) {
      setPending(move)
      return
    }
    setPending(null)
    runBind(id)
  }

  const blockedHint =
    blocked.length > 0
      ? `以下账号尚未绑定代理，无法加入池：${blocked.map((a) => a.name).join('、')}。先为它们绑定出口代理即可加入。`
      : undefined

  if (free.length === 0 && owned.length === 0) {
    return (
      <>
        <div className="kpa-insp-quiet kpa-insp-addnone">没有可加入的账号了</div>
        {blockedHint ? (
          <p className="kpa-insp-warnhint">
            <AlertTriangle size={11} />
            <span>{blockedHint}</span>
          </p>
        ) : null}
      </>
    )
  }

  return (
    <>
      <div className="kpa-insp-add">
        <SelectField<string>
          label="添加成员"
          value=""
          options={[{ value: '', label: '选择一个账号…' }]}
          groups={[
            {
              label: '未接入的账号',
              options: free.map((account) => ({ value: account.id, label: account.name })),
            },
            {
              label: '属于其他池',
              options: owned.map(({ account, from }) => ({
                value: account.id,
                label: `${account.name}（当前属于：${from.name}）`,
              })),
            },
          ]}
          onChange={(v) => {
            if (v) onPick(v)
          }}
          hint={
            owned.length > 0
              ? '一个账号只能属于一个池；选中「属于其他池」里的账号会把它移入本池。'
              : undefined
          }
        />
        <Link2 size={12} className="kpa-insp-add-icon" />
      </div>
      {blockedHint ? (
        <p className="kpa-insp-warnhint">
          <AlertTriangle size={11} />
          <span>{blockedHint}</span>
        </p>
      ) : null}
      {pending ? (
        <div className="kpa-insp-confirm" role="group" aria-label="确认移入账号">
          <p className="kpa-insp-confirm-text">
            将从「{pending.from.name}」移入本池？「{pending.account.name}」会立即离开原来的池。
          </p>
          <div className="kpa-insp-confirm-actions">
            <Button
              size="sm"
              variant="primary"
              icon={<ArrowLeftRight size={12} />}
              onClick={() => {
                const target = pending
                setPending(null)
                runBind(target.account.id)
              }}
            >
              确认移入
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
              取消
            </Button>
          </div>
        </div>
      ) : null}
    </>
  )
}

/* --------------------------------------------------------------- gateway -- */

function GatewaySections({ entity, update }: { entity: GatewayEntity; update: Updater }): JSX.Element {
  const keys = useConsole((s) => s.state.keys)
  const edgeMetrics = useConsole((s) => s.edgeMetrics)

  const rows = useMemo(() => {
    const list = keys.map((key) => ({
      key,
      requests: edgeMetrics[edgeId(entity.id, key.id)]?.requests ?? 0,
    }))
    list.sort((a, b) => b.requests - a.requests || a.key.name.localeCompare(b.key.name))
    const total = list.reduce((sum, row) => sum + row.requests, 0)
    return { list, total }
  }, [keys, edgeMetrics, entity.id])

  return (
    <>
      <Section title="入口" dense>
        <DebouncedTextField
          key={`${entity.id}-endpoint`}
          label="入口地址"
          value={entity.endpoint}
          onCommit={(v) => update({ endpoint: v })}
          mono
          placeholder="https://gw.limi.dev/v1"
          hint="客户端调用的公共 Base URL，所有请求由此进入。"
        />
        <TextField label="版本" value={entity.version} onChange={() => undefined} mono disabled />
      </Section>

      <Section title="全局限流" dense>
        <div className="kpa-insp-grid2">
          <NumberField
            label="速率限制"
            value={entity.rateLimit.rpm}
            min={0}
            max={1000000}
            step={10}
            suffix="次/分钟"
            onChange={(v) => update({ rateLimit: { ...entity.rateLimit, rpm: Math.round(v) } })}
            hint="0 = 不限"
          />
          <NumberField
            label="并发上限"
            value={entity.rateLimit.concurrency}
            min={0}
            max={100000}
            step={1}
            onChange={(v) => update({ rateLimit: { ...entity.rateLimit, concurrency: Math.round(v) } })}
            hint="0 = 不限"
          />
        </div>
        <p className="kpa-insp-hint">全局准入控制：在所有密钥限流之前生效，超过即以 gateway-rate-limited 拒绝。</p>
      </Section>

      <Section title="密钥流量分布" dense>
        {rows.list.length === 0 ? (
          <div className="kpa-insp-quiet">还没有密钥。</div>
        ) : (
          rows.list.map(({ key, requests }) => (
            <div className="kpa-insp-rel" data-kind="key" key={key.id}>
              <div className="kpa-insp-rel-head">
                <StatusDot status={key.status} size={7} />
                <span className="kpa-insp-rel-name" title={key.name}>
                  {key.name}
                </span>
              </div>
              <div className="kpa-insp-rel-body">
                <RelationMetrics
                  source={entity.id}
                  target={key.id}
                  share={rows.total > 0 ? requests / rows.total : 0}
                />
              </div>
            </div>
          ))
        )}
      </Section>
    </>
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
            label="速率限制"
            value={entity.rateLimit.rpm}
            min={0}
            max={100000}
            step={1}
            suffix="次/分钟"
            onChange={(v) => update({ rateLimit: { ...entity.rateLimit, rpm: Math.round(v) } })}
            hint="0 = 不限速"
          />
          <NumberField
            label="并发上限"
            value={entity.rateLimit.concurrency}
            min={0}
            max={2000}
            step={1}
            onChange={(v) => update({ rateLimit: { ...entity.rateLimit, concurrency: Math.round(v) } })}
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
                <RelationMetrics source={entity.id} target={binding.poolId} />
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
  const edgeMetrics = useConsole((s) => s.edgeMetrics)
  const unbind = useConsole((s) => s.unbind)

  // Send only the row that changed; the server merges it into the live array.
  const setMember = (accountId: string, patch: Partial<PoolMember>) => {
    update({ member: { accountId, ...patch } })
  }

  /** Denominator for the per-member share: the pool's total edge traffic. */
  const memberTotal = useMemo(
    () =>
      entity.members.reduce(
        (sum, member) => sum + (edgeMetrics[edgeId(entity.id, member.accountId)]?.requests ?? 0),
        0,
      ),
    [entity.id, entity.members, edgeMetrics],
  )

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
        <p className="kpa-insp-hint">
          账号独占归属：一个账号同一时间只能属于一个池，加入本池即离开原来的池。
        </p>
        {entity.members.length === 0 ? (
          <div className="kpa-insp-quiet">池内没有账号，命中该池的请求会以 no-account 失败。</div>
        ) : (
          entity.members.map((member) => {
            const account = accounts.find((a) => a.id === member.accountId)
            const requests = edgeMetrics[edgeId(entity.id, member.accountId)]?.requests ?? 0
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
                {account ? (
                  <div className="kpa-insp-inline">
                    <span
                      className="kpa-type-badge"
                      data-type={account.accountType}
                      title={`账号类型：${ACCOUNT_TYPE_LABEL_CN[account.accountType]}`}
                    >
                      {ACCOUNT_TYPE_LABEL_CN[account.accountType]}
                    </span>
                    <span className="kpa-insp-quiet">{providerLabel(account.provider)}</span>
                  </div>
                ) : null}
                <RelationMetrics
                  source={entity.id}
                  target={member.accountId}
                  share={memberTotal > 0 ? requests / memberTotal : 0}
                />
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
        <AddPoolMember pool={entity} />
      </Section>
    </>
  )
}

/* --------------------------------------------------------------- account -- */

function AccountSections({ entity, update }: { entity: AccountEntity; update: Updater }): JSX.Element {
  const pools = useConsole((s) => s.state.pools)
  const proxies = useConsole((s) => s.state.proxies)
  const bind = useConsole((s) => s.bind)
  const unbind = useConsole((s) => s.unbind)

  // Feature 7: switching the plan type applies its preset; when that would
  // clobber hand-tuned limits, ask first.
  const [pendingType, setPendingType] = useState<AccountType | null>(null)

  const quotaPct = percent(entity.quota.usedTokens, entity.quota.limitTokens)

  const owner = pools.find((p) => p.id === entity.poolId) ?? null
  const noProxy = entity.proxyId === null
  const autoDisabledByProxy = entity.autoDisabledBy
    ? (proxies.find((p) => p.id === entity.autoDisabledBy) ?? null)
    : null

  /*
   * Membership is never PATCHed: `poolId` is a derived back-reference the
   * server recomputes from `PoolEntity.members`, so it only ever moves through
   * bind / unbind. Joining another pool is a single `bind` — the server treats
   * it as a move and drops the account from its previous pool.
   */
  const onPoolChange = (next: string) => {
    const current = entity.poolId ?? ''
    if (current === next) return
    if (next === '') {
      if (current) void unbind({ kind: 'pool', id: current }, { kind: 'account', id: entity.id })
      return
    }
    void bind({ kind: 'pool', id: next }, { kind: 'account', id: entity.id })
  }

  /*
   * Feature 9: `bind(account, proxy)` REPLACES the previous proxy, so swapping
   * egress is a single bind — never unbind-then-bind, which would be rejected
   * for an in-pool account. Clearing (`''`) is only offered while parked.
   */
  const onProxyChange = (next: string) => {
    const current = entity.proxyId ?? ''
    if (current === next) return
    if (next === '') {
      if (current) void unbind({ kind: 'account', id: entity.id }, { kind: 'proxy', id: current })
      return
    }
    void bind({ kind: 'account', id: entity.id }, { kind: 'proxy', id: next })
  }

  /** True when the operator moved off the current type's preset numbers. */
  const handTuned = useMemo(() => {
    const preset = ACCOUNT_TYPE_PRESETS[entity.accountType]
    if (!preset) return false
    return (
      entity.rateLimit.rpm !== preset.rateLimit.rpm ||
      entity.rateLimit.concurrency !== preset.rateLimit.concurrency ||
      entity.quota.limitTokens !== preset.quotaTokens ||
      entity.models.join(',') !== preset.models.join(',')
    )
  }, [entity.accountType, entity.rateLimit, entity.quota.limitTokens, entity.models])

  const applyType = (next: AccountType) => {
    const preset = ACCOUNT_TYPE_PRESETS[next]
    // The preset fills rate limit / quota / models; the per-entity values stay
    // authoritative for the simulator — the type is defaults + classification,
    // never a hidden multiplier.
    update({
      accountType: next,
      rateLimit: { ...preset.rateLimit },
      quota: { ...entity.quota, limitTokens: preset.quotaTokens },
      models: [...preset.models],
    })
  }

  const onTypeChange = (next: AccountType) => {
    if (next === entity.accountType) return
    if (handTuned) {
      setPendingType(next)
      return
    }
    applyType(next)
  }

  return (
    <>
      <Section title="归属" dense>
        {autoDisabledByProxy ? (
          <p className="kpa-insp-warnhint">
            <AlertTriangle size={11} />
            <span>
              该账号因代理「{autoDisabledByProxy.name}」停用而被自动停用；代理恢复启用后会自动恢复。
            </span>
          </p>
        ) : null}
        <SelectField<string>
          label="所属池"
          value={entity.poolId ?? ''}
          options={[
            { value: '', label: noProxy ? '未接入（需先绑定代理）' : '未接入' },
            ...pools.map((p) => ({ value: p.id, label: p.name, disabled: noProxy })),
          ]}
          onChange={onPoolChange}
          hint={
            noProxy
              ? `账号「${entity.name}」尚未绑定代理，请先在下方绑定出口代理，再加入池。`
              : '一个账号只能属于一个池；切换到别的池会把它整体移过去。'
          }
        />
        {owner ? null : (
          <p className="kpa-insp-warnhint">
            <AlertTriangle size={11} />
            <span>该账号未接入任何池，接入之前不会收到任何流量。</span>
          </p>
        )}
      </Section>

      <Section title="凭证" dense>
        <SelectField<Provider>
          label="供应商"
          value={entity.provider}
          options={PROVIDERS.map((p) => ({ value: p, label: providerLabel(p) }))}
          onChange={(v) => update({ provider: v })}
        />
        <SelectField<AccountType>
          label="账号类型"
          value={entity.accountType}
          options={ACCOUNT_TYPES.map((t) => ({ value: t, label: ACCOUNT_TYPE_LABEL_CN[t] }))}
          onChange={onTypeChange}
          hint="类型决定限流 / 配额 / 模型的预设；切换会应用新类型的预设值。"
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
            label="速率限制"
            value={entity.rateLimit.rpm}
            min={0}
            max={100000}
            step={10}
            suffix="次/分钟"
            onChange={(v) => update({ rateLimit: { ...entity.rateLimit, rpm: Math.round(v) } })}
            hint="0 = 不限"
          />
          <NumberField
            label="并发上限"
            value={entity.rateLimit.concurrency}
            min={0}
            max={2000}
            step={1}
            onChange={(v) => update({ rateLimit: { ...entity.rateLimit, concurrency: Math.round(v) } })}
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
            // An in-pool account must keep a proxy (feature 9): clearing is
            // only offered while the account is parked outside every pool.
            { value: '', label: '未配置代理', disabled: entity.poolId !== null },
            ...proxies.map((p) => ({
              value: p.id,
              label: `${countryFlag(p.countryCode)} ${p.name} · ${p.country}`,
            })),
          ]}
          onChange={onProxyChange}
          hint={
            entity.poolId !== null
              ? '在池账号必须保持有代理：可直接切换到其他代理；如需解绑请先将账号移出池。'
              : '出口代理决定该账号的落地 IP 与地区；绑定后才能加入池。'
          }
        />
        {entity.proxyId ? <RelationMetrics source={entity.id} target={entity.proxyId} /> : null}
        {noProxy ? (
          <p className="kpa-insp-warnhint">
            <AlertTriangle size={11} />
            <span>未绑定代理 · 无法加入池。在上方选择一个出口代理即可解除限制。</span>
          </p>
        ) : null}
      </Section>

      <ConfirmDialog
        open={pendingType !== null}
        title={`切换为「${pendingType ? ACCOUNT_TYPE_LABEL_CN[pendingType] : ''}」？`}
        body={
          <>
            <p>
              该账号的限流 / 配额 / 模型列表已被手动调整过；切换类型会用「
              {pendingType ? ACCOUNT_TYPE_LABEL_CN[pendingType] : ''}」的预设值覆盖这些手动数值。
            </p>
            <p className="kpa-dialog__note">切换后仍可继续手动微调各项数值。</p>
          </>
        }
        confirmLabel="切换并应用预设"
        onConfirm={() => {
          const next = pendingType
          setPendingType(null)
          if (next) applyType(next)
        }}
        onCancel={() => setPendingType(null)}
      />
    </>
  )
}

/* ----------------------------------------------------------------- proxy -- */

function ProxySections({ entity, update }: { entity: ProxyEntity; update: Updater }): JSX.Element {
  const accounts = useConsole((s) => s.state.accounts)
  const users = accounts.filter((a) => a.proxyId === entity.id)
  const ipValid = looksLikeIp(entity.ip)

  return (
    <>
      <Section title="出口" dense>
        {/*
         * Two addresses, kept deliberately apart: `ip` is the EGRESS IP the
         * upstream provider sees; `host:port` below is the DIAL ENDPOINT the
         * gateway connects to. They are not the same address.
         */}
        <DebouncedTextField
          key={`${entity.id}-ip`}
          label="出口 IP"
          value={entity.ip}
          onCommit={(v) => update({ ip: v.trim() })}
          mono
          placeholder="203.0.113.10"
          hint={
            ipValid
              ? '上游供应商实际看到的落地地址。'
              : '格式看起来不像 IPv4 / IPv6 —— 仅提示，不阻止保存。'
          }
          className={ipValid ? undefined : 'kpa-field--warn'}
        />
        <div className="kpa-insp-grid2">
          <DebouncedTextField
            key={`${entity.id}-country`}
            label="国家 / 地区"
            value={entity.country}
            onCommit={(v) => update({ country: v })}
            placeholder="美国"
          />
          <DebouncedTextField
            key={`${entity.id}-cc`}
            label={`代码 ${countryFlag(entity.countryCode)}`}
            value={entity.countryCode}
            onCommit={(v) => update({ countryCode: v.toUpperCase().slice(0, 2) })}
            mono
            placeholder="SG"
          />
        </div>
      </Section>

      <Section title="接入端点" dense>
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
          hint="拨号地址（host:port），区别于上面的出口 IP。"
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
        <DebouncedTextField
          key={`${entity.id}-region`}
          label="区域"
          value={entity.region}
          onCommit={(v) => update({ region: v })}
          mono
        />
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
          hint="关闭后经过该代理的请求会以 proxy-error 失败（不会自动停用账号）"
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
              <div className="kpa-insp-user kpa-insp-user--stack" data-kind="account" key={a.id}>
                <div className="kpa-insp-user-row">
                  <StatusDot status={a.status} size={7} />
                  <span className="kpa-insp-user-name">{a.name}</span>
                  <span
                    className="kpa-type-badge"
                    data-type={a.accountType}
                    title={`账号类型：${ACCOUNT_TYPE_LABEL_CN[a.accountType]}`}
                  >
                    {ACCOUNT_TYPE_LABEL_CN[a.accountType]}
                  </span>
                  <span className="kpa-insp-user-meta">{providerLabel(a.provider)}</span>
                </div>
                <RelationMetrics source={a.id} target={entity.id} />
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

  const everything = useMemo(() => everyEntity(state), [state])

  const rollup = useMemo(() => {
    const acc = {} as Record<EntityKind, { total: number; healthy: number }>
    for (const kind of KIND_ORDER) acc[kind] = { total: 0, healthy: 0 }
    for (const item of everything) {
      acc[item.kind].total += 1
      if (item.enabled && isServing(item.status)) acc[item.kind].healthy += 1
    }
    return acc
  }, [everything])

  const unhealthy = useMemo(
    () =>
      everything
        .filter((item) => !item.enabled || item.status !== 'healthy')
        .sort(
          (a, b) =>
            (STATUS_SEVERITY[b.status] ?? 0) - (STATUS_SEVERITY[a.status] ?? 0) ||
            b.metrics.requests - a.metrics.requests,
        )
        .slice(0, 5),
    [everything],
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
        {KIND_ORDER.map((kind) => {
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
  const state = useConsole((s) => s.state)
  const updateEntity = useConsole((s) => s.updateEntity)
  const deleteEntity = useConsole((s) => s.deleteEntity)
  const select = useConsole((s) => s.select)

  // Feature 6: deleting always goes through a real modal dialog.
  const [deleteOpen, setDeleteOpen] = useState(false)
  // Feature 10: flipping the proxy enable toggle confirms the cascade first.
  const [pendingToggle, setPendingToggle] = useState<{ next: boolean; message: string } | null>(null)

  useEffect(() => {
    setDeleteOpen(false)
    setPendingToggle(null)
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
  const isGateway = entity.kind === 'gateway'

  const consequenceLines = deleteOpen ? deleteConsequences(state, entity) : []

  const onEnabledChange = (next: boolean): void => {
    if (entity.kind === 'proxy') {
      const proxy = entity as ProxyEntity
      if (next) {
        const revivals = proxyEnableRevivals(state, proxy)
        if (revivals.length > 0) {
          setPendingToggle({ next, message: proxyEnableMessage(proxy, revivals) })
          return
        }
      } else {
        const casualties = proxyDisableCasualties(state, proxy)
        if (casualties.length > 0) {
          setPendingToggle({ next, message: proxyDisableMessage(proxy, casualties) })
          return
        }
      }
    }
    update({ enabled: next })
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
          label={isGateway ? '网关总开关' : '启用'}
          value={entity.enabled}
          onChange={onEnabledChange}
          hint={
            isGateway
              ? '总开关（kill switch）：停用后所有请求在入口被拒绝，整个操作台停摆。'
              : '停用后不再参与路由'
          }
        />
        <DetachSection entity={entity} />
        {isGateway ? null : (
          <Button
            variant="danger"
            size="sm"
            full
            icon={<Trash2 size={13} />}
            onClick={() => setDeleteOpen(true)}
            title="删除该节点并解除全部关联"
          >
            删除
          </Button>
        )}
      </header>

      {entity.kind === 'gateway' ? (
        <GatewaySections entity={entity as GatewayEntity} update={update} />
      ) : null}
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

      <ConfirmDialog
        open={deleteOpen}
        title={`删除${kindLabel(entity.kind)}「${entity.name}」？`}
        body={
          <>
            {consequenceLines.slice(0, -1).map((line, i) => (
              <p key={i}>{line}</p>
            ))}
            {consequenceLines.length > 0 ? (
              <p className="kpa-dialog__note">{consequenceLines[consequenceLines.length - 1]}</p>
            ) : null}
          </>
        }
        confirmLabel="删除"
        tone="danger"
        onConfirm={() => {
          setDeleteOpen(false)
          select(null)
          void deleteEntity(entity.kind, entity.id)
        }}
        onCancel={() => setDeleteOpen(false)}
      />

      <ConfirmDialog
        open={pendingToggle !== null}
        title={pendingToggle?.next ? `启用代理「${entity.name}」？` : `停用代理「${entity.name}」？`}
        body={<p>{pendingToggle?.message}</p>}
        confirmLabel={pendingToggle?.next ? '启用' : '停用'}
        tone={pendingToggle?.next ? 'default' : 'danger'}
        onConfirm={() => {
          const next = pendingToggle?.next
          setPendingToggle(null)
          if (next !== undefined) update({ enabled: next })
        }}
        onCancel={() => setPendingToggle(null)}
      />
    </aside>
  )
}
