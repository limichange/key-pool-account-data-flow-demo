import type {
  AccountEntity,
  EdgeMetrics,
  Entity,
  EntityKind,
  GraphState,
  HealthStatus,
  Metrics,
  PoolEntity,
  XY,
} from './types.js'
import { EDGE_HISTORY_SIZE, KIND_ORDER, LAYOUT, METRICS_HISTORY_SIZE } from './constants.js'

/** Canonical edge id, shared by the simulator traces and the React Flow graph. */
export function edgeId(sourceId: string, targetId: string): string {
  return `${sourceId}->${targetId}`
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function round(value: number, digits = 0): number {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

export function percent(used: number, total: number): number {
  if (total <= 0) return 0
  return clamp((used / total) * 100, 0, 100)
}

export function createMetrics(): Metrics {
  return {
    requests: 0,
    success: 0,
    failed: 0,
    rateLimited: 0,
    tokensIn: 0,
    tokensOut: 0,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
    rpm: 0,
    lastUsedAt: null,
    history: new Array<number>(METRICS_HISTORY_SIZE).fill(0),
    inFlight: 0,
  }
}

/** Zeroed per-edge counters for a relation that just appeared in the graph. */
export function createEdgeMetrics(
  id: string,
  sourceId: string,
  targetId: string,
  sourceKind: EntityKind,
): EdgeMetrics {
  return {
    id,
    sourceId,
    targetId,
    sourceKind,
    requests: 0,
    success: 0,
    failed: 0,
    rpm: 0,
    tokens: 0,
    avgLatencyMs: 0,
    lastAt: null,
    history: new Array<number>(EDGE_HISTORY_SIZE).fill(0),
  }
}

/** True when the entity can currently serve traffic. */
export function isServing(status: HealthStatus): boolean {
  return status === 'healthy' || status === 'degraded'
}

export function successRate(metrics: Metrics): number {
  if (metrics.requests === 0) return 1
  return metrics.success / metrics.requests
}

export function allEntities(state: GraphState): Entity[] {
  return [state.gateway, ...state.keys, ...state.pools, ...state.accounts, ...state.proxies]
}

/* --------------------------------------------------------- pool ownership -- */

/*
 * Pool -> Account is ONE-TO-MANY (see the CARDINALITY block in `types.ts`).
 * These three helpers are the only reading vocabulary the console needs for it;
 * all of them are pure and O(pools * members + accounts).
 *
 * They read `PoolEntity.members`, the authoritative side, so they stay correct
 * even if a caller hands them a hand-built state whose `account.poolId`
 * back-references have not been synced yet.
 */

/** The single pool owning `accountId`, or `undefined` when it is unassigned. */
export function poolOfAccount(state: GraphState, accountId: string): PoolEntity | undefined {
  return state.pools.find((pool) => pool.members.some((member) => member.accountId === accountId))
}

/** The accounts owned by `poolId`, in member order. Unknown members are skipped. */
export function accountsOfPool(state: GraphState, poolId: string): AccountEntity[] {
  const pool = state.pools.find((item) => item.id === poolId)
  if (!pool) return []
  const byId = new Map(state.accounts.map((account) => [account.id, account]))
  const out: AccountEntity[] = []
  for (const member of pool.members) {
    const account = byId.get(member.accountId)
    if (account) out.push(account)
  }
  return out
}

/** Accounts that belong to no pool at all — the legal 未分配 state. */
export function unassignedAccounts(state: GraphState): AccountEntity[] {
  const owned = new Set<string>()
  for (const pool of state.pools) {
    for (const member of pool.members) owned.add(member.accountId)
  }
  return state.accounts.filter((account) => !owned.has(account.id))
}

/* ------------------------------------------------------------- detachment -- */

/*
 * Detachment (游离 / 未接入) is a temporary, LEGAL state a pool, account or
 * proxy can be parked in while rewiring: it simply has no upstream relation
 * and therefore receives no traffic. It is ORTHOGONAL to HealthStatus — a
 * detached-but-healthy pool is still "healthy" — so these helpers are the only
 * vocabulary for it; no status value exists for it on purpose.
 */

/**
 * True when the entity has no upstream relation at all: a pool no key binds, an
 * account owned by no pool, a proxy no account references. The gateway is
 * always the root and every key implicitly hangs off the gateway, so those two
 * kinds are never detached.
 */
export function isDetached(state: GraphState, entity: Entity): boolean {
  switch (entity.kind) {
    case 'gateway':
    case 'key':
      return false
    case 'pool':
      return !state.keys.some((key) => key.bindings.some((b) => b.poolId === entity.id))
    case 'account':
      return !state.pools.some((pool) => pool.members.some((m) => m.accountId === entity.id))
    case 'proxy':
      return !state.accounts.some((account) => account.proxyId === entity.id)
  }
}

/** Every detached entity of the graph, in `allEntities` order. */
export function detachedEntities(state: GraphState): Entity[] {
  return allEntities(state).filter((entity) => isDetached(state, entity))
}

/**
 * Egress-before-serve rule: an account may only join a pool once it has an
 * egress proxy bound. Enforced on every server path that can add a member
 * (bind, pool `members` patch, seed, reset).
 */
export function canJoinPool(account: AccountEntity): boolean {
  return account.proxyId !== null
}

/* ------------------------------------------------------------------ layout -- */

/*
 * Canonical canvas geometry — a layered DAG read left to right:
 *
 *   gateway | keys | pools | accounts | proxies
 *
 * GATEWAY, KEY, POOL and PROXY are each exactly ONE vertical column; they
 * never wrap. ACCOUNTS are the only kind allowed to be a grid: each pool's
 * accounts form one contiguous block wrapping at `LAYOUT.accountLanes`
 * columns, blocks stacked in pool order with `LAYOUT.blockGap` between them,
 * unassigned accounts parked below the live graph.
 *
 * Vertical placement expresses the relations: a pool sits across from the
 * centre of its account block, keys sit at the barycentre of the pools they
 * bind, the gateway centres on the key column and proxies sit at the
 * barycentre of the accounts dialling them — so edges read as near-horizontal
 * flows instead of long diagonals.
 *
 * `layoutPositions` is a pure function of the RELATIONS (state order, pool
 * membership, key bindings, proxy usage) — never of the current positions —
 * and the whole console shares it (seed data, server-side placement of new
 * entities, the canvas 自动布局 button), so the three can never drift apart
 * and 自动布局 on an untouched seed graph is an exact no-op.
 */

/** Width of one kind's band: a single card, except the account lane grid. */
function bandWidth(kind: EntityKind): number {
  if (kind === 'account') {
    return (
      LAYOUT.accountLanes * LAYOUT.nodeWidth.account + (LAYOUT.accountLanes - 1) * LAYOUT.laneGap
    )
  }
  return LAYOUT.nodeWidth[kind]
}

/**
 * Fixed x of every kind's column (left edge; for accounts the left edge of
 * lane 0). With single columns the band widths are constants, so the x values
 * no longer depend on how many entities exist.
 */
export function layoutColumnX(): Record<EntityKind, number> {
  const out = {} as Record<EntityKind, number>
  let x = 0
  for (const kind of KIND_ORDER) {
    out[kind] = x
    x += bandWidth(kind) + LAYOUT.columnGap
  }
  return out
}

/**
 * 1-D overlap resolution for one column. Items arrive top-to-bottom with
 * NON-DECREASING desired tops; the result keeps that order, spaces items at
 * least `height + gap` apart and re-centres every run of colliding items on
 * its members' targets — the classic priority / block-shift pass (walk down
 * pushing on overlap, bottom-up relaxation), computed in one deterministic
 * pool-adjacent-violators merge.
 */
function placeColumn(desiredTops: number[], height: number, gap: number): number[] {
  const step = height + gap
  interface Block {
    start: number
    count: number
    /** Sum of the members' implied block-top targets (desired - offset). */
    sum: number
  }
  const blocks: Block[] = []
  desiredTops.forEach((desired, index) => {
    let block: Block = { start: index, count: 1, sum: desired }
    while (blocks.length > 0) {
      const prev = blocks[blocks.length - 1]
      if (prev.sum / prev.count + prev.count * step <= block.sum / block.count) break
      blocks.pop()
      block = {
        start: prev.start,
        count: prev.count + block.count,
        sum: prev.sum + block.sum - block.count * (block.start - prev.start) * step,
      }
    }
    blocks.push(block)
  })
  const tops = new Array<number>(desiredTops.length)
  for (const block of blocks) {
    const top = block.sum / block.count
    for (let i = 0; i < block.count; i += 1) tops[block.start + i] = top + i * step
  }
  return tops
}

/**
 * Home position of every entity in the graph — see the layered-DAG contract
 * above. Detached pools/accounts/proxies (feature 5) are parked in a clearly
 * separated area below the live graph, x-aligned with their own column;
 * parked accounts keep the lane-grid treatment.
 */
export function layoutPositions(state: GraphState): Record<string, XY> {
  const out: Record<string, XY> = {}
  const detachedIds = new Set(detachedEntities(state).map((entity) => entity.id))
  const colX = layoutColumnX()
  const stepOf = (kind: EntityKind): number => LAYOUT.nodeHeight[kind] + LAYOUT.rowGap
  const laneStep = LAYOUT.nodeWidth.account + LAYOUT.laneGap

  /* -- 1. account band: one contiguous block per owning pool ------------- */
  // The band defines the vertical scale of the whole layout. Attached pools
  // first (they anchor the pool column), then detached pools — their accounts
  // are still attached and keep a block while the pool itself parks below.
  const accountById = new Map(state.accounts.map((account) => [account.id, account]))
  const placedAccounts = new Set<string>()
  const blockCentre = new Map<string, number>()
  let cursor = LAYOUT.topY

  const layBlock = (accounts: AccountEntity[]): number => {
    const rows = Math.ceil(accounts.length / LAYOUT.accountLanes)
    accounts.forEach((account, index) => {
      out[account.id] = {
        x: colX.account + (index % LAYOUT.accountLanes) * laneStep,
        y: cursor + Math.floor(index / LAYOUT.accountLanes) * stepOf('account'),
      }
      placedAccounts.add(account.id)
    })
    const height = rows * LAYOUT.nodeHeight.account + (rows - 1) * LAYOUT.rowGap
    const centre = cursor + height / 2
    cursor += height + LAYOUT.blockGap
    return centre
  }

  const blockPools = [
    ...state.pools.filter((pool) => !detachedIds.has(pool.id)),
    ...state.pools.filter((pool) => detachedIds.has(pool.id)),
  ]
  for (const pool of blockPools) {
    // Member order IS reading order: left-to-right, then down. A duplicated
    // claim (momentarily inconsistent snapshot) stays with the first pool.
    const members = pool.members
      .map((member) => accountById.get(member.accountId))
      .filter((account): account is AccountEntity => !!account && !placedAccounts.has(account.id))
    if (members.length === 0) {
      // Memberless pool: no block — aim the pool just below the previous one.
      blockCentre.set(pool.id, cursor + LAYOUT.nodeHeight.pool / 2)
      continue
    }
    blockCentre.set(pool.id, layBlock(members))
  }
  // Defensive: an attached account no member row names (momentarily
  // inconsistent snapshot) still needs a home — one trailing block.
  const strays = state.accounts.filter(
    (account) => !placedAccounts.has(account.id) && !detachedIds.has(account.id),
  )
  if (strays.length > 0) layBlock(strays)

  /* -- 2. pool column: each pool across from its account block ----------- */
  // Attached pools come first in block order, so their desired tops are
  // already non-decreasing — exactly what `placeColumn` needs.
  const attachedPools = state.pools.filter((pool) => !detachedIds.has(pool.id))
  const poolTops = placeColumn(
    attachedPools.map(
      (pool) =>
        (blockCentre.get(pool.id) ?? LAYOUT.topY + LAYOUT.nodeHeight.pool / 2) -
        LAYOUT.nodeHeight.pool / 2,
    ),
    LAYOUT.nodeHeight.pool,
    LAYOUT.rowGap,
  )
  attachedPools.forEach((pool, index) => {
    out[pool.id] = { x: colX.pool, y: Math.round(poolTops[index]) }
  })
  const poolCentre = new Map(
    attachedPools.map((pool, index) => [pool.id, poolTops[index] + LAYOUT.nodeHeight.pool / 2]),
  )

  /* -- 3. key column: barycentre of the bound pools ----------------------- */
  // A pool named by any binding is attached by definition, so `poolCentre`
  // covers every reachable target. Keys binding nothing stack below the bound
  // ones in state order — the same bottom-of-column spot a freshly created
  // key gets from the server.
  const keyed = state.keys.map((key) => {
    const centres = key.bindings
      .map((binding) => poolCentre.get(binding.poolId))
      .filter((value): value is number => value !== undefined)
    return {
      key,
      centre:
        centres.length > 0 ? centres.reduce((sum, value) => sum + value, 0) / centres.length : null,
    }
  })
  const boundKeys = keyed.filter((item) => item.centre !== null)
  // Array.prototype.sort is stable: ties keep state order.
  boundKeys.sort((a, b) => (a.centre as number) - (b.centre as number))
  const keyTops = placeColumn(
    boundKeys.map((item) => (item.centre as number) - LAYOUT.nodeHeight.key / 2),
    LAYOUT.nodeHeight.key,
    LAYOUT.rowGap,
  )
  boundKeys.forEach((item, index) => {
    out[item.key.id] = { x: colX.key, y: Math.round(keyTops[index]) }
  })
  let nextKeyTop =
    boundKeys.length > 0 ? keyTops[boundKeys.length - 1] + stepOf('key') : LAYOUT.topY
  for (const item of keyed) {
    if (item.centre !== null) continue
    out[item.key.id] = { x: colX.key, y: Math.round(nextKeyTop) }
    nextKeyTop += stepOf('key')
  }

  /* -- 4. gateway: vertically centred on the key column ------------------- */
  if (state.gateway?.id) {
    let top = LAYOUT.topY
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const key of state.keys) {
      const position = out[key.id]
      if (!position) continue
      min = Math.min(min, position.y)
      max = Math.max(max, position.y + LAYOUT.nodeHeight.key)
    }
    if (min !== Number.POSITIVE_INFINITY) {
      top = (min + max) / 2 - LAYOUT.nodeHeight.gateway / 2
    }
    out[state.gateway.id] = { x: colX.gateway, y: Math.round(top) }
  }

  /* -- 5. proxy column: barycentre of the accounts dialling it ------------ */
  // Only accounts already placed in the band pull; an attached proxy whose
  // only users are parked accounts stacks below the pulled ones.
  const userCentres = new Map<string, number[]>()
  for (const account of state.accounts) {
    if (!account.proxyId) continue
    const position = out[account.id]
    if (!position) continue
    const centre = position.y + LAYOUT.nodeHeight.account / 2
    const list = userCentres.get(account.proxyId)
    if (list) list.push(centre)
    else userCentres.set(account.proxyId, [centre])
  }
  const proxied = state.proxies
    .filter((proxy) => !detachedIds.has(proxy.id))
    .map((proxy) => {
      const centres = userCentres.get(proxy.id) ?? []
      return {
        proxy,
        centre:
          centres.length > 0
            ? centres.reduce((sum, value) => sum + value, 0) / centres.length
            : null,
      }
    })
  const pulledProxies = proxied.filter((item) => item.centre !== null)
  pulledProxies.sort((a, b) => (a.centre as number) - (b.centre as number))
  const proxyTops = placeColumn(
    pulledProxies.map((item) => (item.centre as number) - LAYOUT.nodeHeight.proxy / 2),
    LAYOUT.nodeHeight.proxy,
    LAYOUT.rowGap,
  )
  pulledProxies.forEach((item, index) => {
    out[item.proxy.id] = { x: colX.proxy, y: Math.round(proxyTops[index]) }
  })
  let nextProxyTop =
    pulledProxies.length > 0
      ? proxyTops[pulledProxies.length - 1] + stepOf('proxy')
      : LAYOUT.topY
  for (const item of proxied) {
    if (item.centre !== null) continue
    out[item.proxy.id] = { x: colX.proxy, y: Math.round(nextProxyTop) }
    nextProxyTop += stepOf('proxy')
  }

  /* -- 6. detached parking (feature 5) ------------------------------------ */
  let bottom = LAYOUT.topY
  for (const entity of allEntities(state)) {
    const position = out[entity.id]
    if (position) bottom = Math.max(bottom, position.y + LAYOUT.nodeHeight[entity.kind])
  }
  const parkY = bottom + LAYOUT.detachedGap
  state.pools
    .filter((pool) => detachedIds.has(pool.id))
    .forEach((pool, index) => {
      out[pool.id] = { x: colX.pool, y: parkY + index * stepOf('pool') }
    })
  state.accounts
    .filter((account) => detachedIds.has(account.id))
    .forEach((account, index) => {
      out[account.id] = {
        x: colX.account + (index % LAYOUT.accountLanes) * laneStep,
        y: parkY + Math.floor(index / LAYOUT.accountLanes) * stepOf('account'),
      }
    })
  state.proxies
    .filter((proxy) => detachedIds.has(proxy.id))
    .forEach((proxy, index) => {
      out[proxy.id] = { x: colX.proxy, y: parkY + index * stepOf('proxy') }
    })

  return out
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) return `${round(value / 1_000_000_000, 1)}B`
  if (abs >= 1_000_000) return `${round(value / 1_000_000, 1)}M`
  if (abs >= 1_000) return `${round(value / 1_000, 1)}K`
  return `${round(value, abs < 10 ? 1 : 0)}`
}

export function formatMs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value >= 1000) return `${round(value / 1000, 2)}s`
  return `${Math.round(value)}ms`
}

export function formatRelativeTime(at: number | null, now = Date.now()): string {
  if (!at) return '从未使用'
  const delta = Math.max(0, now - at)
  if (delta < 1000) return '刚刚'
  if (delta < 60_000) return `${Math.floor(delta / 1000)} 秒前`
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  return `${Math.floor(delta / 3_600_000)} 小时前`
}

export function formatClock(at: number): string {
  const d = new Date(at)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}
