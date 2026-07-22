/**
 * Domain model for the Gateway -> Key -> Pool -> Account -> Proxy console.
 *
 * The chain models a typical LLM API gateway:
 *   client --> Gateway --(api key)--> Key --(binding)--> Pool --(routing)--> Account --(egress)--> Proxy --> upstream
 */

export type EntityKind = 'gateway' | 'key' | 'pool' | 'account' | 'proxy'

export const ENTITY_KINDS: EntityKind[] = ['gateway', 'key', 'pool', 'account', 'proxy']

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

/* -------------------------------------------------------------- gateway -- */

/**
 * The single entry node in front of every key — where ALL client traffic
 * enters, and the graph read-out of TOTAL traffic. It is a SINGLETON:
 * exactly one exists (`GraphState.gateway`), it can never be created or
 * deleted, only PATCHed. The gateway->key edges are system-owned and implicit
 * (every key hangs off the gateway); they are not user-editable.
 */
export interface GatewayEntity extends BaseEntity {
  kind: 'gateway'
  /** Public base URL clients call, e.g. https://gw.limi.dev/v1 */
  endpoint: string
  /** Global admission control in front of every key. 0 = unlimited (the default). */
  rateLimit: RateLimit
  /** Build/version string shown on the card. */
  version: string
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

/**
 * ============================ CARDINALITY ============================
 * The four relations of the chain have a fixed, enforced cardinality:
 *
 *   Key     <-> Pool       MANY-TO-MANY  one key binds several pools;
 *                                        one pool is bound by several keys.
 *                                        Stored on `KeyEntity.bindings`.
 *
 *   Pool     -> Account    ONE-TO-MANY   a pool owns several accounts, but
 *                                        AN ACCOUNT BELONGS TO AT MOST ONE POOL.
 *                                        Stored on `PoolEntity.members`, which
 *                                        is the SINGLE SOURCE OF TRUTH.
 *
 *   Account  -> Proxy      MANY-TO-ONE   an account has at most one proxy;
 *                                        a proxy may serve several accounts.
 *                                        Stored on `AccountEntity.proxyId`.
 *
 * THE INVARIANT: for every AccountEntity `a`, the number of PoolEntity `p`
 * with `p.members.some(m => m.accountId === a.id)` is 0 or 1. Zero is a legal,
 * meaningful state — an "unassigned" (未分配) account that receives no traffic.
 * The server enforces this on every mutating path (see `GraphStore`).
 * =====================================================================
 */

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
  /**
   * The pool's accounts, in routing order. AUTHORITATIVE for the Pool -> Account
   * relation: `AccountEntity.poolId` is only a cached back-reference derived
   * from these arrays. An accountId may appear in at most one pool's `members`
   * across the whole graph.
   */
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

/**
 * Subscription plan of an upstream account — the thing that determines how
 * much traffic it can absorb. The plan drives creation DEFAULTS and classification
 * (see `ACCOUNT_TYPE_PRESETS` in constants.ts); the per-entity
 * rateLimit/quota stay authoritative for the simulator. It is never a hidden
 * multiplier.
 */
export type AccountType = 'k12' | 'plus' | 'pro' | 'prolite'

export const ACCOUNT_TYPES: AccountType[] = ['k12', 'plus', 'pro', 'prolite']

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

/**
 * An upstream credential. See the CARDINALITY block above `PoolEntity`:
 * an account belongs to AT MOST ONE pool and has AT MOST ONE proxy.
 */
export interface AccountEntity extends BaseEntity {
  kind: 'account'
  /**
   * Owning pool, or `null` when the account is unassigned (未分配) and receives
   * no traffic.
   *
   * DERIVED, never authoritative: it is recomputed from `PoolEntity.members` by
   * `GraphStore.syncAccountPoolRefs()` after every mutation that can touch
   * membership. Nothing else may write it — in particular
   * `PATCH /api/entities/account/:id` ignores a client-supplied `poolId`;
   * membership changes only through bind/unbind or a pool `members` patch.
   */
  poolId: string | null
  provider: Provider
  /** Subscription plan; drives defaults and classification, never a hidden multiplier. */
  accountType: AccountType
  credentialType: CredentialType
  /** Masked credential, e.g. `sk-ant-api03-****9c1d`. */
  credentialMask: string
  region: string
  /**
   * Egress proxy binding. `null` means 未配置代理 — a PARKED account. Egress is
   * configured BEFORE an account may serve: a proxy-less account can never
   * join a pool (see `canJoinPool` in utils.ts), so it receives no traffic.
   */
  proxyId: string | null
  /**
   * SERVER-OWNED feature marker: the id of the proxy whose disable cascade
   * auto-disabled this account, or null. Never client-patchable. Cleared when
   * the operator toggles the account manually, when the account leaves its
   * pool, and when it is bound to a different proxy — so re-enabling the proxy
   * never resurrects an account the operator switched off by hand.
   */
  autoDisabledBy: string | null
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
  /**
   * `host`/`port` are the proxy ENDPOINT you dial. They are NOT the egress
   * address: what the upstream provider sees is `ip` below. Conflating the two
   * is the bug the `ip` field exists to prevent.
   */
  host: string
  port: number
  region: string
  countryCode: string
  /** Egress IP as the upstream sees it — the thing that gets a provider account flagged. */
  ip: string
  /** Chinese country/region name matching `countryCode`, e.g. "美国" / "新加坡" / "德国". */
  country: string
  /** Optional label such as `residential` / `datacenter`. */
  poolType: 'residential' | 'datacenter' | 'mobile'
  maxConcurrency: number
  health: ProxyHealth
  /** Intrinsic reliability 0..1 used by the simulator. */
  reliability: number
  baseLatencyMs: number
}

export type Entity = GatewayEntity | KeyEntity | PoolEntity | AccountEntity | ProxyEntity

/** Narrow an entity by kind. */
export type EntityOf<K extends EntityKind> = K extends 'gateway'
  ? GatewayEntity
  : K extends 'key'
    ? KeyEntity
    : K extends 'pool'
      ? PoolEntity
      : K extends 'account'
        ? AccountEntity
        : ProxyEntity

/* ---------------------------------------------------------------- graph -- */

export interface GraphState {
  /** SINGLETON entry node in front of every key. Not creatable, not deletable. */
  gateway: GatewayEntity
  keys: KeyEntity[]
  pools: PoolEntity[]
  accounts: AccountEntity[]
  proxies: ProxyEntity[]
  updatedAt: number
}

/* --------------------------------------------------------- edge metrics -- */

/**
 * Rolling traffic counters kept per RELATION of the graph, keyed by the same
 * `edgeId(sourceId, targetId)` the React Flow edge uses. The server derives
 * the full edge list from the graph itself (gateway->key, key.bindings,
 * pool.members, pool.failoverPoolId, account.proxyId), so a relation with no
 * traffic yet still reports zeroes and dies the moment the relation does.
 */
export interface EdgeMetrics {
  /** edgeId(sourceId, targetId) - the same id the React Flow edge uses. */
  id: string
  sourceId: string
  targetId: string
  sourceKind: EntityKind
  requests: number
  success: number
  failed: number
  /** Rolling requests-per-minute estimate over the last 60s. */
  rpm: number
  tokens: number
  avgLatencyMs: number
  lastAt: number | null
  /** Newest-last request counts, one bucket per simulated second. Length EDGE_HISTORY_SIZE. */
  history: number[]
}

/* -------------------------------------------------------------- tracing -- */

export type RequestOutcome =
  | 'success'
  | 'gateway-disabled'
  | 'gateway-rate-limited'
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
  'gateway-disabled',
  'gateway-rate-limited',
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
