/**
 * Pure presentation helpers: label maps, tone mapping and icon lookup.
 * Everything here is side-effect free so it can be used inside render.
 */
import {
  Bot,
  Brain,
  CircleUser,
  Cloud,
  CloudCog,
  Gem,
  Globe,
  KeyRound,
  Layers,
  type LucideIcon,
} from 'lucide-react'

import {
  KIND_LABEL_CN,
  PROVIDER_LABEL,
  STATUS_LABEL_CN,
  STRATEGY_LABEL_CN,
  type EntityKind,
  type HealthStatus,
  type Provider,
  type RequestOutcome,
  type RoutingStrategy,
} from '@kpa/shared'

export type Tone = 'ok' | 'warn' | 'danger' | 'neutral'

/* --------------------------------------------------------------- status -- */

export function statusLabel(s: HealthStatus): string {
  return STATUS_LABEL_CN[s] ?? s
}

const STATUS_TONE: Record<HealthStatus, Tone> = {
  healthy: 'ok',
  degraded: 'warn',
  throttled: 'warn',
  exhausted: 'danger',
  cooldown: 'danger',
  disabled: 'neutral',
  offline: 'danger',
}

export function statusTone(s: HealthStatus): Tone {
  return STATUS_TONE[s] ?? 'neutral'
}

/* -------------------------------------------------------------- outcome -- */

const OUTCOME_LABEL_CN: Record<RequestOutcome, string> = {
  success: '成功',
  'key-disabled': '密钥停用',
  'key-rate-limited': '密钥限流',
  'key-quota-exceeded': '密钥配额耗尽',
  'no-pool': '未绑定池',
  'pool-unavailable': '池不可用',
  'no-account': '无可用账号',
  'account-rate-limited': '账号限流',
  'account-quota-exceeded': '账号配额耗尽',
  'upstream-error': '上游错误',
  'proxy-error': '代理错误',
  timeout: '超时',
}

const OUTCOME_TONE: Record<RequestOutcome, 'ok' | 'warn' | 'danger'> = {
  success: 'ok',
  'key-disabled': 'warn',
  'key-rate-limited': 'warn',
  'key-quota-exceeded': 'warn',
  'no-pool': 'danger',
  'pool-unavailable': 'danger',
  'no-account': 'danger',
  'account-rate-limited': 'warn',
  'account-quota-exceeded': 'warn',
  'upstream-error': 'danger',
  'proxy-error': 'danger',
  timeout: 'danger',
}

export function outcomeLabel(o: RequestOutcome): string {
  return OUTCOME_LABEL_CN[o] ?? o
}

export function outcomeTone(o: RequestOutcome): 'ok' | 'warn' | 'danger' {
  return OUTCOME_TONE[o] ?? 'danger'
}

/* ----------------------------------------------------------------- kind -- */

export function kindLabel(k: EntityKind): string {
  return KIND_LABEL_CN[k] ?? k
}

const KIND_ICON: Record<EntityKind, LucideIcon> = {
  key: KeyRound,
  pool: Layers,
  account: CircleUser,
  proxy: Globe,
}

export function kindIcon(k: EntityKind): LucideIcon {
  return KIND_ICON[k] ?? KeyRound
}

/* ------------------------------------------------------------- provider -- */

const PROVIDER_ICON: Record<Provider, LucideIcon> = {
  anthropic: Brain,
  openai: Bot,
  gemini: Gem,
  bedrock: Cloud,
  azure: CloudCog,
  deepseek: Globe,
}

export function providerIcon(p: Provider): LucideIcon {
  return PROVIDER_ICON[p] ?? Cloud
}

export function providerLabel(p: Provider): string {
  return PROVIDER_LABEL[p] ?? p
}

/* ------------------------------------------------------------- strategy -- */

export function strategyLabel(s: RoutingStrategy): string {
  return STRATEGY_LABEL_CN[s] ?? s
}

/* --------------------------------------------------------------- misc -- */

const REGIONAL_INDICATOR_BASE = 0x1f1e6
const LETTER_A = 'A'.charCodeAt(0)

/** ISO-3166 alpha-2 code -> regional indicator emoji. Returns a globe for bad input. */
export function countryFlag(code: string): string {
  const upper = (code ?? '').trim().toUpperCase()
  if (upper.length !== 2 || !/^[A-Z]{2}$/.test(upper)) return '🌐'
  const points = [0, 1].map((i) => REGIONAL_INDICATOR_BASE + (upper.charCodeAt(i) - LETTER_A))
  return String.fromCodePoint(...points)
}

/** Keep the last `visible` characters readable and blank out the middle. */
export function maskTail(text: string, visible = 4): string {
  if (!text) return ''
  const keep = Math.max(0, visible)
  if (text.length <= keep) return text
  const headLength = Math.min(6, text.length - keep)
  const head = text.slice(0, headLength)
  const tail = keep === 0 ? '' : text.slice(-keep)
  return `${head}••••${tail}`
}
