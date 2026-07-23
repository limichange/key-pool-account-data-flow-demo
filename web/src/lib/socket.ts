/**
 * Event stream of the engine.
 *
 * Historically an auto-reconnecting WebSocket client; the console is now pure
 * frontend, so this subscribes to the in-browser engine directly. The handler
 * contract is unchanged: a `snapshot` event arrives immediately on connect
 * (the engine mirrors the old server's on-connection behaviour), and the
 * connection state is reported through `onStatus` — always `open`, since an
 * in-process engine cannot drop.
 */
import { type ServerEvent } from '@kpa/shared'

import { localBackend } from './local'
import type { ConnectionState } from './store'

export interface SocketHandlers {
  onEvent(ev: ServerEvent): void
  onStatus(s: ConnectionState): void
}

export function connectSocket(handlers: SocketHandlers): () => void {
  let disposed = false
  const unsubscribe = localBackend().subscribe((ev) => {
    if (!disposed) handlers.onEvent(ev)
  })
  handlers.onStatus('open')
  return () => {
    if (disposed) return
    disposed = true
    unsubscribe()
  }
}
