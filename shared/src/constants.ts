import type { EntityKind, HealthStatus, Provider, RoutingStrategy } from './types.js'

export const METRICS_HISTORY_SIZE = 40
export const TIMELINE_SIZE = 60
export const TRACE_BUFFER_SIZE = 200
/** Simulation tick in ms. */
export const TICK_MS = 250

export const KIND_LABEL: Record<EntityKind, string> = {
  key: 'API Key',
  pool: 'Pool',
  account: 'Account',
  proxy: 'Proxy',
}

export const KIND_LABEL_CN: Record<EntityKind, string> = {
  key: '密钥',
  pool: '池',
  account: '账号',
  proxy: '代理',
}

/** Left-to-right column order on the canvas. */
export const KIND_ORDER: EntityKind[] = ['key', 'pool', 'account', 'proxy']

export const STATUS_LABEL: Record<HealthStatus, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  throttled: 'Throttled',
  exhausted: 'Exhausted',
  cooldown: 'Cooldown',
  disabled: 'Disabled',
  offline: 'Offline',
}

export const STATUS_LABEL_CN: Record<HealthStatus, string> = {
  healthy: '健康',
  degraded: '降级',
  throttled: '限流',
  exhausted: '配额耗尽',
  cooldown: '熔断冷却',
  disabled: '已停用',
  offline: '离线',
}

export const STRATEGY_LABEL: Record<RoutingStrategy, string> = {
  'round-robin': 'Round Robin',
  weighted: 'Weighted',
  'least-latency': 'Least Latency',
  'least-used': 'Least Used',
  'priority-failover': 'Priority Failover',
  random: 'Random',
}

export const STRATEGY_LABEL_CN: Record<RoutingStrategy, string> = {
  'round-robin': '轮询',
  weighted: '权重',
  'least-latency': '最低延迟',
  'least-used': '最少使用',
  'priority-failover': '优先级故障转移',
  random: '随机',
}

export const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  bedrock: 'AWS Bedrock',
  azure: 'Azure OpenAI',
  deepseek: 'DeepSeek',
}

export const MODELS = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'gpt-5.1',
  'gemini-3-pro',
  'deepseek-v4',
] as const

/**
 * Canvas layout geometry shared by the auto-layout helper, the seed data and
 * the server-side placement of freshly created entities.
 *
 * Cards are information dense and therefore tall; `nodeHeight` is the slot
 * height reserved for one card (a little larger than the tallest rendering of
 * that kind so a card that grows a banner still never overlaps its neighbour).
 * A kind whose column would grow past `maxRowsPerLane[kind]` wraps into extra
 * lanes inside its own band, which keeps the whole graph close to the aspect
 * ratio of the canvas instead of degenerating into one very tall strip.
 */
export const LAYOUT = {
  /** Horizontal gutter between two kind bands. */
  columnGap: 96,
  /** Horizontal gap between two lanes of the same kind. */
  laneGap: 28,
  /** Vertical gap between two cards in the same lane. */
  rowGap: 44,
  /**
   * Cards stacked in one lane before the band wraps into another lane, PER KIND.
   *
   * Accounts outnumber every other kind roughly two to one (the seed ships 16 of
   * them against 7/6/7), so they get the tallest lane: one deep account band and
   * three shallow neighbours keep the seed graph at ~3884x2620 px, i.e. an
   * aspect ratio of ~1.48 — comfortably inside the 1.3..1.9 window the canvas
   * viewport wants. Giving accounts the same shallow lane as the rest would
   * spread them over four lanes and blow the ratio past 2.0.
   */
  maxRowsPerLane: { key: 3, pool: 3, account: 6, proxy: 3 } as Record<EntityKind, number>,
  topY: 0,
  nodeWidth: { key: 300, pool: 320, account: 320, proxy: 300 } as Record<EntityKind, number>,
  /**
   * One slot height for every kind: the four cards share a fixed five-slot
   * template, so a row of cards must line up across the four bands.
   */
  nodeHeight: { key: 400, pool: 400, account: 400, proxy: 400 } as Record<EntityKind, number>,
}

/**
 * Full-scale of the upstream-latency gauge on the account card and in the
 * inspector. Both call sites must agree or the same account reads two
 * different arc fills at the same instant.
 */
export const LATENCY_SCALE_MS = 3000

/** Below this canvas zoom a node card renders its compact, readable variant. */
export const COMPACT_ZOOM = 0.5

/** Zoom the canvas opens at when `fitView` would land below it. */
export const MIN_READABLE_ZOOM = 0.65
