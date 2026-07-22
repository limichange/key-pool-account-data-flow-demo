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
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type DefaultEdgeOptions,
  type IsValidConnection,
  type NodeMouseHandler,
  type OnConnect,
  type OnNodeDrag,
} from '@xyflow/react'
import { ArrowLeftRight, Frame, LayoutGrid, Map as MapIcon, PlugZap, Route, SearchX } from 'lucide-react'

import {
  KIND_LABEL_CN,
  KIND_ORDER,
  MIN_READABLE_ZOOM,
  edgeId,
  poolOfAccount,
  type EntityKind,
  type GraphState,
  type XY,
} from '@kpa/shared'

import { Button } from '@/components'
import { edgeTypes } from '@/edges'
import { autoLayout, buildGraph, type FlowEdgeKind, type KpaEdge, type KpaNode } from '@/lib/graph'
import { useConsole } from '@/lib/store'
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

/** The only relations the gateway model allows, left to right. */
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
  key: '多对多绑定池',
  pool: '独占持有多个账号',
  account: '只归属一个池',
  proxy: '可被多个账号共用',
}

const RELATION_TARGET_KIND: Record<FlowEdgeKind, EntityKind> = {
  'key-pool': 'pool',
  'pool-account': 'account',
  'account-proxy': 'proxy',
  // Not a binding — see `onEdgesDelete`, which branches before this lookup.
  'pool-failover': 'pool',
}

function collectKinds(state: GraphState): Map<string, EntityKind> {
  const map = new Map<string, EntityKind>()
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

  const select = useConsole((s) => s.select)
  const setActiveTrace = useConsole((s) => s.setActiveTrace)
  const toggleMiniMap = useConsole((s) => s.toggleMiniMap)
  const moveEntity = useConsole((s) => s.moveEntity)
  const deleteEntity = useConsole((s) => s.deleteEntity)
  const bind = useConsole((s) => s.bind)
  const unbind = useConsole((s) => s.unbind)
  const updateEntity = useConsole((s) => s.updateEntity)
  const resetFilters = useConsole((s) => s.resetFilters)

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
   * at `MIN_READABLE_ZOOM` anchored on the top-left of the graph (the key and
   * pool columns, where the story starts) and let the operator pan.
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
      let minX = Number.POSITIVE_INFINITY
      let minY = Number.POSITIVE_INFINITY
      for (const node of derived.nodes) {
        minX = Math.min(minX, node.position.x)
        minY = Math.min(minY, node.position.y)
      }
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
   * because `buildGraph` renders exactly one owning pool per account. The only
   * pool -> account drop rejected here is the one that already exists.
   */
  const isValidConnection = useCallback<IsValidConnection<KpaEdge>>(
    (candidate) => {
      const { source, target } = candidate
      if (!source || !target || source === target) return false
      const sourceKind = kindOf.get(source)
      const targetKind = kindOf.get(target)
      if (!sourceKind || !targetKind) return false
      if (NEXT_KIND[sourceKind] !== targetKind) return false
      return !boundEdges.has(edgeId(source, target))
    },
    [kindOf, boundEdges],
  )

  const onConnect = useCallback<OnConnect>(
    (params) => {
      const { source, target } = params
      if (!source || !target) return
      const sourceKind = kindOf.get(source)
      const targetKind = kindOf.get(target)
      // Silently reject anything that is not a legal left-to-right relation;
      // isValidConnection already rejects it visually while dragging.
      if (!sourceKind || !targetKind) return
      if (NEXT_KIND[sourceKind] !== targetKind) return

      if (sourceKind === 'pool' && targetKind === 'account') {
        // An account belongs to at most one pool, so binding it to a second one
        // MOVES it out of the first. That is a destructive edit for the pool
        // losing the account, so it is confirmed instead of applied silently.
        const current = poolOfAccount(state, target)
        if (current && current.id !== source) {
          setPendingMove({
            poolId: source,
            poolName: state.pools.find((p) => p.id === source)?.name ?? source,
            accountId: target,
            accountName: state.accounts.find((a) => a.id === target)?.name ?? target,
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

  const onEdgesDelete = useCallback(
    (removed: KpaEdge[]) => {
      for (const edge of removed) {
        const relation = edge.data?.relation
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

  const onNodesDelete = useCallback(
    (removed: KpaNode[]) => {
      for (const node of removed) {
        const kind = node.data?.entity.kind ?? kindOf.get(node.id)
        if (!kind) continue
        void deleteEntity(kind, node.id)
      }
    },
    [deleteEntity, kindOf],
  )

  /* ------------------------------------------------------------- chrome -- */

  const handleAutoLayout = useCallback(() => {
    // Re-running the layout re-groups the account band by owning pool, which is
    // exactly what clears the "ordering went stale" state.
    setLayoutStale(false)
    const positions: Record<string, XY> = autoLayout(state)
    setNodes((prev) =>
      prev.map((node) => {
        const position = positions[node.id]
        return position ? { ...node, position } : node
      }),
    )
    for (const [id, position] of Object.entries(positions)) {
      void moveEntity(id, position)
    }
    window.setTimeout(() => {
      void fitView({ padding: FIT_PADDING, duration: 320, minZoom: EXPLICIT_FIT_MIN_ZOOM })
    }, 80)
  }, [state, setNodes, moveEntity, fitView])

  const handleFitView = useCallback(() => {
    void fitView({ padding: FIT_PADDING, duration: 320, minZoom: EXPLICIT_FIT_MIN_ZOOM })
  }, [fitView])

  const clearFilters = useCallback(() => {
    resetFilters()
  }, [resetFilters])

  const miniMapColor = useCallback((node: KpaNode) => `var(--${node.type ?? 'key'})`, [])

  const offline = connection === 'closed' && !ready

  return (
    <div className="kpa-canvas">
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
        isValidConnection={isValidConnection}
        onEdgeClick={onEdgeClick}
        onEdgesDelete={onEdgesDelete}
        onNodesDelete={onNodesDelete}
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
          <Button
            size="sm"
            variant={layoutStale ? 'primary' : 'subtle'}
            icon={<LayoutGrid size={12} />}
            onClick={handleAutoLayout}
            title="按列重新排布所有节点"
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

      {ready && derived.nodes.length === 0 ? (
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
