/**
 * Maps the domain `GraphState` onto React Flow nodes and edges, plus the
 * 自动布局 entry point (feature 11) delegating to the shared layered-DAG
 * layout in `@kpa/shared`.
 */
import type { Edge, Node } from '@xyflow/react'

import {
  ENTITY_KINDS,
  KIND_ORDER,
  detachedEntities,
  edgeId,
  layoutPositions,
  type AccountEntity,
  type Entity,
  type EntityKind,
  type GatewayEntity,
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

/**
 * Feature 11 — one-click tidy. The geometry lives in `layoutPositions`
 * (shared/src/utils.ts), THE single layout authority also used by the seed
 * data and the server-side placement of new entities, so 自动布局 on an
 * untouched seed graph is an exact no-op. The layout is a pure function of
 * the RELATIONS (state order, pool membership, key bindings, proxy usage) —
 * never of the current positions — so dragging cards around and clicking
 * 自动布局 always restores the same canonical layered-DAG picture: four single
 * columns, per-pool account blocks across from their pools, and detached
 * nodes parked below the live graph.
 */
export function autoLayout(state: GraphState): Record<string, XY> {
  return layoutPositions(state)
}
