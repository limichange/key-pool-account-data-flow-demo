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
  LAYOUT,
  MODELS,
  PROVIDERS,
  PROXY_PROTOCOLS,
  ROUTING_STRATEGIES,
  createMetrics,
  isServing,
  kindCounts,
  layoutSlotFor,
  type AccountEntity,
  type CredentialType,
  type Entity,
  type EntityKind,
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

  private log(level: StoreLogLevel, message: string): void {
    this.logSink?.(level, message)
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
    return [...this.state.keys, ...this.state.pools, ...this.state.accounts, ...this.state.proxies]
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
   * pools and pools feed keys.
   */
  refreshStatuses(now: number = Date.now()): void {
    const ordered: Entity[] = [
      ...this.state.proxies,
      ...this.state.accounts,
      ...this.state.pools,
      ...this.state.keys,
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
    // 1. per-pool cleanup: dangling members and in-pool duplicates.
    for (const pool of this.state.pools) {
      const seen = new Set<string>()
      const kept: PoolMember[] = []
      for (const member of pool.members) {
        if (seen.has(member.accountId)) continue
        if (!this.getAccount(member.accountId)) continue
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
    this.applyPatch(entity, patch, now)
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
        this.state.proxies = this.state.proxies.filter((item) => item.id !== id)
        for (const account of this.state.accounts) {
          if (account.proxyId === id) {
            account.proxyId = null
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
        account.proxyId = proxy.id
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
        account.proxyId = null
        account.updatedAt = now
        this.markDirty(account)
        break
      }
    }

    // Unbinding pool -> account leaves the account unassigned (poolId null),
    // which is a legal, meaningful state (未分配).
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
      `非法连接: ${from.kind} -> ${to.kind}，仅支持 密钥→池 / 池→账号 / 账号→代理`,
    )
  }

  /* ------------------------------------------------------------ internals -- */

  private reindex(): void {
    this.index.clear()
    for (const entity of this.all()) this.index.set(entity.id, entity)
  }

  private listOf(kind: EntityKind): Entity[] {
    switch (kind) {
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
   * Next free canvas slot of the kind's band, laid out like the seed data.
   *
   * `layoutSlotFor` recomputes the whole band geometry for `count + 1` while
   * the entities already on the canvas still sit on the geometry computed for
   * `count` — and an operator may have dragged them anywhere at all. So the
   * candidate slot is only a starting point: push it down until its rect is
   * clear of every existing card.
   */
  private nextFreePosition(kind: EntityKind): XY {
    const candidate = layoutSlotFor(kindCounts(this.state), kind, this.listOf(kind).length)
    const width = LAYOUT.nodeWidth[kind]
    const height = LAYOUT.nodeHeight[kind]
    const step = height + LAYOUT.rowGap
    const existing = this.all()

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
    const prefix = kind === 'key' ? 'key' : kind === 'pool' ? 'pool' : kind === 'account' ? 'acc' : 'px'
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
      case 'key':
        return {
          ...base,
          kind: 'key',
          name: '新建密钥',
          secret: `sk-limi-live-****${maskedTail()}`,
          owner: '未指派',
          tier: 'pro',
          rateLimit: { rpm: 120, concurrency: 16 },
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
      case 'account':
        return {
          ...base,
          kind: 'account',
          name: '新建账号',
          // A new account starts in NO pool. It only gets an owner through
          // bind() or a pool `members` patch, and `syncAccountPoolRefs` is the
          // only writer of this field afterwards.
          poolId: null,
          provider: 'anthropic',
          credentialType: 'api-key',
          credentialMask: `sk-ant-api03-****${maskedTail()}`,
          region: 'us-west-2',
          proxyId: null,
          rateLimit: { rpm: 120, concurrency: 16 },
          quota: { limitTokens: 5_000_000, usedTokens: 0, resetAt: now + HOUR },
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
          models: [MODELS[2]],
        }
      case 'proxy':
        return {
          ...base,
          kind: 'proxy',
          name: '新建代理',
          protocol: 'https',
          host: 'new.egress.limi.net',
          port: 8443,
          region: 'us-west-2',
          countryCode: 'US',
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

    if (entity.kind === 'key' || entity.kind === 'account') {
      if (isRecord(patch.rateLimit)) {
        entity.rateLimit = {
          rpm: Math.max(0, toNum(patch.rateLimit.rpm, entity.rateLimit.rpm)),
          concurrency: Math.max(0, toNum(patch.rateLimit.concurrency, entity.rateLimit.concurrency)),
        }
      }
      if (isRecord(patch.quota)) {
        entity.quota = {
          limitTokens: Math.max(0, toNum(patch.quota.limitTokens, entity.quota.limitTokens)),
          usedTokens: Math.max(0, toNum(patch.quota.usedTokens, entity.quota.usedTokens)),
          resetAt: toNum(patch.quota.resetAt, entity.quota.resetAt),
        }
      }
    }

    switch (entity.kind) {
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
        if (has('members')) entity.members = parseMembers(patch.members, entity.members)
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
        entity.provider = has('provider')
          ? toEnum<Provider>(patch.provider, PROVIDERS, entity.provider)
          : entity.provider
        entity.credentialType = has('credentialType')
          ? toEnum(patch.credentialType, CREDENTIAL_TYPES, entity.credentialType)
          : entity.credentialType
        entity.credentialMask = S('credentialMask', entity.credentialMask)
        entity.region = S('region', entity.region)
        if (has('proxyId')) entity.proxyId = toNullableStr(patch.proxyId, entity.proxyId)
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
