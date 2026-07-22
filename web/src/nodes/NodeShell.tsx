import { useEffect, useState, type ReactNode } from 'react'
import { Handle, Position, useStore } from '@xyflow/react'
import clsx from 'clsx'
import { COMPACT_ZOOM, LAYOUT, type Entity, type EntityKind } from '@kpa/shared'

import { StatusDot } from '@/components'
import { statusLabel } from '@/lib/format'
import { useConsole, useNodePulse } from '@/lib/store'

/** Handle topology of a card: keys emit, proxies receive, the middle does both. */
export type NodeHandles = 'out' | 'in-out' | 'in'

/**
 * One fixed template shared by all four kinds so the eye can learn a single
 * card and reuse it across the chain:
 *
 *   1. identity row   icon · name · id · status
 *   2. badge row      kind-specific chips
 *   3. detail line    secret | strategy | credential | host   +   one aside
 *   4. body           the kind-specific block (bars, members, gauge, …)
 *   5. stat rail      always 请求数 / 成功率 / p95, directly above the footer
 *   6. footer         kind-specific relations
 *
 * Slots 1, 3 and 5 are mandatory; that is what makes a row of cards scannable.
 */
export interface NodeShellProps {
  entity: Entity
  selected: boolean
  icon: ReactNode
  subtitle: ReactNode
  badges?: ReactNode
  /** Slot 3: exactly one identity/detail line. */
  detail: ReactNode
  /** Slot 4: the kind-specific body. */
  children: ReactNode
  /** Slot 5: the mandatory three-cell stat rail. */
  rail: ReactNode
  footer?: ReactNode
  /** Single read-out shown instead of the body when the canvas is zoomed out. */
  headline?: ReactNode
  handles: NodeHandles
  dimmed?: boolean
  traced?: boolean
  className?: string
}

/** Horizontal room available inside the card body, used to size sparklines. */
export function nodeInnerWidth(kind: EntityKind): number {
  return LAYOUT.nodeWidth[kind] - 24
}

type PulseTone = 'ok' | 'err'

const PULSE_MS = 450

export function NodeShell({
  entity,
  selected,
  icon,
  subtitle,
  badges,
  detail,
  children,
  rail,
  footer,
  headline,
  handles,
  dimmed = false,
  traced = false,
  className,
}: NodeShellProps): JSX.Element {
  const pulseAt = useNodePulse(entity.id)
  const lastOk = useConsole((s) => s.nodeActivity[entity.id]?.lastOk ?? true)
  const [pulse, setPulse] = useState<PulseTone | null>(null)
  // Level of detail: below this zoom the dense body is unreadable texture, so
  // the card degrades to a legible topology tile instead of grey mush.
  const compact = useStore((s) => s.transform[2] < COMPACT_ZOOM)

  useEffect(() => {
    if (!pulseAt) return
    setPulse(lastOk ? 'ok' : 'err')
    const timer = window.setTimeout(() => setPulse(null), PULSE_MS)
    return () => window.clearTimeout(timer)
  }, [pulseAt, lastOk])

  const showIn = handles === 'in' || handles === 'in-out'
  const showOut = handles === 'out' || handles === 'in-out'

  return (
    <div
      className={clsx('kpa-node', compact && 'kpa-node--compact', className)}
      data-kind={entity.kind}
      data-status={entity.status}
      data-selected={selected || undefined}
      data-dimmed={dimmed || undefined}
      data-traced={traced || undefined}
      data-pulse={pulse ?? undefined}
      style={{ width: LAYOUT.nodeWidth[entity.kind] }}
    >
      {showIn ? (
        <Handle
          id="in"
          type="target"
          position={Position.Left}
          className="kpa-node__handle kpa-node__handle--in"
        />
      ) : null}

      <header className="kpa-node__header">
        <span className="kpa-node__icon">{icon}</span>
        <span className="kpa-node__ident">
          <span className="kpa-node__name" title={entity.name}>
            {entity.name}
          </span>
          {compact ? null : <span className="kpa-node__subtitle">{subtitle}</span>}
        </span>
        <span className="kpa-node__status" title={statusLabel(entity.status)}>
          <StatusDot status={entity.status} pulse={entity.status !== 'disabled'} />
          <span className="kpa-node__status-text">{statusLabel(entity.status)}</span>
        </span>
      </header>

      {compact ? (
        <div className="kpa-node__headline">{headline}</div>
      ) : (
        <>
          {badges ? <div className="kpa-node__badges">{badges}</div> : null}
          <div className="kpa-node__detail">{detail}</div>
          <div className="kpa-node__body">{children}</div>
          <div className="kpa-node__stats">{rail}</div>
          {footer ? <footer className="kpa-node__footer">{footer}</footer> : null}
        </>
      )}

      {showOut ? (
        <Handle
          id="out"
          type="source"
          position={Position.Right}
          className="kpa-node__handle kpa-node__handle--out"
        />
      ) : null}
    </div>
  )
}
