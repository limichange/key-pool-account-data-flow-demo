import type { NodeTypes } from '@xyflow/react'

import { KeyNode } from './KeyNode'
import { PoolNode } from './PoolNode'
import { AccountNode } from './AccountNode'
import { ProxyNode } from './ProxyNode'

/** React Flow node registry: `node.type` is the entity kind. */
export const nodeTypes = {
  key: KeyNode,
  pool: PoolNode,
  account: AccountNode,
  proxy: ProxyNode,
} as unknown as NodeTypes

export { NodeShell } from './NodeShell'
export { KeyNode, PoolNode, AccountNode, ProxyNode }
