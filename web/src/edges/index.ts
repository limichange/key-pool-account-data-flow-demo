import type { EdgeTypes } from '@xyflow/react'

import { FlowEdge } from './FlowEdge'

/**
 * React Flow's `EdgeTypes` map is intentionally loosely typed (`data: any`),
 * so the cast here is the sanctioned boundary between our typed edge component
 * and the library's registry.
 */
export const edgeTypes = {
  flow: FlowEdge,
} as unknown as EdgeTypes

export { FlowEdge }
