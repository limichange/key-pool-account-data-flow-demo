import type {
  AccountType,
  EntityKind,
  HealthStatus,
  Provider,
  RateLimit,
  RoutingStrategy,
} from './types.js'

export const METRICS_HISTORY_SIZE = 40
/** Ring-buffer length of `EdgeMetrics.history`, one bucket per simulated second. */
export const EDGE_HISTORY_SIZE = 24
export const TIMELINE_SIZE = 60
export const TRACE_BUFFER_SIZE = 200
/** Simulation tick in ms. */
export const TICK_MS = 250

/** Rate limit a freshly created key starts with, in requests per minute. */
export const DEFAULT_KEY_RPM = 60

export const KIND_LABEL: Record<EntityKind, string> = {
  gateway: 'Gateway',
  key: 'API Key',
  pool: 'Pool',
  account: 'Account',
  proxy: 'Proxy',
}

export const KIND_LABEL_CN: Record<EntityKind, string> = {
  gateway: '网关',
  key: '密钥',
  pool: '池',
  account: '账号',
  proxy: '代理',
}

/** Left-to-right column order on the canvas. */
export const KIND_ORDER: EntityKind[] = ['gateway', 'key', 'pool', 'account', 'proxy']

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

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  k12: 'K12',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
}

export const ACCOUNT_TYPE_LABEL_CN: Record<AccountType, string> = {
  k12: '教育版',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
}

/**
 * Plan-type DEFAULTS applied when an account is created and when the operator
 * explicitly switches the type in the inspector. They are a believable ladder:
 * prolite lowest rpm/concurrency/quota with a restricted model list, plus in
 * the middle, pro the highest, and k12 a school seat — a large token quota but
 * a restricted model list and a modest rpm (lots of tokens, few parallel
 * users).
 *
 * The per-entity rateLimit/quota stay AUTHORITATIVE for the simulator: the
 * type only drives defaults and classification, never a hidden multiplier.
 */
export const ACCOUNT_TYPE_PRESETS: Record<
  AccountType,
  { rateLimit: RateLimit; quotaTokens: number; models: string[] }
> = {
  prolite: {
    rateLimit: { rpm: 60, concurrency: 8 },
    quotaTokens: 2_000_000,
    models: ['claude-sonnet-5'],
  },
  plus: {
    rateLimit: { rpm: 180, concurrency: 24 },
    quotaTokens: 8_000_000,
    models: ['claude-sonnet-5', 'claude-opus-4-8'],
  },
  pro: {
    rateLimit: { rpm: 420, concurrency: 60 },
    quotaTokens: 24_000_000,
    models: ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5'],
  },
  k12: {
    rateLimit: { rpm: 120, concurrency: 16 },
    quotaTokens: 16_000_000,
    models: ['claude-sonnet-5'],
  },
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
 * The canvas is a layered DAG read left to right — gateway | keys | pools |
 * accounts | proxies. GATEWAY, KEY, POOL and PROXY are each exactly ONE
 * vertical column and never wrap. ACCOUNTS are the only kind allowed to be a
 * grid: each pool's accounts form one contiguous block wrapping at
 * `accountLanes` columns, blocks stacked in pool order. `layoutPositions` in
 * utils.ts is the single owner of the resulting geometry.
 *
 * Cards are information dense and therefore tall; `nodeHeight` is the slot
 * height reserved for one card (a little larger than the tallest rendering of
 * that kind so a card that grows a banner still never overlaps its neighbour).
 */
export const LAYOUT = {
  /** Horizontal gutter between two kind columns. */
  columnGap: 96,
  /** Horizontal gap between two account lanes inside the account band. */
  laneGap: 28,
  /** Vertical gap between two cards in the same column / lane. */
  rowGap: 44,
  /**
   * Lanes of the ACCOUNT grid — the only kind that wraps (16 tall cards in one
   * column would be absurd). Three lanes keep every seed pool block a single
   * row (the pools own 3/3/3/2/2/2 accounts), which keeps the account band
   * roughly as tall as the other columns; that vertical compression is what
   * lets the pool/key/proxy barycentre alignment render the edges as
   * near-horizontal flows instead of long diagonals.
   */
  accountLanes: 3,
  /** Vertical gap between two per-pool account blocks (~rowGap * 1.5). */
  blockGap: 66,
  /** Vertical clearance between the live graph and the detached parking area. */
  detachedGap: 120,
  topY: 0,
  nodeWidth: { gateway: 360, key: 300, pool: 320, account: 320, proxy: 300 } as Record<
    EntityKind,
    number
  >,
  /**
   * One slot height for every kind: the four chain cards share a fixed
   * five-slot template, so a row of cards must line up across the bands. The
   * gateway hero card is shorter and there is only one of it, so it gets its
   * own slot height.
   */
  nodeHeight: { gateway: 360, key: 400, pool: 400, account: 400, proxy: 400 } as Record<
    EntityKind,
    number
  >,
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
