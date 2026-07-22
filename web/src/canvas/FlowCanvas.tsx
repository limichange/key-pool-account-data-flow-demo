import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type DefaultEdgeOptions,
  type IsValidConnection,
  type NodeMouseHandler,
  type OnBeforeDelete,
  type OnConnect,
  type OnNodeDrag,
} from '@xyflow/react'
import clsx from 'clsx'
import { ArrowLeftRight, Frame, LayoutGrid, Map as MapIcon, PlugZap, Route, SearchX } from 'lucide-react'

import {
  KIND_LABEL_CN,
  KIND_ORDER,
  MIN_READABLE_ZOOM,
  canJoinPool,
  edgeId,
  poolOfAccount,
  type Entity,
  type EntityKind,
  type GraphState,
} from '@kpa/shared'

import { Button, ConfirmDialog, DELETE_IRREVERSIBLE_NOTE, deleteConsequences } from '@/components'
import { edgeTypes } from '@/edges'
import { buildGraph, type FlowEdgeKind, type KpaEdge, type KpaNode } from '@/lib/graph'
import { LAYOUT_ANIM_MS, useConsole } from '@/lib/store'
import { nodeTypes } from '@/nodes'

/* React Flow requires stable identity for these maps. */
const NODE_TYPES = nodeTypes
const EDGE_TYPES = edgeTypes

const EMPTY_IDS: Set<string> = new Set<string>()

const DEFAULT_EDGE_OPTIONS: DefaultEdgeOptions = { type: 'flow' }
/** Breathing room kept around the graph when fitting it into the canvas. */
const FIT_PADDING = 0.06
/**
 * The instance `minZoom` (0.4) is a legibility floor for the FIRST paint, where
 * an unclamped fit lands around 0.29 and the cards become texture. But when the
 * operator clicks 适应视图 / 自动布局 they have explicitly asked to see the whole
 * graph, so those calls override the floor and are allowed to zoom out far
 * enough to actually contain every node. `FitViewOptions.minZoom` wins over the
 * instance value for that one call.
 */
const EXPLICIT_FIT_MIN_ZOOM = 0.2
/**
 * Screen-space margin used when the opening view is clamped to a readable
 * zoom. Large enough that the first row of cards clears the legend pill in the
 * top-left corner instead of opening underneath it.
 */
const OPEN_MARGIN_PX = 56
const DELETE_KEYS = ['Backspace', 'Delete']
const PRO_OPTIONS = { hideAttribution: true }
/** How long the "已整理" confirmation stays next to the auto-layout button. */
const LAYOUT_DONE_MS = 1800

/**
 * The only DRAGGABLE relations, left to right. The gateway is deliberately
 * absent on both sides: its gateway->key edges are system-owned and implicit
 * (every key hangs off the gateway), never user-editable.
 */
const NEXT_KIND: Partial<Record<EntityKind, EntityKind>> = {
  key: 'pool',
  pool: 'account',
  account: 'proxy',
}

/**
 * One short line per band stating the cardinality of the relation it owns.
 * The legend is where an operator learns the model, so the rules live here in
 * plain 中文 rather than only in the docs.
 */
const CARDINALITY_HINT: Record<EntityKind, string> = {
  gateway: '全局唯一入口',
  key: '多对多绑定池',
  pool: '独占持有多个账号',
  account: '只归属一个池',
  proxy: '可被多个账号共用',
}

const RELATION_TARGET_KIND: Record<FlowEdgeKind, EntityKind> = {
  'gateway-key': 'key',
  'key-pool': 'pool',
  'pool-account': 'account',
  'account-proxy': 'proxy',
  // Not a binding — see `onEdgesDelete`, which branches before this lookup.
  'pool-failover': 'pool',
}

function collectKinds(state: GraphState): Map<string, EntityKind> {
  const map = new Map<string, EntityKind>()
  if (state.gateway?.id) map.set(state.gateway.id, 'gateway')
  for (const key of state.keys) map.set(key.id, 'key')
  for (const pool of state.pools) map.set(pool.id, 'pool')
  for (const account of state.accounts) map.set(account.id, 'account')
  for (const proxy of state.proxies) map.set(proxy.id, 'proxy')
  return map
}

function collectBoundEdges(state: GraphState): Set<string> {
  const bound = new Set<string>()
  for (const key of state.keys) {
    for (const binding of key.bindings) bound.add(edgeId(key.id, binding.poolId))
  }
  for (const pool of state.pools) {
    for (const member of pool.members) bound.add(edgeId(pool.id, member.accountId))
  }
  for (const account of state.accounts) {
    if (account.proxyId) bound.add(edgeId(account.id, account.proxyId))
  }
  return bound
}

/** A pool -> account drop that would re-parent the account, awaiting confirmation. */
interface PendingMove {
  poolId: string
  poolName: string
  accountId: string
  accountName: string
  fromPoolName: string
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true
  return target.isContentEditable
}

function CanvasInner(): JSX.Element {
  const state = useConsole((s) => s.state)
  const search = useConsole((s) => s.search)
  const kindFilter = useConsole((s) => s.kindFilter)
  const onlyProblems = useConsole((s) => s.onlyProblems)
  const showMiniMap = useConsole((s) => s.showMiniMap)
  const traces = useConsole((s) => s.traces)
  const activeTraceId = useConsole((s) => s.activeTraceId)
  const selectedId = useConsole((s) => s.selectedId)
  const ready = useConsole((s) => s.ready)
  const connection = useConsole((s) => s.connection)
  const layoutAnimating = useConsole((s) => s.layoutAnimating)
  const layoutEpoch = useConsole((s) => s.layoutEpoch)

  const select = useConsole((s) => s.select)
  const setActiveTrace = useConsole((s) => s.setActiveTrace)
  const toggleMiniMap = useConsole((s) => s.toggleMiniMap)
  const moveEntity = useConsole((s) => s.moveEntity)
  const applyAutoLayout = useConsole((s) => s.applyAutoLayout)
  const deleteEntity = useConsole((s) => s.deleteEntity)
  const bind = useConsole((s) => s.bind)
  const unbind = useConsole((s) => s.unbind)
  const updateEntity = useConsole((s) => s.updateEntity)
  const resetFilters = useConsole((s) => s.resetFilters)
  const pushLog = useConsole((s) => s.pushLog)

  const { fitView, getZoom, setViewport } = useReactFlow<KpaNode, KpaEdge>()

  /* ---------------------------------------------------------- derivation -- */

  const activeTrace = useMemo(
    () => (activeTraceId ? (traces.find((t) => t.id === activeTraceId) ?? null) : null),
    [activeTraceId, traces],
  )

  const tracedIds = useMemo(() => {
    if (!activeTrace) return EMPTY_IDS
    const ids = new Set<string>()
    for (const hop of activeTrace.path) ids.add(hop.id)
    return ids
  }, [activeTrace])

  const tracedEdgeIds = useMemo(
    () => (activeTrace ? new Set(activeTrace.edgeIds) : EMPTY_IDS),
    [activeTrace],
  )

  const derived = useMemo(
    () =>
      buildGraph(state, {
        search,
        kindFilter,
        onlyProblems,
        tracedIds,
        tracedEdgeIds,
      }),
    [state, search, kindFilter, onlyProblems, tracedIds, tracedEdgeIds],
  )

  const kindOf = useMemo(() => collectKinds(state), [state])
  const boundEdges = useMemo(() => collectBoundEdges(state), [state])

  /* --------------------------------------------------- react flow state -- */

  const [nodes, setNodes, onNodesChange] = useNodesState<KpaNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<KpaEdge>([])

  /** Pending pool -> account re-parent awaiting the operator's confirmation. */
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null)
  /** Nodes captured from a Delete/Backspace press, awaiting the confirm dialog. */
  const [pendingDelete, setPendingDelete] = useState<Entity[] | null>(null)

  /*
   * The account band's pool-grouped ordering (what keeps the pool -> account
   * forest crossing-free) is only recomputed by `autoLayout`. A re-parent
   * through the UI leaves the account in its old slot, so a couple of edges can
   * sweep back across the band. We can't silently re-layout — that would yank
   * every card the operator has hand-placed — so instead we flag the ordering
   * as stale whenever the account -> pool mapping changes, and nudge them to
   * press 自动布局. The signature only changes on a genuine membership change,
   * not on the ~4x/s health patches, so this effect stays quiet otherwise.
   */
  const membershipSig = useMemo(
    () =>
      state.accounts
        .map((account) => `${account.id}:${account.poolId ?? ''}`)
        .sort()
        .join('|'),
    [state.accounts],
  )
  const [layoutStale, setLayoutStale] = useState(false)
  const lastMembershipSig = useRef<string | null>(null)

  useEffect(() => {
    if (!ready) return
    if (lastMembershipSig.current === null) {
      lastMembershipSig.current = membershipSig
      return
    }
    if (lastMembershipSig.current !== membershipSig) {
      lastMembershipSig.current = membershipSig
      setLayoutStale(true)
    }
  }, [ready, membershipSig])

  /** Ids the operator is dragging right now: server patches must not fight them. */
  const draggingIds = useRef<Set<string>>(new Set())
  /** Selection already mirrored onto the canvas, to avoid clobbering edge selection. */
  const mirroredSelection = useRef<string | null>(null)
  /** Set when the selection change originated from an edge click. */
  const skipSelectionMirror = useRef(false)

  /*
   * The store patches ~4x/s, which rebuilds `derived` from scratch. Handing
   * React Flow brand new node objects on every patch is not free: `measured`
   * is lost, `parseHandles` drops `handleBounds`, `getEdgePosition` returns
   * null and *every* edge unmounts and remounts — which also destroys the
   * traffic particle state mid-flight. So carry the previous object forward
   * whenever nothing this component owns has actually changed, and return the
   * previous array outright when no element moved, so React Flow's own
   * equality fast path hits too.
   */
  useEffect(() => {
    setNodes((prev) => {
      const previous = new Map<string, KpaNode>(prev.map((node) => [node.id, node]))
      let changed = prev.length !== derived.nodes.length
      const next = derived.nodes.map((incoming) => {
        const old = previous.get(incoming.id)
        if (!old) {
          changed = true
          return incoming
        }
        const pinned = draggingIds.current.has(incoming.id) || old.dragging === true
        const position = pinned ? old.position : incoming.position
        if (
          old.data.entity === incoming.data.entity &&
          old.data.dimmed === incoming.data.dimmed &&
          old.data.traced === incoming.data.traced &&
          old.data.detached === incoming.data.detached &&
          old.position.x === position.x &&
          old.position.y === position.y
        ) {
          return old
        }
        changed = true
        return {
          ...old,
          ...incoming,
          position,
          measured: old.measured,
          dragging: old.dragging,
          selected: old.selected,
        }
      })
      return changed ? next : prev
    })
  }, [derived, setNodes])

  useEffect(() => {
    setEdges((prev) => {
      const previous = new Map<string, KpaEdge>(prev.map((edge) => [edge.id, edge]))
      let changed = prev.length !== derived.edges.length
      const next = derived.edges.map((incoming) => {
        const old = previous.get(incoming.id)
        if (!old) {
          changed = true
          return incoming
        }
        const a = old.data
        const b = incoming.data
        if (
          old.source === incoming.source &&
          old.target === incoming.target &&
          a?.label === b?.label &&
          a?.weight === b?.weight &&
          a?.disabled === b?.disabled &&
          a?.live === b?.live &&
          a?.dimmed === b?.dimmed &&
          a?.traced === b?.traced
        ) {
          return old
        }
        changed = true
        return { ...old, ...incoming, selected: old.selected }
      })
      return changed ? next : prev
    })
  }, [derived, setEdges])

  /*
   * The opening view.
   *
   * A bare `fitView` on this graph lands around zoom 0.29 on a 1440x900
   * screen, where the 14px card title renders at 4px and the whole console is
   * texture. A mission-control board must open on something a person can read,
   * so the fit is clamped: keep it when it is already legible, otherwise open
   * at `MIN_READABLE_ZOOM` anchored on the top-left of the graph (the gateway
   * and key columns, where the story starts) and let the operator pan.
   *
   * This deliberately does NOT use React Flow's `fitView` prop: cards render a
   * compact variant below `COMPACT_ZOOM`, so an automatic re-fit after the
   * clamp would measure the now-taller cards, shrink back below the threshold
   * and oscillate. Fitting exactly once, by hand, breaks that loop.
   */
  const clampedOpen = useRef(false)
  const nodesInitialized = useNodesInitialized()

  useEffect(() => {
    if (clampedOpen.current || !ready || !nodesInitialized || derived.nodes.length === 0) return
    clampedOpen.current = true
    void (async () => {
      await fitView({ padding: FIT_PADDING })
      if (getZoom() >= MIN_READABLE_ZOOM) return
      // Anchor minY on the gateway + key bands only. The account band is far
      // taller than the entry bands, so the GLOBAL bounding-box top sits high
      // above the vertically-centred gateway — anchoring on it opened the view
      // on empty canvas with the gateway hero below the fold. The story starts
      // at the gateway, so that is what must be on screen at first paint.
      let minX = Number.POSITIVE_INFINITY
      let entryMinY = Number.POSITIVE_INFINITY
      let anyMinY = Number.POSITIVE_INFINITY
      for (const node of derived.nodes) {
        minX = Math.min(minX, node.position.x)
        anyMinY = Math.min(anyMinY, node.position.y)
        const kind = node.data.entity.kind
        if (kind === 'gateway' || kind === 'key') entryMinY = Math.min(entryMinY, node.position.y)
      }
      // Both entry kinds can be filtered away; fall back to the global top.
      const minY = Number.isFinite(entryMinY) ? entryMinY : anyMinY
      if (!Number.isFinite(minX) || !Number.isFinite(minY)) return
      await setViewport(
        {
          x: OPEN_MARGIN_PX - minX * MIN_READABLE_ZOOM,
          y: OPEN_MARGIN_PX - minY * MIN_READABLE_ZOOM,
          zoom: MIN_READABLE_ZOOM,
        },
        { duration: 260 },
      )
    })()
  }, [ready, nodesInitialized, derived.nodes, fitView, getZoom, setViewport])

  // Mirror store selection onto the canvas (palette / inspector driven selection).
  useEffect(() => {
    if (mirroredSelection.current === selectedId) return
    mirroredSelection.current = selectedId
    if (skipSelectionMirror.current) {
      skipSelectionMirror.current = false
      return
    }
    setNodes((prev) => {
      let changed = false
      const next = prev.map((node) => {
        const shouldSelect = node.id === selectedId
        if (Boolean(node.selected) === shouldSelect) return node
        changed = true
        return { ...node, selected: shouldSelect }
      })
      return changed ? next : prev
    })
  }, [selectedId, setNodes])

  /* -------------------------------------------------------- auto layout -- */

  /*
   * Both auto-layout buttons (canvas and TopBar) go through the SAME store
   * action; the canvas reacts to `layoutEpoch` so the animation + re-fit also
   * runs when the TopBar triggered it. While `layoutAnimating` is true the
   * wrapper class turns on a CSS transition on the node transforms, so cards
   * glide into their new slots instead of snapping (disabled under
   * prefers-reduced-motion in canvas.css).
   */
  const [layoutDone, setLayoutDone] = useState(false)
  const lastLayoutEpoch = useRef(0)

  useEffect(() => {
    if (layoutEpoch === 0 || layoutEpoch === lastLayoutEpoch.current) return
    lastLayoutEpoch.current = layoutEpoch
    setLayoutStale(false)
    setLayoutDone(true)
    const fitTimer = window.setTimeout(() => {
      void fitView({ padding: FIT_PADDING, duration: 320, minZoom: EXPLICIT_FIT_MIN_ZOOM })
    }, LAYOUT_ANIM_MS)
    const doneTimer = window.setTimeout(() => setLayoutDone(false), LAYOUT_DONE_MS)
    return () => {
      window.clearTimeout(fitTimer)
      window.clearTimeout(doneTimer)
    }
  }, [layoutEpoch, fitView])

  const handleAutoLayout = useCallback(() => {
    void applyAutoLayout()
  }, [applyAutoLayout])

  // Keyboard shortcut: A = 自动布局 (documented in the button title / README).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key !== 'a' && event.key !== 'A') return
      if (isTypingTarget(event.target)) return
      event.preventDefault()
      void applyAutoLayout()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [applyAutoLayout])

  /* ------------------------------------------------------- interactions -- */

  const onNodeClick = useCallback<NodeMouseHandler<KpaNode>>(
    (_event, node) => {
      setPendingMove(null)
      select(node.id)
    },
    [select],
  )

  const onPaneClick = useCallback(() => {
    setPendingMove(null)
    select(null)
    setActiveTrace(null)
  }, [select, setActiveTrace])

  const cancelMove = useCallback(() => {
    setPendingMove(null)
  }, [])

  const confirmMove = useCallback(() => {
    if (!pendingMove) return
    const move = pendingMove
    setPendingMove(null)
    void bind({ kind: 'pool', id: move.poolId }, { kind: 'account', id: move.accountId })
  }, [bind, pendingMove])

  /*
   * While the prompt is up, Escape belongs to it: the capture-phase listener
   * runs before the app-wide Escape shortcut and swallows the event, so
   * cancelling a re-parent does not also drop the current selection.
   */
  useEffect(() => {
    if (!pendingMove) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setPendingMove(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [pendingMove])

  // Drop a stale prompt when either side of the move disappears from the graph.
  useEffect(() => {
    if (!pendingMove) return
    if (kindOf.has(pendingMove.poolId) && kindOf.has(pendingMove.accountId)) return
    setPendingMove(null)
  }, [pendingMove, kindOf])

  // Same for the delete dialog: prune entities that vanished server-side.
  useEffect(() => {
    if (!pendingDelete) return
    const alive = pendingDelete.filter((entity) => kindOf.has(entity.id))
    if (alive.length === pendingDelete.length) return
    setPendingDelete(alive.length > 0 ? alive : null)
  }, [pendingDelete, kindOf])

  const onNodeDragStart = useCallback<OnNodeDrag<KpaNode>>((_event, node, dragged) => {
    draggingIds.current.add(node.id)
    for (const item of dragged) draggingIds.current.add(item.id)
  }, [])

  const onNodeDragStop = useCallback<OnNodeDrag<KpaNode>>(
    (_event, node, dragged) => {
      const moved = dragged.length > 0 ? dragged : [node]
      for (const item of moved) {
        draggingIds.current.delete(item.id)
        void moveEntity(item.id, item.position)
      }
      draggingIds.current.delete(node.id)
    },
    [moveEntity],
  )

  /*
   * A pool -> account drop stays VALID even when the account already belongs to
   * another pool: that drop is a *move*, which is the intended way to re-parent
   * an account on the canvas. It can never produce a second incoming pool edge,
   * because `buildGraph` renders exactly one owning pool per account. Rejected
   * here are: anything touching the gateway (its edges are system-owned), a
   * pool -> account drop onto a proxy-less account (feature 9 — egress before
   * serving), and a relation that already exists. The reason for the newest
   * rejection is kept so `onConnectEnd` can surface it in the operator log.
   */
  const connectReject = useRef<string | null>(null)

  const isValidConnection = useCallback<IsValidConnection<KpaEdge>>(
    (candidate) => {
      const { source, target } = candidate
      if (!source || !target || source === target) return false
      const sourceKind = kindOf.get(source)
      const targetKind = kindOf.get(target)
      if (!sourceKind || !targetKind) return false
      if (sourceKind === 'gateway' || targetKind === 'gateway') {
        connectReject.current = '网关是全局入口：网关 → 密钥的连线由系统维护，不能手动创建或修改。'
        return false
      }
      if (NEXT_KIND[sourceKind] !== targetKind) return false
      if (sourceKind === 'pool' && targetKind === 'account') {
        const account = state.accounts.find((item) => item.id === target)
        if (account && !canJoinPool(account)) {
          connectReject.current = `账号「${account.name}」尚未绑定出口代理，无法加入池；请先为它绑定代理。`
          return false
        }
      }
      if (boundEdges.has(edgeId(source, target))) return false
      connectReject.current = null
      return true
    },
    [kindOf, boundEdges, state],
  )

  const onConnectStart = useCallback(() => {
    connectReject.current = null
  }, [])

  const onConnectEnd = useCallback(() => {
    if (!connectReject.current) return
    pushLog('warn', connectReject.current)
    connectReject.current = null
  }, [pushLog])

  const onConnect = useCallback<OnConnect>(
    (params) => {
      const { source, target } = params
      if (!source || !target) return
      const sourceKind = kindOf.get(source)
      const targetKind = kindOf.get(target)
      // Silently reject anything that is not a legal left-to-right relation;
      // isValidConnection already rejects it visually while dragging.
      if (!sourceKind || !targetKind) return
      if (sourceKind === 'gateway' || targetKind === 'gateway') return
      if (NEXT_KIND[sourceKind] !== targetKind) return

      if (sourceKind === 'pool' && targetKind === 'account') {
        const account = state.accounts.find((item) => item.id === target)
        // Feature 9: egress is configured BEFORE an account may serve.
        if (account && !canJoinPool(account)) return
        // An account belongs to at most one pool, so binding it to a second one
        // MOVES it out of the first. That is a destructive edit for the pool
        // losing the account, so it is confirmed instead of applied silently.
        const current = poolOfAccount(state, target)
        if (current && current.id !== source) {
          setPendingMove({
            poolId: source,
            poolName: state.pools.find((p) => p.id === source)?.name ?? source,
            accountId: target,
            accountName: account?.name ?? target,
            fromPoolName: current.name,
          })
          return
        }
      }

      void bind({ kind: sourceKind, id: source }, { kind: targetKind, id: target })
    },
    [bind, kindOf, state],
  )

  const onEdgeClick = useCallback(
    (_event: ReactMouseEvent, edge: KpaEdge) => {
      skipSelectionMirror.current = true
      select(edge.source)
    },
    [select],
  )

  /*
   * Feature 6 — the Delete/Backspace keys NEVER remove a node directly.
   * `onBeforeDelete` strips every node out of React Flow's delete batch and
   * parks it in `pendingDelete`; only the <ConfirmDialog> confirm button calls
   * `deleteEntity`. Explicitly selected EDGES still delete immediately — an
   * unbind is cheap and reversible — but the connected edges React Flow adds
   * for a doomed node are dropped along with it (the server cascades on the
   * real delete anyway). The gateway and the implicit gateway->key edges are
   * excluded outright.
   */
  const onBeforeDelete = useCallback<OnBeforeDelete<KpaNode, KpaEdge>>(
    async ({ nodes: doomedNodes, edges: doomedEdges }) => {
      const explicitEdges = doomedEdges.filter(
        (edge) => edge.selected === true && edge.data?.relation !== 'gateway-key',
      )
      const doomed = doomedNodes.filter((node) => node.data.entity.kind !== 'gateway')
      if (doomed.length > 0) setPendingDelete(doomed.map((node) => node.data.entity))
      return { nodes: [], edges: explicitEdges }
    },
    [],
  )

  const cancelPendingDelete = useCallback(() => {
    setPendingDelete(null)
  }, [])

  const confirmPendingDelete = useCallback(() => {
    const doomed = pendingDelete ?? []
    setPendingDelete(null)
    for (const entity of doomed) {
      if (entity.kind === 'gateway') continue
      void deleteEntity(entity.kind, entity.id)
    }
  }, [pendingDelete, deleteEntity])

  const onEdgesDelete = useCallback(
    (removed: KpaEdge[]) => {
      for (const edge of removed) {
        const relation = edge.data?.relation
        // System-owned, implicit relation — never deletable (guarded again here
        // in case a future code path bypasses onBeforeDelete).
        if (relation === 'gateway-key') continue
        // The failover edge is a field on the pool, not a binding: unbinding it
        // would post pool -> pool, which the server rejects with a 400.
        if (relation === 'pool-failover') {
          void updateEntity('pool', edge.source, { failoverPoolId: null })
          continue
        }
        const sourceKind = edge.data?.sourceKind ?? kindOf.get(edge.source)
        const targetKind = relation ? RELATION_TARGET_KIND[relation] : kindOf.get(edge.target)
        if (!sourceKind || !targetKind) continue
        void unbind({ kind: sourceKind, id: edge.source }, { kind: targetKind, id: edge.target })
      }
    },
    [unbind, updateEntity, kindOf],
  )

  /* ------------------------------------------------------------- chrome -- */

  const handleFitView = useCallback(() => {
    void fitView({ padding: FIT_PADDING, duration: 320, minZoom: EXPLICIT_FIT_MIN_ZOOM })
  }, [fitView])

  const clearFilters = useCallback(() => {
    resetFilters()
  }, [resetFilters])

  const miniMapColor = useCallback((node: KpaNode) => `var(--${node.type ?? 'key'})`, [])

  /* Anchor of the 游离节点 parking label: just above the top-left detached card. */
  const detachedAnchor = useMemo(() => {
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let count = 0
    for (const node of derived.nodes) {
      if (!node.data.detached) continue
      count += 1
      minX = Math.min(minX, node.position.x)
      minY = Math.min(minY, node.position.y)
    }
    if (count === 0) return null
    return { x: minX, y: minY - 36, count }
  }, [derived.nodes])

  const offline = connection === 'closed' && !ready
  const hasWorkNodes = derived.nodes.some((node) => node.data.entity.kind !== 'gateway')

  return (
    <div className={clsx('kpa-canvas', layoutAnimating && 'kpa-canvas--layout-anim')}>
      {/* Feature 13: purely presentational scan-sweep band (see canvas.css). */}
      <div className="kpa-canvas__sweep" aria-hidden="true" />
      <ReactFlow<KpaNode, KpaEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onEdgeClick={onEdgeClick}
        onBeforeDelete={onBeforeDelete}
        onEdgesDelete={onEdgesDelete}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        proOptions={PRO_OPTIONS}
        minZoom={0.4}
        maxZoom={1.6}
        nodesDraggable
        elevateEdgesOnSelect
        elevateNodesOnSelect
        deleteKeyCode={DELETE_KEYS}
        panOnScroll
        zoomOnDoubleClick={false}
        connectionRadius={28}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1}
          color="var(--border)"
          className="kpa-canvas__grid"
        />
        <Controls className="kpa-controls" showInteractive={false} position="bottom-left" />
        {showMiniMap ? (
          <MiniMap<KpaNode>
            className="kpa-minimap"
            position="top-right"
            nodeColor={miniMapColor}
            nodeStrokeColor="var(--bg-root)"
            nodeStrokeWidth={2}
            nodeBorderRadius={4}
            maskColor="rgba(7, 10, 17, 0.72)"
            bgColor="var(--bg-canvas)"
            pannable
            zoomable
            ariaLabel="画布缩略图"
          />
        ) : null}

        {detachedAnchor ? (
          <ViewportPortal>
            <div
              className="kpa-detached-label"
              style={{ transform: `translate(${detachedAnchor.x}px, ${detachedAnchor.y}px)` }}
            >
              游离节点 · {detachedAnchor.count} · 未接入不参与流量
            </div>
          </ViewportPortal>
        ) : null}

        <Panel position="top-left" className="kpa-legend">
          {KIND_ORDER.map((kind, index) => (
            <div className="kpa-legend__cell" key={kind}>
              {index > 0 ? <span className="kpa-legend__arrow" aria-hidden="true" /> : null}
              <div
                className="kpa-legend__item"
                data-kind={kind}
                data-filtered={derived.filtered ? 'true' : undefined}
                title={
                  derived.filtered
                    ? `${KIND_LABEL_CN[kind]}：${derived.visible[kind]} / ${derived.total[kind]} 可见 · ${CARDINALITY_HINT[kind]}`
                    : `${KIND_LABEL_CN[kind]} ${derived.total[kind]} · ${CARDINALITY_HINT[kind]}`
                }
              >
                <span className="kpa-legend__swatch" />
                <span className="kpa-legend__text">
                  <span className="kpa-legend__line">
                    <span className="kpa-legend__label">{KIND_LABEL_CN[kind]}</span>
                    <span className="kpa-legend__count">
                      {derived.filtered
                        ? `${derived.visible[kind]} / ${derived.total[kind]}`
                        : derived.total[kind]}
                    </span>
                  </span>
                  <span className="kpa-legend__rule">{CARDINALITY_HINT[kind]}</span>
                </span>
              </div>
            </div>
          ))}
          <div
            className="kpa-legend__edge-rule"
            title="连线颜色语义：绿色 = 两端节点均已启用（通路），灰色 = 任一端已停用（断路）"
          >
            <span className="kpa-legend__edge-line" data-live="true" aria-hidden="true" />
            <span>两端启用</span>
            <span className="kpa-legend__edge-line" data-live="false" aria-hidden="true" />
            <span>任一端停用</span>
          </div>
          {activeTrace ? (
            <div className="kpa-legend__trace">
              <Route size={11} />
              <span>已高亮链路</span>
              <code>{activeTrace.id}</code>
            </div>
          ) : null}
        </Panel>

        {pendingMove ? (
          <Panel position="top-center" className="kpa-move-confirm">
            <span className="kpa-move-confirm__icon" aria-hidden="true">
              <ArrowLeftRight size={13} />
            </span>
            <span className="kpa-move-confirm__text">
              <b>「{pendingMove.accountName}」当前属于「{pendingMove.fromPoolName}」</b>
              <span>
                一个账号只能属于一个池。确认后它会离开「{pendingMove.fromPoolName}」，改由「
                {pendingMove.poolName}」持有。
              </span>
            </span>
            <span className="kpa-move-confirm__actions">
              <Button size="sm" variant="primary" onClick={confirmMove}>
                确认移入
              </Button>
              <Button size="sm" variant="subtle" onClick={cancelMove} title="按 Esc 也可以取消">
                取消
              </Button>
            </span>
          </Panel>
        ) : null}

        <Panel position="bottom-right" className="kpa-canvas-tools">
          {layoutStale ? (
            <span className="kpa-canvas-tools__hint" role="status">
              归属已变更，点击自动布局重新排列
            </span>
          ) : null}
          {layoutDone ? (
            <span className="kpa-canvas-tools__done" role="status">
              已整理
            </span>
          ) : null}
          <Button
            size="sm"
            variant={layoutStale ? 'primary' : 'subtle'}
            icon={<LayoutGrid size={12} />}
            onClick={handleAutoLayout}
            title="按列重新排布所有节点（快捷键 A）"
          >
            自动布局
          </Button>
          <Button size="sm" variant="subtle" icon={<Frame size={12} />} onClick={handleFitView} title="缩放到全部节点">
            适应视图
          </Button>
          <Button
            size="sm"
            variant={showMiniMap ? 'primary' : 'subtle'}
            icon={<MapIcon size={12} />}
            onClick={toggleMiniMap}
            title="显示/隐藏小地图 (M)"
          >
            小地图
          </Button>
        </Panel>
      </ReactFlow>

      {pendingDelete && pendingDelete.length > 0 ? (
        <ConfirmDialog
          open
          tone="danger"
          title={
            pendingDelete.length === 1
              ? `删除${KIND_LABEL_CN[pendingDelete[0].kind]}「${pendingDelete[0].name}」`
              : `删除 ${pendingDelete.length} 个节点`
          }
          body={
            <div className="kpa-delete-body">
              {pendingDelete.map((entity) => (
                <div className="kpa-delete-body__entity" key={entity.id}>
                  {pendingDelete.length > 1 ? (
                    <div className="kpa-delete-body__name">
                      {KIND_LABEL_CN[entity.kind]}「{entity.name}」
                    </div>
                  ) : null}
                  {/* The helper appends the irreversible note per entity; it is
                      stripped here and rendered exactly once, muted, below. */}
                  {deleteConsequences(state, entity)
                    .filter((line) => line !== DELETE_IRREVERSIBLE_NOTE)
                    .map((line, index) => (
                      <p className="kpa-delete-body__line" key={index}>
                        {line}
                      </p>
                    ))}
                </div>
              ))}
              <p className="kpa-delete-body__note">{DELETE_IRREVERSIBLE_NOTE}</p>
            </div>
          }
          confirmLabel="确认删除"
          cancelLabel="取消"
          onConfirm={confirmPendingDelete}
          onCancel={cancelPendingDelete}
        />
      ) : null}

      {ready && derived.filtered && !hasWorkNodes ? (
        <div className="kpa-canvas__empty">
          <SearchX size={22} />
          <h2>没有符合条件的节点</h2>
          <p>当前的类型筛选或「只看异常」把所有节点都排除了。</p>
          <Button size="sm" variant="primary" onClick={clearFilters}>
            清除筛选
          </Button>
        </div>
      ) : null}

      {!ready ? (
        <div className="kpa-canvas__overlay">
          {offline ? (
            <div className="kpa-canvas__offline">
              <PlugZap size={26} />
              <h2>无法连接到模拟器</h2>
              <p>
                网关模拟服务没有响应。请在项目根目录执行 <code>pnpm dev</code>，
                确认 <code>127.0.0.1:8787</code> 已经启动后，页面会自动重连。
              </p>
            </div>
          ) : (
            <div className="kpa-canvas__loading">
              <div className="kpa-canvas__shimmer" />
              <div className="kpa-canvas__shimmer" />
              <div className="kpa-canvas__shimmer" />
              <span className="kpa-canvas__loading-text">正在拉取网关拓扑…</span>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

export function FlowCanvas(): JSX.Element {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  )
}
