import { memo, useEffect, useRef, useState } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useStore,
  type EdgeProps,
} from '@xyflow/react'
import clsx from 'clsx'

import { clamp, type EntityKind } from '@kpa/shared'
import type { KpaEdge } from '@/lib/graph'
import { useConsole, useEdgeMaxRpm, useEdgeMetrics, useEdgeOk, useEdgePulse, useEdgeVolume } from '@/lib/store'

import { EdgeChart } from './EdgeChart'

/** Travel time of a traffic particle along the whole path. */
const PARTICLE_MS = 900
/** Duration of the reduced-motion fallback flash. */
const FLASH_MS = 280
/** Hard cap so a hot edge cannot spawn an unbounded number of SVG nodes. */
const MAX_PARTICLES = 6
/** Particles spawned for one flush batch, staggered by this much. */
const PARTICLE_STAGGER_MS = 120

/**
 * Zoom LOD for the midpoint chip:
 *   zoom >= CHIP_FULL_ZOOM     full chip (label · bars · total · success rate)
 *   zoom >= CHIP_COMPACT_ZOOM  compact chip (micro bars only)
 *   below                      no chip at all (and no metric subscription)
 */
const CHIP_FULL_ZOOM = 0.75
const CHIP_COMPACT_ZOOM = 0.45

interface Particle {
  key: number
  ok: boolean
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() =>
    typeof window === 'undefined'
      ? false
      : window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  return reduced
}

/**
 * Spawns particles every time the edge pulse timestamp advances. Traces are
 * flushed in ~100ms batches, so one pulse can stand for many requests: the
 * batch size drives how many particles launch (staggered, so they read as a
 * stream) and that is the only thing that makes volume legible in the motion.
 * A dead or dimmed edge (`active === false`) spawns nothing at all.
 */
function useTrafficParticles(edgeIdValue: string, reduced: boolean, active: boolean): Particle[] {
  const pulse = useEdgePulse(edgeIdValue)
  const ok = useEdgeOk(edgeIdValue)
  const volume = useEdgeVolume(edgeIdValue)

  const [particles, setParticles] = useState<Particle[]>([])
  // Seeded with the current pulse so remounting an edge never replays old traffic.
  const lastPulse = useRef<number>(pulse)
  const sequence = useRef(0)
  const timers = useRef<number[]>([])

  useEffect(() => {
    if (!pulse || pulse === lastPulse.current) return
    lastPulse.current = pulse
    if (!active) return

    const lifetime = reduced ? FLASH_MS : PARTICLE_MS
    const count = reduced ? 1 : clamp(Math.round(volume), 1, 4)

    const launch = (): void => {
      sequence.current += 1
      const key = sequence.current
      setParticles((prev) => [...prev.slice(-(MAX_PARTICLES - 1)), { key, ok }])
      const dispose = window.setTimeout(() => {
        setParticles((prev) => prev.filter((p) => p.key !== key))
        timers.current = timers.current.filter((t) => t !== dispose)
      }, lifetime)
      timers.current.push(dispose)
    }

    launch()
    for (let i = 1; i < count; i += 1) {
      const stagger = window.setTimeout(() => {
        timers.current = timers.current.filter((t) => t !== stagger)
        launch()
      }, i * PARTICLE_STAGGER_MS)
      timers.current.push(stagger)
    }
  }, [pulse, ok, reduced, volume, active])

  useEffect(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer)
      timers.current = []
    },
    [],
  )

  return particles
}

/**
 * Wire thickness: the configured relation weight is the base, plus a modest
 * clamped component from this edge's rolling rpm relative to the busiest edge
 * on the board, so a hot path visibly thickens without dwarfing the topology.
 */
function strokeWidthFor(weight: number, share: number): number {
  const configured = 1.3 + weight * 0.32
  return clamp(configured + share * 2.2, 1.3, 5)
}

/**
 * Mounted only while the chip is visible, so hidden/dimmed edges do not even
 * subscribe to the per-edge metrics stream.
 */
const EdgeChipSlot = memo(function EdgeChipSlot({
  id,
  label,
  sourceKind,
  compact,
}: {
  id: string
  label: string
  sourceKind: EntityKind
  compact: boolean
}): JSX.Element {
  const metrics = useEdgeMetrics(id)
  return <EdgeChart metrics={metrics} label={label} sourceKind={sourceKind} compact={compact} />
})

function FlowEdgeComponent({
  id,
  data,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  markerEnd,
}: EdgeProps<KpaEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.32,
  })

  const zoom = useStore((s) => s.transform[2])
  const reduced = usePrefersReducedMotion()

  const sourceKind = data?.sourceKind ?? 'key'
  const label = data?.label ?? ''
  const weight = data?.weight ?? 1
  const disabled = data?.disabled ?? false
  const live = data?.live ?? true
  const dimmed = data?.dimmed ?? false
  const traced = data?.traced ?? false

  /*
   * Feature 4 — a dead path must read as dead in SHAPE, not only in hue:
   * thinner, dashed (CSS), particle-free and with a muted chip, so the state
   * survives a colour-blind viewer and a greyscale screenshot.
   */
  const dead = !live || disabled
  const particles = useTrafficParticles(id, reduced, !dead && !dimmed)

  // Throughput-aware stroke: primitives only, so the memoised edge re-renders
  // exactly when its own rpm or the board maximum changes.
  const rpm = useConsole((s) => s.edgeMetrics[id]?.rpm ?? 0)
  const maxRpm = useEdgeMaxRpm()
  const share = maxRpm > 0 ? rpm / maxRpm : 0

  /* Particle radii live in graph coordinates, so at the opening zoom a 2.6px
     core measured 0.59 CSS px on screen — invisible. Size them in screen space
     instead, with the design radius as the lower bound. */
  const coreR = clamp(2.6 / zoom, 2.6, 9)
  const haloR = clamp(7.5 / zoom, 7.5, 26)

  const width = dead ? 1.1 : strokeWidthFor(weight, share)

  // Dimmed and hidden edges render no chip and do no metric work at all.
  const chipMode: 'full' | 'compact' | 'hidden' = dimmed
    ? 'hidden'
    : zoom >= CHIP_FULL_ZOOM
      ? 'full'
      : zoom >= CHIP_COMPACT_ZOOM
        ? 'compact'
        : 'hidden'

  return (
    <>
      <g
        className={clsx('kpa-edge', selected && 'kpa-edge--selected')}
        data-kind={sourceKind}
        data-traced={traced ? 'true' : 'false'}
        data-dimmed={dimmed ? 'true' : 'false'}
        data-disabled={disabled ? 'true' : 'false'}
        data-live={live ? 'true' : 'false'}
      >
        {traced ? (
          <path
            d={path}
            className="kpa-edge__halo"
            fill="none"
            style={{ strokeWidth: width + 7 }}
          />
        ) : null}

        <BaseEdge
          id={id}
          path={path}
          className="kpa-edge__path"
          style={{ strokeWidth: width }}
          markerEnd={markerEnd}
          interactionWidth={26}
        />

        {particles.map((particle) =>
          reduced ? (
            <path
              key={particle.key}
              d={path}
              fill="none"
              className="kpa-edge__flash"
              data-ok={particle.ok ? 'true' : 'false'}
              style={{ strokeWidth: width + 2.5 }}
            />
          ) : (
            <g
              key={particle.key}
              className="kpa-edge__particle"
              data-ok={particle.ok ? 'true' : 'false'}
            >
              <circle r={haloR} className="kpa-edge__particle-halo" />
              {/* Comet tail (feature 13): rotate="auto" keeps the group
                  aligned with the path, so negative cx trails the core. */}
              <circle
                r={coreR * 0.72}
                cx={-coreR * 2.4}
                className="kpa-edge__particle-tail kpa-edge__particle-tail--a"
              />
              <circle
                r={coreR * 0.5}
                cx={-coreR * 4.1}
                className="kpa-edge__particle-tail kpa-edge__particle-tail--b"
              />
              <circle r={coreR} className="kpa-edge__particle-core" />
              <animateMotion
                dur={`${PARTICLE_MS}ms`}
                path={path}
                fill="freeze"
                repeatCount="1"
                calcMode="linear"
                rotate="auto"
              />
            </g>
          ),
        )}
      </g>

      {chipMode !== 'hidden' ? (
        <EdgeLabelRenderer>
          {/* pointer-events stays off on the wrap; only the chip itself is
              interactive, as EdgeLabelRenderer requires. */}
          <div
            className={clsx('kpa-edge-chip-wrap', 'nodrag', 'nopan')}
            data-kind={sourceKind}
            data-live={dead ? 'false' : 'true'}
            data-traced={traced ? 'true' : 'false'}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            <EdgeChipSlot id={id} label={label} sourceKind={sourceKind} compact={chipMode === 'compact'} />
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

export const FlowEdge = memo(FlowEdgeComponent)
