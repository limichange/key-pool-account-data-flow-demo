/**
 * Domain model for the Key -> Pool -> Account -> Proxy gateway console.
 *
 * The chain models a typical LLM API gateway:
 *   client --(api key)--> Key --(binding)--> Pool --(routing)--> Account --(egress)--> Proxy --> upstream
 */

export type EntityKind = 'key' | 'pool' | 'account' | 'proxy'

export const ENTITY_KINDS: EntityKind[] = ['key', 'pool', 'account', 'proxy']

/** Health / lifecycle state shared by every entity. */
export type HealthStatus =
  | 'healthy' // serving normally
  | 'degraded' // elevated latency or partial failures
  | 'throttled' // hitting its own rate limit right now
  | 'exhausted' // quota used up
  | 'cooldown' // circuit-broken after consecutive failures
  | 'disabled' // manually switched off by the operator
  | 'offline' // unreachable (proxy dead / credential invalid)

export const HEALTH_STATUSES: HealthStatus[] = [
  'healthy',
  'degraded',
  'throttled',
  'exhausted',
  'cooldown',
  'disabled',
  'offline',
]

export interface XY {
  x: number
  y: number
}

/** Rolling counters kept per entity. */
export interface Metrics {
  requests: number
  success: number
  failed: number
  rateLimited: number
  tokensIn: number
  tokensOut: number
  avgLatencyMs: number
  p95LatencyMs: number
  rpm: number
  lastUsedAt: number | null
  /** Newest-last request counts, one bucket per simulation second. Fixed length: METRICS_HISTORY_SIZE. */
  history: number[]
  /** In-flight request count, used to visualise concurrency pressure. */
  inFlight: number
}

export interface RateLimit {
  /** Requests per minute allowed. 0 means unlimited. */
  rpm: number
  /** Max concurrent in-flight requests. 0 means unlimited. */
  concurrency: number
}

export interface Quota {
  /** Token budget for the current window. 0 means unlimited. */
  limitTokens: number
  usedTokens: number
  /** Epoch ms when usedTokens resets. */
  resetAt: number
}

export interface BaseEntity {
  id: string
  kind: EntityKind
  name: string
  enabled: boolean
  status: HealthStatus
  tags: string[]
  note: string
  createdAt: number
  updatedAt: number
  /** Canvas position, persisted server-side so layout survives reloads. */
  position: XY
  metrics: Metrics
}

/* ------------------------------------------------------------------ key -- */

/** A key may fan out to several pools; lowest `priority` wins, ties broken by `weight`. */
export interface PoolBinding {
  poolId: string
  priority: number
  weight: number
}

export type KeyTier = 'free' | 'pro' | 'team' | 'enterprise'

export interface KeyEntity extends BaseEntity {
  kind: 'key'
  /** Masked secret, e.g. `sk-limi-live-****f21a`. */
  secret: string
  owner: string
  tier: KeyTier
  rateLimit: RateLimit
  quota: Quota
  bindings: PoolBinding[]
  /** Models this key is allowed to call. Empty = all. */
  allowedModels: string[]
  /** Relative share of generated traffic in the simulator (1 = baseline). */
  trafficWeight: number
  expiresAt: number | null
}

/* ----------------------------------------------------------------- pool -- */

export type RoutingStrategy =
  | 'round-robin'
  | 'weighted'
  | 'least-latency'
  | 'least-used'
  | 'priority-failover'
  | 'random'

export const ROUTING_STRATEGIES: RoutingStrategy[] = [
  'round-robin',
  'weighted',
  'least-latency',
  'least-used',
  'priority-failover',
  'random',
]

export interface PoolMember {
  accountId: string
  weight: number
  priority: number
  enabled: boolean
}

export interface PoolEntity extends BaseEntity {
  kind: 'pool'
  strategy: RoutingStrategy
  members: PoolMember[]
  /** Route a session to the same account when possible. */
  stickySession: boolean
  /** Max retries against sibling accounts before the request fails. */
  maxRetries: number
  maxConcurrency: number
  /** Spill over to this pool when every member is unavailable. */
  failoverPoolId: string | null
  /** Round-robin cursor (server-owned, surfaced for the inspector). */
  cursor: number
}

/* -------------------------------------------------------------- account -- */

export type Provider = 'anthropic' | 'openai' | 'gemini' | 'bedrock' | 'azure' | 'deepseek'

export const PROVIDERS: Provider[] = ['anthropic', 'openai', 'gemini', 'bedrock', 'azure', 'deepseek']

export type CredentialType = 'api-key' | 'oauth' | 'session'

export interface AccountHealth {
  latencyMs: number
  errorRate: number
  consecutiveFailures: number
  /** Epoch ms; while in the future the account is circuit-broken. */
  cooldownUntil: number | null
  lastErrorAt: number | null
  lastError: string | null
}

export interface AccountEntity extends BaseEntity {
  kind: 'account'
  provider: Provider
  credentialType: CredentialType
  /** Masked credential, e.g. `sk-ant-api03-****9c1d`. */
  credentialMask: string
  region: string
  /** Egress proxy binding; null means direct connection. */
  proxyId: string | null
  rateLimit: RateLimit
  quota: Quota
  health: AccountHealth
  /** Intrinsic reliability 0..1 used by the simulator. */
  reliability: number
  /** Baseline upstream latency in ms used by the simulator. */
  baseLatencyMs: number
  models: string[]
}

/* ---------------------------------------------------------------- proxy -- */

export type ProxyProtocol = 'http' | 'https' | 'socks5'

export const PROXY_PROTOCOLS: ProxyProtocol[] = ['http', 'https', 'socks5']

export interface ProxyHealth {
  latencyMs: number
  alive: boolean
  packetLoss: number
  lastCheckAt: number
}

export interface ProxyEntity extends BaseEntity {
  kind: 'proxy'
  protocol: ProxyProtocol
  host: string
  port: number
  region: string
  countryCode: string
  /** Optional label such as `residential` / `datacenter`. */
  poolType: 'residential' | 'datacenter' | 'mobile'
  maxConcurrency: number
  health: ProxyHealth
  /** Intrinsic reliability 0..1 used by the simulator. */
  reliability: number
  baseLatencyMs: number
}

export type Entity = KeyEntity | PoolEntity | AccountEntity | ProxyEntity

/** Narrow an entity by kind. */
export type EntityOf<K extends EntityKind> = K extends 'key'
  ? KeyEntity
  : K extends 'pool'
    ? PoolEntity
    : K extends 'account'
      ? AccountEntity
      : ProxyEntity

/* ---------------------------------------------------------------- graph -- */

export interface GraphState {
  keys: KeyEntity[]
  pools: PoolEntity[]
  accounts: AccountEntity[]
  proxies: ProxyEntity[]
  updatedAt: number
}

/* -------------------------------------------------------------- tracing -- */

export type RequestOutcome =
  | 'success'
  | 'key-disabled'
  | 'key-rate-limited'
  | 'key-quota-exceeded'
  | 'no-pool'
  | 'pool-unavailable'
  | 'no-account'
  | 'account-rate-limited'
  | 'account-quota-exceeded'
  | 'upstream-error'
  | 'proxy-error'
  | 'timeout'

export const FAILURE_OUTCOMES: RequestOutcome[] = [
  'key-disabled',
  'key-rate-limited',
  'key-quota-exceeded',
  'no-pool',
  'pool-unavailable',
  'no-account',
  'account-rate-limited',
  'account-quota-exceeded',
  'upstream-error',
  'proxy-error',
  'timeout',
]

/** One resolved node in the request path, in traversal order. */
export interface RequestHop {
  kind: EntityKind
  id: string
  name: string
  /** Why this hop was chosen, e.g. `weighted -> 42%`. */
  reason: string
  ok: boolean
  latencyMs: number
}

export interface RequestAttempt {
  accountId: string
  accountName: string
  proxyId: string | null
  outcome: RequestOutcome
  latencyMs: number
  message: string
}

export interface RequestTrace {
  id: string
  startedAt: number
  durationMs: number
  outcome: RequestOutcome
  ok: boolean
  statusCode: number
  message: string
  model: string
  keyId: string
  keyName: string
  poolId: string | null
  accountId: string | null
  proxyId: string | null
  /** Edge ids lit up by this request, in `${source}->${target}` form. */
  edgeIds: string[]
  path: RequestHop[]
  attempts: RequestAttempt[]
  tokensIn: number
  tokensOut: number
  retries: number
}

/* ------------------------------------------------------------ simulator -- */

export interface SimConfig {
  running: boolean
  /** Target requests per second across all keys. */
  rps: number
  /** Extra failure probability injected on top of intrinsic reliability, 0..1. */
  chaos: number
  /** Multiplier applied to simulated latency. */
  latencyScale: number
  /** Enable pool-level retry/failover. */
  failoverEnabled: boolean
  /** Enable per-entity rate limiting. */
  rateLimitEnabled: boolean
}

export interface TimelinePoint {
  t: number
  ok: number
  err: number
  latencyMs: number
}

export interface GlobalStats {
  totalRequests: number
  success: number
  failed: number
  rateLimited: number
  retries: number
  avgLatencyMs: number
  p95LatencyMs: number
  rps: number
  tokensIn: number
  tokensOut: number
  startedAt: number
  /** Newest-last, one point per simulation second. */
  timeline: TimelinePoint[]
  /** Counts keyed by RequestOutcome. */
  outcomes: Record<string, number>
}
