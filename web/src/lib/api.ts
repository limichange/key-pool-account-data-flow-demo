/**
 * Typed command surface of the engine.
 *
 * Historically a fetch wrapper over the Node server's REST API; the console is
 * now pure frontend, so every call delegates to the in-browser engine in
 * `local.ts`. Signatures (and rejection semantics: a thrown `Error` with a
 * Chinese message) are unchanged, so the store above never noticed the swap.
 */
import {
  type Entity,
  type EntityKind,
  type InjectResponse,
  type MoveRequest,
  type RequestTrace,
  type SimConfig,
  type StateResponse,
  type XY,
} from '@kpa/shared'

import { localBackend } from './local'

export interface EntityRef {
  kind: EntityKind
  id: string
}

export interface OkResponse {
  ok: true
}

/**
 * Engine calls are synchronous, but the surface stays Promise-based so the
 * store's optimistic flows (and any future remote transport) keep working.
 * `Promise.resolve().then(...)` also converts synchronous throws into
 * rejections, matching the old fetch error path.
 */
function call<T>(fn: () => T): Promise<T> {
  return Promise.resolve().then(fn)
}

export const api = {
  getState(): Promise<StateResponse> {
    return call(() => localBackend().getState())
  },

  createEntity(kind: EntityKind, draft: Record<string, unknown> = {}): Promise<Entity> {
    return call(() => localBackend().createEntity(kind, draft))
  },

  updateEntity(kind: EntityKind, id: string, patch: Record<string, unknown>): Promise<Entity> {
    return call(() => localBackend().updateEntity(kind, id, patch))
  },

  deleteEntity(kind: EntityKind, id: string): Promise<OkResponse> {
    return call(() => {
      localBackend().deleteEntity(kind, id)
      return { ok: true as const }
    })
  },

  move(id: string, position: XY): Promise<Entity> {
    return call(() => localBackend().move(id, position))
  },

  moveBatch(moves: MoveRequest[]): Promise<OkResponse> {
    return call(() => {
      localBackend().moveBatch(moves)
      return { ok: true as const }
    })
  },

  bind(source: EntityRef, target: EntityRef): Promise<OkResponse> {
    return call(() => {
      localBackend().bind(source, target)
      return { ok: true as const }
    })
  },

  unbind(source: EntityRef, target: EntityRef): Promise<OkResponse> {
    return call(() => {
      localBackend().unbind(source, target)
      return { ok: true as const }
    })
  },

  setSim(patch: Partial<SimConfig>): Promise<SimConfig> {
    return call(() => localBackend().setSim(patch))
  },

  inject(keyId?: string, count = 1, model?: string): Promise<InjectResponse> {
    return call(() => ({ traces: localBackend().inject(keyId, count, model) }))
  },

  reset(): Promise<StateResponse> {
    return call(() => localBackend().reset())
  },

  getTraces(limit = 100): Promise<RequestTrace[]> {
    return call(() => localBackend().getTraces(limit))
  },
}
