import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Info, OctagonAlert } from 'lucide-react'
import type { Entity, EntityKind, GatewayEntity, GraphState } from '@kpa/shared'

import { useConsole } from '@/lib/store'

/**
 * Server-pushed operator notices (feature 10): the store keeps a FIFO queue so
 * a burst shows one dialog at a time; dismissing the head slides the next one
 * in. Affected entities render as clickable chips that select the node on the
 * canvas. Notices also land in the operator log, so closing this fast loses
 * nothing.
 */

function findEntity(state: GraphState, id: string): Entity | undefined {
  const gateway = state.gateway as GatewayEntity | undefined
  if (gateway && gateway.id === id) return gateway
  return (
    state.keys.find((e) => e.id === id) ??
    state.pools.find((e) => e.id === id) ??
    state.accounts.find((e) => e.id === id) ??
    state.proxies.find((e) => e.id === id)
  )
}

const LEVEL_ICON = {
  info: Info,
  warn: AlertTriangle,
  error: OctagonAlert,
} as const

export function NoticeDialog(): JSX.Element | null {
  const notice = useConsole((s) => s.notices[0])
  const dismissNotice = useConsole((s) => s.dismissNotice)
  const select = useConsole((s) => s.select)
  const state = useConsole((s) => s.state)

  const okRef = useRef<HTMLButtonElement | null>(null)
  const at: number | undefined = notice?.at

  // Focus the single action whenever a (new) notice surfaces.
  useEffect(() => {
    if (at === undefined) return
    okRef.current?.focus()
  }, [at])

  if (!notice) return null

  const Icon = LEVEL_ICON[notice.level as keyof typeof LEVEL_ICON] ?? Info

  const onBackdropMouseDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) dismissNotice()
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    e.stopPropagation()
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault()
      dismissNotice()
    }
  }

  const chips = (notice.entityIds as string[]).map((id: string) => {
    const entity = findEntity(state, id)
    return {
      id,
      name: entity?.name ?? id,
      kind: (entity?.kind ?? 'account') as EntityKind,
      missing: !entity,
    }
  })

  return createPortal(
    <div className="kpa-dialog-backdrop" onMouseDown={onBackdropMouseDown} onKeyDown={onKeyDown}>
      <div
        className="kpa-dialog kpa-notice"
        role="alertdialog"
        aria-modal="true"
        aria-label={notice.title}
        data-level={notice.level}
      >
        <h2 className="kpa-dialog__title kpa-notice__title">
          <Icon size={14} className="kpa-notice__icon" />
          {notice.title}
        </h2>
        <div className="kpa-dialog__body">
          <p>{notice.message}</p>
          {chips.length > 0 ? (
            <div className="kpa-notice__chips" role="list" aria-label="受影响的节点">
              {chips.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  className="kpa-notice__chip"
                  data-kind={chip.kind}
                  disabled={chip.missing}
                  title={chip.missing ? '该节点已不存在' : `在画布上选中「${chip.name}」`}
                  onClick={() => select(chip.id)}
                >
                  {chip.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="kpa-dialog__actions">
          <button
            ref={okRef}
            type="button"
            className="kpa-btn"
            data-variant="primary"
            data-size="sm"
            onClick={dismissNotice}
          >
            <span className="kpa-btn__label">知道了</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
