/**
 * Application shell: the CSS grid that hosts every panel, the websocket
 * lifecycle, the global keyboard shortcuts and a render-error safety net.
 */
import { Component, useCallback, useEffect } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { AlertTriangle, RotateCcw, X } from 'lucide-react'

import { FlowCanvas } from '@/canvas/FlowCanvas'
import { Inspector, LogToasts, Palette, TopBar, TraceLog } from '@/panels'
import { useConsole } from '@/lib/store'

/* -------------------------------------------------------- error boundary -- */

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/** Keeps a render crash inside one readable panel instead of a blank screen. */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[kpa] 界面渲染异常', error, info.componentStack)
  }

  private readonly handleReload = (): void => {
    window.location.reload()
  }

  private readonly handleDismiss = (): void => {
    this.setState({ error: null })
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="kpa-crash">
        <div className="kpa-crash__card">
          <div className="kpa-crash__head">
            <AlertTriangle size={18} />
            <h1 className="kpa-crash__title">操作台渲染失败</h1>
          </div>
          <p className="kpa-crash__text">
            界面在渲染时抛出了一个异常，为了避免整页白屏，这里保留了错误现场。
            数据仍在后台模拟器中运行，刷新页面即可重新连接。
          </p>
          <pre className="kpa-crash__stack">{error.stack ?? error.message}</pre>
          <div className="kpa-crash__actions">
            <button type="button" className="kpa-crash__btn" data-variant="primary" onClick={this.handleReload}>
              <RotateCcw size={13} />
              重新加载页面
            </button>
            <button type="button" className="kpa-crash__btn" onClick={this.handleDismiss}>
              尝试继续
            </button>
          </div>
        </div>
      </div>
    )
  }
}

/* ------------------------------------------------------------ shortcuts -- */

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (EDITABLE_TAGS.has(target.tagName)) return true
  return target.isContentEditable
}

/**
 * Space toggles the simulator, `i` injects a burst, `l` folds the trace log,
 * `m` toggles the mini map and Escape drops the selection plus the traced path.
 */
function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return

      const store = useConsole.getState()

      switch (event.key) {
        case ' ':
        case 'Spacebar': {
          // Let a focused button keep its native activation.
          if (event.target instanceof HTMLElement && event.target.closest('button')) return
          event.preventDefault()
          void store.setSim({ running: !store.config.running })
          break
        }
        case 'i':
        case 'I':
          event.preventDefault()
          void store.inject(undefined, 5)
          break
        case 'l':
        case 'L':
          event.preventDefault()
          store.toggleLog()
          break
        case 'm':
        case 'M':
          event.preventDefault()
          store.toggleMiniMap()
          break
        case 'Escape':
          store.select(null)
          store.setActiveTrace(null)
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

/* ----------------------------------------------------------------- shell -- */

export function App(): JSX.Element {
  const logCollapsed = useConsole((s) => s.logCollapsed)
  const selectedId = useConsole((s) => s.selectedId)
  const select = useConsole((s) => s.select)

  // One socket for the whole app; the store refcounts it so StrictMode is safe.
  useEffect(() => useConsole.getState().connect(), [])

  useGlobalShortcuts()

  const closeInspector = useCallback(() => {
    select(null)
  }, [select])

  return (
    <ErrorBoundary>
      <div className="kpa-app" data-log={logCollapsed ? 'collapsed' : 'open'}>
        <TopBar />

        <div className="kpa-app__main">
          <Palette />
          <FlowCanvas />
          <div className="kpa-app__inspector" data-open={selectedId ? 'true' : 'false'}>
            <button
              type="button"
              className="kpa-app__drawer-close"
              onClick={closeInspector}
              aria-label="关闭详情面板"
              title="关闭详情面板"
            >
              <X size={14} />
            </button>
            <Inspector />
          </div>
        </div>

        <TraceLog />
        <LogToasts />
      </div>
    </ErrorBoundary>
  )
}
