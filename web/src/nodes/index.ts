import type { NodeTypes } from '@xyflow/react'

import { GatewayNode } from './GatewayNode'
import { KeyNode } from './KeyNode'
import { PoolNode } from './PoolNode'
import { AccountNode } from './AccountNode'
import { ProxyNode } from './ProxyNode'

/** React Flow node registry: `node.type` is the entity kind. */
export const nodeTypes = {
  gateway: GatewayNode,
  key: KeyNode,
  pool: PoolNode,
  account: AccountNode,
  proxy: ProxyNode,
} as unknown as NodeTypes

export { NodeShell } from './NodeShell'
export { GatewayNode, KeyNode, PoolNode, AccountNode, ProxyNode }
