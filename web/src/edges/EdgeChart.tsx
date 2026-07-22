import { memo } from 'react'
import clsx from 'clsx'

import {
  EDGE_HISTORY_SIZE,
  formatMs,
  formatNumber,
  formatRelativeTime,
  type EdgeMetrics,
  type EntityKind,
} from '@kpa/shared'

import { MiniBars } from '@/components'

export interface EdgeChartProps {
  /** Rolling counters for this relation; undefined until the first sync lands. */
  metrics?: EdgeMetrics
  /** The relation label merged into the chip (P1 / w3 / socks5 / 入口 / 故障转移). */
  label: string
  /** Colours the micro bars and the chip border via the kind accent. */
  sourceKind: EntityKind
  /** Bars-only variant for the mid zoom band. */
  compact: boolean
}

const EMPTY_HISTORY: number[] = new Array<number>(EDGE_HISTORY_SIZE).fill(0)

const BAR_WIDTH = 38
const BAR_HEIGHT = 14

function rateTone(rate: number): 'ok' | 'warn' | 'danger' {
  if (rate >= 0.95) return 'ok'
  if (rate >= 0.8) return 'warn'
  return 'danger'
}

/**
 * The single compact pill sitting at an edge's midpoint: relation label,
 * per-second micro bars in the SOURCE kind accent, total requests and success
 * rate — plus a hover popover with the full Chinese breakdown.
 *
 * Dumb and pure by design: everything it shows arrives through props, so it
 * can be memoised aggressively (~50 chips re-render up to 4x/second). The
 * number cells reserve width (tabular numerals + min-width) so the chip never
 * jitters as values change.
 */
function EdgeChartComponent({ metrics, label, sourceKind, compact }: EdgeChartProps): JSX.Element {
  const requests = metrics?.requests ?? 0
  const success = metrics?.success ?? 0
  const failed = metrics?.failed ?? 0
  const rate = requests > 0 ? success / requests : 1
  const idle = requests === 0
  const history = metrics?.history ?? EMPTY_HISTORY

  return (
    <div
      className={clsx('kpa-edge-chip', compact && 'kpa-edge-chip--compact', idle && 'kpa-edge-chip--idle')}
      data-kind={sourceKind}
    >
      {compact ? (
        <MiniBars
          data={history}
          width={BAR_WIDTH}
          height={12}
          tone="accent"
          className="kpa-edge-chip__bars"
        />
      ) : (
        <>
          {label ? <span className="kpa-edge-chip__label">{label}</span> : null}
          {idle ? (
            <span className="kpa-edge-chip__zero">0 请求</span>
          ) : (
            <>
              <MiniBars
                data={history}
                width={BAR_WIDTH}
                height={BAR_HEIGHT}
                tone="accent"
                className="kpa-edge-chip__bars"
              />
              <span className="kpa-edge-chip__total">{formatNumber(requests)}</span>
              <span className="kpa-edge-chip__rate" data-tone={rateTone(rate)}>
                {Math.round(rate * 100)}%
              </span>
            </>
          )}
        </>
      )}

      <div className="kpa-edge-chip__pop" role="tooltip">
        {label ? <div className="kpa-edge-chip__pop-title">{label}</div> : null}
        <div className="kpa-edge-chip__pop-row">
          <span>请求</span>
          <b>{formatNumber(requests)}</b>
        </div>
        <div className="kpa-edge-chip__pop-row">
          <span>成功</span>
          <b>{formatNumber(success)}</b>
        </div>
        <div className="kpa-edge-chip__pop-row">
          <span>失败</span>
          <b>{formatNumber(failed)}</b>
        </div>
        <div className="kpa-edge-chip__pop-row">
          <span>成功率</span>
          <b data-tone={idle ? undefined : rateTone(rate)}>{Math.round(rate * 100)}%</b>
        </div>
        <div className="kpa-edge-chip__pop-row">
          <span>RPM</span>
          <b>{formatNumber(metrics?.rpm ?? 0)}</b>
        </div>
        <div className="kpa-edge-chip__pop-row">
          <span>平均延迟</span>
          <b>{formatMs(metrics?.avgLatencyMs ?? 0)}</b>
        </div>
        <div className="kpa-edge-chip__pop-row">
          <span>Token</span>
          <b>{formatNumber(metrics?.tokens ?? 0)}</b>
        </div>
        <div className="kpa-edge-chip__pop-row">
          <span>最近使用</span>
          <b>{formatRelativeTime(metrics?.lastAt ?? null)}</b>
        </div>
      </div>
    </div>
  )
}

export const EdgeChart = memo(EdgeChartComponent)
