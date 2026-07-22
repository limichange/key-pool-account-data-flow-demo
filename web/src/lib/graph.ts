/**
 * Maps the domain `GraphState` onto React Flow nodes and edges, plus the
 * band/lane auto-layout with barycentre crossing reduction (feature 11).
 */
import type { Edge, Node } from '@xyflow/react'

import {
  ENTITY_KINDS,
  KIND_ORDER,
  LAYOUT,
  detachedEntities,
  edgeId,
  layoutSlots,
  type AccountEntity,
  type Entity,
  type EntityKind,
  type GatewayEntity,
  type GraphState,
  type KeyEntity,
  type KindCounts,
  type PoolEntity,
  type ProxyEntity,
  type XY,
} from '@kpa/shared'

export interface FlowNodeData extends Record<string, unknown> {
  entity: Entity
  dimmed: boolean
  traced: boolean
  /**
   * Feature 5 — no upstream relation at all (游离 / 未接入). Orthogonal to
   * `status`: a detached-but-healthy pool is still "healthy", it simply
   * receives no traffic. Cards render the dashed treatment from this flag.
   */
  detached: boolean
}

export type KpaNode = Node<FlowNodeData, EntityKind>

/**
 * `pool-failover` is a pool -> pool edge and is NOT a binding: it is the
 * `failoverPoolId` field. It needs its own relation so deleting it patches the
 * field instead of posting an `unbind` the server must reject.
 * `gateway-key` is system-owned and implicit (every key hangs off the
 * gateway): it can never be created, deleted or edited by the operator.
 */
export type FlowEdgeKind = 'gateway-key' | 'key-pool' | 'pool-account' | 'account-proxy' | 'pool-failover'

export interface FlowEdgeData extends Record<string, unknown> {
  relation: FlowEdgeKind
  sourceKind: EntityKind
  label: string
  weight: number
  disabled: boolean
  /**
   * Feature 4 — the edge STROKE now answers exactly one question: is this
   * path live? GREEN (--ok) when BOTH endpoints are enabled, GREY when either
   * is off. The owner asked for "node on -> its upstream line is green, node
   * off -> grey"; the rule is deliberately extended to the source side too,
   * because a live-green line dangling off a visibly disabled source card
   * would read as a bug. Kind identity moved out of the stroke and into the
   * chip (micro-bar colour, chip border) and the traffic particles.
   * Precomputed here so `FlowEdge` stays a cheap primitive-only consumer.
   */
  live: boolean
  dimmed: boolean
  traced: boolean
}

export type KpaEdge = Edge<FlowEdgeData, 'flow'>

/** The relation-specific half of `FlowEdgeData`; the rest is derived while building. */
interface EdgeSpec {
  relation: FlowEdgeKind
  label: string
  weight: number
  disabled: boolean
}

export interface BuildGraphOptions {
  search: string
  kindFilter: Record<EntityKind, boolean>
  onlyProblems: boolean
  tracedIds: Set<string>
  tracedEdgeIds: Set<string>
}

const KIND_INDEX = KIND_ORDER.reduce(
  (acc, kind, index) => {
    acc[kind] = index
    return acc
  },
  {} as Record<EntityKind, number>,
)

/* ----------------------------------------------------------- filtering -- */

function searchCorpus(entity: Entity): string {
  const parts: string[] = [entity.id, entity.name, entity.note, ...entity.tags]
  switch (entity.kind) {
    case 'gateway': {
      const gateway = entity as GatewayEntity
      parts.push(gateway.endpoint, gateway.version)
      break
    }
    case 'key': {
      const key = entity as KeyEntity
      parts.push(key.secret, key.owner, key.tier, ...key.allowedModels)
      break
    }
    case 'pool': {
      const pool = entity as PoolEntity
      parts.push(pool.strategy)
      break
    }
    case 'account': {
      const account = entity as AccountEntity
      parts.push(
        account.provider,
        account.accountType,
        account.credentialMask,
        account.region,
        account.credentialType,
        ...account.models,
      )
      break
    }
    case 'proxy': {
      const proxy = entity as ProxyEntity
      parts.push(
        proxy.host,
        `${proxy.host}:${proxy.port}`,
        proxy.ip,
        proxy.country,
        proxy.region,
        proxy.countryCode,
        proxy.protocol,
      )
      break
    }
  }
  return parts.join(' ').toLowerCase()
}

/**
 * The chips and the 只看异常 toggle are *filters*: they remove nodes (and the
 * edges touching them) from the graph. Free-text search is a *highlight*: it
 * keeps the topology intact and dims what does not match.
 */
function keeps(entity: Entity, opts: BuildGraphOptions): boolean {
  // The gateway is the singleton root of the whole graph: filtering it away
  // would orphan the key band, so the chips and 只看异常 never remove it.
  if (entity.kind === 'gateway') return true
  if (!opts.kindFilter[entity.kind]) return false
  if (opts.onlyProblems && entity.status === 'healthy') return false
  return true
}

export interface BuiltGraph {
  nodes: KpaNode[]
  edges: KpaEdge[]
  /** Nodes of each kind left after filtering, and how many exist in total. */
  visible: Record<EntityKind, number>
  total: Record<EntityKind, number>
  /** True when the chips / 只看异常 are removing anything. */
  filtered: boolean
  /** Number of visible nodes matching the free-text search (-1 when unused). */
  searchMatches: number
}

/* ------------------------------------------------------------- builder -- */

export function buildGraph(state: GraphState, opts: BuildGraphOptions): BuiltGraph {
  const needle = opts.search.trim().toLowerCase()
  const filtered = opts.onlyProblems || ENTITY_KINDS.some((kind) => !opts.kindFilter[kind])

  // `state.gateway.id === ''` is the pre-snapshot placeholder — skip it.
  const hasGateway = Boolean(state.gateway?.id)
  const all: Entity[] = [...state.keys, ...state.pools, ...state.accounts, ...state.proxies]
  if (hasGateway) all.unshift(state.gateway)

  const zeroCounts = (): Record<EntityKind, number> => ({
    gateway: 0,
    key: 0,
    pool: 0,
    account: 0,
    proxy: 0,
  })
  const total = zeroCounts()
  for (const entity of all) total[entity.kind] += 1

  const entities = filtered ? all.filter((entity) => keeps(entity, opts)) : all
  const visible = zeroCounts()
  const dimmedIds = new Set<string>()
  const known = new Map<string, Entity>()
  const detachedIds = new Set(detachedEntities(state).map((entity) => entity.id))
  let searchMatches = 0

  for (const entity of entities) {
    known.set(entity.id, entity)
    visible[entity.kind] += 1
    if (needle.length === 0) continue
    if (searchCorpus(entity).includes(needle)) searchMatches += 1
    else dimmedIds.add(entity.id)
  }

  const nodes: KpaNode[] = entities.map((entity) => ({
    id: entity.id,
    type: entity.kind,
    position: { x: entity.position.x, y: entity.position.y },
    draggable: true,
    selectable: true,
    // The gateway singleton can never be deleted (feature 1/6).
    deletable: entity.kind !== 'gateway',
    data: {
      entity,
      dimmed: dimmedIds.has(entity.id),
      traced: opts.tracedIds.has(entity.id),
      detached: detachedIds.has(entity.id),
    },
  }))

  const edges: KpaEdge[] = []
  // Every React Flow edge id must be unique. The account band already dedupes by
  // owning pool, but the key band can still hand us two rows for the same
  // key->pool pair (a regressed server, a momentarily inconsistent snapshot), so
  // guard every edge id here — a duplicate key throws inside @xyflow's renderer.
  const emittedEdgeIds = new Set<string>()

  const pushEdge = (source: Entity, targetId: string, spec: EdgeSpec): void => {
    const target = known.get(targetId)
    if (!target) return
    const id = edgeId(source.id, targetId)
    if (emittedEdgeIds.has(id)) return
    emittedEdgeIds.add(id)
    edges.push({
      id,
      source: source.id,
      target: targetId,
      sourceHandle: 'out',
      targetHandle: 'in',
      type: 'flow',
      // The implicit gateway->key edges are system-owned, never user-deletable.
      deletable: spec.relation !== 'gateway-key',
      data: {
        ...spec,
        sourceKind: source.kind,
        live: source.enabled && target.enabled,
        dimmed: dimmedIds.has(source.id) || dimmedIds.has(targetId),
        traced: opts.tracedEdgeIds.has(id),
      },
    })
  }

  // Every key hangs off the gateway; these edges show each key's SHARE of the
  // total traffic entering the console (feature 1).
  if (hasGateway) {
    for (const key of state.keys) {
      if (!known.has(key.id)) continue
      pushEdge(state.gateway, key.id, {
        relation: 'gateway-key',
        label: '入口',
        weight: key.trafficWeight,
        disabled: false,
      })
    }
  }

  for (const key of known.values()) {
    if (key.kind !== 'key') continue
    for (const binding of key.bindings) {
      pushEdge(key, binding.poolId, {
        relation: 'key-pool',
        label: `P${binding.priority}`,
        weight: binding.weight,
        disabled: false,
      })
    }
  }

  /*
   * THE INVARIANT, enforced at render time: an account has at most one owning
   * pool, so it may never have more than one incoming `pool-account` edge.
   * `PoolEntity.members` stays the source of truth, but a snapshot that is
   * momentarily inconsistent (or a server that regressed) must not paint two
   * parents. `edgeOwner` resolves the winner once, up front: the derived
   * `account.poolId` back-reference wins when it agrees with a membership row,
   * otherwise the first pool in state order keeps the account and every other
   * claim is dropped.
   */
  const edgeOwner = new Map<string, string>()
  for (const pool of known.values()) {
    if (pool.kind !== 'pool') continue
    for (const member of pool.members) {
      const account = known.get(member.accountId)
      if (account?.kind === 'account' && account.poolId === pool.id) {
        edgeOwner.set(member.accountId, pool.id)
      }
    }
  }
  for (const pool of known.values()) {
    if (pool.kind !== 'pool') continue
    for (const member of pool.members) {
      if (!edgeOwner.has(member.accountId)) edgeOwner.set(member.accountId, pool.id)
    }
  }

  const emitted = new Set<string>()
  for (const pool of known.values()) {
    if (pool.kind !== 'pool') continue
    for (const member of pool.members) {
      // Claim on an account another pool already owns, or a repeated membership
      // row inside this pool: either way it is a duplicate edge, so drop it.
      if (edgeOwner.get(member.accountId) !== pool.id) continue
      if (emitted.has(member.accountId)) continue
      emitted.add(member.accountId)
      pushEdge(pool, member.accountId, {
        relation: 'pool-account',
        label: `w${member.weight}`,
        weight: member.weight,
        disabled: !member.enabled,
      })
    }
    if (pool.failoverPoolId && pool.failoverPoolId !== pool.id) {
      pushEdge(pool, pool.failoverPoolId, {
        relation: 'pool-failover',
        label: '故障转移',
        weight: 1,
        disabled: true,
      })
    }
  }

  for (const account of known.values()) {
    if (account.kind !== 'account') continue
    if (!account.proxyId) continue
    const proxy = known.get(account.proxyId)
    const label = proxy && proxy.kind === 'proxy' ? proxy.protocol : 'proxy'
    pushEdge(account, account.proxyId, {
      relation: 'account-proxy',
      label,
      weight: 1,
      disabled: false,
    })
  }

  const nodeOrder = (node: KpaNode): number => KIND_INDEX[node.data.entity.kind] ?? 0
  nodes.sort((a, b) => nodeOrder(a) - nodeOrder(b) || a.position.y - b.position.y || a.id.localeCompare(b.id))

  const positionOf = (id: string): XY => known.get(id)?.position ?? { x: 0, y: 0 }
  edges.sort((a, b) => {
    const ka = KIND_INDEX[a.data?.sourceKind ?? 'key'] ?? 0
    const kb = KIND_INDEX[b.data?.sourceKind ?? 'key'] ?? 0
    if (ka !== kb) return ka - kb
    const ya = positionOf(a.source).y
    const yb = positionOf(b.source).y
    if (ya !== yb) return ya - yb
    return a.id.localeCompare(b.id)
  })

  return {
    nodes,
    edges,
    visible,
    total,
    filtered,
    searchMatches: needle.length === 0 ? -1 : searchMatches,
  }
}

/* -------------------------------------------------------------- layout -- */

/** Vertical clearance between the live graph and the detached parking area. */
const DETACHED_GAP = 120

/** Kinds that may legally detach (feature 5); the gateway and keys never do. */
const DETACHABLE = ['pool', 'account', 'proxy'] as const

/**
 * Stable "where is it now" order. `layoutSlots` fills a band LANE-MAJOR (lane
 * = x, then row = y), so recovering the current order must read x first —
 * sorting y-first would interleave the lanes of a wrapped band and scramble a
 * graph that was already tidy.
 */
function byCanvasOrder(a: Entity, b: Entity): number {
  return a.position.x - b.position.x || a.position.y - b.position.y || a.id.localeCompare(b.id)
}

/** The four attached band orders one layout candidate is made of. */
interface BandOrders {
  keys: KeyEntity[]
  pools: PoolEntity[]
  accounts: AccountEntity[]
  proxies: ProxyEntity[]
}

/**
 * Re-packs the whole graph onto the canonical band/lane grid:
 *
 *   1. five bands left to right — gateway (singleton, vertically centred by
 *      `layoutSlots`), keys, pools, accounts, proxies;
 *   2. band ORDER starts from the current canvas order, then a couple of
 *      barycentre crossing-reduction sweeps propose refinements (pools near
 *      the keys that share them, keys near their pools, proxies at the mean
 *      position of the accounts dialling them). Every candidate — including
 *      the INCOMING free-form layout itself — is EVALUATED with
 *      `countEdgeCrossings`; the repack wins ties against the current
 *      positions (the tidy grid has value beyond crossings) but anything
 *      strictly worse than what the operator already has is rejected, so the
 *      result can never be worse than the incoming layout and 自动布局 on an
 *      untouched seed graph is a no-op. The account band is always regrouped
 *      into one contiguous block per owning pool — that structural rule is
 *      what keeps the pool->account forest crossing-free;
 *   3. detached pools/accounts/proxies (feature 5) are parked in a clearly
 *      separated area BELOW the live graph, x-aligned with their own band, so
 *      they never tangle the live topology.
 *
 * Coordinates come from `layoutSlots` — the same helper the seed data and the
 * server-side placement of new entities use — which owns lane wrapping
 * (`LAYOUT.maxRowsPerLane`), band centring and the overall aspect ratio
 * window. This file only decides *order*.
 */
export function autoLayout(state: GraphState): Record<string, XY> {
  const hasGateway = Boolean(state.gateway?.id)
  const detachedIds = new Set(detachedEntities(state).map((entity) => entity.id))
  const accountById = new Map(state.accounts.map((account) => [account.id, account]))

  /* ---------------------------------------------- structural account rule -- */

  // One CONTIGUOUS block per owning pool, pools in band order, members in
  // routing order. Accounts owned by a *detached* pool are still attached
  // (they have a pool), so they stay in the band, after the live blocks; an
  // attached account no member row names (momentarily inconsistent snapshot)
  // is stable-appended rather than lost.
  const groupAccounts = (poolOrder: PoolEntity[]): AccountEntity[] => {
    const ordered: AccountEntity[] = []
    const placed = new Set<string>()
    const claim = (pool: PoolEntity): void => {
      for (const member of pool.members) {
        const account = accountById.get(member.accountId)
        if (!account || placed.has(account.id) || detachedIds.has(account.id)) continue
        placed.add(account.id)
        ordered.push(account)
      }
    }
    for (const pool of poolOrder) claim(pool)
    for (const pool of state.pools) {
      if (detachedIds.has(pool.id)) claim(pool)
    }
    for (const account of state.accounts) {
      if (placed.has(account.id) || detachedIds.has(account.id)) continue
      placed.add(account.id)
      ordered.push(account)
    }
    return ordered
  }

  const basePools = state.pools.filter((pool) => !detachedIds.has(pool.id)).sort(byCanvasOrder)
  const base: BandOrders = {
    keys: state.keys.slice().sort(byCanvasOrder),
    pools: basePools,
    accounts: groupAccounts(basePools),
    proxies: state.proxies.filter((proxy) => !detachedIds.has(proxy.id)).sort(byCanvasOrder),
  }

  /* --------------------------------------------------------- geometry -- */

  const counts: KindCounts = {
    gateway: hasGateway ? 1 : 0,
    key: base.keys.length,
    pool: base.pools.length,
    account: base.accounts.length,
    proxy: base.proxies.length,
  }
  const slots = layoutSlots(counts)

  // Centre-y of the i-th slot of a band — the coordinate the crossing counter
  // actually measures. Index-based barycentres go wrong the moment a band
  // wraps into lanes (index order is lane-major, not top-to-bottom); slot-y
  // ones do not.
  const slotY = (kind: EntityKind, index: number): number =>
    (slots[kind][index]?.y ?? 0) + LAYOUT.nodeHeight[kind] / 2

  /* --------------------------------- detached parking (features 5 + 11) -- */

  let bottom = LAYOUT.topY
  for (const kind of KIND_ORDER) {
    for (const slot of slots[kind]) bottom = Math.max(bottom, slot.y + LAYOUT.nodeHeight[kind])
  }
  // Probe with every count clamped to >= 1: `layoutSlots` gives a 0-count band
  // and a 1-count band the same width (both are one lane), so `slots[kind][0].x`
  // is the band's base x even when every node of that band is parked.
  const probe = layoutSlots({
    gateway: Math.max(1, counts.gateway ?? 0),
    key: Math.max(1, counts.key ?? 0),
    pool: Math.max(1, counts.pool ?? 0),
    account: Math.max(1, counts.account ?? 0),
    proxy: Math.max(1, counts.proxy ?? 0),
  })
  const parkY = bottom + DETACHED_GAP
  const parked: Record<string, XY> = {}
  const listsByKind: Record<(typeof DETACHABLE)[number], Entity[]> = {
    pool: state.pools,
    account: state.accounts,
    proxy: state.proxies,
  }
  for (const kind of DETACHABLE) {
    const lost = listsByKind[kind].filter((entity) => detachedIds.has(entity.id)).sort(byCanvasOrder)
    const baseX = probe[kind][0]?.x ?? 0
    lost.forEach((entity, index) => {
      parked[entity.id] = {
        x: baseX,
        y: parkY + index * (LAYOUT.nodeHeight[kind] + LAYOUT.rowGap),
      }
    })
  }

  const positionsFor = (orders: BandOrders): Record<string, XY> => {
    const out: Record<string, XY> = {}
    const assign = (kind: EntityKind, ordered: Entity[]): void => {
      ordered.forEach((entity, index) => {
        const slot = slots[kind][index]
        if (slot) out[entity.id] = { x: slot.x, y: slot.y }
      })
    }
    if (hasGateway) assign('gateway', [state.gateway])
    assign('key', orders.keys)
    assign('pool', orders.pools)
    assign('account', orders.accounts)
    assign('proxy', orders.proxies)
    // Parked nodes are part of every candidate, so their (long) edges are
    // measured by the evaluator too.
    Object.assign(out, parked)
    return out
  }

  /* ------------------------------- barycentre sweeps, evaluation-gated -- */

  // Reverse adjacency of Key <-> Pool, for the pool band's barycentres.
  const keysOfPool = new Map<string, string[]>()
  for (const key of state.keys) {
    for (const binding of key.bindings) {
      const list = keysOfPool.get(binding.poolId)
      if (list) list.push(key.id)
      else keysOfPool.set(binding.poolId, [key.id])
    }
  }

  // Nodes with no neighbours keep their current slot-y (stable sort keeps
  // exact ties in their current relative order).
  const orderByBarycentre = <T extends Entity>(
    list: T[],
    kind: EntityKind,
    neighbourYs: (entity: T) => number[],
  ): T[] =>
    list
      .map((entity, index) => {
        const ns = neighbourYs(entity)
        const centre =
          ns.length > 0 ? ns.reduce((sum, value) => sum + value, 0) / ns.length : slotY(kind, index)
        return { entity, centre }
      })
      .sort((a, b) => a.centre - b.centre)
      .map((item) => item.entity)

  const sweep = (orders: BandOrders): BandOrders => {
    const keyY = new Map(orders.keys.map((entity, index) => [entity.id, slotY('key', index)]))
    const pools = orderByBarycentre(orders.pools, 'pool', (pool) =>
      (keysOfPool.get(pool.id) ?? [])
        .map((id) => keyY.get(id))
        .filter((value): value is number => value !== undefined),
    )
    const poolY = new Map(pools.map((entity, index) => [entity.id, slotY('pool', index)]))
    const keys = orderByBarycentre(orders.keys, 'key', (key) =>
      key.bindings
        .map((binding) => poolY.get(binding.poolId))
        .filter((value): value is number => value !== undefined),
    )
    const accounts = groupAccounts(pools)
    const accountY = new Map<string, number[]>()
    accounts.forEach((account, index) => {
      if (!account.proxyId) return
      const list = accountY.get(account.proxyId)
      if (list) list.push(slotY('account', index))
      else accountY.set(account.proxyId, [slotY('account', index)])
    })
    const proxies = orderByBarycentre(orders.proxies, 'proxy', (proxy) => accountY.get(proxy.id) ?? [])
    return { keys, pools, accounts, proxies }
  }

  /*
   * The INCOMING free-form layout is a candidate too: hand-placed positions
   * are scored first, so the repack can never leave the canvas with MORE
   * crossings than the operator had. Detached parking is unconditional (it is
   * feature 5's contract), so the current candidate carries the parked
   * coordinates as well — even a "keep everything" outcome still parks.
   */
  const currentCandidate: Record<string, XY> = {}
  for (const entity of [
    ...(hasGateway ? [state.gateway] : []),
    ...state.keys,
    ...state.pools,
    ...state.accounts,
    ...state.proxies,
  ]) {
    currentCandidate[entity.id] = { x: entity.position.x, y: entity.position.y }
  }
  Object.assign(currentCandidate, parked)

  let bestPositions = currentCandidate
  let bestScore = countEdgeCrossings(state, currentCandidate)

  // The canonical repack wins TIES against the free-form layout — the tidy
  // band/lane grid has value beyond crossings — but a strictly worse repack is
  // rejected, keeping the "never worse than the incoming layout" guarantee.
  // On an untouched seed the repack equals the current positions, so the tie
  // rule keeps 自动布局 a no-op there.
  const baseCandidate = positionsFor(base)
  const baseScore = countEdgeCrossings(state, baseCandidate)
  if (baseScore <= bestScore) {
    bestScore = baseScore
    bestPositions = baseCandidate
  }

  let current = base
  for (let pass = 0; pass < 2; pass += 1) {
    current = sweep(current)
    const candidate = positionsFor(current)
    const score = countEdgeCrossings(state, candidate)
    // Strictly better only: an equal-score shuffle would break the
    // untouched-graph no-op guarantee for nothing.
    if (score < bestScore) {
      bestScore = score
      bestPositions = candidate
    }
  }

  return bestPositions
}

/* --------------------------------------------------- crossing counting -- */

interface CrossSeg {
  source: string
  target: string
  sy: number
  ty: number
}

/**
 * Counts pairs of same-channel edges whose endpoint order inverts between the
 * two bands — the standard proxy for visual edge crossings in a layered
 * layout. Pass `positions` to evaluate a candidate layout without applying it.
 * Used to verify that `autoLayout` actually reduces crossings.
 */
export function countEdgeCrossings(state: GraphState, positions?: Record<string, XY>): number {
  const entities = new Map<string, Entity>()
  for (const entity of [
    ...(state.gateway?.id ? [state.gateway] : []),
    ...state.keys,
    ...state.pools,
    ...state.accounts,
    ...state.proxies,
  ]) {
    entities.set(entity.id, entity)
  }

  const centreY = (id: string): number | null => {
    const entity = entities.get(id)
    if (!entity) return null
    const y = positions?.[entity.id]?.y ?? entity.position.y
    return y + LAYOUT.nodeHeight[entity.kind] / 2
  }

  const channels = new Map<string, CrossSeg[]>()
  const add = (channel: string, source: string, target: string): void => {
    const sy = centreY(source)
    const ty = centreY(target)
    if (sy === null || ty === null) return
    const list = channels.get(channel)
    const seg = { source, target, sy, ty }
    if (list) list.push(seg)
    else channels.set(channel, [seg])
  }

  if (state.gateway?.id) {
    for (const key of state.keys) add('gateway-key', state.gateway.id, key.id)
  }
  for (const key of state.keys) {
    for (const binding of key.bindings) add('key-pool', key.id, binding.poolId)
  }
  for (const pool of state.pools) {
    for (const member of pool.members) add('pool-account', pool.id, member.accountId)
  }
  for (const account of state.accounts) {
    if (account.proxyId) add('account-proxy', account.id, account.proxyId)
  }

  let crossings = 0
  for (const segs of channels.values()) {
    for (let i = 0; i < segs.length; i += 1) {
      for (let j = i + 1; j < segs.length; j += 1) {
        const a = segs[i]
        const b = segs[j]
        // Edges sharing an endpoint touch, they do not cross.
        if (a.source === b.source || a.target === b.target) continue
        if ((a.sy - b.sy) * (a.ty - b.ty) < 0) crossings += 1
      }
    }
  }
  return crossings
}
