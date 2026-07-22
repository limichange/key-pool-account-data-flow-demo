import type {
  AccountEntity,
  Entity,
  EntityKind,
  GraphState,
  HealthStatus,
  Metrics,
  PoolEntity,
  XY,
} from './types.js'
import { KIND_ORDER, LAYOUT, METRICS_HISTORY_SIZE } from './constants.js'

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

/** True when the entity can currently serve traffic. */
export function isServing(status: HealthStatus): boolean {
  return status === 'healthy' || status === 'degraded'
}

export function successRate(metrics: Metrics): number {
  if (metrics.requests === 0) return 1
  return metrics.success / metrics.requests
}

export function allEntities(state: GraphState): Entity[] {
  return [...state.keys, ...state.pools, ...state.accounts, ...state.proxies]
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

/* ------------------------------------------------------------------ layout -- */

export type KindCounts = Partial<Record<EntityKind, number>>

/**
 * Canonical canvas geometry: one left-to-right band per kind, each band packed
 * into as many vertical lanes as it needs, every band vertically centred on the
 * tallest one. Slots are returned in the same order as the entities were
 * counted, so `slots[kind][i]` is the home of the i-th entity of that kind.
 *
 * The whole console shares this helper (seed data, the server's placement of
 * new entities and the canvas "auto layout" button) so the three can never
 * drift apart.
 *
 * Since Pool -> Account is one-to-many the pool->account edges form a forest,
 * so callers are expected to feed the accounts in owning-pool order (pools in
 * state order, unassigned accounts last). That ordering plus this geometry is
 * what removes almost every edge crossing in the account band.
 */
export function layoutSlots(counts: KindCounts): Record<EntityKind, XY[]> {
  const bands = KIND_ORDER.map((kind) => {
    const count = Math.max(0, Math.floor(counts[kind] ?? 0))
    const lanes = Math.max(1, Math.ceil(count / Math.max(1, LAYOUT.maxRowsPerLane[kind])))
    const rows = count > 0 ? Math.ceil(count / lanes) : 0
    return {
      kind,
      count,
      rows,
      width: lanes * LAYOUT.nodeWidth[kind] + (lanes - 1) * LAYOUT.laneGap,
      height: rows > 0 ? rows * LAYOUT.nodeHeight[kind] + (rows - 1) * LAYOUT.rowGap : 0,
    }
  })

  const tallest = bands.reduce((max, band) => Math.max(max, band.height), 0)

  const slots = {} as Record<EntityKind, XY[]>
  let x = 0
  for (const band of bands) {
    const top = LAYOUT.topY + Math.round((tallest - band.height) / 2)
    const column: XY[] = []
    for (let i = 0; i < band.count; i += 1) {
      const lane = Math.floor(i / band.rows)
      const row = i % band.rows
      column.push({
        x: x + lane * (LAYOUT.nodeWidth[band.kind] + LAYOUT.laneGap),
        y: top + row * (LAYOUT.nodeHeight[band.kind] + LAYOUT.rowGap),
      })
    }
    slots[band.kind] = column
    x += band.width + LAYOUT.columnGap
  }
  return slots
}

/** Home slot for the entity that is about to become the `index`-th of its kind. */
export function layoutSlotFor(counts: KindCounts, kind: EntityKind, index: number): XY {
  const next: KindCounts = { ...counts, [kind]: Math.max(index + 1, counts[kind] ?? 0) }
  return layoutSlots(next)[kind][index] ?? { x: 0, y: LAYOUT.topY }
}

/** Number of entities of every kind currently in the graph. */
export function kindCounts(state: GraphState): Record<EntityKind, number> {
  return {
    key: state.keys.length,
    pool: state.pools.length,
    account: state.accounts.length,
    proxy: state.proxies.length,
  }
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
