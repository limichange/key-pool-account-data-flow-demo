/**
 * In-memory graph store.
 *
 * Owns the whole `GraphState`, keeps an id index, derives entity health and
 * tracks a dirty set so the websocket layer can broadcast minimal patches.
 *
 * It is also the ONLY place that enforces the Pool -> Account cardinality (see
 * the CARDINALITY block in `shared/src/types.ts`): `PoolEntity.members` is
 * authoritative, an account appears in at most one pool's members, and
 * `AccountEntity.poolId` is a derived back-reference recomputed by exactly one
 * function — `syncAccountPoolRefs()` — after every mutating path.
 */
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_PRESETS,
  DEFAULT_KEY_RPM,
  LAYOUT,
  MODELS,
  PROVIDERS,
  PROXY_PROTOCOLS,
  ROUTING_STRATEGIES,
  canJoinPool,
  createMetrics,
  isDetached,
  isServing,
  layoutColumnX,
  type AccountEntity,
  type AccountType,
  type CredentialType,
  type Entity,
  type EntityKind,
  type GatewayEntity,
  type GraphState,
  type HealthStatus,
  type KeyEntity,
  type KeyTier,
  type PoolBinding,
  type PoolEntity,
  type PoolMember,
  type Provider,
  type ProxyEntity,
  type ProxyProtocol,
  type RoutingStrategy,
  type XY,
} from '@kpa/shared'

import { rng } from './rng.js'
import { createSeedState } from './seed.js'

const HOUR = 3_600_000

const KEY_TIERS: KeyTier[] = ['free', 'pro', 'team', 'enterprise']
const CREDENTIAL_TYPES: CredentialType[] = ['api-key', 'oauth', 'session']
const PROXY_POOL_TYPES: ProxyEntity['poolType'][] = ['residential', 'datacenter', 'mobile']

/** Reference to one side of a relation. */
export interface EntityRef {
  kind: EntityKind
  id: string
}

/** Operator-visible log line emitted by a store mutation. */
export type StoreLogLevel = 'info' | 'warn' | 'error'
export type StoreLogSink = (level: StoreLogLevel, message: string) => void

/**
 * User-facing announcement a store mutation raises (dialog-worthy, unlike a
 * log line) — e.g. the proxy-disable cascade. The HTTP layer forwards it as a
 * `notice` ServerEvent, so it fires even when the mutation came in through the
 * REST API rather than the UI.
 */
export interface StoreNotice {
  level: StoreLogLevel
  title: string
  message: string
  entityIds: string[]
}
export type StoreNoticeSink = (notice: StoreNotice) => void

/** Dev-only invariant checks; a broken invariant warns, it never throws. */
const CHECK_INVARIANTS = process.env.NODE_ENV !== 'production'

/* ------------------------------------------------------------- coercion -- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toStr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function toNum(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function toBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function toStrArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  return value.filter((item): item is string => typeof item === 'string')
}

function toEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

function toXY(value: unknown, fallback: XY): XY {
  if (!isRecord(value)) return fallback
  return { x: toNum(value.x, fallback.x), y: toNum(value.y, fallback.y) }
}

function toNullableNum(value: unknown, fallback: number | null): number | null {
  if (value === null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return fallback
}

function toNullableStr(value: unknown, fallback: string | null): string | null {
  if (value === null) return null
  if (typeof value === 'string') return value
  return fallback
}

function maskedTail(length = 4): string {
  return Math.floor(rng.nextFloat() * 16 ** length)
    .toString(16)
    .padStart(length, '0')
}

/* ------------------------------------------------------------ the store -- */

export class GraphStore {
  private state: GraphState
  private index = new Map<string, Entity>()
  private dirty = new Set<string>()
  /** Exponentially smoothed error rate per entity, used for `degraded`. */
  private recentError = new Map<string, number>()
  /** Set by the HTTP layer so re-parenting is announced on the operator log. */
  private logSink: StoreLogSink | null = null
  /** Set by the HTTP layer so cascades raise a user-facing `notice` dialog. */
  private noticeSink: StoreNoticeSink | null = null

  constructor(state: GraphState = createSeedState()) {
    this.state = state
    this.reindex()
    this.syncAccountPoolRefs(Date.now())
    this.syncKeyBindingRefs(Date.now())
    this.refreshStatuses()
    this.dirty.clear()
  }

  /** Route store-level operator messages to the websocket broadcast. */
  setLogSink(sink: StoreLogSink | null): void {
    this.logSink = sink
  }

  /** Route store-level user-facing notices to the websocket broadcast. */
  setNoticeSink(sink: StoreNoticeSink | null): void {
    this.noticeSink = sink
  }

  private log(level: StoreLogLevel, message: string): void {
    this.logSink?.(level, message)
  }

  private notice(level: StoreLogLevel, title: string, message: string, entityIds: string[]): void {
    this.noticeSink?.({ level, title, message, entityIds })
  }

  /* ------------------------------------------------------------ reading -- */

  snapshot(): GraphState {
    return this.state
  }

  replace(state: GraphState): void {
    this.state = state
    this.recentError.clear()
    this.dirty.clear()
    this.reindex()
    this.syncAccountPoolRefs(Date.now())
    this.syncKeyBindingRefs(Date.now())
    this.refreshStatuses()
    this.dirty.clear()
  }

  get(id: string): Entity | undefined {
    return this.index.get(id)
  }

  /** The singleton entry node — always present, never created or deleted. */
  getGateway(): GatewayEntity {
    return this.state.gateway
  }

  getKey(id: string | null | undefined): KeyEntity | undefined {
    const found = id ? this.index.get(id) : undefined
    return found && found.kind === 'key' ? found : undefined
  }

  getPool(id: string | null | undefined): PoolEntity | undefined {
    const found = id ? this.index.get(id) : undefined
    return found && found.kind === 'pool' ? found : undefined
  }

  getAccount(id: string | null | undefined): AccountEntity | undefined {
    const found = id ? this.index.get(id) : undefined
    return found && found.kind === 'account' ? found : undefined
  }

  getProxy(id: string | null | undefined): ProxyEntity | undefined {
    const found = id ? this.index.get(id) : undefined
    return found && found.kind === 'proxy' ? found : undefined
  }

  keys(): KeyEntity[] {
    return this.state.keys
  }

  pools(): PoolEntity[] {
    return this.state.pools
  }

  accounts(): AccountEntity[] {
    return this.state.accounts
  }

  proxies(): ProxyEntity[] {
    return this.state.proxies
  }

  all(): Entity[] {
    return [
      this.state.gateway,
      ...this.state.keys,
      ...this.state.pools,
      ...this.state.accounts,
      ...this.state.proxies,
    ]
  }

  /* ------------------------------------------------------------ dirtying -- */

  markDirty(entity: Entity): void {
    this.dirty.add(entity.id)
  }

  drainDirty(): Entity[] {
    if (this.dirty.size === 0) return []
    const out: Entity[] = []
    for (const id of this.dirty) {
      const entity = this.index.get(id)
      if (entity) out.push(entity)
    }
    this.dirty.clear()
    return out
  }

  /* ------------------------------------------------------------- health -- */

  /** Feed a request result into the rolling error rate used by `recomputeStatus`. */
  noteOutcome(id: string, ok: boolean): void {
    const prev = this.recentError.get(id) ?? 0
    const alpha = 0.08
    this.recentError.set(id, prev * (1 - alpha) + (ok ? 0 : 1) * alpha)
  }

  errorRateOf(id: string): number {
    return this.recentError.get(id) ?? 0
  }

  recomputeStatus(entity: Entity, now: number = Date.now()): HealthStatus {
    if (!entity.enabled) return 'disabled'

    // The gateway only knows three states: disabled (the console-wide kill
    // switch), throttled (its own global rpm ceiling) and healthy.
    if (entity.kind === 'gateway') {
      if (entity.rateLimit.rpm > 0 && entity.metrics.rpm >= entity.rateLimit.rpm) {
        return 'throttled'
      }
      return 'healthy'
    }

    if (entity.kind === 'proxy' && !entity.health.alive) return 'offline'

    if (entity.kind === 'account') {
      if (entity.health.cooldownUntil !== null && entity.health.cooldownUntil > now) return 'cooldown'
    }

    if (entity.kind === 'key' || entity.kind === 'account') {
      if (entity.quota.limitTokens > 0 && entity.quota.usedTokens >= entity.quota.limitTokens) {
        return 'exhausted'
      }
      if (entity.rateLimit.rpm > 0 && entity.metrics.rpm >= entity.rateLimit.rpm) {
        return 'throttled'
      }
    }

    if (entity.kind === 'pool') {
      const serving = entity.members.filter((member) => {
        if (!member.enabled) return false
        const account = this.getAccount(member.accountId)
        return !!account && isServing(account.status)
      }).length
      if (serving === 0) return 'offline'
      if (serving * 2 < entity.members.length) return 'degraded'
    }

    if (entity.kind === 'key') {
      const usable = entity.bindings.some((binding) => {
        const pool = this.getPool(binding.poolId)
        return !!pool && pool.enabled && isServing(pool.status)
      })
      if (!usable) return 'degraded'
    }

    if (this.errorRateOf(entity.id) > 0.2) return 'degraded'

    if (entity.kind === 'account' || entity.kind === 'proxy') {
      if (entity.baseLatencyMs > 0 && entity.health.latencyMs > entity.baseLatencyMs * 2.5) {
        return 'degraded'
      }
    }

    return 'healthy'
  }

  /**
   * Recompute every status. Order matters: proxies feed accounts, accounts feed
   * pools, pools feed keys and the gateway sits in front of everything.
   */
  refreshStatuses(now: number = Date.now()): void {
    const ordered: Entity[] = [
      ...this.state.proxies,
      ...this.state.accounts,
      ...this.state.pools,
      ...this.state.keys,
      this.state.gateway,
    ]
    for (const entity of ordered) {
      const next = this.recomputeStatus(entity, now)
      if (entity.status !== next) {
        entity.status = next
        entity.updatedAt = now
        this.markDirty(entity)
      }
    }
  }

  /** Roll quota windows forward once they expire. */
  resetQuotaWindows(now: number = Date.now()): void {
    const windowed: Array<KeyEntity | AccountEntity> = [...this.state.keys, ...this.state.accounts]
    for (const entity of windowed) {
      if (entity.quota.resetAt > now) continue
      let next = entity.quota.resetAt
      while (next <= now) next += HOUR
      entity.quota.usedTokens = 0
      entity.quota.resetAt = next
      entity.updatedAt = now
      this.markDirty(entity)
    }
  }

  /* -------------------------------------------- pool -> account ownership -- */

  /**
   * Recompute every `account.poolId` from `pool.members` — THE ONLY writer of
   * that field in the whole codebase.
   *
   * It also repairs the authoritative side defensively, so a hand-built state,
   * a replayed snapshot or a future code path can never leave the graph in an
   * illegal shape:
   *   - a member row pointing at an unknown account is dropped;
   *   - a duplicated accountId inside one pool collapses to a single row;
   *   - an account listed by several pools is kept by the LAST pool in
   *     `state.pools` order and removed from the earlier ones, with a warn log.
   *
   * Every mutating path that can touch membership calls this: create, update,
   * remove, bind, unbind, replace/reset and the constructor (seed).
   */
  private syncAccountPoolRefs(now: number = Date.now()): void {
    // 1. per-pool cleanup: dangling members, in-pool duplicates and — the
    //    egress-before-serve rule — members whose account has NO proxy. The
    //    last one is what turns "delete a proxy" into a cascade: the accounts
    //    lose their proxyId in `remove()` and fall out of their pool right
    //    here, becoming 未接入.
    for (const pool of this.state.pools) {
      const seen = new Set<string>()
      const kept: PoolMember[] = []
      for (const member of pool.members) {
        if (seen.has(member.accountId)) continue
        const account = this.getAccount(member.accountId)
        if (!account) continue
        if (!canJoinPool(account)) {
          this.log(
            'warn',
            `账号「${account.name}」未绑定出口代理，已从池「${pool.name}」移除（变为未接入）`,
          )
          continue
        }
        seen.add(member.accountId)
        kept.push(member)
      }
      if (kept.length !== pool.members.length) {
        pool.members = kept
        pool.cursor = 0
        pool.updatedAt = now
        this.markDirty(pool)
      }
    }

    // 2. cross-pool cleanup: at most one owner per account, last pool wins.
    const owner = new Map<string, PoolEntity>()
    for (const pool of this.state.pools) {
      for (const member of pool.members) {
        const previous = owner.get(member.accountId)
        if (previous && previous !== pool) {
          previous.members = previous.members.filter((row) => row.accountId !== member.accountId)
          previous.cursor = 0
          previous.updatedAt = now
          this.markDirty(previous)
          const account = this.getAccount(member.accountId)
          this.log(
            'warn',
            `账号「${account?.name ?? member.accountId}」同时出现在多个池中，已从「${previous.name}」移除，仅保留在「${pool.name}」`,
          )
        }
        owner.set(member.accountId, pool)
      }
    }

    // 3. rewrite the derived back-reference.
    for (const account of this.state.accounts) {
      const next = owner.get(account.id)?.id ?? null
      if (account.poolId !== next) {
        account.poolId = next
        // Leaving the pool clears the proxy-cascade marker: a detached
        // account's enabled switch is fully operator-owned again, so a later
        // proxy re-enable can never resurrect it.
        if (next === null && account.autoDisabledBy !== null) account.autoDisabledBy = null
        account.updatedAt = now
        this.markDirty(account)
      }
    }
  }

  /**
   * Defensive repair pass for the Key <-> Pool relation — the sibling of
   * `syncAccountPoolRefs`. `parseBindings` already collapses duplicate rows by
   * poolId; this additionally drops any binding that points at a pool which no
   * longer exists (or never did), so a key can never carry a dangling reference
   * after a mutation — most importantly after a pool is removed.
   *
   * Called from every mutating path that can touch bindings or pools: create,
   * update, remove, bind, unbind, replace/reset and the constructor (seed).
   */
  private syncKeyBindingRefs(now: number = Date.now()): void {
    for (const key of this.state.keys) {
      const seen = new Set<string>()
      const kept: PoolBinding[] = []
      for (const binding of key.bindings) {
        if (seen.has(binding.poolId)) continue
        if (!this.getPool(binding.poolId)) continue
        seen.add(binding.poolId)
        kept.push(binding)
      }
      if (kept.length !== key.bindings.length) {
        key.bindings = kept
        key.updatedAt = now
        this.markDirty(key)
      }
    }
  }

  /**
   * Make `pool` the sole owner of every account it now lists: steal them from
   * whichever pool held them before. Used by the `members` patch, which is the
   * one place a client can hand us a whole new member list.
   */
  private claimAccounts(pool: PoolEntity, now: number): void {
    const claimed = new Set(pool.members.map((member) => member.accountId))
    if (claimed.size === 0) return
    for (const other of this.state.pools) {
      if (other.id === pool.id) continue
      const before = other.members.length
      const stolen = other.members.filter((member) => claimed.has(member.accountId))
      if (stolen.length === 0) continue
      other.members = other.members.filter((member) => !claimed.has(member.accountId))
      if (other.members.length === before) continue
      other.cursor = 0
      other.updatedAt = now
      this.markDirty(other)
      for (const member of stolen) {
        const account = this.getAccount(member.accountId)
        this.log(
          'info',
          `账号「${account?.name ?? member.accountId}」已从池「${other.name}」迁移到池「${pool.name}」`,
        )
      }
    }
  }

  /**
   * The proxy ENABLE switch cascades to the in-pool accounts behind it: the
   * egress rule says an in-pool account must have a working proxy, so the
   * moment its proxy is switched OFF the account can no longer serve and is
   * taken out of rotation instead of silently failing every request.
   *
   * Driven ONLY by `proxy.enabled` — a proxy that merely goes unhealthy
   * (`health.alive === false`) is already handled by the router skipping it
   * and must NOT disable anything.
   *
   * `autoDisabledBy` records the causality precisely, so re-enabling the proxy
   * only resurrects the accounts THIS cascade switched off — never one the
   * operator disabled by hand. Accounts outside any pool are left alone
   * (nothing to protect).
   */
  private cascadeProxyEnabled(proxy: ProxyEntity, now: number): void {
    if (!proxy.enabled) {
      const affected = this.state.accounts.filter(
        (account) => account.proxyId === proxy.id && account.poolId !== null && account.enabled,
      )
      if (affected.length === 0) return
      for (const account of affected) {
        account.enabled = false
        account.autoDisabledBy = proxy.id
        account.updatedAt = now
        this.markDirty(account)
      }
      const names = affected.map((account) => account.name).join('、')
      this.notice(
        'warn',
        '代理停用 · 账号联动停用',
        `停用代理「${proxy.name}」已同时自动停用正在使用它的 ${affected.length} 个池内账号：${names}。重新启用该代理后这些账号会自动恢复。`,
        [proxy.id, ...affected.map((account) => account.id)],
      )
      return
    }

    const restored = this.state.accounts.filter((account) => account.autoDisabledBy === proxy.id)
    if (restored.length === 0) return
    for (const account of restored) {
      account.enabled = true
      account.autoDisabledBy = null
      account.updatedAt = now
      this.markDirty(account)
    }
    const names = restored.map((account) => account.name).join('、')
    this.notice(
      'info',
      '代理恢复 · 账号联动恢复',
      `代理「${proxy.name}」已重新启用，之前被联动停用的 ${restored.length} 个账号已自动恢复：${names}。`,
      [proxy.id, ...restored.map((account) => account.id)],
    )
  }

  /**
   * Cheap dev-time guard. Warns — never throws — when the one-pool-per-account
   * invariant or its derived back-reference got out of sync after a mutation.
   */
  private assertPoolInvariant(context: string): void {
    if (!CHECK_INVARIANTS) return
    const owners = new Map<string, string[]>()
    for (const pool of this.state.pools) {
      for (const member of pool.members) {
        const list = owners.get(member.accountId)
        if (list) list.push(pool.id)
        else owners.set(member.accountId, [pool.id])
      }
    }

    for (const [accountId, list] of owners) {
      if (list.length > 1) {
        console.warn(
          `[kpa] invariant broken after ${context}: account ${accountId} is owned by ${list.length} pools (${list.join(', ')})`,
        )
      }
      if (!this.getAccount(accountId)) {
        console.warn(
          `[kpa] invariant broken after ${context}: pool(s) ${list.join(', ')} reference unknown account ${accountId}`,
        )
      }
    }

    for (const account of this.state.accounts) {
      const list = owners.get(account.id) ?? []
      const expected = list.length === 1 ? list[0] : null
      if (list.length <= 1 && account.poolId !== expected) {
        console.warn(
          `[kpa] invariant broken after ${context}: account ${account.id} poolId=${String(account.poolId)} but pool.members say ${String(expected)}`,
        )
      }
    }
  }

  /* ---------------------------------------------------------- mutations -- */

  create(kind: EntityKind, draft: Record<string, unknown> = {}): Entity {
    // The gateway is a SINGLETON: exactly one exists for the life of the
    // console, so creating another is a client error, never a merge.
    if (kind === 'gateway') {
      throw new Error('网关是系统内置的唯一入口节点，不能创建新的网关')
    }
    const now = Date.now()
    const entity = this.buildDefault(kind, now)
    this.applyPatch(entity, draft, now)
    if (!isRecord(draft.position)) {
      entity.position = this.nextFreePosition(kind)
    }
    this.listOf(kind).push(entity)
    this.index.set(entity.id, entity)
    // A freshly created account is in no pool (poolId null); a pool created with
    // a `members` draft must steal those accounts from their previous owners.
    if (entity.kind === 'pool') this.claimAccounts(entity, now)
    this.syncAccountPoolRefs(now)
    this.syncKeyBindingRefs(now)
    this.state.updatedAt = now
    this.refreshStatuses(now)
    this.markDirty(entity)
    this.assertPoolInvariant(`create(${kind})`)
    return entity
  }

  update(kind: EntityKind, id: string, patch: Record<string, unknown>): Entity {
    const entity = this.index.get(id)
    if (!entity) throw new Error(`实体不存在: ${id}`)
    if (entity.kind !== kind) throw new Error(`实体 ${id} 的类型是 ${entity.kind}，不是 ${kind}`)
    const now = Date.now()
    const enabledBefore = entity.enabled
    this.applyPatch(entity, patch, now)
    // The proxy ENABLE switch cascades to the in-pool accounts behind it.
    // Keyed off the `enabled` transition ONLY — see `cascadeProxyEnabled`.
    if (entity.kind === 'proxy' && entity.enabled !== enabledBefore) {
      this.cascadeProxyEnabled(entity, now)
    }
    // A `members` patch is a re-parenting operation: every account it now lists
    // leaves whatever pool used to own it (Pool -> Account is one-to-many).
    // Member rows are validated in `parseMembers` (weight/priority coerced) and
    // rows pointing at an unknown account are dropped by `syncAccountPoolRefs`.
    if (entity.kind === 'pool') this.claimAccounts(entity, now)
    this.syncAccountPoolRefs(now)
    this.syncKeyBindingRefs(now)
    entity.updatedAt = now
    this.state.updatedAt = now
    this.refreshStatuses(now)
    this.markDirty(entity)
    this.assertPoolInvariant(`update(${kind})`)
    return entity
  }

  remove(kind: EntityKind, id: string): void {
    // The gateway can never be deleted — it is the root of the whole graph.
    if (kind === 'gateway') {
      throw new Error('网关是系统内置的唯一入口节点，不能删除（可通过停用来切断流量）')
    }
    const entity = this.index.get(id)
    if (!entity) throw new Error(`实体不存在: ${id}`)
    if (entity.kind !== kind) throw new Error(`实体 ${id} 的类型是 ${entity.kind}，不是 ${kind}`)
    const now = Date.now()

    switch (kind) {
      case 'key':
        this.state.keys = this.state.keys.filter((item) => item.id !== id)
        break
      case 'pool': {
        // The pool's accounts are NOT deleted: they simply become unassigned
        // (未分配). `syncAccountPoolRefs` below resets their poolId to null, and
        // `syncKeyBindingRefs` drops every key binding that pointed at this pool.
        this.state.pools = this.state.pools.filter((item) => item.id !== id)
        for (const pool of this.state.pools) {
          if (pool.failoverPoolId === id) {
            pool.failoverPoolId = null
            pool.updatedAt = now
            this.markDirty(pool)
          }
        }
        break
      }
      case 'account': {
        this.state.accounts = this.state.accounts.filter((item) => item.id !== id)
        for (const pool of this.state.pools) {
          const before = pool.members.length
          pool.members = pool.members.filter((member) => member.accountId !== id)
          if (pool.members.length !== before) {
            pool.cursor = 0
            pool.updatedAt = now
            this.markDirty(pool)
          }
        }
        break
      }
      case 'proxy': {
        // CASCADE (egress-before-serve): every account using this proxy loses
        // its egress AND therefore its pool seat — `syncAccountPoolRefs` below
        // drops the now proxy-less members, turning those accounts 未接入.
        this.state.proxies = this.state.proxies.filter((item) => item.id !== id)
        for (const account of this.state.accounts) {
          if (account.proxyId === id) {
            account.proxyId = null
            if (account.autoDisabledBy === id) account.autoDisabledBy = null
            account.updatedAt = now
            this.markDirty(account)
          }
        }
        break
      }
    }

    this.index.delete(id)
    this.dirty.delete(id)
    this.recentError.delete(id)
    this.syncAccountPoolRefs(now)
    this.syncKeyBindingRefs(now)
    this.state.updatedAt = now
    this.refreshStatuses(now)
    this.assertPoolInvariant(`remove(${kind})`)
  }

  move(id: string, position: XY): Entity {
    const entity = this.index.get(id)
    if (!entity) throw new Error(`实体不存在: ${id}`)
    entity.position = { x: toNum(position.x, entity.position.x), y: toNum(position.y, entity.position.y) }
    entity.updatedAt = Date.now()
    this.state.updatedAt = entity.updatedAt
    this.markDirty(entity)
    return entity
  }

  /* ------------------------------------------------------------ relations -- */

  bind(source: EntityRef, target: EntityRef): void {
    const now = Date.now()
    const relation = this.resolveRelation(source, target)

    switch (relation.type) {
      case 'key-pool': {
        const { key, pool } = relation
        if (key.bindings.some((binding) => binding.poolId === pool.id)) return
        const nextPriority = key.bindings.reduce((max, b) => Math.max(max, b.priority), 0) + 1
        key.bindings.push({ poolId: pool.id, priority: nextPriority, weight: 1 })
        key.updatedAt = now
        this.markDirty(key)
        break
      }
      case 'pool-account': {
        const { pool, account } = relation
        if (pool.members.some((member) => member.accountId === account.id)) return

        // Egress-before-serve: an account may only join a pool once its exit
        // proxy is configured. This is an ORDERING rule, enforced on every
        // path that can add a member.
        if (!canJoinPool(account)) {
          throw new Error(
            `账号「${account.name}」尚未绑定代理，请先绑定出口代理后再加入池`,
          )
        }

        // Pool -> Account is ONE-TO-MANY: an account belongs to at most one
        // pool, so binding an account that another pool already owns is a MOVE
        // (re-parenting), never an error. Dragging an edge from a pool onto an
        // already-owned account in the canvas therefore steals it — which is the
        // desired UX, so it is announced on the operator log.
        const previous = this.state.pools.find(
          (other) =>
            other.id !== pool.id && other.members.some((member) => member.accountId === account.id),
        )
        if (previous) {
          previous.members = previous.members.filter((member) => member.accountId !== account.id)
          previous.cursor = 0
          previous.updatedAt = now
          this.markDirty(previous)
        }

        const nextPriority = pool.members.reduce((max, m) => Math.max(max, m.priority), 0) + 1
        pool.members.push({ accountId: account.id, weight: 1, priority: nextPriority, enabled: true })
        pool.updatedAt = now
        this.markDirty(pool)

        if (previous) {
          this.log(
            'info',
            `账号「${account.name}」已从池「${previous.name}」迁移到池「${pool.name}」（一个账号只能属于一个池）`,
          )
        }
        break
      }
      case 'account-proxy': {
        const { account, proxy } = relation
        if (account.proxyId === proxy.id) return
        // Binding a different proxy REPLACES the old one — this is how egress
        // is swapped without touching pool membership. Causality of a previous
        // proxy-disable cascade no longer applies, so the marker is cleared.
        account.proxyId = proxy.id
        if (account.autoDisabledBy !== null) account.autoDisabledBy = null
        account.updatedAt = now
        this.markDirty(account)
        break
      }
    }

    this.syncAccountPoolRefs(now)
    this.syncKeyBindingRefs(now)
    this.state.updatedAt = now
    this.refreshStatuses(now)
    this.assertPoolInvariant('bind')
  }

  unbind(source: EntityRef, target: EntityRef): void {
    const now = Date.now()
    const relation = this.resolveRelation(source, target)

    switch (relation.type) {
      case 'key-pool': {
        const { key, pool } = relation
        const before = key.bindings.length
        key.bindings = key.bindings.filter((binding) => binding.poolId !== pool.id)
        if (key.bindings.length === before) return
        key.updatedAt = now
        this.markDirty(key)
        break
      }
      case 'pool-account': {
        const { pool, account } = relation
        const before = pool.members.length
        pool.members = pool.members.filter((member) => member.accountId !== account.id)
        if (pool.members.length === before) return
        pool.cursor = 0
        pool.updatedAt = now
        this.markDirty(pool)
        break
      }
      case 'account-proxy': {
        const { account, proxy } = relation
        if (account.proxyId !== proxy.id) return
        // Egress-before-serve: while the account sits in a pool its proxy may
        // be REPLACED (bind a different one) but never removed — otherwise the
        // pool would hold a member that cannot exit. Parked accounts unbind
        // freely.
        const owner = this.state.pools.find((pool) =>
          pool.members.some((member) => member.accountId === account.id),
        )
        if (owner) {
          throw new Error(
            `账号「${account.name}」仍在池「${owner.name}」中，不能解绑代理；请先将其移出池，或直接改绑其他代理`,
          )
        }
        account.proxyId = null
        if (account.autoDisabledBy !== null) account.autoDisabledBy = null
        account.updatedAt = now
        this.markDirty(account)
        break
      }
    }

    // Unbinding pool -> account leaves the account unassigned (poolId null),
    // which is a legal, meaningful state (未接入 / 未分配). Unbinding the LAST
    // upstream relation of a pool / account / proxy is equally legal — the
    // node simply becomes detached (游离) and receives no traffic.
    this.syncAccountPoolRefs(now)
    this.syncKeyBindingRefs(now)
    this.state.updatedAt = now
    this.refreshStatuses(now)
    this.assertPoolInvariant('unbind')
  }

  private resolveRelation(
    source: EntityRef,
    target: EntityRef,
  ):
    | { type: 'key-pool'; key: KeyEntity; pool: PoolEntity }
    | { type: 'pool-account'; pool: PoolEntity; account: AccountEntity }
    | { type: 'account-proxy'; account: AccountEntity; proxy: ProxyEntity } {
    const from = this.index.get(source.id)
    const to = this.index.get(target.id)
    if (!from) throw new Error(`源实体不存在: ${source.id}`)
    if (!to) throw new Error(`目标实体不存在: ${target.id}`)
    if (from.kind !== source.kind || to.kind !== target.kind) {
      throw new Error('实体类型与请求不一致')
    }

    if (from.kind === 'key' && to.kind === 'pool') return { type: 'key-pool', key: from, pool: to }
    if (from.kind === 'pool' && to.kind === 'account') {
      return { type: 'pool-account', pool: from, account: to }
    }
    if (from.kind === 'account' && to.kind === 'proxy') {
      return { type: 'account-proxy', account: from, proxy: to }
    }

    throw new Error(
      `非法连接: ${from.kind} -> ${to.kind}，仅支持 密钥→池 / 池→账号 / 账号→代理（网关→密钥 为系统内置连线，不可编辑）`,
    )
  }

  /* ------------------------------------------------------------ internals -- */

  private reindex(): void {
    this.index.clear()
    for (const entity of this.all()) this.index.set(entity.id, entity)
  }

  private listOf(kind: EntityKind): Entity[] {
    switch (kind) {
      case 'gateway':
        // Unreachable: `create` rejects the kind before ever getting here.
        throw new Error('网关是单例节点，不属于任何实体列表')
      case 'key':
        return this.state.keys as Entity[]
      case 'pool':
        return this.state.pools as Entity[]
      case 'account':
        return this.state.accounts as Entity[]
      case 'proxy':
        return this.state.proxies as Entity[]
    }
  }

  /**
   * Home for a freshly created entity, matching the shared layered-DAG layout
   * (`layoutPositions`): a new attached entity appends to the BOTTOM of its
   * kind's single column. Pools, accounts and proxies are born DETACHED (no
   * upstream relation yet), so they land where the layout parks detached
   * nodes — below the live graph, x-aligned with their own column; new
   * accounts continue the parked block's lane grid. The operator may have
   * dragged cards anywhere at all, so the candidate is only a starting point:
   * push it down until its rect is clear of every existing card.
   */
  private nextFreePosition(kind: EntityKind): XY {
    const colX = layoutColumnX()
    const width = LAYOUT.nodeWidth[kind]
    const height = LAYOUT.nodeHeight[kind]
    const step = height + LAYOUT.rowGap
    const existing = this.all()

    // Bottom of this kind's column (parked cards included).
    let y = LAYOUT.topY
    for (const entity of existing) {
      if (entity.kind !== kind) continue
      y = Math.max(y, entity.position.y + height + LAYOUT.rowGap)
    }
    const candidate: XY = { x: colX[kind], y }

    if (kind !== 'key') {
      // Born detached: never above the parking line under the live graph.
      let attachedBottom = LAYOUT.topY
      for (const entity of existing) {
        if (entity.kind !== 'gateway' && isDetached(this.state, entity)) continue
        attachedBottom = Math.max(
          attachedBottom,
          entity.position.y + LAYOUT.nodeHeight[entity.kind],
        )
      }
      let parkLine = attachedBottom + LAYOUT.detachedGap
      // Parked rows of every kind share ONE top line. Appending to an attached
      // column (e.g. a freshly created key) can extend the live graph BELOW an
      // already-established parked band; a new detached node must then JOIN
      // that band's top row instead of opening a second parking line further
      // down, so the baseline is clamped to the highest already-parked card.
      // `layoutPositions` re-parks everything at one parkY on the next
      // 自动布局 either way — this only keeps the interim picture coherent.
      let parkedTop = Number.POSITIVE_INFINITY
      for (const entity of existing) {
        if (!isDetached(this.state, entity)) continue
        parkedTop = Math.min(parkedTop, entity.position.y)
      }
      if (parkedTop !== Number.POSITIVE_INFINITY) parkLine = Math.min(parkLine, parkedTop)
      candidate.y = Math.max(candidate.y, parkLine)
      if (kind === 'account') {
        // Continue the parked account block's lane grid: the i-th detached
        // account sits in lane i % accountLanes of the parked block.
        const parkedCount = this.state.accounts.filter((account) =>
          isDetached(this.state, account),
        ).length
        const lane = parkedCount % LAYOUT.accountLanes
        candidate.x += lane * (LAYOUT.nodeWidth.account + LAYOUT.laneGap)
        // A lane to the right of an existing parked card shares its row.
        if (lane > 0) candidate.y = Math.max(LAYOUT.topY, candidate.y - step)
      }
    }

    const collides = (pos: XY): boolean =>
      existing.some((entity) => {
        const otherWidth = LAYOUT.nodeWidth[entity.kind]
        const otherHeight = LAYOUT.nodeHeight[entity.kind]
        return (
          pos.x < entity.position.x + otherWidth &&
          pos.x + width > entity.position.x &&
          pos.y < entity.position.y + otherHeight &&
          pos.y + height > entity.position.y
        )
      })

    const position: XY = { ...candidate }
    for (let guard = 0; guard < 50 && collides(position); guard += 1) {
      position.y += step
    }
    return position
  }

  private freshId(kind: EntityKind): string {
    const prefixes: Record<EntityKind, string> = {
      gateway: 'gw',
      key: 'key',
      pool: 'pool',
      account: 'acc',
      proxy: 'px',
    }
    const prefix = prefixes[kind]
    let id = rng.shortId(prefix)
    while (this.index.has(id)) id = rng.shortId(prefix)
    return id
  }

  private buildDefault(kind: EntityKind, now: number): Entity {
    const base = {
      id: this.freshId(kind),
      name: '',
      enabled: true,
      status: 'healthy' as HealthStatus,
      tags: [] as string[],
      note: '',
      createdAt: now,
      updatedAt: now,
      // Overwritten by `nextFreePosition` unless the caller supplied one.
      position: { x: 0, y: LAYOUT.topY },
      metrics: createMetrics(),
    }

    switch (kind) {
      case 'gateway':
        // Unreachable: `create` rejects the kind before ever getting here.
        throw new Error('网关是系统内置的唯一入口节点，不能创建新的网关')
      case 'key':
        return {
          ...base,
          kind: 'key',
          name: '新建密钥',
          secret: `sk-limi-live-****${maskedTail()}`,
          owner: '未指派',
          tier: 'pro',
          // Every newly created key starts at DEFAULT_KEY_RPM 次/分钟.
          rateLimit: { rpm: DEFAULT_KEY_RPM, concurrency: 16 },
          quota: { limitTokens: 2_000_000, usedTokens: 0, resetAt: now + HOUR },
          bindings: [],
          allowedModels: [],
          trafficWeight: 1,
          expiresAt: null,
        }
      case 'pool':
        return {
          ...base,
          kind: 'pool',
          name: '新建池',
          strategy: 'round-robin',
          members: [],
          stickySession: false,
          maxRetries: 2,
          maxConcurrency: 40,
          failoverPoolId: null,
          cursor: 0,
        }
      case 'account': {
        // A new account starts as the default plan type; the plan PRESETS seed
        // its rateLimit / quota / models. A draft `accountType` (and any
        // explicit rateLimit/quota/models) is applied on top by `applyPatch`.
        const accountType: AccountType = 'plus'
        const preset = ACCOUNT_TYPE_PRESETS[accountType]
        return {
          ...base,
          kind: 'account',
          name: '新建账号',
          // A new account starts in NO pool. It only gets an owner through
          // bind() or a pool `members` patch, and `syncAccountPoolRefs` is the
          // only writer of this field afterwards.
          poolId: null,
          provider: 'anthropic',
          accountType,
          credentialType: 'api-key',
          credentialMask: `sk-ant-api03-****${maskedTail()}`,
          region: 'us-west-2',
          // No proxy yet: the account is PARKED (未配置代理) and cannot join a
          // pool until an egress proxy is bound (egress-before-serve).
          proxyId: null,
          autoDisabledBy: null,
          rateLimit: { ...preset.rateLimit },
          quota: { limitTokens: preset.quotaTokens, usedTokens: 0, resetAt: now + HOUR },
          health: {
            latencyMs: 900,
            errorRate: 0,
            consecutiveFailures: 0,
            cooldownUntil: null,
            lastErrorAt: null,
            lastError: null,
          },
          reliability: 0.98,
          baseLatencyMs: 900,
          models: [...preset.models],
        }
      }
      case 'proxy':
        return {
          ...base,
          kind: 'proxy',
          name: '新建代理',
          protocol: 'https',
          // `host`/`port` is the endpoint you DIAL; `ip`/`country` is the
          // egress the upstream SEES. They are deliberately different fields.
          host: 'new.egress.limi.net',
          port: 8443,
          region: 'us-west-2',
          countryCode: 'US',
          ip: '198.51.100.24',
          country: '美国',
          poolType: 'datacenter',
          maxConcurrency: 64,
          health: { latencyMs: 120, alive: true, packetLoss: 0.005, lastCheckAt: now },
          reliability: 0.99,
          baseLatencyMs: 120,
        }
    }
  }

  /** Whitelisted, type-checked merge. Unknown keys are ignored on purpose. */
  private applyPatch(entity: Entity, patch: Record<string, unknown>, now: number): void {
    const has = (field: string): boolean => Object.prototype.hasOwnProperty.call(patch, field)
    const S = (field: string, fallback: string): string =>
      has(field) ? toStr(patch[field], fallback) : fallback
    const N = (field: string, fallback: number): number =>
      has(field) ? toNum(patch[field], fallback) : fallback
    const B = (field: string, fallback: boolean): boolean =>
      has(field) ? toBool(patch[field], fallback) : fallback

    entity.name = S('name', entity.name)
    entity.enabled = B('enabled', entity.enabled)
    entity.note = S('note', entity.note)
    entity.tags = has('tags') ? toStrArray(patch.tags, entity.tags) : entity.tags
    if (has('position')) entity.position = toXY(patch.position, entity.position)

    // Switching the plan type re-baselines rateLimit / quota / models to the
    // type PRESETS. Runs BEFORE the generic rateLimit/quota merge below so an
    // explicit rateLimit/quota/models in the same patch still wins. The type
    // itself never scales anything at runtime — presets are defaults only.
    if (entity.kind === 'account' && has('accountType')) {
      const nextType = toEnum<AccountType>(patch.accountType, ACCOUNT_TYPES, entity.accountType)
      if (nextType !== entity.accountType) {
        const preset = ACCOUNT_TYPE_PRESETS[nextType]
        entity.accountType = nextType
        entity.rateLimit = { ...preset.rateLimit }
        entity.quota = { ...entity.quota, limitTokens: preset.quotaTokens }
        entity.models = [...preset.models]
      }
    }

    if (entity.kind === 'key' || entity.kind === 'account' || entity.kind === 'gateway') {
      if (isRecord(patch.rateLimit)) {
        entity.rateLimit = {
          rpm: Math.max(0, toNum(patch.rateLimit.rpm, entity.rateLimit.rpm)),
          concurrency: Math.max(0, toNum(patch.rateLimit.concurrency, entity.rateLimit.concurrency)),
        }
      }
    }
    if (entity.kind === 'key' || entity.kind === 'account') {
      if (isRecord(patch.quota)) {
        entity.quota = {
          limitTokens: Math.max(0, toNum(patch.quota.limitTokens, entity.quota.limitTokens)),
          usedTokens: Math.max(0, toNum(patch.quota.usedTokens, entity.quota.usedTokens)),
          resetAt: toNum(patch.quota.resetAt, entity.quota.resetAt),
        }
      }
    }

    switch (entity.kind) {
      case 'gateway': {
        // Singleton: name/enabled/rateLimit/note/tags/position handled above,
        // plus the public endpoint and the build string. Nothing else moves.
        entity.endpoint = S('endpoint', entity.endpoint)
        entity.version = S('version', entity.version)
        break
      }
      case 'key': {
        entity.secret = S('secret', entity.secret)
        entity.owner = S('owner', entity.owner)
        entity.tier = has('tier') ? toEnum(patch.tier, KEY_TIERS, entity.tier) : entity.tier
        entity.trafficWeight = Math.max(0, N('trafficWeight', entity.trafficWeight))
        entity.allowedModels = has('allowedModels')
          ? toStrArray(patch.allowedModels, entity.allowedModels)
          : entity.allowedModels
        if (has('expiresAt')) entity.expiresAt = toNullableNum(patch.expiresAt, entity.expiresAt)
        if (has('bindings')) entity.bindings = parseBindings(patch.bindings, entity.bindings)
        // Single-row merge. The console patches one binding at a time; sending
        // the whole array would be a read-modify-write against an entity the
        // simulator replaces several times a second, so two quick edits could
        // clobber each other.
        if (isRecord(patch.binding)) {
          const row = patch.binding
          const poolId = toStr(row.poolId, '')
          const index = entity.bindings.findIndex((item) => item.poolId === poolId)
          if (index >= 0) {
            const current = entity.bindings[index]
            entity.bindings = entity.bindings.slice()
            entity.bindings[index] = {
              poolId,
              priority: Math.max(1, Math.round(toNum(row.priority, current.priority))),
              weight: Math.max(0, toNum(row.weight, current.weight)),
            }
          }
        }
        break
      }
      case 'pool': {
        entity.strategy = has('strategy')
          ? toEnum<RoutingStrategy>(patch.strategy, ROUTING_STRATEGIES, entity.strategy)
          : entity.strategy
        entity.stickySession = B('stickySession', entity.stickySession)
        entity.maxRetries = Math.max(0, Math.round(N('maxRetries', entity.maxRetries)))
        entity.maxConcurrency = Math.max(0, Math.round(N('maxConcurrency', entity.maxConcurrency)))
        entity.cursor = Math.max(0, Math.round(N('cursor', entity.cursor)))
        if (has('failoverPoolId')) {
          const next = toNullableStr(patch.failoverPoolId, entity.failoverPoolId)
          entity.failoverPoolId = next === entity.id ? null : next
        }
        if (has('members')) {
          // Egress-before-serve: a members patch containing a proxy-less
          // account DROPS that member with a warn log rather than corrupting
          // the graph. Unknown accountIds are handled by `syncAccountPoolRefs`.
          entity.members = parseMembers(patch.members, entity.members).filter((member) => {
            const account = this.getAccount(member.accountId)
            if (account && !canJoinPool(account)) {
              this.log(
                'warn',
                `账号「${account.name}」尚未绑定代理，已从池「${entity.name}」的成员列表中忽略`,
              )
              return false
            }
            return true
          })
        }
        // Single-row merge, same reasoning as `binding` above.
        if (isRecord(patch.member)) {
          const row = patch.member
          const accountId = toStr(row.accountId, '')
          const index = entity.members.findIndex((item) => item.accountId === accountId)
          if (index >= 0) {
            const current = entity.members[index]
            entity.members = entity.members.slice()
            entity.members[index] = {
              accountId,
              weight: Math.max(0, toNum(row.weight, current.weight)),
              priority: Math.max(1, Math.round(toNum(row.priority, current.priority))),
              enabled: toBool(row.enabled, current.enabled),
            }
          }
        }
        break
      }
      case 'account': {
        // `poolId` is DERIVED from PoolEntity.members and is deliberately NOT
        // patchable: PATCH /api/entities/account ignores a client-supplied
        // poolId. Membership only changes through bind/unbind or a pool
        // `members` patch, and only `syncAccountPoolRefs` writes this field.
        // Accepting it here would let a client desync the derived reference from
        // the authoritative member lists.
        //
        // `autoDisabledBy` is SERVER-OWNED and equally not patchable: only the
        // proxy-disable cascade writes it. A manual `enabled` patch clears it —
        // the operator has taken over, so a later proxy re-enable must not
        // resurrect (or re-kill) this account behind their back.
        if (has('enabled')) entity.autoDisabledBy = null
        entity.provider = has('provider')
          ? toEnum<Provider>(patch.provider, PROVIDERS, entity.provider)
          : entity.provider
        entity.credentialType = has('credentialType')
          ? toEnum(patch.credentialType, CREDENTIAL_TYPES, entity.credentialType)
          : entity.credentialType
        entity.credentialMask = S('credentialMask', entity.credentialMask)
        entity.region = S('region', entity.region)
        if (has('proxyId')) {
          const nextProxyId = toNullableStr(patch.proxyId, entity.proxyId)
          // Unknown proxy ids are ignored (defensive: never store a dangling
          // reference). Setting it to null while the account sits in a pool is
          // allowed here but the member is dropped by `syncAccountPoolRefs`
          // (egress-before-serve) with a warn log.
          if (nextProxyId !== entity.proxyId && (nextProxyId === null || this.getProxy(nextProxyId))) {
            entity.proxyId = nextProxyId
            // A different egress (or none) ends the old cascade's causality.
            entity.autoDisabledBy = null
          }
        }
        entity.reliability = Math.min(1, Math.max(0, N('reliability', entity.reliability)))
        entity.baseLatencyMs = Math.max(1, N('baseLatencyMs', entity.baseLatencyMs))
        entity.models = has('models') ? toStrArray(patch.models, entity.models) : entity.models
        if (isRecord(patch.health)) {
          const h = patch.health
          entity.health = {
            latencyMs: Math.max(0, toNum(h.latencyMs, entity.health.latencyMs)),
            errorRate: Math.min(1, Math.max(0, toNum(h.errorRate, entity.health.errorRate))),
            consecutiveFailures: Math.max(
              0,
              Math.round(toNum(h.consecutiveFailures, entity.health.consecutiveFailures)),
            ),
            cooldownUntil: toNullableNum(h.cooldownUntil, entity.health.cooldownUntil),
            lastErrorAt: toNullableNum(h.lastErrorAt, entity.health.lastErrorAt),
            lastError: toNullableStr(h.lastError, entity.health.lastError),
          }
        }
        break
      }
      case 'proxy': {
        entity.protocol = has('protocol')
          ? toEnum<ProxyProtocol>(patch.protocol, PROXY_PROTOCOLS, entity.protocol)
          : entity.protocol
        entity.host = S('host', entity.host)
        entity.port = Math.min(65535, Math.max(1, Math.round(N('port', entity.port))))
        entity.region = S('region', entity.region)
        entity.countryCode = S('countryCode', entity.countryCode).slice(0, 2).toUpperCase()
        entity.poolType = has('poolType')
          ? toEnum(patch.poolType, PROXY_POOL_TYPES, entity.poolType)
          : entity.poolType
        entity.maxConcurrency = Math.max(0, Math.round(N('maxConcurrency', entity.maxConcurrency)))
        entity.reliability = Math.min(1, Math.max(0, N('reliability', entity.reliability)))
        entity.baseLatencyMs = Math.max(1, N('baseLatencyMs', entity.baseLatencyMs))
        if (isRecord(patch.health)) {
          const h = patch.health
          entity.health = {
            latencyMs: Math.max(0, toNum(h.latencyMs, entity.health.latencyMs)),
            alive: toBool(h.alive, entity.health.alive),
            packetLoss: Math.min(1, Math.max(0, toNum(h.packetLoss, entity.health.packetLoss))),
            lastCheckAt: toNum(h.lastCheckAt, now),
          }
        }
        break
      }
    }
  }
}

function parseBindings(value: unknown, fallback: PoolBinding[]): PoolBinding[] {
  if (!Array.isArray(value)) return fallback
  const out: PoolBinding[] = []
  // A key binds a given pool at most once: collapse duplicate rows by poolId,
  // the Key -> Pool mirror of the per-pool member dedupe in `syncAccountPoolRefs`
  // step 1. Dangling poolIds are dropped later by `syncKeyBindingRefs`.
  const seen = new Set<string>()
  value.forEach((raw, index) => {
    if (!isRecord(raw)) return
    const poolId = toStr(raw.poolId, '')
    if (!poolId) return
    if (seen.has(poolId)) return
    seen.add(poolId)
    out.push({
      poolId,
      priority: Math.max(1, Math.round(toNum(raw.priority, index + 1))),
      weight: Math.max(0, toNum(raw.weight, 1)),
    })
  })
  return out
}

function parseMembers(value: unknown, fallback: PoolMember[]): PoolMember[] {
  if (!Array.isArray(value)) return fallback
  const out: PoolMember[] = []
  value.forEach((raw, index) => {
    if (!isRecord(raw)) return
    const accountId = toStr(raw.accountId, '')
    if (!accountId) return
    out.push({
      accountId,
      weight: Math.max(0, toNum(raw.weight, 1)),
      priority: Math.max(1, Math.round(toNum(raw.priority, index + 1))),
      enabled: toBool(raw.enabled, true),
    })
  })
  return out
}
