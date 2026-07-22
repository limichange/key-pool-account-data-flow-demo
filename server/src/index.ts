/**
 * HTTP + WebSocket entry point.
 *
 * REST surface is documented in `shared/src/protocol.ts`; every mutation is
 * broadcast to the connected consoles as a `ServerEvent`.
 */
import http from 'node:http'
import process from 'node:process'

import cors from 'cors'
import express, { type NextFunction, type Request, type Response } from 'express'
import { WebSocket, WebSocketServer } from 'ws'

import {
  API_PREFIX,
  ENTITY_KINDS,
  WS_PATH,
  type EntityKind,
  type ServerEvent,
  type XY,
} from '@kpa/shared'

import { Simulator } from './simulator.js'
import { GraphStore } from './store.js'

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '127.0.0.1'

/* --------------------------------------------------------------- plumbing -- */

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const clients = new Set<WebSocket>()

function broadcast(event: ServerEvent): void {
  if (clients.size === 0) return
  const payload = JSON.stringify(event)
  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) continue
    try {
      client.send(payload)
    } catch {
      clients.delete(client)
    }
  }
}

const store = new GraphStore()
const simulator = new Simulator(store, broadcast)

/** Push everything the last mutation touched to every console. */
function flushPatches(): void {
  const entities = store.drainDirty()
  if (entities.length > 0) broadcast({ type: 'patch', entities })
}

function body(req: Request): Record<string, unknown> {
  const raw: unknown = req.body
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  return {}
}

function parseKind(value: string): EntityKind {
  if ((ENTITY_KINDS as string[]).includes(value)) return value as EntityKind
  throw new HttpError(400, `未知实体类型: ${value}`)
}

function parseRef(value: unknown, label: string): { kind: EntityKind; id: string } {
  if (typeof value !== 'object' || value === null) {
    throw new HttpError(400, `${label} 必须是 { kind, id } 对象`)
  }
  const ref = value as Record<string, unknown>
  const id = typeof ref.id === 'string' ? ref.id : ''
  if (!id) throw new HttpError(400, `${label}.id 缺失`)
  const kind = typeof ref.kind === 'string' ? parseKind(ref.kind) : undefined
  if (!kind) throw new HttpError(400, `${label}.kind 缺失`)
  return { kind, id }
}

function parsePosition(value: unknown): XY {
  if (typeof value !== 'object' || value === null) throw new HttpError(400, 'position 必须是对象')
  const pos = value as Record<string, unknown>
  const x = Number(pos.x)
  const y = Number(pos.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new HttpError(400, 'position.x/y 必须是数字')
  return { x, y }
}

type RouteHandler = (req: Request, res: Response) => void

/** Wrap a handler so a bad request never takes the process down. */
function route(handler: RouteHandler): RouteHandler {
  return (req, res) => {
    try {
      handler(req, res)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 400
      const message = error instanceof Error ? error.message : '请求处理失败'
      res.status(status).json({ error: message })
    }
  }
}

/* ------------------------------------------------------------------ routes -- */

const app = express()
app.disable('x-powered-by')
app.use(cors())
app.use(express.json({ limit: '1mb' }))
app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error) {
    res.status(400).json({ error: '请求体不是合法的 JSON' })
    return
  }
  next()
})

const api = express.Router()

api.get(
  '/state',
  route((_req, res) => {
    res.json({ state: store.snapshot(), config: simulator.getConfig(), stats: simulator.getStats() })
  }),
)

api.post(
  '/entities/:kind',
  route((req, res) => {
    const kind = parseKind(req.params.kind)
    const entity = store.create(kind, body(req))
    flushPatches()
    res.status(201).json(entity)
  }),
)

api.patch(
  '/entities/:kind/:id',
  route((req, res) => {
    const kind = parseKind(req.params.kind)
    const id = req.params.id
    if (!store.get(id)) throw new HttpError(404, `实体不存在: ${id}`)
    const entity = store.update(kind, id, body(req))
    flushPatches()
    res.json(entity)
  }),
)

api.delete(
  '/entities/:kind/:id',
  route((req, res) => {
    const kind = parseKind(req.params.kind)
    const id = req.params.id
    if (!store.get(id)) throw new HttpError(404, `实体不存在: ${id}`)
    store.remove(kind, id)
    // The store has no hook into the simulator, so its per-entity bookkeeping
    // has to be released here or it leaks for the life of the process.
    simulator.forget(id)
    broadcast({ type: 'removed', ids: [id] })
    flushPatches()
    res.json({ ok: true })
  }),
)

api.post(
  '/entities/:id/move',
  route((req, res) => {
    const payload = body(req)
    const id = typeof payload.id === 'string' && payload.id ? payload.id : req.params.id
    if (!store.get(id)) throw new HttpError(404, `实体不存在: ${id}`)
    const entity = store.move(id, parsePosition(payload.position))
    flushPatches()
    res.json(entity)
  }),
)

api.post(
  '/bind',
  route((req, res) => {
    const payload = body(req)
    store.bind(parseRef(payload.source, 'source'), parseRef(payload.target, 'target'))
    flushPatches()
    res.json({ ok: true })
  }),
)

api.post(
  '/unbind',
  route((req, res) => {
    const payload = body(req)
    store.unbind(parseRef(payload.source, 'source'), parseRef(payload.target, 'target'))
    flushPatches()
    res.json({ ok: true })
  }),
)

api.post(
  '/sim',
  route((req, res) => {
    res.json(simulator.setConfig(body(req)))
  }),
)

api.post(
  '/inject',
  route((req, res) => {
    const payload = body(req)
    const keyId = typeof payload.keyId === 'string' && payload.keyId ? payload.keyId : undefined
    const model = typeof payload.model === 'string' && payload.model ? payload.model : undefined
    const count = typeof payload.count === 'number' ? payload.count : 1
    if (keyId && !store.getKey(keyId)) throw new HttpError(404, `密钥不存在: ${keyId}`)
    const traces = simulator.inject(keyId, count, model)
    res.json({ traces })
  }),
)

api.post(
  '/reset',
  route((_req, res) => {
    simulator.reset()
    res.json({ state: store.snapshot(), config: simulator.getConfig(), stats: simulator.getStats() })
  }),
)

api.get(
  '/traces',
  route((req, res) => {
    const raw = req.query.limit
    const limit = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : 50
    res.json({ traces: simulator.getTraces(Number.isFinite(limit) ? limit : 50) })
  }),
)

app.use(API_PREFIX, api)

app.use(API_PREFIX, (_req: Request, res: Response) => {
  res.status(404).json({ error: '接口不存在' })
})

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = error instanceof HttpError ? error.status : 500
  const message = error instanceof Error ? error.message : '服务器内部错误'
  res.status(status).json({ error: message })
})

/* --------------------------------------------------------------- websocket -- */

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: WS_PATH })

wss.on('connection', (socket: WebSocket) => {
  clients.add(socket)
  let alive = true
  socket.on('pong', () => {
    alive = true
  })

  try {
    socket.send(
      JSON.stringify({
        type: 'snapshot',
        state: store.snapshot(),
        config: simulator.getConfig(),
        stats: simulator.getStats(),
      } satisfies ServerEvent),
    )
  } catch {
    clients.delete(socket)
    return
  }

  const heartbeat = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return
    if (!alive) {
      socket.terminate()
      return
    }
    alive = false
    socket.ping()
  }, 30_000)

  const cleanup = (): void => {
    clearInterval(heartbeat)
    clients.delete(socket)
  }
  socket.on('close', cleanup)
  socket.on('error', cleanup)
})

/* ---------------------------------------------------------------- lifecycle -- */

server.listen(PORT, HOST, () => {
  const state = store.snapshot()
  const lines = [
    '',
    '  ┌──────────────────────────────────────────────┐',
    '  │  Key → Pool → Account → Proxy 数据流演示台   │',
    '  └──────────────────────────────────────────────┘',
    `  REST      http://${HOST}:${PORT}${API_PREFIX}`,
    `  WebSocket ws://${HOST}:${PORT}${WS_PATH}`,
    `  拓扑      ${state.keys.length} keys · ${state.pools.length} pools · ${state.accounts.length} accounts · ${state.proxies.length} proxies`,
    `  模拟器    running=${simulator.getConfig().running} rps=${simulator.getConfig().rps}`,
    '',
  ]
  console.log(lines.join('\n'))
})

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[kpa] 端口 ${PORT} 已被占用，请先释放或设置 PORT 环境变量。`)
    process.exit(1)
  }
  console.error('[kpa] 服务器错误:', error.message)
})

process.on('uncaughtException', (error: Error) => {
  console.error('[kpa] 未捕获异常:', error.message)
})

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[kpa] 未处理的 Promise 拒绝:', reason)
})

let shuttingDown = false

function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n[kpa] 收到 ${signal}，正在关闭…`)
  simulator.dispose()
  for (const client of clients) {
    try {
      client.close(1001, 'server shutting down')
    } catch {
      // ignore
    }
  }
  clients.clear()
  wss.close()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
