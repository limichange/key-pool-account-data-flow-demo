/**
 * Single zustand store backing the whole console.
 *
 * Design notes:
 *  - every selector must return a primitive or a referentially stable value (zustand v5),
 *  - trace bursts are buffered and flushed on a timer so React re-renders ~10x/s at most,
 *  - mutations are fire-and-forget against the REST API; the server echoes a `patch` event.
 */
import { useMemo } from 'react'
import { create } from 'zustand'

import {
  ENTITY_KINDS,
  TRACE_BUFFER_SIZE,
  type AccountEntity,
  type Entity,
  type EntityKind,
  type GlobalStats,
  type GraphState,
  type KeyEntity,
  type PoolEntity,
  type ProxyEntity,
  type RequestTrace,
  type ServerEvent,
  type SimConfig,
  type XY,
} from '@kpa/shared'

import { api } from './api'
import { connectSocket } from './socket'

export type ConnectionState = 'connecting' | 'open' | 'closed'

export interface LogLine {
  id: string
  level: 'info' | 'warn' | 'error'
  message: string
  at: number
}

export interface EdgeActivity {
  count: number
  ok: number
  err: number
  lastAt: number
  lastOk: boolean
  /**
   * Crossings in the flush batch that produced `lastAt`. Traces are batched
   * every `TRACE_FLUSH_MS`, so without this an edge carrying 40 req/s and one
   * carrying 3 req/s animate identically and the motion carries no volume.
   */
  burst: number
}

export interface NodeActivity {
  count: number
  lastAt: number
  lastOk: boolean
}

export interface EntityRef {
  kind: EntityKind
  id: string
}

export interface ConsoleStore {
  state: GraphState
  config: SimConfig
  stats: GlobalStats
  traces: RequestTrace[]
  logs: LogLine[]
  connection: ConnectionState
  ready: boolean
  edgeActivity: Record<string, EdgeActivity>
  nodeActivity: Record<string, NodeActivity>
  selectedId: string | null
  activeTraceId: string | null
  search: string
  kindFilter: Record<EntityKind, boolean>
  onlyProblems: boolean
  showMiniMap: boolean
  logCollapsed: boolean
  select(id: string | null): void
  setActiveTrace(id: string | null): void
  setSearch(v: string): void
  toggleKind(kind: EntityKind): void
  setOnlyProblems(v: boolean): void
  resetFilters(): void
  toggleMiniMap(): void
  toggleLog(): void
  applyServerEvent(ev: ServerEvent): void
  connect(): () => void
  createEntity(kind: EntityKind, draft?: Record<string, unknown>): Promise<void>
  updateEntity(kind: EntityKind, id: string, patch: Record<string, unknown>): Promise<void>
  deleteEntity(kind: EntityKind, id: string): Promise<void>
  moveEntity(id: string, position: XY): Promise<void>
  bind(source: EntityRef, target: EntityRef): Promise<void>
  unbind(source: EntityRef, target: EntityRef): Promise<void>
  setSim(patch: Partial<SimConfig>): Promise<void>
  inject(keyId?: string, count?: number): Promise<void>
  reset(): Promise<void>
}

/* ------------------------------------------------------------- defaults -- */

const LOG_BUFFER_SIZE = 100
const TRACE_FLUSH_MS = 100

const EMPTY_STATE: GraphState = { keys: [], pools: [], accounts: [], proxies: [], updatedAt: 0 }

const DEFAULT_CONFIG: SimConfig = {
  running: false,
  rps: 4,
  chaos: 0,
  latencyScale: 1,
  failoverEnabled: true,
  rateLimitEnabled: true,
}

const EMPTY_STATS: GlobalStats = {
  totalRequests: 0,
  success: 0,
  failed: 0,
  rateLimited: 0,
  retries: 0,
  avgLatencyMs: 0,
  p95LatencyMs: 0,
  rps: 0,
  tokensIn: 0,
  tokensOut: 0,
  startedAt: 0,
  timeline: [],
  outcomes: {},
}

const ALL_KINDS_ON: Record<EntityKind, boolean> = {
  key: true,
  pool: true,
  account: true,
  proxy: true,
}

/* -------------------------------------------------------------- helpers -- */

let logSeq = 0

function makeLog(level: LogLine['level'], message: string, at = Date.now()): LogLine {
  logSeq += 1
  return { id: `log-${logSeq}`, level, message, at }
}

function findEntity(state: GraphState, id: string): Entity | undefined {
  return (
    state.keys.find((e) => e.id === id) ??
    state.pools.find((e) => e.id === id) ??
    state.accounts.find((e) => e.id === id) ??
    state.proxies.find((e) => e.id === id)
  )
}

function upsertInto<T extends Entity>(list: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return list
  const next = list.slice()
  for (const item of incoming) {
    // A drag that has not been acknowledged yet always wins: the simulator
    // broadcasts a patch every 250ms and its copy still carries the position
    // the node had *before* the drag, which would snap the card back.
    const local = movePending.get(item.id)
    const entity = local ? ({ ...item, position: local } as T) : item
    const index = next.findIndex((entry) => entry.id === item.id)
    if (index >= 0) next[index] = entity
    else next.push(entity)
  }
  return next
}

function upsertEntities(state: GraphState, entities: Entity[]): GraphState {
  if (entities.length === 0) return state
  const keys: KeyEntity[] = []
  const pools: PoolEntity[] = []
  const accounts: AccountEntity[] = []
  const proxies: ProxyEntity[] = []
  for (const entity of entities) {
    switch (entity.kind) {
      case 'key':
        keys.push(entity)
        break
      case 'pool':
        pools.push(entity)
        break
      case 'account':
        accounts.push(entity)
        break
      case 'proxy':
        proxies.push(entity)
        break
    }
  }
  return {
    keys: upsertInto(state.keys, keys),
    pools: upsertInto(state.pools, pools),
    accounts: upsertInto(state.accounts, accounts),
    proxies: upsertInto(state.proxies, proxies),
    updatedAt: Date.now(),
  }
}

function removeEntities(state: GraphState, ids: string[]): GraphState {
  if (ids.length === 0) return state
  const gone = new Set(ids)
  return {
    keys: state.keys.filter((e) => !gone.has(e.id)),
    pools: state.pools.filter((e) => !gone.has(e.id)),
    accounts: state.accounts.filter((e) => !gone.has(e.id)),
    proxies: state.proxies.filter((e) => !gone.has(e.id)),
    updatedAt: Date.now(),
  }
}

function withPosition(state: GraphState, id: string, position: XY): GraphState {
  const patch = <T extends Entity>(list: T[]): T[] => {
    const index = list.findIndex((entry) => entry.id === id)
    if (index < 0) return list
    const next = list.slice()
    next[index] = { ...next[index], position } as T
    return next
  }
  return {
    keys: patch(state.keys),
    pools: patch(state.pools),
    accounts: patch(state.accounts),
    proxies: patch(state.proxies),
    updatedAt: state.updatedAt,
  }
}

/* ------------------------------------------------------- trace batching -- */

let traceBuffer: RequestTrace[] = []
let flushTimer: number | null = null

/**
 * Newest-first trace list with ids deduplicated. The live socket and the
 * `/api/traces` backfill overlap by design, so the same trace can arrive twice;
 * without this the log would render duplicate React keys.
 */
function mergeTraces(incoming: RequestTrace[], existing: RequestTrace[]): RequestTrace[] {
  const seen = new Set<string>()
  const merged: RequestTrace[] = []
  for (const trace of incoming) {
    if (seen.has(trace.id)) continue
    seen.add(trace.id)
    merged.push(trace)
  }
  for (const trace of existing) {
    if (seen.has(trace.id)) continue
    seen.add(trace.id)
    merged.push(trace)
  }
  merged.sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))
  return merged.slice(0, TRACE_BUFFER_SIZE)
}

function flushTraces(): void {
  flushTimer = null
  if (traceBuffer.length === 0) return
  const incoming = traceBuffer
  traceBuffer = []
  const now = Date.now()

  useConsole.setState((prev) => {
    const known = new Set(prev.traces.map((trace) => trace.id))
    // Only traces the store has never seen may bump the activity counters.
    const batch: RequestTrace[] = []
    for (const trace of incoming) {
      if (known.has(trace.id)) continue
      known.add(trace.id)
      batch.push(trace)
    }
    if (batch.length === 0) return prev

    const traces = mergeTraces(batch.slice().reverse(), prev.traces)
    const nodeActivity = { ...prev.nodeActivity }
    const edgeActivity = { ...prev.edgeActivity }
    const burst = new Map<string, number>()

    for (const trace of batch) {
      for (const hop of trace.path) {
        const previous = nodeActivity[hop.id]
        nodeActivity[hop.id] = {
          count: (previous?.count ?? 0) + 1,
          lastAt: now,
          lastOk: trace.ok,
        }
      }
      for (const id of trace.edgeIds) {
        const previous = edgeActivity[id]
        const crossings = (burst.get(id) ?? 0) + 1
        burst.set(id, crossings)
        edgeActivity[id] = {
          count: (previous?.count ?? 0) + 1,
          ok: (previous?.ok ?? 0) + (trace.ok ? 1 : 0),
          err: (previous?.err ?? 0) + (trace.ok ? 0 : 1),
          lastAt: now,
          lastOk: trace.ok,
          burst: crossings,
        }
      }
    }

    return { traces, nodeActivity, edgeActivity }
  })
}

function enqueueTrace(trace: RequestTrace): void {
  traceBuffer.push(trace)
  if (traceBuffer.length > TRACE_BUFFER_SIZE) {
    traceBuffer = traceBuffer.slice(-TRACE_BUFFER_SIZE)
  }
  if (flushTimer === null) {
    flushTimer = window.setTimeout(flushTraces, TRACE_FLUSH_MS)
  }
}

function cancelFlush(): void {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer)
    flushTimer = null
  }
  traceBuffer = []
}

/* --------------------------------------------------- socket lifecycle -- */

let socketRefCount = 0
let socketDisposer: (() => void) | null = null
let socketTeardown: number | null = null

/* ------------------------------------------------------ move bookkeeping -- */

/**
 * Positions written locally but not yet acknowledged by the server, plus the
 * ids whose write loop is currently running. `upsertEntities` reads
 * `movePending` so an in-flight drag is never clobbered by a server patch.
 */
const movePending = new Map<string, XY>()
const moveInFlight = new Set<string>()

/* ---------------------------------------------------------------- store -- */

export const useConsole = create<ConsoleStore>()((set, get) => {
  const pushLog = (level: LogLine['level'], message: string): void => {
    set((prev) => ({ logs: [makeLog(level, message), ...prev.logs].slice(0, LOG_BUFFER_SIZE) }))
  }

  const fail = (action: string, error: unknown): void => {
    pushLog('error', `${action}失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const bootstrap = async (): Promise<void> => {
    try {
      const data = await api.getState()
      set({ state: data.state, config: data.config, stats: data.stats, ready: true })
    } catch (error) {
      fail('加载状态', error)
      return
    }
    try {
      const traces = await api.getTraces(TRACE_BUFFER_SIZE)
      // The live stream may already have delivered part of this window.
      if (traces.length > 0) set((prev) => ({ traces: mergeTraces(traces, prev.traces) }))
    } catch {
      // History is optional; the live stream will fill in.
    }
  }

  return {
    state: EMPTY_STATE,
    config: DEFAULT_CONFIG,
    stats: EMPTY_STATS,
    traces: [],
    logs: [],
    connection: 'connecting',
    ready: false,
    edgeActivity: {},
    nodeActivity: {},
    selectedId: null,
    activeTraceId: null,
    search: '',
    kindFilter: ALL_KINDS_ON,
    onlyProblems: false,
    showMiniMap: true,
    logCollapsed: false,

    /* -------------------------------------------------------- ui state -- */

    select(id) {
      set({ selectedId: id })
    },

    setActiveTrace(id) {
      set({ activeTraceId: id })
    },

    setSearch(v) {
      set({ search: v })
    },

    toggleKind(kind) {
      set((prev) => ({ kindFilter: { ...prev.kindFilter, [kind]: !prev.kindFilter[kind] } }))
    },

    setOnlyProblems(v) {
      set({ onlyProblems: v })
    },

    resetFilters() {
      set({ search: '', kindFilter: ALL_KINDS_ON, onlyProblems: false })
    },

    toggleMiniMap() {
      set((prev) => ({ showMiniMap: !prev.showMiniMap }))
    },

    toggleLog() {
      set((prev) => ({ logCollapsed: !prev.logCollapsed }))
    },

    /* ---------------------------------------------------- server events -- */

    applyServerEvent(ev) {
      switch (ev.type) {
        case 'snapshot':
          set({ state: ev.state, config: ev.config, stats: ev.stats, ready: true })
          break
        case 'patch':
          set((prev) => ({ state: upsertEntities(prev.state, ev.entities) }))
          break
        case 'removed': {
          const gone = new Set(ev.ids)
          set((prev) => {
            const nodeActivity = { ...prev.nodeActivity }
            for (const id of ev.ids) delete nodeActivity[id]
            const edgeActivity: Record<string, EdgeActivity> = {}
            for (const [id, activity] of Object.entries(prev.edgeActivity)) {
              const [source, target] = id.split('->')
              if (gone.has(source) || gone.has(target)) continue
              edgeActivity[id] = activity
            }
            return {
              state: removeEntities(prev.state, ev.ids),
              nodeActivity,
              edgeActivity,
              selectedId: prev.selectedId && gone.has(prev.selectedId) ? null : prev.selectedId,
            }
          })
          break
        }
        case 'trace':
          enqueueTrace(ev.trace)
          break
        case 'stats':
          set({ stats: ev.stats })
          break
        case 'config':
          set({ config: ev.config })
          break
        case 'log':
          set((prev) => ({
            logs: [makeLog(ev.level, ev.message, ev.at), ...prev.logs].slice(0, LOG_BUFFER_SIZE),
          }))
          break
      }
    },

    /* ------------------------------------------------------- connection -- */

    connect() {
      if (socketTeardown !== null) {
        window.clearTimeout(socketTeardown)
        socketTeardown = null
      }
      socketRefCount += 1
      if (socketRefCount === 1 && socketDisposer === null) {
        void bootstrap()
        socketDisposer = connectSocket({
          onEvent: (ev) => get().applyServerEvent(ev),
          onStatus: (status) => set({ connection: status }),
        })
      }
      let released = false
      return () => {
        if (released) return
        released = true
        socketRefCount = Math.max(0, socketRefCount - 1)
        if (socketRefCount > 0 || socketTeardown !== null) return
        // Deferred so React's StrictMode remount (unmount + mount in the same
        // tick) reuses the live socket instead of reconnecting.
        socketTeardown = window.setTimeout(() => {
          socketTeardown = null
          if (socketRefCount > 0) return
          socketDisposer?.()
          socketDisposer = null
          cancelFlush()
        }, 0)
      }
    },

    /* ---------------------------------------------------------- mutations -- */

    async createEntity(kind, draft = {}) {
      try {
        const entity = await api.createEntity(kind, draft)
        set((prev) => ({ state: upsertEntities(prev.state, [entity]), selectedId: entity.id }))
        pushLog('info', `已创建 ${entity.name}`)
      } catch (error) {
        fail('创建实体', error)
      }
    },

    async updateEntity(kind, id, patch) {
      try {
        const entity = await api.updateEntity(kind, id, patch)
        set((prev) => ({ state: upsertEntities(prev.state, [entity]) }))
      } catch (error) {
        fail('更新实体', error)
      }
    },

    async deleteEntity(kind, id) {
      try {
        await api.deleteEntity(kind, id)
        set((prev) => ({
          state: removeEntities(prev.state, [id]),
          selectedId: prev.selectedId === id ? null : prev.selectedId,
        }))
        pushLog('info', `已删除 ${id}`)
      } catch (error) {
        fail('删除实体', error)
      }
    },

    /**
     * Optimistic local move, then a write that starts immediately.
     *
     * `moveEntity` is only ever called from `onNodeDragStop` and the auto
     * layout button, never per animation frame, so a debounce bought nothing
     * and cost an 80ms window in which a server patch could snap the node
     * back. Instead the newest position stays in `movePending` — which
     * `upsertEntities` honours — until the server acknowledges *that* exact
     * position; concurrent calls for the same id collapse into the running
     * loop rather than racing each other.
     */
    async moveEntity(id, position) {
      set((prev) => ({ state: withPosition(prev.state, id, position) }))
      movePending.set(id, position)

      if (moveInFlight.has(id)) return
      moveInFlight.add(id)
      try {
        while (movePending.has(id)) {
          const pending = movePending.get(id) as XY
          try {
            await api.move(id, pending)
          } catch (error) {
            fail('保存位置', error)
          }
          if (movePending.get(id) === pending) movePending.delete(id)
        }
      } finally {
        moveInFlight.delete(id)
      }
    },

    async bind(source, target) {
      try {
        await api.bind(source, target)
      } catch (error) {
        fail('建立绑定', error)
      }
    },

    async unbind(source, target) {
      try {
        await api.unbind(source, target)
      } catch (error) {
        fail('解除绑定', error)
      }
    },

    async setSim(patch) {
      set((prev) => ({ config: { ...prev.config, ...patch } }))
      try {
        const config = await api.setSim(patch)
        set({ config })
      } catch (error) {
        fail('更新模拟器', error)
      }
    },

    async inject(keyId, count = 1) {
      try {
        await api.inject(keyId, count)
      } catch (error) {
        fail('注入请求', error)
      }
    },

    async reset() {
      try {
        const data = await api.reset()
        cancelFlush()
        set({
          state: data.state,
          config: data.config,
          stats: data.stats,
          traces: [],
          nodeActivity: {},
          edgeActivity: {},
          activeTraceId: null,
          selectedId: null,
          ready: true,
        })
        pushLog('info', '已重置演示环境')
      } catch (error) {
        fail('重置', error)
      }
    },
  }
})

/* ------------------------------------------------------------ selectors -- */

export function useEntity(id: string | null | undefined): Entity | undefined {
  return useConsole((s) => (id ? findEntity(s.state, id) : undefined))
}

export function useNodePulse(id: string): number {
  return useConsole((s) => s.nodeActivity[id]?.lastAt ?? 0)
}

export function useEdgePulse(id: string): number {
  return useConsole((s) => s.edgeActivity[id]?.lastAt ?? 0)
}

export function useEdgeOk(id: string): boolean {
  return useConsole((s) => s.edgeActivity[id]?.lastOk ?? true)
}

/** How many requests crossed this edge in the batch behind the latest pulse. */
export function useEdgeVolume(id: string): number {
  return useConsole((s) => s.edgeActivity[id]?.burst ?? 1)
}

/** Rolling share of this edge's traffic against the busiest edge on the board. */
export function useEdgeLoad(id: string): number {
  return useConsole((s) => {
    const mine = s.edgeActivity[id]?.count ?? 0
    if (mine === 0) return 0
    let max = 1
    for (const activity of Object.values(s.edgeActivity)) {
      if (activity.count > max) max = activity.count
    }
    return mine / max
  })
}

/** The trace currently highlighted on the canvas, if it is still in the buffer. */
export function useActiveTrace(): RequestTrace | undefined {
  const activeTraceId = useConsole((s) => s.activeTraceId)
  const traces = useConsole((s) => s.traces)
  return useMemo(
    () => (activeTraceId ? traces.find((t) => t.id === activeTraceId) : undefined),
    [activeTraceId, traces],
  )
}

const EMPTY_IDS: Set<string> = new Set()

/** Node ids and edge ids lit up by the active trace, memoised for `buildGraph`. */
export function useTracedIds(): { nodes: Set<string>; edges: Set<string> } {
  const trace = useActiveTrace()
  return useMemo(() => {
    if (!trace) return { nodes: EMPTY_IDS, edges: EMPTY_IDS }
    return {
      nodes: new Set(trace.path.map((hop) => hop.id)),
      edges: new Set(trace.edgeIds),
    }
  }, [trace])
}

/** True when at least one filter is narrowing the graph. */
export function useFilterActive(): boolean {
  return useConsole(
    (s) => s.search.trim().length > 0 || s.onlyProblems || ENTITY_KINDS.some((k) => !s.kindFilter[k]),
  )
}
