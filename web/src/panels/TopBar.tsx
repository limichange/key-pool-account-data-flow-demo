import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Pause, Play, RotateCcw, SlidersHorizontal, Zap } from 'lucide-react'
import { formatMs, formatNumber } from '@kpa/shared'

import { Button, IconButton, Sparkline, SliderField, StatusDot, ToggleField } from '@/components'
import { useConsole } from '@/lib/store'
import type { ConnectionState } from '@/lib/store'

const CONNECTION_TEXT: Record<ConnectionState, string> = {
  connecting: '连接中',
  open: '已连接',
  closed: '已断开',
}

const CONNECTION_STATUS = {
  connecting: 'degraded',
  open: 'healthy',
  closed: 'offline',
} as const

interface TopStatProps {
  label: string
  value: string
  unit?: string
  tone?: 'default' | 'ok' | 'warn' | 'danger'
}

function TopStat({ label, value, unit, tone = 'default' }: TopStatProps): JSX.Element {
  return (
    <div className="kpa-tb-stat" data-tone={tone}>
      <span className="kpa-tb-stat-label">{label}</span>
      <span className="kpa-tb-stat-value">
        {value}
        {unit ? <em className="kpa-tb-stat-unit">{unit}</em> : null}
      </span>
    </div>
  )
}

export function TopBar(): JSX.Element {
  const stats = useConsole((s) => s.stats)
  const config = useConsole((s) => s.config)
  const connection = useConsole((s) => s.connection)
  const setSim = useConsole((s) => s.setSim)
  const inject = useConsole((s) => s.inject)
  const reset = useConsole((s) => s.reset)

  const [tuning, setTuning] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const popoverRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!tuning) return
    const onPointer = (ev: MouseEvent) => {
      const node = popoverRef.current
      if (node && !node.contains(ev.target as Node)) setTuning(false)
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setTuning(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [tuning])

  useEffect(() => {
    if (!confirmReset) return
    const timer = window.setTimeout(() => setConfirmReset(false), 4000)
    return () => window.clearTimeout(timer)
  }, [confirmReset])

  const okSeries = useMemo(() => stats.timeline.map((p) => p.ok), [stats.timeline])

  const successRatio = stats.totalRequests > 0 ? (stats.success / stats.totalRequests) * 100 : 100
  const successTone = successRatio >= 99 ? 'ok' : successRatio >= 92 ? 'warn' : 'danger'
  const tokens = stats.tokensIn + stats.tokensOut

  const onToggleRun = useCallback(() => {
    void setSim({ running: !config.running })
  }, [config.running, setSim])

  const onInject = useCallback(() => {
    void inject(undefined, 5)
  }, [inject])

  const onReset = useCallback(() => {
    if (!confirmReset) {
      setConfirmReset(true)
      return
    }
    setConfirmReset(false)
    void reset()
  }, [confirmReset, reset])

  return (
    <header className="kpa-topbar">
      <div className="kpa-tb-brand">
        <span className="kpa-tb-mark" aria-hidden="true">
          <i data-kind="key" />
          <i data-kind="pool" />
          <i data-kind="account" />
          <i data-kind="proxy" />
        </span>
        <span className="kpa-tb-titles">
          <strong className="kpa-tb-title">Key · Pool · Account · Proxy</strong>
          <span className="kpa-tb-subtitle">网关操作台</span>
        </span>
        <span className="kpa-tb-conn" data-state={connection}>
          <StatusDot status={CONNECTION_STATUS[connection]} size={7} pulse={connection !== 'closed'} />
          {CONNECTION_TEXT[connection]}
        </span>
      </div>

      <div className="kpa-tb-stats">
        <TopStat label="请求总数" value={formatNumber(stats.totalRequests)} />
        <TopStat label="成功率" value={successRatio.toFixed(1)} unit="%" tone={successTone} />
        <TopStat label="RPS" value={stats.rps.toFixed(1)} />
        <TopStat label="p95 延迟" value={formatMs(stats.p95LatencyMs)} />
        <TopStat label="重试" value={formatNumber(stats.retries)} tone={stats.retries > 0 ? 'warn' : 'default'} />
        <TopStat label="Token 用量" value={formatNumber(tokens)} />
        <div className="kpa-tb-spark" title="每秒成功请求数">
          <Sparkline data={okSeries} width={112} height={22} tone="ok" fill />
        </div>
      </div>

      <div className="kpa-tb-actions">
        <Button
          variant={config.running ? 'subtle' : 'primary'}
          size="sm"
          icon={config.running ? <Pause size={13} /> : <Play size={13} />}
          onClick={onToggleRun}
          title={config.running ? '暂停流量模拟器 (Space)' : '开始流量模拟器 (Space)'}
        >
          {config.running ? '暂停' : '开始'}
        </Button>
        <Button variant="ghost" size="sm" icon={<Zap size={13} />} onClick={onInject} title="立即注入 5 条请求 (I)">
          注入请求
        </Button>
        <IconButton
          icon={<RotateCcw size={14} />}
          label={confirmReset ? '再次点击确认重置' : '重置演示数据'}
          tone={confirmReset ? 'danger' : 'neutral'}
          active={confirmReset}
          onClick={onReset}
          size="sm"
        />
        <div className="kpa-tb-popwrap" ref={popoverRef}>
          <IconButton
            icon={<SlidersHorizontal size={14} />}
            label="模拟器参数"
            active={tuning}
            onClick={() => setTuning((v) => !v)}
            size="sm"
          />
          {tuning ? (
            <div className="kpa-tb-popover" role="dialog" aria-label="模拟器参数">
              <div className="kpa-tb-pop-head">
                <Activity size={12} />
                模拟器参数
              </div>
              <SliderField
                label="请求速率"
                value={config.rps}
                min={0}
                max={80}
                step={1}
                format={(v) => `${v} req/s`}
                onChange={(v) => void setSim({ rps: v })}
                hint="全局目标 RPS，按密钥流量权重分配"
              />
              <SliderField
                label="故障注入"
                value={config.chaos}
                min={0}
                max={0.5}
                step={0.01}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(v) => void setSim({ chaos: v })}
                hint="在账号固有可靠性之上叠加的额外失败概率"
              />
              <SliderField
                label="延迟倍率"
                value={config.latencyScale}
                min={0.25}
                max={3}
                step={0.05}
                format={(v) => `${v.toFixed(2)}x`}
                onChange={(v) => void setSim({ latencyScale: v })}
                hint="放大或收缩全链路模拟延迟"
              />
              <ToggleField
                label="故障转移"
                value={config.failoverEnabled}
                onChange={(v) => void setSim({ failoverEnabled: v })}
                hint="池内重试与溢出到备用池"
              />
              <ToggleField
                label="限流"
                value={config.rateLimitEnabled}
                onChange={(v) => void setSim({ rateLimitEnabled: v })}
                hint="按密钥与账号的 RPM / 并发上限拦截"
              />
            </div>
          ) : null}
        </div>
      </div>
    </header>
  )
}
