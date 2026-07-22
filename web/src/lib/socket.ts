/** Auto-reconnecting WebSocket client for the simulator event stream. */
import { WS_PATH, type ServerEvent } from '@kpa/shared'

import type { ConnectionState } from './store'

export interface SocketHandlers {
  onEvent(ev: ServerEvent): void
  onStatus(s: ConnectionState): void
}

const MIN_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 5000

function socketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}${WS_PATH}`
}

/**
 * Opens the event socket and keeps it alive with an exponential backoff
 * (500ms -> 5s). Returns a disposer that stops reconnecting and closes the socket.
 */
export function connectSocket(handlers: SocketHandlers): () => void {
  let socket: WebSocket | null = null
  let timer: number | null = null
  let attempt = 0
  let disposed = false

  const scheduleReconnect = (): void => {
    if (disposed || timer !== null) return
    const delay = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** attempt)
    attempt += 1
    timer = window.setTimeout(() => {
      timer = null
      open()
    }, delay)
  }

  const open = (): void => {
    if (disposed) return
    handlers.onStatus('connecting')

    let next: WebSocket
    try {
      next = new WebSocket(socketUrl())
    } catch {
      handlers.onStatus('closed')
      scheduleReconnect()
      return
    }
    socket = next

    next.onopen = () => {
      if (disposed) return
      attempt = 0
      handlers.onStatus('open')
    }

    next.onmessage = (event: MessageEvent<unknown>) => {
      if (disposed || typeof event.data !== 'string') return
      try {
        handlers.onEvent(JSON.parse(event.data) as ServerEvent)
      } catch {
        // Ignore malformed frames rather than tearing the socket down.
      }
    }

    next.onerror = () => {
      // `onclose` always follows, reconnection is handled there.
    }

    next.onclose = () => {
      if (socket === next) socket = null
      if (disposed) return
      handlers.onStatus('closed')
      scheduleReconnect()
    }
  }

  open()

  return () => {
    disposed = true
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
    const current = socket
    socket = null
    if (!current) return
    current.onmessage = null
    current.onerror = null
    current.onclose = null
    if (current.readyState === WebSocket.CONNECTING) {
      // Closing mid-handshake makes the browser log "WebSocket is closed before
      // the connection is established"; let it finish, then hang up cleanly.
      current.onopen = () => current.close(1000, 'client disposed')
      return
    }
    current.onopen = null
    if (current.readyState === WebSocket.OPEN) current.close(1000, 'client disposed')
  }
}
