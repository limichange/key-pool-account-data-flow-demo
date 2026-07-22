import { memo, useEffect, useRef, useState } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useStore,
  type EdgeProps,
} from '@xyflow/react'
import clsx from 'clsx'

import { clamp } from '@kpa/shared'
import type { KpaEdge } from '@/lib/graph'
import { useEdgeLoad, useEdgeOk, useEdgePulse, useEdgeVolume } from '@/lib/store'

/** Travel time of a traffic particle along the whole path. */
const PARTICLE_MS = 900
/** Duration of the reduced-motion fallback flash. */
const FLASH_MS = 280
/** Hard cap so a hot edge cannot spawn an unbounded number of SVG nodes. */
const MAX_PARTICLES = 6
/** Particles spawned for one flush batch, staggered by this much. */
const PARTICLE_STAGGER_MS = 120
/** Below this zoom the midpoint labels become noise, so they are hidden. */
const LABEL_MIN_ZOOM = 0.55

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
 */
function useTrafficParticles(edgeIdValue: string, reduced: boolean): Particle[] {
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
  }, [pulse, ok, reduced, volume])

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
 * Wire thickness follows live throughput, with the configured weight as the
 * floor so an idle board still shows the intended shape of the topology.
 */
function strokeWidthFor(weight: number, load: number): number {
  const configured = 1.3 + weight * 0.32
  return clamp(Math.max(configured, 1.3 + load * 3.6), 1.3, 5)
}

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
  const particles = useTrafficParticles(id, reduced)
  const load = useEdgeLoad(id)

  /* Particle radii live in graph coordinates, so at the opening zoom a 2.6px
     core measured 0.59 CSS px on screen — invisible. Size them in screen space
     instead, with the design radius as the lower bound. */
  const coreR = clamp(2.6 / zoom, 2.6, 9)
  const haloR = clamp(7.5 / zoom, 7.5, 26)

  const sourceKind = data?.sourceKind ?? 'key'
  const label = data?.label ?? ''
  const weight = data?.weight ?? 1
  const disabled = data?.disabled ?? false
  const dimmed = data?.dimmed ?? false
  const traced = data?.traced ?? false

  const width = strokeWidthFor(weight, load)
  const showLabel = Boolean(label) && !dimmed && zoom >= LABEL_MIN_ZOOM

  return (
    <>
      <g
        className={clsx('kpa-edge', selected && 'kpa-edge--selected')}
        data-kind={sourceKind}
        data-traced={traced ? 'true' : 'false'}
        data-dimmed={dimmed ? 'true' : 'false'}
        data-disabled={disabled ? 'true' : 'false'}
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
              <circle r={coreR} className="kpa-edge__particle-core" />
              <animateMotion
                dur={`${PARTICLE_MS}ms`}
                path={path}
                fill="freeze"
                repeatCount="1"
                calcMode="linear"
              />
            </g>
          ),
        )}
      </g>

      {showLabel ? (
        <EdgeLabelRenderer>
          <div
            className={clsx('kpa-edge-label', 'nodrag', 'nopan')}
            data-kind={sourceKind}
            data-traced={traced ? 'true' : 'false'}
            data-disabled={disabled ? 'true' : 'false'}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title={label}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

export const FlowEdge = memo(FlowEdgeComponent)
