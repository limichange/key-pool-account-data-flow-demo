import { useCallback, useMemo } from 'react'
import { AlertTriangle, Plus, Search, Unplug } from 'lucide-react'
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_LABEL_CN,
  HEALTH_STATUSES,
  KIND_LABEL_CN,
  KIND_ORDER,
  STATUS_LABEL_CN,
  detachedEntities,
  isServing,
} from '@kpa/shared'
import type { Entity, EntityKind, GatewayEntity } from '@kpa/shared'

import { IconButton, MetricBar, Section, StatusDot, TextField, ToggleField } from '@/components'
import { kindIcon } from '@/lib/format'
import { useConsole } from '@/lib/store'

const CHAIN_HINT: Record<EntityKind, string> = {
  gateway: '统一入口：所有客户端请求先经过网关，网关到密钥的边即每个密钥的流量份额',
  key: '客户端凭证：携带配额与限流，绑定到一个或多个池',
  pool: '路由池：按策略在成员账号之间分发请求',
  account: '上游账号：真正持有供应商凭证并发起调用',
  proxy: '出口代理：决定落地 IP 与地区，可被多个账号复用',
}

const CREATE_LABEL: Record<EntityKind, string> = {
  gateway: '', // singleton — never creatable
  key: '新建密钥',
  pool: '新建池',
  account: '新建账号',
  proxy: '新建代理',
}

/** Kinds the operator can create: the gateway is a singleton, never creatable. */
const CREATABLE_KINDS = KIND_ORDER.filter((kind) => kind !== 'gateway')

/**
 * The relations and their exact cardinality, plus the edge colour rule. This
 * is the clearest place in the console to teach the model, so it is spelled
 * out rather than implied.
 */
const CARDINALITY_RULES: [string, string][] = [
  ['网关 → 密钥', '单一入口：所有请求先经网关再分流到密钥；该边隐式存在，不可编辑'],
  ['密钥 ⇄ 池', '多对多：一个密钥可绑定多个池，一个池也能被多个密钥绑定'],
  ['池 → 账号', '一对多：一个池持有多个账号，但一个账号只能属于一个池'],
  ['账号 → 代理', '多对一：一个账号最多一个代理，一个代理可服务多个账号'],
  ['游离节点', '合法状态：池 / 账号 / 代理可以暂时没有任何上游，接入之前不收流量'],
  ['连线颜色', '两端节点都启用 = 绿色（链路存活）；任一端停用 = 灰色虚线（链路断开）'],
]

const SHORTCUTS: [string, string][] = [
  ['Space', '暂停 / 继续模拟器'],
  ['I', '注入 5 条请求'],
  ['A', '自动布局：一键整理画布'],
  ['L', '收起 / 展开请求流'],
  ['M', '显示 / 隐藏小地图'],
  ['Del', '删除选中的节点或连线（弹出确认）'],
  ['Esc', '取消选中与链路高亮'],
]

export function Palette(): JSX.Element {
  const state = useConsole((s) => s.state)
  const search = useConsole((s) => s.search)
  const kindFilter = useConsole((s) => s.kindFilter)
  const onlyProblems = useConsole((s) => s.onlyProblems)
  const setSearch = useConsole((s) => s.setSearch)
  const toggleKind = useConsole((s) => s.toggleKind)
  const setOnlyProblems = useConsole((s) => s.setOnlyProblems)
  const createEntity = useConsole((s) => s.createEntity)

  /** Every entity including the gateway singleton (it is not in a list). */
  const everything = useMemo<Entity[]>(() => {
    const gateway = state.gateway as GatewayEntity | undefined
    return [
      ...(gateway ? [gateway as Entity] : []),
      ...state.keys,
      ...state.pools,
      ...state.accounts,
      ...state.proxies,
    ]
  }, [state])

  const rollup = useMemo(() => {
    const acc = {} as Record<EntityKind, { total: number; healthy: number }>
    for (const kind of KIND_ORDER) acc[kind] = { total: 0, healthy: 0 }
    for (const entity of everything) {
      const bucket = acc[entity.kind]
      bucket.total += 1
      if (entity.enabled && isServing(entity.status)) bucket.healthy += 1
    }
    return acc
  }, [everything])

  /**
   * Feature 5: pools / accounts / proxies with no upstream relation at all.
   * A detached node is legal but a dead end — it must never be invisible.
   */
  const detached = useMemo(() => detachedEntities(state), [state])
  const detachedTitle = useMemo(() => {
    if (detached.length === 0) return '每个池 / 账号 / 代理都已接入上游'
    const byKind = new Map<EntityKind, number>()
    for (const item of detached) byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1)
    const parts = Array.from(byKind.entries()).map(
      ([kind, count]) => `${KIND_LABEL_CN[kind]} ${count}`,
    )
    return `这些节点没有任何上游关联，不会收到流量：${parts.join('，')}`
  }, [detached])

  /** Feature 7: plan-type mix across the account fleet, with unhealthy counts. */
  const typeBreakdown = useMemo(
    () =>
      ACCOUNT_TYPES.map((type) => {
        const of = state.accounts.filter((a) => a.accountType === type)
        const bad = of.filter((a) => !a.enabled || !isServing(a.status)).length
        return { type, total: of.length, bad }
      }),
    [state.accounts],
  )

  /** How many entities the current free-text search actually matches. */
  const matchCount = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (needle.length === 0) return -1
    return everything.filter((entity) => {
      if (!kindFilter[entity.kind]) return false
      if (onlyProblems && entity.status === 'healthy') return false
      return `${entity.id} ${entity.name} ${entity.note} ${entity.tags.join(' ')}`
        .toLowerCase()
        .includes(needle)
    }).length
  }, [everything, search, kindFilter, onlyProblems])

  const onCreate = useCallback(
    (kind: EntityKind) => {
      const index = rollup[kind].total + 1
      const suffix = String(index).padStart(2, '0')
      void createEntity(kind, { name: `${KIND_LABEL_CN[kind]}-${suffix}` })
    },
    [createEntity, rollup],
  )

  return (
    <aside className="kpa-palette kpa-scroll">
      {/* Order matters: what decodes the console comes first, and the least
          urgent action in a read-only demo (creating entities) comes last. */}
      <Section title="概览" dense rail="hide">
        <div className="kpa-pal-rollup">
          {KIND_ORDER.map((kind) => {
            const { total, healthy } = rollup[kind]
            const bad = total - healthy
            const tone = bad === 0 ? 'ok' : bad * 2 > total ? 'danger' : 'warn'
            return (
              <div className="kpa-pal-rollup-row" data-kind={kind} key={kind}>
                <MetricBar
                  value={healthy}
                  max={Math.max(total, 1)}
                  tone={tone}
                  height={4}
                  label={<span className="kpa-pal-rollup-name">{KIND_LABEL_CN[kind]}</span>}
                  right={
                    <span className="kpa-pal-rollup-right">
                      {healthy}/{total}
                      {bad > 0 ? <em className="kpa-pal-rollup-bad">{bad} 异常</em> : null}
                    </span>
                  }
                />
              </div>
            )
          })}
          <div
            className="kpa-pal-orphans"
            data-warn={detached.length > 0 ? 'true' : undefined}
            title={detachedTitle}
          >
            <span className="kpa-pal-orphans-label">
              {detached.length > 0 ? <Unplug size={11} /> : null}
              游离节点
            </span>
            <span className="kpa-pal-orphans-count">{detached.length}</span>
          </div>
          <div className="kpa-pal-types">
            <div className="kpa-pal-caption">账号类型</div>
            {typeBreakdown.map(({ type, total, bad }) => (
              <div className="kpa-pal-type-row" key={type} data-warn={bad > 0 ? 'true' : undefined}>
                <span className="kpa-type-badge" data-type={type}>
                  {ACCOUNT_TYPE_LABEL_CN[type]}
                </span>
                <span className="kpa-pal-type-count kpa-mono">{total}</span>
                <span className="kpa-pal-type-bad">{bad > 0 ? `${bad} 异常` : ''}</span>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section title="筛选" dense>
        <TextField
          label="搜索"
          value={search}
          onChange={setSearch}
          placeholder="名称 / ID / 主机 / 标签"
          hint="匹配的节点高亮，其余淡出"
        />
        <div className="kpa-pal-chips" role="group" aria-label="按类型筛选（隐藏后节点会移出画布）">
          {KIND_ORDER.map((kind) => {
            const Icon = kindIcon(kind)
            const active = kindFilter[kind]
            return (
              <button
                type="button"
                key={kind}
                className="kpa-pal-chip"
                data-kind={kind}
                data-active={active ? 'true' : 'false'}
                onClick={() => toggleKind(kind)}
                title={`${active ? '隐藏' : '显示'}${KIND_LABEL_CN[kind]}`}
                aria-pressed={active}
              >
                <Icon size={12} />
                <span className="kpa-pal-chip-label">{KIND_LABEL_CN[kind]}</span>
                <span className="kpa-pal-chip-count">{rollup[kind].total}</span>
              </button>
            )
          })}
        </div>
        <ToggleField
          label="只看异常"
          value={onlyProblems}
          onChange={setOnlyProblems}
          hint="仅保留非健康或已停用的节点"
        />
        {/* The toggle above is dropped in the icon rail, so it needs an icon
            equivalent there rather than becoming unreachable below 1280px. */}
        <div className="kpa-pal-rail-toggle">
          <IconButton
            icon={<AlertTriangle size={14} />}
            label="只看异常"
            active={onlyProblems}
            onClick={() => setOnlyProblems(!onlyProblems)}
            size="sm"
          />
        </div>
        {search ? (
          <div className="kpa-pal-searching">
            <Search size={11} />
            正在过滤：<code>{search}</code>
            <span className="kpa-pal-matchcount">{matchCount} 个匹配</span>
          </div>
        ) : null}
      </Section>

      {/* The status legend is the key to every dot in the app: it must never
          sit below the fold or behind a collapse. */}
      <div className="kpa-pal-legend-strip" data-rail="hide">
        <div className="kpa-pal-caption">状态</div>
        <div className="kpa-pal-status-legend">
          {HEALTH_STATUSES.map((status) => (
            <span className="kpa-pal-status" data-status={status} key={status}>
              <StatusDot status={status} size={7} />
              {STATUS_LABEL_CN[status]}
            </span>
          ))}
        </div>
      </div>

      <Section title="图例" dense collapsible defaultOpen={false} rail="hide">
        <ol className="kpa-pal-chain">
          {KIND_ORDER.map((kind, i) => (
            <li className="kpa-pal-chain-row" data-kind={kind} key={kind}>
              <span className="kpa-pal-swatch" />
              <span className="kpa-pal-chain-text">
                <b>
                  {i + 1}. {KIND_LABEL_CN[kind]}
                </b>
                <span>{CHAIN_HINT[kind]}</span>
              </span>
            </li>
          ))}
        </ol>
        <div className="kpa-pal-caption">关系与规则</div>
        <dl className="kpa-pal-rules">
          {CARDINALITY_RULES.map(([relation, rule]) => (
            <div className="kpa-pal-rule-row" key={relation}>
              <dt>{relation}</dt>
              <dd>{rule}</dd>
            </div>
          ))}
        </dl>
        <div className="kpa-pal-caption">快捷键</div>
        <dl className="kpa-pal-keys">
          {SHORTCUTS.map(([key, description]) => (
            <div className="kpa-pal-key-row" key={key}>
              <dt>
                <kbd>{key}</kbd>
              </dt>
              <dd>{description}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="新建" dense>
        <div className="kpa-pal-create">
          {CREATABLE_KINDS.map((kind) => {
            const Icon = kindIcon(kind)
            return (
              <div className="kpa-pal-create-row" data-kind={kind} key={kind}>
                <IconButton
                  icon={
                    <span className="kpa-pal-create-glyph">
                      <Icon size={13} />
                      <Plus size={8} className="kpa-pal-create-plus" />
                    </span>
                  }
                  label={CREATE_LABEL[kind]}
                  onClick={() => onCreate(kind)}
                  size="sm"
                />
              </div>
            )
          })}
        </div>
      </Section>
    </aside>
  )
}
