/**
 * Deterministic pseudo random number generator (mulberry32).
 *
 * The whole demo is driven by a single seeded instance so that a fresh server
 * start always produces the same opening minute of traffic, which makes the
 * console pleasant to record and to debug.
 */

const DEFAULT_SEED = 0x5eed_1234

export class Rng {
  private state: number
  private counter = 0

  constructor(seed: number = DEFAULT_SEED) {
    this.state = seed >>> 0
  }

  /** Reseed in place, e.g. after a reset. */
  reseed(seed: number = DEFAULT_SEED): void {
    this.state = seed >>> 0
    this.counter = 0
  }

  /** Uniform float in [0, 1). */
  nextFloat(): number {
    this.state = (this.state + 0x6d2b_79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }

  /** Uniform integer in [min, max], both inclusive. */
  nextInt(min: number, max: number): number {
    if (max <= min) return Math.round(min)
    return Math.floor(this.nextFloat() * (max - min + 1)) + min
  }

  /** Uniform float in [min, max). */
  nextRange(min: number, max: number): number {
    return min + this.nextFloat() * (max - min)
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.nextFloat() * items.length) % items.length]
  }

  /**
   * Pick an item proportionally to `weightOf`. Items with a non-positive
   * weight are ignored. Returns undefined when nothing is selectable.
   */
  weightedPick<T>(items: readonly T[], weightOf: (item: T) => number): T | undefined {
    let total = 0
    for (const item of items) {
      const w = weightOf(item)
      if (w > 0) total += w
    }
    if (total <= 0) return undefined
    let cut = this.nextFloat() * total
    for (const item of items) {
      const w = weightOf(item)
      if (w <= 0) continue
      cut -= w
      if (cut <= 0) return item
    }
    return items[items.length - 1]
  }

  /** Box-Muller normal sample. */
  gaussian(mean = 0, stddev = 1): number {
    const u = 1 - this.nextFloat()
    const v = this.nextFloat()
    const mag = Math.sqrt(-2 * Math.log(u))
    return mean + stddev * mag * Math.cos(2 * Math.PI * v)
  }

  chance(probability: number): boolean {
    if (probability <= 0) return false
    if (probability >= 1) return true
    return this.nextFloat() < probability
  }

  /** Short, human-scannable identifier such as `req_k3f8a1`. */
  shortId(prefix: string): string {
    this.counter = (this.counter + 1) % 0xffff
    const noise = Math.floor(this.nextFloat() * 0xffffff).toString(36)
    const seq = this.counter.toString(36)
    return `${prefix}_${noise}${seq}`
  }
}

/** Module level instance shared by the seed builder and the simulator. */
export const rng = new Rng()
