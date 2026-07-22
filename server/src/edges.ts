/**
 * Per-edge traffic metrics.
 *
 * One `EdgeMetrics` entry per RELATION of the graph, keyed by
 * `edgeId(sourceId, targetId)`. The full edge list is derived from the GRAPH —
 * gateway->every key, key.bindings, pool.failoverPoolId, pool.members,
 * account.proxyId — not from observed traffic, so a relation with no traffic
 * yet still reports zeroes and the UI can draw an explicit "0 请求" state.
 * Metrics are dropped the moment a relation disappears; `sync` returns the
 * dead ids so the websocket layer can tell the client via `removed.edgeIds`.
 *
 * The rolling windows (rpm per tick, history ring per simulated second) are
 * driven by the Simulator on the SAME cadence as the entity metrics, so the
 * edge chart and the node sparklines describe the same seconds.
 */
import {
  EDGE_HISTORY_SIZE,
  createEdgeMetrics,
  edgeId,
  type EdgeMetrics,
  type EntityKind,
  type GraphState,
} from '@kpa/shared'

/** One request's contribution to a single edge. */
export interface EdgeCredit {
  ok: boolean
  latencyMs: number
  tokens: number
}

export class EdgeMetricsStore {
  private edges = new Map<string, EdgeMetrics>()
  /** Requests since the previous tick, feeding the rolling rpm. */
  private tickCounts = new Map<string, number>()
  /** Requests since the previous simulated second, feeding the history ring. */
  private secondCounts = new Map<string, number>()
  private dirty = new Set<string>()

  list(): EdgeMetrics[] {
    return [...this.edges.values()]
  }

  get(id: string): EdgeMetrics | undefined {
    return this.edges.get(id)
  }

  /**
   * Reconcile the metric set against the graph: create a zeroed entry for
   * every relation that appeared (marked dirty so the next `edges` event
   * announces it) and drop every entry whose relation is gone. Returns the
   * removed edge ids for the `removed.edgeIds` broadcast.
   */
  sync(state: GraphState): string[] {
    const wanted = new Map<string, { sourceId: string; targetId: string; sourceKind: EntityKind }>()
    const want = (sourceId: string, targetId: string, sourceKind: EntityKind): void => {
      const id = edgeId(sourceId, targetId)
      if (!wanted.has(id)) wanted.set(id, { sourceId, targetId, sourceKind })
    }

    // Every key implicitly hangs off the singleton gateway.
    for (const key of state.keys) want(state.gateway.id, key.id, 'gateway')
    for (const key of state.keys) {
      for (const binding of key.bindings) want(key.id, binding.poolId, 'key')
    }
    for (const pool of state.pools) {
      if (pool.failoverPoolId) want(pool.id, pool.failoverPoolId, 'pool')
      for (const member of pool.members) want(pool.id, member.accountId, 'pool')
    }
    for (const account of state.accounts) {
      if (account.proxyId) want(account.id, account.proxyId, 'account')
    }

    const removed: string[] = []
    for (const id of this.edges.keys()) {
      if (!wanted.has(id)) removed.push(id)
    }
    for (const id of removed) {
      this.edges.delete(id)
      this.tickCounts.delete(id)
      this.secondCounts.delete(id)
      this.dirty.delete(id)
    }

    for (const [id, ref] of wanted) {
      if (this.edges.has(id)) continue
      this.edges.set(id, createEdgeMetrics(id, ref.sourceId, ref.targetId, ref.sourceKind))
      // Announce the zeroed entry so the UI can render "0 请求" immediately.
      this.dirty.add(id)
    }

    return removed
  }

  /** Attribute one request (or one attempt) to a single edge. */
  record(
    sourceId: string,
    targetId: string,
    sourceKind: EntityKind,
    credit: EdgeCredit,
    now: number,
  ): void {
    const id = edgeId(sourceId, targetId)
    let metrics = this.edges.get(id)
    if (!metrics) {
      // A relation the simulator saw before the next sync (defensive).
      metrics = createEdgeMetrics(id, sourceId, targetId, sourceKind)
      this.edges.set(id, metrics)
    }
    metrics.requests += 1
    if (credit.ok) metrics.success += 1
    else metrics.failed += 1
    metrics.tokens += credit.tokens
    if (credit.latencyMs > 0) {
      // Same EMA blend the entity metrics use.
      metrics.avgLatencyMs =
        metrics.avgLatencyMs === 0
          ? credit.latencyMs
          : metrics.avgLatencyMs * 0.9 + credit.latencyMs * 0.1
    }
    metrics.lastAt = now
    this.tickCounts.set(id, (this.tickCounts.get(id) ?? 0) + 1)
    this.secondCounts.set(id, (this.secondCounts.get(id) ?? 0) + 1)
    this.dirty.add(id)
  }

  /**
   * Per-TICK rpm decay — must use the same formula and cadence as the entity
   * metrics in `Simulator.rollWindows` or the edge chip and the node cards
   * disagree about the same instant. `perMinute` is passed in by the caller so
   * the two stay coupled to one definition.
   */
  rollRpm(perMinute: number): void {
    for (const [id, metrics] of this.edges) {
      const seen = this.tickCounts.get(id) ?? 0
      const next = metrics.rpm * 0.85 + seen * perMinute
      const rpm = next < 0.05 ? 0 : Math.round(next * 10) / 10
      if (rpm !== metrics.rpm) {
        metrics.rpm = rpm
        this.dirty.add(id)
      }
    }
    this.tickCounts.clear()
  }

  /** Per-SECOND history roll, same cadence as the entity history buckets. */
  rollHistory(): void {
    for (const [id, metrics] of this.edges) {
      const bucket = this.secondCounts.get(id) ?? 0
      const dropped = metrics.history.shift() ?? 0
      metrics.history.push(bucket)
      while (metrics.history.length < EDGE_HISTORY_SIZE) metrics.history.unshift(0)
      if (bucket > 0 || dropped > 0) this.dirty.add(id)
    }
    this.secondCounts.clear()
  }

  /** Edges changed since the last drain, for the `edges` event. */
  drainDirty(): EdgeMetrics[] {
    if (this.dirty.size === 0) return []
    const out: EdgeMetrics[] = []
    for (const id of this.dirty) {
      const metrics = this.edges.get(id)
      if (metrics) out.push(metrics)
    }
    this.dirty.clear()
    return out
  }

  /** Full zeroed rebuild from a fresh graph (reset). */
  reset(state: GraphState): void {
    this.edges.clear()
    this.tickCounts.clear()
    this.secondCounts.clear()
    this.dirty.clear()
    this.sync(state)
    // The caller broadcasts a snapshot carrying the full set; nothing is dirty.
    this.dirty.clear()
  }
}
