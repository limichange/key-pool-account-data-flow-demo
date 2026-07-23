/**
 * In-browser backend: the same GraphStore + Simulator the Node server used to
 * host, running inside the page so the console deploys as pure static files.
 *
 * This module owns the singleton engine and mirrors the old REST surface as
 * direct method calls (`api.ts` delegates here, `socket.ts` subscribes here).
 * State survives reloads through a throttled localStorage snapshot; 重置
 * clears it and reseeds.
 */
import {
  type Entity,
  type EntityKind,
  type GraphState,
  type RequestTrace,
  type ServerEvent,
  type SimConfig,
  type XY,
  ENTITY_KINDS,
} from '@kpa/shared'

import { EdgeMetricsStore } from '@kpa/sim/edges'
import { Simulator } from '@kpa/sim/simulator'
import { GraphStore } from '@kpa/sim/store'

const STORAGE_KEY = 'kpa:standalone:v1'
const SAVE_THROTTLE_MS = 1500

interface PersistedShape {
  v: 1
  state: GraphState
  config: SimConfig
}

function loadPersisted(): PersistedShape | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedShape>
    if (parsed.v !== 1 || typeof parsed.state !== 'object' || parsed.state === null) return null
    if (typeof parsed.config !== 'object' || parsed.config === null) return null
    // Cheap shape sanity: a persisted blob from an older schema without the
    // gateway singleton (or with missing bands) falls back to a fresh seed.
    const state = parsed.state as GraphState
    if (!state.gateway || !Array.isArray(state.keys) || !Array.isArray(state.accounts)) return null
    return parsed as PersistedShape
  } catch {
    return null
  }
}

class LocalBackend {
  private readonly store: GraphStore
  private readonly edges: EdgeMetricsStore
  private readonly simulator: Simulator
  private readonly listeners = new Set<(ev: ServerEvent) => void>()
  private saveTimer: number | null = null
  private dirty = false

  constructor() {
    const persisted = loadPersisted()
    this.store = persisted ? new GraphStore(persisted.state) : new GraphStore()
    this.edges = new EdgeMetricsStore()
    this.store.setLogSink((level, message) =>
      this.broadcast({ type: 'log', level, message, at: Date.now() }),
    )
    this.store.setNoticeSink((notice) => {
      const at = Date.now()
      this.broadcast({ type: 'notice', ...notice, at })
      this.broadcast({
        type: 'log',
        level: notice.level,
        message: `${notice.title}：${notice.message}`,
        at,
      })
    })
    this.simulator = new Simulator(this.store, this.edges, (ev) => this.broadcast(ev))
    if (persisted) this.simulator.setConfig(persisted.config)

    window.addEventListener('beforeunload', () => this.saveNow())
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.saveNow()
    })
  }

  /* ----------------------------------------------------------- events -- */

  subscribe(listener: (ev: ServerEvent) => void): () => void {
    this.listeners.add(listener)
    // Mirror the old WebSocket behaviour: a snapshot lands immediately on connect.
    listener({
      type: 'snapshot',
      state: this.store.snapshot(),
      config: this.simulator.getConfig(),
      stats: this.simulator.getStats(),
      edges: this.edges.list(),
    })
    return () => {
      this.listeners.delete(listener)
    }
  }

  private broadcast(event: ServerEvent): void {
    if (event.type === 'patch' || event.type === 'removed' || event.type === 'config') {
      this.scheduleSave()
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A broken consumer must not take the engine down with it.
      }
    }
  }

  /** Push everything the last mutation touched, exactly like the old server did. */
  private flushPatches(): void {
    const removedEdgeIds = this.edges.sync(this.store.snapshot())
    if (removedEdgeIds.length > 0) {
      this.broadcast({ type: 'removed', ids: [], edgeIds: removedEdgeIds })
    }
    const entities = this.store.drainDirty()
    if (entities.length > 0) this.broadcast({ type: 'patch', entities })
  }

  /* ------------------------------------------------------ persistence -- */

  private scheduleSave(): void {
    this.dirty = true
    if (this.saveTimer !== null) return
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null
      this.saveNow()
    }, SAVE_THROTTLE_MS)
  }

  private saveNow(): void {
    if (!this.dirty) return
    this.dirty = false
    try {
      const payload: PersistedShape = {
        v: 1,
        state: this.store.snapshot(),
        config: this.simulator.getConfig(),
      }
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
    } catch {
      // Quota/private-mode failures degrade to a session-only demo.
    }
  }

  /* -------------------------------------------------------------- api -- */

  getState() {
    return {
      state: this.store.snapshot(),
      config: this.simulator.getConfig(),
      stats: this.simulator.getStats(),
      edges: this.edges.list(),
    }
  }

  createEntity(kind: EntityKind, draft: Record<string, unknown>): Entity {
    if (!(ENTITY_KINDS as string[]).includes(kind)) throw new Error(`未知实体类型: ${kind}`)
    const entity = this.store.create(kind, draft)
    this.flushPatches()
    return entity
  }

  updateEntity(kind: EntityKind, id: string, patch: Record<string, unknown>): Entity {
    if (!this.store.get(id)) throw new Error(`实体不存在: ${id}`)
    const entity = this.store.update(kind, id, patch)
    this.flushPatches()
    return entity
  }

  deleteEntity(kind: EntityKind, id: string): void {
    if (!this.store.get(id)) throw new Error(`实体不存在: ${id}`)
    this.store.remove(kind, id)
    // Release the simulator's per-entity bookkeeping, as the old server did.
    this.simulator.forget(id)
    const removedEdgeIds = this.edges.sync(this.store.snapshot())
    this.broadcast({
      type: 'removed',
      ids: [id],
      ...(removedEdgeIds.length > 0 ? { edgeIds: removedEdgeIds } : {}),
    })
    this.flushPatches()
  }

  move(id: string, position: XY): Entity {
    if (!this.store.get(id)) throw new Error(`实体不存在: ${id}`)
    const entity = this.store.move(id, position)
    this.flushPatches()
    return entity
  }

  moveBatch(moves: { id: string; position: XY }[]): void {
    for (const move of moves) {
      // A node deleted while the layout was computing is skipped, not fatal.
      if (!this.store.get(move.id)) continue
      this.store.move(move.id, move.position)
    }
    this.flushPatches()
  }

  bind(source: { kind: EntityKind; id: string }, target: { kind: EntityKind; id: string }): void {
    this.store.bind(source, target)
    this.flushPatches()
  }

  unbind(source: { kind: EntityKind; id: string }, target: { kind: EntityKind; id: string }): void {
    this.store.unbind(source, target)
    this.flushPatches()
  }

  setSim(patch: Partial<SimConfig>): SimConfig {
    return this.simulator.setConfig(patch)
  }

  inject(keyId?: string, count = 1, model?: string): RequestTrace[] {
    if (keyId && !this.store.getKey(keyId)) throw new Error(`密钥不存在: ${keyId}`)
    return this.simulator.inject(keyId, count, model)
  }

  reset() {
    try {
      window.localStorage.removeItem(STORAGE_KEY)
    } catch {
      // Ignore: worst case the stale blob is overwritten by the next save.
    }
    this.simulator.reset()
    return this.getState()
  }

  getTraces(limit: number): RequestTrace[] {
    return this.simulator.getTraces(limit)
  }
}

let backend: LocalBackend | null = null

/** The lazily-created in-browser engine singleton. */
export function localBackend(): LocalBackend {
  if (backend === null) backend = new LocalBackend()
  return backend
}
