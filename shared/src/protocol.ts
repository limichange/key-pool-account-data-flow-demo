/** Wire protocol between the Node simulator and the React console. */
import type {
  Entity,
  EntityKind,
  GlobalStats,
  GraphState,
  RequestTrace,
  SimConfig,
  XY,
} from './types.js'

/* ------------------------------------------------- server -> client (ws) -- */

export type ServerEvent =
  /** Full state, sent right after the socket opens and after a reset. */
  | { type: 'snapshot'; state: GraphState; config: SimConfig; stats: GlobalStats }
  /** Partial upsert of entities whose fields changed. */
  | { type: 'patch'; entities: Entity[] }
  /** Entities removed from the graph. */
  | { type: 'removed'; ids: string[] }
  /** A request finished flowing through the chain. */
  | { type: 'trace'; trace: RequestTrace }
  /** Aggregate counters, emitted once per simulation tick. */
  | { type: 'stats'; stats: GlobalStats }
  /** Simulator knobs changed. */
  | { type: 'config'; config: SimConfig }
  /** Human-readable operator log line. */
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; at: number }

/* -------------------------------------------------- client -> server (http) -- */

export interface BindRequest {
  /** Source entity of the edge, e.g. a key or a pool. */
  source: { kind: EntityKind; id: string }
  /** Target entity of the edge, e.g. a pool or an account. */
  target: { kind: EntityKind; id: string }
}

export interface MoveRequest {
  id: string
  position: XY
}

export interface InjectRequest {
  keyId?: string
  /** How many requests to fire. Defaults to 1. */
  count?: number
  model?: string
}

export interface ApiError {
  error: string
}

/** Result of POST /api/inject. */
export interface InjectResponse {
  traces: RequestTrace[]
}

export interface StateResponse {
  state: GraphState
  config: SimConfig
  stats: GlobalStats
}

/**
 * REST surface exposed by the server. All routes are prefixed with `/api`.
 *
 *  GET    /state                       -> StateResponse
 *  POST   /entities/:kind              -> Entity            (create, body = Partial<Entity>)
 *  PATCH  /entities/:kind/:id          -> Entity            (update, body = Partial<Entity>)
 *  DELETE /entities/:kind/:id          -> { ok: true }      (also detaches every relation)
 *  POST   /entities/:id/move           -> Entity            (body = MoveRequest)
 *  POST   /bind                        -> { ok: true }      (body = BindRequest)
 *  POST   /unbind                      -> { ok: true }      (body = BindRequest)
 *  POST   /sim                         -> SimConfig         (body = Partial<SimConfig>)
 *  POST   /inject                      -> InjectResponse    (body = InjectRequest)
 *  POST   /reset                       -> StateResponse
 *  GET    /traces?limit=n              -> { traces: RequestTrace[] }
 */
export const API_PREFIX = '/api'
export const WS_PATH = '/ws'
