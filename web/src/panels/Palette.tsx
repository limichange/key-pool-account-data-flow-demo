import { useCallback, useMemo } from 'react'
import { AlertTriangle, Plus, Search } from 'lucide-react'
import {
  ENTITY_KINDS,
  HEALTH_STATUSES,
  KIND_LABEL_CN,
  STATUS_LABEL_CN,
  allEntities,
  isServing,
} from '@kpa/shared'
import type { EntityKind } from '@kpa/shared'

import { IconButton, MetricBar, Section, StatusDot, TextField, ToggleField } from '@/components'
import { kindIcon } from '@/lib/format'
import { useConsole } from '@/lib/store'

const CHAIN_HINT: Record<EntityKind, string> = {
  key: '客户端凭证：携带配额与限流，绑定到一个或多个池',
  pool: '路由池：按策略在成员账号之间分发请求',
  account: '上游账号：真正持有供应商凭证并发起调用',
  proxy: '出口代理：决定落地 IP 与地区，可被多个账号复用',
}

const CREATE_LABEL: Record<EntityKind, string> = {
  key: '新建密钥',
  pool: '新建池',
  account: '新建账号',
  proxy: '新建代理',
}

const SHORTCUTS: [string, string][] = [
  ['Space', '暂停 / 继续模拟器'],
  ['I', '注入 5 条请求'],
  ['L', '收起 / 展开请求流'],
  ['M', '显示 / 隐藏小地图'],
  ['Del', '删除选中的节点或连线'],
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

  const rollup = useMemo(() => {
    const list = allEntities(state)
    const empty = { total: 0, healthy: 0 }
    const acc: Record<EntityKind, { total: number; healthy: number }> = {
      key: { ...empty },
      pool: { ...empty },
      account: { ...empty },
      proxy: { ...empty },
    }
    for (const entity of list) {
      const bucket = acc[entity.kind]
      bucket.total += 1
      if (entity.enabled && isServing(entity.status)) bucket.healthy += 1
    }
    return acc
  }, [state])

  /** How many entities the current free-text search actually matches. */
  const matchCount = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (needle.length === 0) return -1
    return allEntities(state).filter((entity) => {
      if (!kindFilter[entity.kind]) return false
      if (onlyProblems && entity.status === 'healthy') return false
      return `${entity.id} ${entity.name} ${entity.note} ${entity.tags.join(' ')}`
        .toLowerCase()
        .includes(needle)
    }).length
  }, [state, search, kindFilter, onlyProblems])

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
          {ENTITY_KINDS.map((kind) => {
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
          {ENTITY_KINDS.map((kind) => {
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
          {ENTITY_KINDS.map((kind, i) => (
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
          {ENTITY_KINDS.map((kind) => {
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
