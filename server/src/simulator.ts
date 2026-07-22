/**
 * Traffic simulator.
 *
 * Every tick it generates requests, walks the full
 * key -> pool -> account -> proxy -> upstream chain, records a decision trace
 * for each hop and streams patches / traces / stats to the console.
 */
import {
  METRICS_HISTORY_SIZE,
  TICK_MS,
  TIMELINE_SIZE,
  TRACE_BUFFER_SIZE,
  clamp,
  edgeId,
  isServing,
  percent,
  type AccountEntity,
  type Entity,
  type GlobalStats,
  type KeyEntity,
  type PoolEntity,
  type PoolMember,
  type ProxyEntity,
  type RequestHop,
  type RequestOutcome,
  type RequestTrace,
  type ServerEvent,
  type SimConfig,
} from '@kpa/shared'

import { rng } from './rng.js'
import { createSeedState } from './seed.js'
import { GraphStore } from './store.js'

export interface RouteResult {
  trace: RequestTrace
}

interface Candidate {
  member: PoolMember
  account: AccountEntity
  reason: string
}

interface AttemptResult {
  ok: boolean
  outcome: RequestOutcome
  message: string
  latencyMs: number
}

interface RecordInput {
  ok: boolean
  latencyMs: number
  rateLimited?: boolean
  tokensIn?: number
  tokensOut?: number
}

const STATUS_CODE: Record<RequestOutcome, number> = {
  success: 200,
  'key-disabled': 403,
  'key-rate-limited': 429,
  'key-quota-exceeded': 402,
  'no-pool': 503,
  'pool-unavailable': 503,
  'no-account': 503,
  'account-rate-limited': 429,
  'account-quota-exceeded': 402,
  'upstream-error': 502,
  'proxy-error': 503,
  timeout: 504,
}

const RETRYABLE: ReadonlySet<RequestOutcome> = new Set<RequestOutcome>([
  'account-rate-limited',
  'account-quota-exceeded',
  'upstream-error',
  'proxy-error',
  'timeout',
])

const RATE_LIMIT_OUTCOMES: ReadonlySet<RequestOutcome> = new Set<RequestOutcome>([
  'key-rate-limited',
  'account-rate-limited',
])

const DEFAULT_CONFIG: SimConfig = {
  running: true,
  rps: 7,
  chaos: 0.02,
  latencyScale: 1,
  failoverEnabled: true,
  rateLimitEnabled: true,
}

/** Upper bound of traces pushed to the socket per tick (~40/s at TICK_MS=250). */
const TRACE_EMIT_BUDGET = 10
/** Per-entity latency sample window used for the p95 estimate. */
const LATENCY_SAMPLE_SIZE = 64
/** Circuit breaker: consecutive failures before an account is cooled down. */
const BREAKER_THRESHOLD = 3
const BREAKER_COOLDOWN_MS = 8_000
const TIMEOUT_MS = 8_000
/** How long a `stickySession` pin survives before the strategy picks again. */
const STICKY_TTL_MS = 20_000
const MAX_REQUESTS_PER_TICK = 240

function createStats(now: number): GlobalStats {
  return {
    totalRequests: 0,
    success: 0,
    failed: 0,
    rateLimited: 0,
    retries: 0,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
    rps: 0,
    tokensIn: 0,
    tokensOut: 0,
    startedAt: now,
    timeline: [],
    outcomes: {},
  }
}

function p95Of(samples: number[]): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
  return Math.round(sorted[index])
}

export class Simulator {
  private readonly store: GraphStore
  private readonly emit: (event: ServerEvent) => void

  private config: SimConfig = { ...DEFAULT_CONFIG }
  private stats: GlobalStats
  private traces: RequestTrace[] = []

  private timer: ReturnType<typeof setInterval> | null = null
  private tickIndex = 0
  private pendingRequests = 0
  private lastSecondAt: number

  /** Requests counted since the previous tick, used for the rolling rpm. */
  private tickCounts = new Map<string, number>()
  /** Requests counted since the previous simulated second, used for history. */
  private secondCounts = new Map<string, number>()
  private latencySamples = new Map<string, number[]>()
  private globalLatency: number[] = []

  private secondOk = 0
  private secondErr = 0
  private secondLatencySum = 0
  private secondLatencyCount = 0

  private traceBudget = TRACE_EMIT_BUDGET
  private logMemo = new Map<string, number>()
  private proxyBlipUntil = new Map<string, number>()
  /** Entities whose latency window changed since the last p95 recomputation. */
  private p95Dirty = new Set<string>()
  /** `stickySession`: the account a given key last landed on inside a pool. */
  private sticky = new Map<string, { accountId: string; until: number }>()

  constructor(store: GraphStore, emit: (event: ServerEvent) => void) {
    this.store = store
    this.emit = emit
    const now = Date.now()
    this.stats = createStats(now)
    this.lastSecondAt = now
    this.timer = setInterval(() => {
      try {
        this.tick()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.log('error', `模拟器 tick 异常：${message}`, 'tick-error')
      }
    }, TICK_MS)
  }

  /* --------------------------------------------------------------- public -- */

  getConfig(): SimConfig {
    return this.config
  }

  getStats(): GlobalStats {
    return this.stats
  }

  getTraces(limit = 50): RequestTrace[] {
    return this.traces.slice(0, clamp(Math.round(limit), 1, TRACE_BUFFER_SIZE))
  }

  setConfig(patch: Partial<SimConfig>): SimConfig {
    const next: SimConfig = { ...this.config }
    if (typeof patch.running === 'boolean') next.running = patch.running
    if (typeof patch.rps === 'number' && Number.isFinite(patch.rps)) {
      next.rps = clamp(patch.rps, 0, 200)
    }
    if (typeof patch.chaos === 'number' && Number.isFinite(patch.chaos)) {
      next.chaos = clamp(patch.chaos, 0, 1)
    }
    if (typeof patch.latencyScale === 'number' && Number.isFinite(patch.latencyScale)) {
      next.latencyScale = clamp(patch.latencyScale, 0.1, 8)
    }
    if (typeof patch.failoverEnabled === 'boolean') next.failoverEnabled = patch.failoverEnabled
    if (typeof patch.rateLimitEnabled === 'boolean') next.rateLimitEnabled = patch.rateLimitEnabled

    const wasRunning = this.config.running
    this.config = next
    this.emit({ type: 'config', config: this.config })
    if (wasRunning !== next.running) {
      this.log('info', next.running ? '流量模拟已启动' : '流量模拟已暂停', 'sim-toggle')
    }
    return this.config
  }

  /** Fire requests on demand, bypassing the `running` switch. */
  inject(keyId?: string, count = 1, model?: string): RequestTrace[] {
    const total = clamp(Math.round(count), 1, 50)
    const out: RequestTrace[] = []
    for (let i = 0; i < total; i += 1) {
      const key = keyId ? this.store.getKey(keyId) : this.pickKey()
      if (!key) throw new Error(keyId ? `密钥不存在: ${keyId}` : '当前没有可用密钥')
      out.push(this.routeRequest(key.id, model, true).trace)
    }
    this.flush()
    return out
  }

  reset(): void {
    rng.reseed()
    this.store.replace(createSeedState())
    const now = Date.now()
    this.stats = createStats(now)
    this.traces = []
    this.tickCounts.clear()
    this.secondCounts.clear()
    this.latencySamples.clear()
    this.globalLatency = []
    this.logMemo.clear()
    this.proxyBlipUntil.clear()
    this.p95Dirty.clear()
    this.sticky.clear()
    this.pendingRequests = 0
    this.lastSecondAt = now
    this.secondOk = 0
    this.secondErr = 0
    this.secondLatencySum = 0
    this.secondLatencyCount = 0
    this.store.drainDirty()
    this.emit({
      type: 'snapshot',
      state: this.store.snapshot(),
      config: this.config,
      stats: this.stats,
    })
    this.log('warn', '演示环境已重置为初始拓扑', 'reset')
  }

  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Drop every per-entity bookkeeping entry for a deleted id. `GraphStore`
   * cannot do this for us — it has no hook into the simulator — so the delete
   * route calls it, otherwise each removed account leaks a 64-sample latency
   * window plus a handful of log-memo keys for the life of the process.
   */
  forget(id: string): void {
    this.latencySamples.delete(id)
    this.tickCounts.delete(id)
    this.secondCounts.delete(id)
    this.proxyBlipUntil.delete(id)
    this.p95Dirty.delete(id)
    const suffix = `:${id}`
    for (const key of this.logMemo.keys()) {
      if (key.endsWith(suffix)) this.logMemo.delete(key)
    }
    for (const [key, pin] of this.sticky) {
      if (pin.accountId === id || key.endsWith(suffix)) this.sticky.delete(key)
    }
  }

  /* ----------------------------------------------------------------- tick -- */

  private tick(): void {
    const now = Date.now()
    this.tickIndex += 1
    this.traceBudget = TRACE_EMIT_BUDGET

    this.store.resetQuotaWindows(now)
    this.expireCooldowns(now)
    if (this.tickIndex % 4 === 0) this.jitterHealth(now)

    if (this.config.running) this.generateTraffic(now)

    this.rollWindows(now)
    this.store.refreshStatuses(now)
    this.flush()
    this.emit({ type: 'stats', stats: this.stats })
  }

  private flush(): void {
    const entities = this.store.drainDirty()
    if (entities.length > 0) this.emit({ type: 'patch', entities })
  }

  private generateTraffic(now: number): void {
    this.pendingRequests += this.config.rps * (TICK_MS / 1000)
    let planned = Math.floor(this.pendingRequests)
    this.pendingRequests -= planned
    if (planned > 0) {
      // Poisson-ish burstiness so the stream never looks metronomic.
      planned = Math.round(clamp(rng.gaussian(planned, Math.sqrt(planned)), 0, planned * 3))
    }
    planned = Math.min(planned, MAX_REQUESTS_PER_TICK)

    for (let i = 0; i < planned; i += 1) {
      const key = this.pickKey()
      if (!key) return
      this.routeRequest(key.id, undefined, false, now)
    }
  }

  private pickKey(): KeyEntity | undefined {
    const keys = this.store.keys().filter((key) => key.enabled)
    if (keys.length === 0) return undefined
    return rng.weightedPick(keys, (key) => Math.max(0.01, key.trafficWeight))
  }

  private expireCooldowns(now: number): void {
    for (const account of this.store.accounts()) {
      const until = account.health.cooldownUntil
      if (until !== null && until <= now) {
        account.health.cooldownUntil = null
        account.health.consecutiveFailures = 0
        account.updatedAt = now
        this.store.markDirty(account)
        this.log('info', `账号「${account.name}」熔断恢复，重新加入调度`, `recover:${account.id}`)
      }
    }
  }

  /** Latency wander plus the occasional proxy blip, so the board keeps breathing. */
  private jitterHealth(now: number): void {
    for (const proxy of this.store.proxies()) {
      if (!proxy.enabled) continue
      const blipUntil = this.proxyBlipUntil.get(proxy.id)
      if (blipUntil !== undefined) {
        if (now >= blipUntil) {
          this.proxyBlipUntil.delete(proxy.id)
          proxy.health.alive = true
          proxy.health.packetLoss = clamp(proxy.health.packetLoss, 0, 0.05)
          proxy.health.lastCheckAt = now
          proxy.updatedAt = now
          this.store.markDirty(proxy)
          this.log('info', `代理「${proxy.name}」恢复在线`, `proxy-up:${proxy.id}`)
        }
        continue
      }
      if (!proxy.health.alive) continue

      const target = proxy.baseLatencyMs * rng.nextRange(0.82, 1.45)
      proxy.health.latencyMs = clamp(
        proxy.health.latencyMs * 0.75 + target * 0.25,
        proxy.baseLatencyMs * 0.5,
        proxy.baseLatencyMs * 4,
      )
      proxy.health.lastCheckAt = now
      this.store.markDirty(proxy)

      if (rng.chance(0.004)) {
        proxy.health.alive = false
        proxy.health.packetLoss = 1
        proxy.updatedAt = now
        this.proxyBlipUntil.set(proxy.id, now + rng.nextInt(5_000, 13_000))
        this.log('warn', `代理「${proxy.name}」健康检查失败，暂时摘除`, `proxy-down:${proxy.id}`)
      }
    }

    for (const account of this.store.accounts()) {
      const target = account.baseLatencyMs * rng.nextRange(0.9, 1.2)
      account.health.latencyMs = clamp(
        account.health.latencyMs * 0.88 + target * 0.12,
        account.baseLatencyMs * 0.5,
        account.baseLatencyMs * 5,
      )
      this.store.markDirty(account)
    }
  }

  /** Rolling rpm / in-flight / history buckets / global timeline. */
  private rollWindows(now: number): void {
    const perMinute = (60_000 / TICK_MS) * 0.15
    for (const entity of this.store.all()) {
      const seen = this.tickCounts.get(entity.id) ?? 0
      const metrics = entity.metrics
      const nextRpm = metrics.rpm * 0.85 + seen * perMinute
      const rpm = nextRpm < 0.05 ? 0 : Math.round(nextRpm * 10) / 10
      const inFlight = Math.round((rpm / 60) * (metrics.avgLatencyMs / 1000))
      if (rpm !== metrics.rpm || inFlight !== metrics.inFlight) {
        metrics.rpm = rpm
        metrics.inFlight = clamp(inFlight, 0, 9999)
        this.store.markDirty(entity)
      }
    }
    this.tickCounts.clear()

    // p95 is a sort over a 64-sample window: doing that inside `record` meant
    // ~400 copies+sorts per second at rps 80 for a figure nobody can read
    // faster than the tick anyway.
    if (this.p95Dirty.size > 0) {
      for (const id of this.p95Dirty) {
        const entity = this.store.get(id)
        if (!entity) continue
        const next = p95Of(this.latencySamples.get(id) ?? [])
        if (next !== entity.metrics.p95LatencyMs) {
          entity.metrics.p95LatencyMs = next
          this.store.markDirty(entity)
        }
      }
      this.p95Dirty.clear()
    }

    if (now - this.lastSecondAt < 1000) return
    this.lastSecondAt = now

    for (const entity of this.store.all()) {
      const bucket = this.secondCounts.get(entity.id) ?? 0
      const history = entity.metrics.history
      const dropped = history.shift() ?? 0
      history.push(bucket)
      while (history.length < METRICS_HISTORY_SIZE) history.unshift(0)
      if (bucket > 0 || dropped > 0) this.store.markDirty(entity)
    }
    this.secondCounts.clear()

    const latency =
      this.secondLatencyCount > 0 ? Math.round(this.secondLatencySum / this.secondLatencyCount) : 0
    this.stats.timeline.push({ t: now, ok: this.secondOk, err: this.secondErr, latencyMs: latency })
    while (this.stats.timeline.length > TIMELINE_SIZE) this.stats.timeline.shift()
    this.stats.rps = Math.round((this.secondOk + this.secondErr) * 10) / 10
    this.secondOk = 0
    this.secondErr = 0
    this.secondLatencySum = 0
    this.secondLatencyCount = 0
  }

  /* -------------------------------------------------------------- routing -- */

  routeRequest(keyId: string, model?: string, forceEmit = false, at?: number): RouteResult {
    const now = at ?? Date.now()
    const key = this.store.getKey(keyId)
    if (!key) throw new Error(`密钥不存在: ${keyId}`)

    const trace: RequestTrace = {
      id: rng.shortId('req'),
      startedAt: now,
      durationMs: 0,
      outcome: 'success',
      ok: true,
      statusCode: 200,
      message: '',
      model: model ?? this.pickModel(key),
      keyId: key.id,
      keyName: key.name,
      poolId: null,
      accountId: null,
      proxyId: null,
      edgeIds: [],
      path: [],
      attempts: [],
      tokensIn: 0,
      tokensOut: 0,
      retries: 0,
    }

    const touchedPools = new Set<PoolEntity>()
    let latencyTotal = 0

    const finish = (outcome: RequestOutcome, message: string): RouteResult => {
      trace.outcome = outcome
      trace.ok = outcome === 'success'
      trace.statusCode = STATUS_CODE[outcome]
      trace.message = message
      trace.durationMs = Math.round(latencyTotal)

      if (trace.ok) {
        key.quota.usedTokens += trace.tokensIn + trace.tokensOut
      }
      this.record(
        key,
        {
          ok: trace.ok,
          latencyMs: trace.durationMs,
          rateLimited: RATE_LIMIT_OUTCOMES.has(outcome),
          tokensIn: trace.tokensIn,
          tokensOut: trace.tokensOut,
        },
        now,
      )
      for (const pool of touchedPools) {
        this.record(
          pool,
          {
            ok: trace.ok,
            latencyMs: trace.durationMs,
            rateLimited: RATE_LIMIT_OUTCOMES.has(outcome),
            tokensIn: trace.tokensIn,
            tokensOut: trace.tokensOut,
          },
          now,
        )
      }
      this.commit(trace, forceEmit)
      return { trace }
    }

    /* -- a. key gate ------------------------------------------------------ */

    if (!key.enabled) {
      trace.path.push(hop('key', key.id, key.name, '密钥已停用', false, 0))
      return finish('key-disabled', `密钥「${key.name}」已停用`)
    }
    if (key.expiresAt !== null && key.expiresAt <= now) {
      trace.path.push(hop('key', key.id, key.name, '密钥已过期', false, 0))
      this.log('warn', `密钥「${key.name}」已过期，请求被拒绝`, `key-expired:${key.id}`)
      return finish('key-disabled', `密钥「${key.name}」已过期`)
    }
    if (this.config.rateLimitEnabled && key.rateLimit.rpm > 0 && key.metrics.rpm >= key.rateLimit.rpm) {
      trace.path.push(
        hop(
          'key',
          key.id,
          key.name,
          `RPM ${Math.round(key.metrics.rpm)}/${key.rateLimit.rpm} 触顶`,
          false,
          0,
        ),
      )
      return finish('key-rate-limited', `密钥限流：RPM 超过 ${key.rateLimit.rpm}`)
    }
    if (
      this.config.rateLimitEnabled &&
      key.rateLimit.concurrency > 0 &&
      key.metrics.inFlight >= key.rateLimit.concurrency
    ) {
      trace.path.push(
        hop(
          'key',
          key.id,
          key.name,
          `在途 ${key.metrics.inFlight}/${key.rateLimit.concurrency} 触顶`,
          false,
          0,
        ),
      )
      return finish('key-rate-limited', `密钥限流：并发超过 ${key.rateLimit.concurrency}`)
    }
    if (key.quota.limitTokens > 0 && key.quota.usedTokens >= key.quota.limitTokens) {
      trace.path.push(hop('key', key.id, key.name, '本窗口配额已耗尽', false, 0))
      this.log('warn', `密钥「${key.name}」配额耗尽，请求被拒绝`, `key-quota:${key.id}`)
      return finish('key-quota-exceeded', `密钥配额耗尽（${key.quota.limitTokens} tokens）`)
    }
    trace.path.push(
      hop(
        'key',
        key.id,
        key.name,
        `校验通过 · RPM ${Math.round(key.metrics.rpm)}/${key.rateLimit.rpm || '∞'} · 配额 ${Math.round(
          percent(key.quota.usedTokens, key.quota.limitTokens),
        )}%`,
        true,
        0,
      ),
    )

    /* -- b. pool selection ------------------------------------------------ */

    const bindings = [...key.bindings].sort(
      (a, b) => a.priority - b.priority || b.weight - a.weight,
    )
    const resolved = bindings
      .map((binding) => ({ binding, pool: this.store.getPool(binding.poolId) }))
      .filter((item): item is { binding: (typeof bindings)[number]; pool: PoolEntity } => !!item.pool)

    if (resolved.length === 0) {
      return finish('no-pool', `密钥「${key.name}」没有绑定任何池`)
    }

    const chosenIndex = resolved.findIndex((item) => this.isPoolAvailable(item.pool))

    let pool: PoolEntity
    let usedFailover = false

    if (chosenIndex >= 0) {
      pool = resolved[chosenIndex].pool
      const poolReason =
        chosenIndex === 0
          ? `优先级 ${resolved[0].binding.priority} 命中`
          : `优先级 ${resolved[chosenIndex].binding.priority} 接管（前 ${chosenIndex} 个池不可用）`
      trace.path.push(hop('pool', pool.id, pool.name, poolReason, true, 0))
      addEdge(trace, key.id, pool.id)
    } else {
      // Every bound pool is down: try a configured spill-over target first.
      const spill = this.config.failoverEnabled
        ? resolved
            .map((item) => ({ from: item.pool, to: this.store.getPool(item.pool.failoverPoolId) }))
            .find((item) => !!item.to && this.isPoolAvailable(item.to))
        : undefined

      if (!spill || !spill.to) {
        const names = resolved.map((item) => item.pool.name).join('、')
        this.log('error', `密钥「${key.name}」的全部绑定池不可用：${names}`, `pool-down:${key.id}`)
        return finish('pool-unavailable', `绑定的池全部不可用（${names}）`)
      }

      usedFailover = true
      pool = spill.to
      trace.path.push(hop('pool', spill.from.id, spill.from.name, '池内无可用账号', false, 0))
      addEdge(trace, key.id, spill.from.id)
      touchedPools.add(spill.from)
      trace.path.push(hop('pool', pool.id, pool.name, '溢出到备用池', true, 0))
      // Without this hop the highlighted path is two disconnected arrows: one
      // into the dead pool and one out of the backup, with nothing joining them.
      addEdge(trace, spill.from.id, pool.id)
      this.log('warn', `「${pool.name}」接管「${spill.from.name}」的溢出流量`, `spill:${pool.id}`)
    }

    trace.poolId = pool.id
    touchedPools.add(pool)

    /* -- c..h. account selection, attempts, retries ----------------------- */

    const tried = new Set<string>()
    let last: AttemptResult | null = null

    for (let attempt = 0; ; attempt += 1) {
      const candidate = this.selectAccount(pool, key.id, tried, now)

      if (!candidate) {
        if (!usedFailover && this.config.failoverEnabled && pool.failoverPoolId) {
          const backup = this.store.getPool(pool.failoverPoolId)
          if (backup && this.isPoolAvailable(backup)) {
            usedFailover = true
            const previousPoolId = pool.id
            pool = backup
            trace.poolId = backup.id
            touchedPools.add(backup)
            trace.path.push(hop('pool', backup.id, backup.name, '溢出到备用池', true, 0))
            // Keep the highlighted path connected across the failover hop.
            addEdge(trace, previousPoolId, backup.id)
            this.log('warn', `「${pool.name}」接管溢出流量（主池无可用账号）`, `failover:${backup.id}`)
            tried.clear()
            continue
          }
        }
        if (last) return finish(last.outcome, last.message)
        return finish('no-account', `池「${pool.name}」内没有可用账号`)
      }

      tried.add(candidate.account.id)
      const result = this.runAttempt(trace, pool, candidate, now)
      latencyTotal += result.latencyMs
      last = result

      // Every attempt is recorded, the winning one included, so the retry list
      // is a complete per-attempt record instead of a failures-only log.
      trace.attempts.push({
        accountId: candidate.account.id,
        accountName: candidate.account.name,
        proxyId: candidate.account.proxyId,
        outcome: result.outcome,
        latencyMs: Math.round(result.latencyMs),
        message: result.message,
      })

      if (result.ok) {
        if (pool.stickySession) {
          this.sticky.set(stickyKey(pool.id, key.id), {
            accountId: candidate.account.id,
            until: now + STICKY_TTL_MS,
          })
        }
        return finish('success', `成功 · ${trace.model}`)
      }

      const canRetry =
        this.config.failoverEnabled && RETRYABLE.has(result.outcome) && attempt < pool.maxRetries
      if (!canRetry) return finish(result.outcome, result.message)
      trace.retries += 1
    }
  }

  /** A pool can take traffic when it is enabled, serving and under its ceiling. */
  private isPoolAvailable(pool: PoolEntity): boolean {
    if (!pool.enabled || !isServing(pool.status)) return false
    if (
      this.config.rateLimitEnabled &&
      pool.maxConcurrency > 0 &&
      pool.metrics.inFlight >= pool.maxConcurrency
    ) {
      return false
    }
    return true
  }

  private pickModel(key: KeyEntity): string {
    if (key.allowedModels.length > 0) return rng.pick(key.allowedModels)
    const pools = key.bindings
      .map((binding) => this.store.getPool(binding.poolId))
      .filter((pool): pool is PoolEntity => !!pool)
    const models = new Set<string>()
    for (const pool of pools) {
      for (const member of pool.members) {
        const account = this.store.getAccount(member.accountId)
        if (!account) continue
        for (const model of account.models) models.add(model)
      }
    }
    const list = [...models]
    return list.length > 0 ? rng.pick(list) : 'claude-sonnet-5'
  }

  /**
   * Whether the pool may hand this account a request *at all*.
   *
   * Deliberately does NOT check the account's own rate limit or quota: those
   * are 429/402 responses the upstream gives back, so the account has to be
   * selected first and rejected in `runAttempt`, which produces a real
   * `account-rate-limited` / `account-quota-exceeded` trace the retry loop can
   * fail over from. Filtering them out here made both outcomes unreachable.
   */
  private isAccountAvailable(account: AccountEntity, now: number): boolean {
    if (!account.enabled) return false
    if (account.status === 'offline') return false
    if (account.health.cooldownUntil !== null && account.health.cooldownUntil > now) return false
    return true
  }

  /** Apply the pool routing strategy and explain the decision in Chinese. */
  private selectAccount(
    pool: PoolEntity,
    keyId: string,
    tried: Set<string>,
    now: number,
  ): Candidate | null {
    const pairs = pool.members
      .map((member) => ({ member, account: this.store.getAccount(member.accountId) }))
      .filter((pair): pair is { member: PoolMember; account: AccountEntity } => !!pair.account)
      .filter(
        (pair) =>
          pair.member.enabled &&
          !tried.has(pair.account.id) &&
          this.isAccountAvailable(pair.account, now),
      )

    if (pairs.length === 0) return null
    const total = pairs.length

    // Session stickiness wins over the strategy while the pin is alive and the
    // pinned account is still a legal candidate. The pin expires so the pool
    // does not weld one key to one account forever — and so the pool's actual
    // strategy stays observable.
    if (pool.stickySession) {
      const pin = this.sticky.get(stickyKey(pool.id, keyId))
      if (pin && pin.until > now) {
        const found = pairs.find((pair) => pair.account.id === pin.accountId)
        if (found) return { ...found, reason: `会话粘滞命中（${found.account.name}）` }
      }
    }

    switch (pool.strategy) {
      case 'round-robin': {
        // The cursor indexes the member list, not the transiently-available
        // subset: otherwise it points at a different account every time a
        // member blips and the card reads "2/2" for a three-member pool.
        const members = pool.members
        const start = members.length > 0 ? pool.cursor % members.length : 0
        let picked = pairs[0]
        let pickedIndex = members.findIndex((m) => m.accountId === picked.account.id)
        for (let step = 0; step < members.length; step += 1) {
          const index = (start + step) % members.length
          const match = pairs.find((pair) => pair.account.id === members[index].accountId)
          if (match) {
            picked = match
            pickedIndex = index
            break
          }
        }
        pool.cursor = members.length > 0 ? (pickedIndex + 1) % members.length : 0
        this.store.markDirty(pool)
        return {
          ...picked,
          reason: `轮询游标 ${start} -> ${pool.cursor}（成员 ${pickedIndex + 1}/${members.length}）`,
        }
      }
      case 'weighted': {
        const sum = pairs.reduce((acc, pair) => acc + Math.max(0, pair.member.weight), 0)
        const picked =
          rng.weightedPick(pairs, (pair) => Math.max(0, pair.member.weight)) ?? pairs[0]
        const share = sum > 0 ? Math.round((Math.max(0, picked.member.weight) / sum) * 100) : 100
        return { ...picked, reason: `权重 ${share}% 命中（${picked.member.weight}/${sum}）` }
      }
      case 'least-latency': {
        const picked = pairs.reduce((best, pair) =>
          pair.account.health.latencyMs < best.account.health.latencyMs ? pair : best,
        )
        return { ...picked, reason: `延迟最低 ${Math.round(picked.account.health.latencyMs)}ms` }
      }
      case 'least-used': {
        const picked = pairs.reduce((best, pair) =>
          pair.account.metrics.requests < best.account.metrics.requests ? pair : best,
        )
        return { ...picked, reason: `最少使用（${picked.account.metrics.requests} 次）` }
      }
      case 'priority-failover': {
        const picked = pairs.reduce((best, pair) =>
          pair.member.priority < best.member.priority ? pair : best,
        )
        const skipped = pool.members.filter((member) => member.priority < picked.member.priority)
        const reason =
          skipped.length > 0
            ? `优先级 ${picked.member.priority} 接管（跳过 ${skipped.length} 个更高优先级）`
            : `优先级 ${picked.member.priority} 命中`
        return { ...picked, reason }
      }
      case 'random': {
        const index = rng.nextInt(0, total - 1)
        const picked = pairs[index]
        return { ...picked, reason: `随机命中 ${index + 1}/${total}` }
      }
    }
  }

  /** One end-to-end attempt against a single account (proxy hop included). */
  private runAttempt(
    trace: RequestTrace,
    pool: PoolEntity,
    candidate: Candidate,
    now: number,
  ): AttemptResult {
    const { account, reason } = candidate
    trace.accountId = account.id
    addEdge(trace, pool.id, account.id)

    /* -- d. account gate -------------------------------------------------- */

    if (
      this.config.rateLimitEnabled &&
      account.rateLimit.rpm > 0 &&
      account.metrics.rpm >= account.rateLimit.rpm
    ) {
      trace.path.push(
        hop(
          'account',
          account.id,
          account.name,
          `${reason} · RPM ${Math.round(account.metrics.rpm)}/${account.rateLimit.rpm} 触顶`,
          false,
          0,
        ),
      )
      this.record(account, { ok: false, latencyMs: 0, rateLimited: true }, now)
      return {
        ok: false,
        outcome: 'account-rate-limited',
        message: `账号「${account.name}」限流（RPM ${account.rateLimit.rpm}）`,
        latencyMs: 0,
      }
    }

    if (
      this.config.rateLimitEnabled &&
      account.rateLimit.concurrency > 0 &&
      account.metrics.inFlight >= account.rateLimit.concurrency
    ) {
      trace.path.push(
        hop(
          'account',
          account.id,
          account.name,
          `${reason} · 在途 ${account.metrics.inFlight}/${account.rateLimit.concurrency} 触顶`,
          false,
          0,
        ),
      )
      this.record(account, { ok: false, latencyMs: 0, rateLimited: true }, now)
      return {
        ok: false,
        outcome: 'account-rate-limited',
        message: `账号「${account.name}」并发触顶（${account.rateLimit.concurrency}）`,
        latencyMs: 0,
      }
    }

    if (account.quota.limitTokens > 0 && account.quota.usedTokens >= account.quota.limitTokens) {
      trace.path.push(hop('account', account.id, account.name, `${reason} · 配额耗尽`, false, 0))
      this.record(account, { ok: false, latencyMs: 0 }, now)
      this.log('warn', `账号「${account.name}」配额耗尽，退出调度`, `acc-quota:${account.id}`)
      return {
        ok: false,
        outcome: 'account-quota-exceeded',
        message: `账号「${account.name}」配额耗尽`,
        latencyMs: 0,
      }
    }

    /* -- e. proxy hop ----------------------------------------------------- */

    let proxy: ProxyEntity | undefined
    let proxyLatency = 0

    if (account.proxyId) {
      const bound = this.store.getProxy(account.proxyId)
      trace.proxyId = bound ? bound.id : null

      if (!bound || !bound.enabled || !bound.health.alive || !isServing(bound.status)) {
        trace.path.push(hop('account', account.id, account.name, reason, true, 0))
        if (bound) {
          addEdge(trace, account.id, bound.id)
          trace.path.push(hop('proxy', bound.id, bound.name, '代理离线，无法出网', false, 0))
          this.record(bound, { ok: false, latencyMs: 0 }, now)
          this.log('error', `代理「${bound.name}」不可用，链路中断`, `proxy-err:${bound.id}`)
        }
        this.record(account, { ok: false, latencyMs: 0 }, now)
        this.failAccount(account, '代理不可达', now)
        return {
          ok: false,
          outcome: 'proxy-error',
          message: bound ? `代理「${bound.name}」离线` : '账号绑定的代理已不存在',
          latencyMs: 0,
        }
      }

      proxy = bound
      addEdge(trace, account.id, proxy.id)
      proxyLatency = proxy.health.latencyMs

      if (
        this.config.rateLimitEnabled &&
        proxy.maxConcurrency > 0 &&
        proxy.metrics.inFlight >= proxy.maxConcurrency
      ) {
        trace.path.push(hop('account', account.id, account.name, reason, true, 0))
        trace.path.push(
          hop(
            'proxy',
            proxy.id,
            proxy.name,
            `出口并发 ${proxy.metrics.inFlight}/${proxy.maxConcurrency} 触顶`,
            false,
            0,
          ),
        )
        this.record(proxy, { ok: false, latencyMs: 0 }, now)
        this.record(account, { ok: false, latencyMs: 0 }, now)
        this.log('warn', `代理「${proxy.name}」并发触顶，请求被拒绝`, `proxy-busy:${proxy.id}`)
        return {
          ok: false,
          outcome: 'proxy-error',
          message: `代理「${proxy.name}」并发触顶（${proxy.maxConcurrency}）`,
          latencyMs: 0,
        }
      }

      if (rng.chance(proxy.health.packetLoss)) {
        trace.path.push(hop('account', account.id, account.name, reason, true, 0))
        trace.path.push(
          hop(
            'proxy',
            proxy.id,
            proxy.name,
            `丢包（丢包率 ${(proxy.health.packetLoss * 100).toFixed(1)}%）`,
            false,
            Math.round(proxyLatency),
          ),
        )
        this.record(proxy, { ok: false, latencyMs: proxyLatency }, now)
        this.record(account, { ok: false, latencyMs: proxyLatency }, now)
        this.failAccount(account, '代理丢包', now)
        return {
          ok: false,
          outcome: 'proxy-error',
          message: `代理「${proxy.name}」丢包，请求未送达`,
          latencyMs: proxyLatency,
        }
      }
    } else {
      trace.proxyId = null
    }

    /* -- f. upstream call -------------------------------------------------- */

    const jitter = clamp(rng.gaussian(1, 0.22), 0.45, 3.4)
    const latency = Math.max(
      30,
      (account.baseLatencyMs + proxyLatency) * this.config.latencyScale * jitter,
    )
    const timedOut = latency > TIMEOUT_MS
    const successProbability = clamp(
      account.reliability * (proxy ? proxy.reliability : 1) - this.config.chaos,
      0,
      1,
    )
    const ok = !timedOut && rng.chance(successProbability)

    if (ok) {
      /* -- h. token accounting -------------------------------------------- */
      const tokensIn = rng.nextInt(200, 4000)
      const tokensOut = rng.nextInt(100, 2000)
      trace.tokensIn = tokensIn
      trace.tokensOut = tokensOut
      account.quota.usedTokens += tokensIn + tokensOut

      account.health.consecutiveFailures = 0
      account.health.latencyMs = account.health.latencyMs * 0.8 + latency * 0.2
      account.health.errorRate = account.health.errorRate * 0.9
      this.store.markDirty(account)

      trace.path.push(
        hop('account', account.id, account.name, reason, true, Math.round(latency - proxyLatency)),
      )
      this.record(account, { ok: true, latencyMs: latency, tokensIn, tokensOut }, now)

      if (proxy) {
        proxy.health.latencyMs = proxy.health.latencyMs * 0.9 + proxyLatency * 0.1
        trace.path.push(
          hop(
            'proxy',
            proxy.id,
            proxy.name,
            `${proxy.protocol.toUpperCase()} · ${proxy.countryCode} · +${Math.round(proxyLatency)}ms`,
            true,
            Math.round(proxyLatency),
          ),
        )
        this.record(proxy, { ok: true, latencyMs: proxyLatency, tokensIn, tokensOut }, now)
      }

      return { ok: true, outcome: 'success', message: '上游返回 200', latencyMs: latency }
    }

    const outcome: RequestOutcome = timedOut ? 'timeout' : 'upstream-error'
    const message = timedOut
      ? `上游超时（${Math.round(latency)}ms > ${TIMEOUT_MS}ms）`
      : `上游错误 · ${account.provider} 返回 5xx`

    trace.path.push(
      hop(
        'account',
        account.id,
        account.name,
        `${reason} · ${timedOut ? '超时' : '上游错误'}`,
        false,
        Math.round(latency - proxyLatency),
      ),
    )
    this.record(account, { ok: false, latencyMs: latency }, now)
    if (proxy) {
      trace.path.push(
        hop('proxy', proxy.id, proxy.name, `已转发，上游失败`, false, Math.round(proxyLatency)),
      )
      this.record(proxy, { ok: false, latencyMs: proxyLatency }, now)
    }
    this.failAccount(account, message, now)

    return { ok: false, outcome, message, latencyMs: latency }
  }

  /** Failure bookkeeping + circuit breaker. */
  private failAccount(account: AccountEntity, message: string, now: number): void {
    account.health.consecutiveFailures += 1
    account.health.lastError = message
    account.health.lastErrorAt = now
    account.health.errorRate = clamp(account.health.errorRate * 0.9 + 0.1, 0, 1)
    if (
      account.health.consecutiveFailures >= BREAKER_THRESHOLD &&
      (account.health.cooldownUntil === null || account.health.cooldownUntil <= now)
    ) {
      account.health.cooldownUntil = now + BREAKER_COOLDOWN_MS
      this.log(
        'warn',
        `账号「${account.name}」连续失败 ${account.health.consecutiveFailures} 次，熔断 ${
          BREAKER_COOLDOWN_MS / 1000
        }s`,
        `breaker:${account.id}`,
      )
    }
    account.updatedAt = now
    this.store.markDirty(account)
  }

  /* -------------------------------------------------------------- metrics -- */

  private record(entity: Entity, input: RecordInput, now: number): void {
    const metrics = entity.metrics
    metrics.requests += 1
    if (input.ok) metrics.success += 1
    else metrics.failed += 1
    if (input.rateLimited) metrics.rateLimited += 1
    metrics.tokensIn += input.tokensIn ?? 0
    metrics.tokensOut += input.tokensOut ?? 0
    metrics.lastUsedAt = now

    if (input.latencyMs > 0) {
      metrics.avgLatencyMs =
        metrics.avgLatencyMs === 0
          ? input.latencyMs
          : metrics.avgLatencyMs * 0.9 + input.latencyMs * 0.1
      const samples = this.latencySamples.get(entity.id) ?? []
      samples.push(input.latencyMs)
      if (samples.length > LATENCY_SAMPLE_SIZE) samples.shift()
      this.latencySamples.set(entity.id, samples)
      // Recomputed once per tick in `rollWindows`, not once per request.
      this.p95Dirty.add(entity.id)
    }

    this.tickCounts.set(entity.id, (this.tickCounts.get(entity.id) ?? 0) + 1)
    this.secondCounts.set(entity.id, (this.secondCounts.get(entity.id) ?? 0) + 1)
    this.store.noteOutcome(entity.id, input.ok)
    this.store.markDirty(entity)
  }

  private commit(trace: RequestTrace, forceEmit: boolean): void {
    this.traces.unshift(trace)
    while (this.traces.length > TRACE_BUFFER_SIZE) this.traces.pop()

    const stats = this.stats
    stats.totalRequests += 1
    if (trace.ok) {
      stats.success += 1
      this.secondOk += 1
    } else {
      stats.failed += 1
      this.secondErr += 1
    }
    if (RATE_LIMIT_OUTCOMES.has(trace.outcome)) stats.rateLimited += 1
    stats.retries += trace.retries
    stats.tokensIn += trace.tokensIn
    stats.tokensOut += trace.tokensOut
    stats.outcomes[trace.outcome] = (stats.outcomes[trace.outcome] ?? 0) + 1

    if (trace.durationMs > 0) {
      stats.avgLatencyMs =
        stats.avgLatencyMs === 0
          ? trace.durationMs
          : stats.avgLatencyMs * 0.94 + trace.durationMs * 0.06
      this.globalLatency.push(trace.durationMs)
      if (this.globalLatency.length > 256) this.globalLatency.shift()
      stats.p95LatencyMs = p95Of(this.globalLatency)
      this.secondLatencySum += trace.durationMs
      this.secondLatencyCount += 1
    }

    if (forceEmit || this.traceBudget > 0) {
      if (!forceEmit) this.traceBudget -= 1
      this.emit({ type: 'trace', trace })
    }
  }

  private log(level: 'info' | 'warn' | 'error', message: string, memoKey?: string): void {
    const now = Date.now()
    if (memoKey) {
      const last = this.logMemo.get(memoKey) ?? 0
      if (now - last < 4000) return
      this.logMemo.set(memoKey, now)
    }
    this.emit({ type: 'log', level, message, at: now })
  }
}

function hop(
  kind: RequestHop['kind'],
  id: string,
  name: string,
  reason: string,
  ok: boolean,
  latencyMs: number,
): RequestHop {
  return { kind, id, name, reason, ok, latencyMs }
}

/** Key of the sticky-session pin: one pinned account per (pool, key) pair. */
function stickyKey(poolId: string, keyId: string): string {
  return `${poolId}@${keyId}`
}

function addEdge(trace: RequestTrace, sourceId: string, targetId: string): void {
  const id = edgeId(sourceId, targetId)
  if (!trace.edgeIds.includes(id)) trace.edgeIds.push(id)
}
