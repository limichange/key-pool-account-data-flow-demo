/**
 * Maps the domain `GraphState` onto React Flow nodes and edges,
 * plus a dagre based auto-layout helper.
 */
import dagre from '@dagrejs/dagre'
import type { Edge, Node } from '@xyflow/react'

import {
  ENTITY_KINDS,
  KIND_ORDER,
  LAYOUT,
  allEntities,
  edgeId,
  kindCounts,
  layoutSlots,
  type AccountEntity,
  type Entity,
  type EntityKind,
  type GraphState,
  type KeyEntity,
  type PoolEntity,
  type ProxyEntity,
  type XY,
} from '@kpa/shared'

export interface FlowNodeData extends Record<string, unknown> {
  entity: Entity
  dimmed: boolean
  traced: boolean
}

export type KpaNode = Node<FlowNodeData, EntityKind>

/**
 * `pool-failover` is a pool -> pool edge and is NOT a binding: it is the
 * `failoverPoolId` field. It needs its own relation so deleting it patches the
 * field instead of posting an `unbind` the server must reject.
 */
export type FlowEdgeKind = 'key-pool' | 'pool-account' | 'account-proxy' | 'pool-failover'

export interface FlowEdgeData extends Record<string, unknown> {
  relation: FlowEdgeKind
  sourceKind: EntityKind
  label: string
  weight: number
  disabled: boolean
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

const KIND_INDEX: Record<EntityKind, number> = {
  key: KIND_ORDER.indexOf('key'),
  pool: KIND_ORDER.indexOf('pool'),
  account: KIND_ORDER.indexOf('account'),
  proxy: KIND_ORDER.indexOf('proxy'),
}

/* ----------------------------------------------------------- filtering -- */

function searchCorpus(entity: Entity): string {
  const parts: string[] = [entity.id, entity.name, entity.note, ...entity.tags]
  switch (entity.kind) {
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
        account.credentialMask,
        account.region,
        account.credentialType,
        ...account.models,
      )
      break
    }
    case 'proxy': {
      const proxy = entity as ProxyEntity
      parts.push(proxy.host, `${proxy.host}:${proxy.port}`, proxy.region, proxy.countryCode, proxy.protocol)
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

  const all = allEntities(state)
  const total: Record<EntityKind, number> = { key: 0, pool: 0, account: 0, proxy: 0 }
  for (const entity of all) total[entity.kind] += 1

  const entities = filtered ? all.filter((entity) => keeps(entity, opts)) : all
  const visible: Record<EntityKind, number> = { key: 0, pool: 0, account: 0, proxy: 0 }
  const dimmedIds = new Set<string>()
  const known = new Map<string, Entity>()
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
    data: {
      entity,
      dimmed: dimmedIds.has(entity.id),
      traced: opts.tracedIds.has(entity.id),
    },
  }))

  const edges: KpaEdge[] = []
  // Every React Flow edge id must be unique. The account band already dedupes by
  // owning pool, but the key band can still hand us two rows for the same
  // key->pool pair (a regressed server, a momentarily inconsistent snapshot), so
  // guard every edge id here — a duplicate key throws inside @xyflow's renderer.
  const emittedEdgeIds = new Set<string>()

  const pushEdge = (source: Entity, targetId: string, data: EdgeSpec): void => {
    if (!known.has(targetId)) return
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
      data: {
        ...data,
        sourceKind: source.kind,
        dimmed: dimmedIds.has(source.id) || dimmedIds.has(targetId),
        traced: opts.tracedEdgeIds.has(id),
      },
    })
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

function buckets(state: GraphState): Record<EntityKind, Entity[]> {
  return {
    key: state.keys,
    pool: state.pools,
    account: state.accounts,
    proxy: state.proxies,
  }
}

/**
 * Ranks the entities of every kind so that connected nodes end up close to each
 * other, which is the only thing dagre is used for here: the actual coordinates
 * come from `layoutSlots`, so the four bands stay aligned with the seed data
 * and cards can never overlap. Returns `null` when dagre cannot rank the graph.
 */
function dagreOrder(state: GraphState): Map<string, number> | null {
  try {
    const entities = allEntities(state)
    const graph = new dagre.graphlib.Graph({ multigraph: true })
    graph.setGraph({ rankdir: 'LR', ranksep: 200, nodesep: LAYOUT.rowGap, marginx: 0, marginy: 0 })
    graph.setDefaultEdgeLabel(() => ({}))

    const ids = new Set(entities.map((entity) => entity.id))
    for (const entity of entities) {
      graph.setNode(entity.id, {
        width: LAYOUT.nodeWidth[entity.kind],
        height: LAYOUT.nodeHeight[entity.kind],
      })
    }

    let edgeCount = 0
    const link = (source: string, target: string): void => {
      if (!ids.has(target) || source === target) return
      graph.setEdge(source, target, {}, `e${edgeCount}`)
      edgeCount += 1
    }
    for (const key of state.keys) for (const binding of key.bindings) link(key.id, binding.poolId)
    for (const pool of state.pools) {
      for (const member of pool.members) link(pool.id, member.accountId)
      if (pool.failoverPoolId) link(pool.id, pool.failoverPoolId)
    }
    for (const account of state.accounts) {
      if (account.proxyId) link(account.id, account.proxyId)
    }

    dagre.layout(graph)

    const ranks = new Map<string, number>()
    for (const entity of entities) {
      const node = graph.node(entity.id)
      if (!node || !Number.isFinite(node.y)) return null
      ranks.set(entity.id, node.y)
    }
    return ranks
  } catch {
    return null
  }
}

/**
 * Index of the pool that owns each account, for grouping the account band.
 *
 * Accounts with no pool sort after every pool (`state.pools.length`), which is
 * what puts 未分配 accounts at the bottom of the band. The derived
 * `account.poolId` back-reference is preferred; `PoolEntity.members` — the
 * source of truth — fills in anything it does not resolve.
 */
function poolRankOf(state: GraphState): Map<string, number> {
  const poolIndex = new Map(state.pools.map((pool, index) => [pool.id, index]))
  const rank = new Map<string, number>()
  for (const account of state.accounts) {
    const index = account.poolId ? poolIndex.get(account.poolId) : undefined
    if (index !== undefined) rank.set(account.id, index)
  }
  state.pools.forEach((pool, index) => {
    for (const member of pool.members) {
      if (!rank.has(member.accountId)) rank.set(member.accountId, index)
    }
  })
  return rank
}

/**
 * Re-packs the whole graph onto the canonical band/lane grid. Entities keep the
 * order dagre suggests when it is available, otherwise their current top-to-
 * bottom order on the canvas.
 *
 * The account band is grouped by owning pool first (pools in state order,
 * 未分配 last) so the one-pool-per-account forest reads as a forest instead of
 * a tangle — the same order the server lays the seed data out in. Coordinates
 * still come from `layoutSlots`, which owns lane wrapping (including the
 * per-kind `LAYOUT.maxRowsPerLane` record), so this file only decides *order*.
 */
export function autoLayout(state: GraphState): Record<string, XY> {
  const entities = allEntities(state)
  if (entities.length === 0) return {}

  const ranks = dagreOrder(state)
  const slots = layoutSlots(kindCounts(state))
  const columns = buckets(state)
  const poolRank = poolRankOf(state)
  const unassignedRank = state.pools.length
  const positions: Record<string, XY> = {}

  for (const kind of KIND_ORDER) {
    const ordered = columns[kind].slice().sort((a, b) => {
      if (kind === 'account') {
        const pa = poolRank.get(a.id) ?? unassignedRank
        const pb = poolRank.get(b.id) ?? unassignedRank
        if (pa !== pb) return pa - pb
      }
      const ra = ranks?.get(a.id) ?? a.position.y
      const rb = ranks?.get(b.id) ?? b.position.y
      if (ra !== rb) return ra - rb
      return a.id.localeCompare(b.id)
    })
    ordered.forEach((entity, index) => {
      const slot = slots[kind][index]
      if (slot) positions[entity.id] = { x: slot.x, y: slot.y }
    })
  }

  return positions
}
