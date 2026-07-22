/**
 * Thin typed wrapper over the gateway console REST surface.
 * Every helper throws `Error(message)` when the server answers with a non-2xx status.
 */
import {
  API_PREFIX,
  type ApiError,
  type Entity,
  type EntityKind,
  type InjectResponse,
  type MoveRequest,
  type RequestTrace,
  type SimConfig,
  type StateResponse,
  type XY,
} from '@kpa/shared'

export interface EntityRef {
  kind: EntityKind
  id: string
}

export interface OkResponse {
  ok: true
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_PREFIX}${path}`, {
      ...init,
      headers:
        init?.body === undefined
          ? init?.headers
          : { 'content-type': 'application/json', ...init?.headers },
    })
  } catch (error) {
    throw new Error(`网络请求失败: ${(error as Error).message}`)
  }

  const text = await response.text()
  let payload: unknown = null
  if (text.length > 0) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && typeof (payload as ApiError).error === 'string'
        ? (payload as ApiError).error
        : `${response.status} ${response.statusText || 'Request failed'}`
    throw new Error(message)
  }

  return payload as T
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
}

export const api = {
  getState(): Promise<StateResponse> {
    return request<StateResponse>('/state')
  },

  createEntity(kind: EntityKind, draft: Record<string, unknown> = {}): Promise<Entity> {
    return post<Entity>(`/entities/${kind}`, draft)
  },

  updateEntity(kind: EntityKind, id: string, patch: Record<string, unknown>): Promise<Entity> {
    return request<Entity>(`/entities/${kind}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  },

  deleteEntity(kind: EntityKind, id: string): Promise<OkResponse> {
    return request<OkResponse>(`/entities/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  move(id: string, position: XY): Promise<Entity> {
    return post<Entity>(`/entities/${encodeURIComponent(id)}/move`, { id, position })
  },

  /** Persist a whole auto-layout in ONE request (feature 11). */
  moveBatch(moves: MoveRequest[]): Promise<OkResponse> {
    return post<OkResponse>('/entities/move-batch', { moves })
  },

  bind(source: EntityRef, target: EntityRef): Promise<OkResponse> {
    return post<OkResponse>('/bind', { source, target })
  },

  unbind(source: EntityRef, target: EntityRef): Promise<OkResponse> {
    return post<OkResponse>('/unbind', { source, target })
  },

  setSim(patch: Partial<SimConfig>): Promise<SimConfig> {
    return post<SimConfig>('/sim', patch)
  },

  inject(keyId?: string, count = 1, model?: string): Promise<InjectResponse> {
    return post<InjectResponse>('/inject', { keyId, count, model })
  },

  reset(): Promise<StateResponse> {
    return post<StateResponse>('/reset')
  },

  async getTraces(limit = 100): Promise<RequestTrace[]> {
    const data = await request<{ traces: RequestTrace[] }>(`/traces?limit=${limit}`)
    return data?.traces ?? []
  },
}
