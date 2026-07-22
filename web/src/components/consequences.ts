/**
 * Pure helpers that turn a pending destructive action into the exact Chinese
 * consequence lines the confirm dialogs show. Everything is computed from the
 * real graph — names, kinds and counts — never from a generic warning.
 *
 * Shared by the Inspector delete button, the canvas Delete-key path and the
 * proxy enable/disable cascade dialogs, so the three surfaces can never tell a
 * different story about the same action.
 */
import type {
  AccountEntity,
  Entity,
  GraphState,
  KeyEntity,
  PoolEntity,
  ProxyEntity,
} from '@kpa/shared'

/** Always the last line returned by `deleteConsequences`; render it muted. */
export const DELETE_IRREVERSIBLE_NOTE = '删除操作不可撤销。'

/** `A、B、C 等 5 个` — keeps dialog bodies short when a cascade is wide. */
function joinNames(names: string[], max = 4): string {
  if (names.length <= max) return names.join('、')
  return `${names.slice(0, max).join('、')} 等 ${names.length} 个`
}

/** Accounts whose egress proxy is `proxyId` (the authoritative back-reference). */
function accountsUsingProxy(state: GraphState, proxyId: string): AccountEntity[] {
  return state.accounts.filter((a) => a.proxyId === proxyId)
}

function keyLines(state: GraphState, key: KeyEntity): string[] {
  const lines: string[] = []
  const boundPools = state.pools.filter((p) => key.bindings.some((b) => b.poolId === p.id))
  if (boundPools.length === 0) {
    lines.push(`密钥「${key.name}」未绑定任何池，删除不会影响其他节点。`)
    return lines
  }
  lines.push(`删除密钥「${key.name}」将解除它与 ${boundPools.length} 个池的绑定。`)
  // A pool bound only by this key loses its last upstream and becomes detached.
  const orphaned = boundPools.filter(
    (pool) =>
      !state.keys.some((other) => other.id !== key.id && other.bindings.some((b) => b.poolId === pool.id)),
  )
  if (orphaned.length > 0) {
    lines.push(
      `其中 ${orphaned.length} 个池（${joinNames(orphaned.map((p) => p.name))}）将失去最后一个密钥，变为未接入状态。`,
    )
  }
  return lines
}

function poolLines(state: GraphState, pool: PoolEntity): string[] {
  const lines: string[] = []
  const boundKeys = state.keys.filter((k) => k.bindings.some((b) => b.poolId === pool.id))
  const memberCount = pool.members.length
  if (boundKeys.length === 0 && memberCount === 0) {
    lines.push(`池「${pool.name}」没有任何绑定，删除不会影响其他节点。`)
  } else {
    const parts: string[] = []
    if (boundKeys.length > 0) parts.push(`解除 ${boundKeys.length} 个密钥的绑定`)
    if (memberCount > 0) parts.push(`其下 ${memberCount} 个账号会变成未接入状态`)
    lines.push(`删除池「${pool.name}」将${parts.join('，')}。`)
  }
  const failoverSources = state.pools.filter((p) => p.id !== pool.id && p.failoverPoolId === pool.id)
  if (failoverSources.length > 0) {
    lines.push(
      `${failoverSources.length} 个池（${joinNames(failoverSources.map((p) => p.name))}）将失去指向它的故障转移配置。`,
    )
  }
  return lines
}

function accountLines(state: GraphState, account: AccountEntity): string[] {
  const pool = account.poolId ? state.pools.find((p) => p.id === account.poolId) : undefined
  const proxy = account.proxyId ? state.proxies.find((p) => p.id === account.proxyId) : undefined
  if (!pool && !proxy) {
    return [`账号「${account.name}」未接入任何池，也未绑定代理，删除不会影响其他节点。`]
  }
  const parts: string[] = []
  if (pool) parts.push(`将把它从「${pool.name}」移除`)
  if (proxy) parts.push(`${pool ? '并' : '将'}释放代理「${proxy.name}」`)
  return [`删除账号「${account.name}」${parts.join('，')}。`]
}

function proxyLines(state: GraphState, proxy: ProxyEntity): string[] {
  const users = accountsUsingProxy(state, proxy.id)
  if (users.length === 0) {
    return [`当前没有账号使用代理「${proxy.name}」，删除不会影响其他节点。`]
  }
  const lines: string[] = [
    `删除代理「${proxy.name}」将使 ${users.length} 个账号失去代理：${joinNames(users.map((a) => a.name))}。`,
  ]
  // Feature 9 cascade: an in-pool account must keep a proxy, so losing the
  // proxy also removes it from its pool — it becomes detached (未接入).
  const pooled = users.filter((a) => a.poolId !== null)
  if (pooled.length > 0) {
    lines.push(`其中 ${pooled.length} 个账号会被移出所属池，变为未接入状态。`)
  }
  return lines
}

/**
 * Chinese consequence lines for deleting `entity`, computed from the live
 * graph. The final line is always `DELETE_IRREVERSIBLE_NOTE` so callers can
 * style it muted.
 */
export function deleteConsequences(state: GraphState, entity: Entity): string[] {
  let lines: string[]
  switch (entity.kind) {
    case 'key':
      lines = keyLines(state, entity as KeyEntity)
      break
    case 'pool':
      lines = poolLines(state, entity as PoolEntity)
      break
    case 'account':
      lines = accountLines(state, entity as AccountEntity)
      break
    case 'proxy':
      lines = proxyLines(state, entity as ProxyEntity)
      break
    default:
      // The gateway can never be deleted; its dialog never opens.
      lines = ['网关是全局入口，不可删除。']
      break
  }
  return [...lines, DELETE_IRREVERSIBLE_NOTE]
}

/*
 * Feature 10 — the proxy enable-switch cascade. This is about the ENABLED
 * switch only: a proxy that merely goes unhealthy is handled by the router
 * skipping it and must not disable anything.
 */

/** Accounts that will be auto-disabled when `proxy` is switched off: in a pool, currently enabled. */
export function proxyDisableCasualties(state: GraphState, proxy: ProxyEntity): AccountEntity[] {
  return state.accounts.filter((a) => a.proxyId === proxy.id && a.poolId !== null && a.enabled)
}

/** Accounts that will come back when `proxy` is re-enabled: precisely the ones it auto-disabled. */
export function proxyEnableRevivals(state: GraphState, proxy: ProxyEntity): AccountEntity[] {
  return state.accounts.filter((a) => a.autoDisabledBy === proxy.id)
}

/** Body text for the proxy-off confirm dialog, naming every casualty. */
export function proxyDisableMessage(proxy: ProxyEntity, casualties: AccountEntity[]): string {
  return `停用代理「${proxy.name}」会同时自动停用正在使用它的 ${casualties.length} 个账号：${joinNames(
    casualties.map((a) => a.name),
  )}。是否继续？`
}

/** Body text for the proxy-on confirm dialog, naming the accounts that return. */
export function proxyEnableMessage(proxy: ProxyEntity, revivals: AccountEntity[]): string {
  return `启用代理「${proxy.name}」会自动恢复因它停用的 ${revivals.length} 个账号：${joinNames(
    revivals.map((a) => a.name),
  )}。是否继续？`
}
