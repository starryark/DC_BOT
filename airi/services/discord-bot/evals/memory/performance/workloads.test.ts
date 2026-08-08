import { describe, expect, it } from 'vitest'

import * as v from 'valibot'

import { workloadSpecSchema } from './contracts'
import { WORKLOAD_CATALOG, workloadById, workloadsForSuite } from './workloads'

/**
 * Workload catalog tests for the IMP-803 deterministic performance benchmark.
 *
 * These assert the smoke and full suites contain the operation families the
 * plan freezes (§6.6), that active/control pairs are matched, and that every
 * barge-in workload carries the full cancellation postcondition predicate.
 */

describe('smoke suite', () => {
  const smoke = workloadsForSuite('smoke')

  it('contains the essential fast, credential-free paths', () => {
    const ids = smoke.map(workload => workload.workloadId)
    expect(ids).toEqual(expect.arrayContaining([
      'smoke-runtime-open-close',
      'smoke-text-ingress-append',
      'smoke-context-assembly-8',
      'smoke-generation-segment-delivery',
      'smoke-close-reopen-continuity',
      'smoke-text-controller-inert-active-pair',
      'smoke-voice-controller-cancellation',
    ]))
  })

  it('dedicated smoke workloads use a single sample to stay fast and credential-free', () => {
    // Workloads prefixed `smoke-` are the fast smoke-only paths; shared
    // workloads that also belong to performance-v2 carry their full sample count.
    const dedicated = smoke.filter(workload => workload.workloadId.startsWith('smoke-'))
    expect(dedicated.length).toBeGreaterThan(0)
    for (const workload of dedicated)
      expect(workload.sampleCount).toBe(1)
  })

  it('the smoke cancellation workload uses the same real barge-in driver as the full suite', () => {
    // ROOT CAUSE:
    //
    // v1 selected the cancellation driver with `workloadId.startsWith('barge-in')`.
    // `smoke-voice-controller-cancellation` fails that test, so smoke ran the
    // nominal turn while still asserting cancellation postconditions — which
    // passed only because four of them were hardcoded `ok = true`.
    const workload = workloadById('smoke-voice-controller-cancellation')
    expect(workload.driverCase).toBe('voice-barge-in')
    expect(workload.triggerStage).not.toBeNull()
    expect(workload.postconditions).toContain('no-cancelled-segment-delivered')
    expect(workload.postconditions).toContain('controller-accepts-next-turn')
  })
})

describe('full performance-v2 runtime workloads', () => {
  const full = workloadsForSuite('performance-v2')
  const runtimeIds = full.filter(workload => workload.runner === 'runtime').map(workload => workload.workloadId)

  it('covers the runtime operation families from the frozen catalog', () => {
    expect(runtimeIds).toEqual(expect.arrayContaining([
      'runtime-cold-open',
      'runtime-warm-reopen',
      'text-ingress',
      'voice-ingress',
      'text-append',
      'voice-append',
      'context-assembly-0',
      'context-assembly-8',
      'context-assembly-24',
      'generation-begin',
      'generation-terminal-transition',
      'text-segment-delivery-lifecycle',
      'voice-segment-delivery-lifecycle',
      'same-room-serialized-load',
      'eight-room-concurrent-load',
      'acknowledged-state-close-reopen-recovery',
      'interrupted-delivery-recovery',
    ]))
  })

  it('drops the writer-contention workload rather than keeping a claim it cannot prove', () => {
    // In v1 its measured body was byte-identical to `same-room-serialized-load`
    // and its postcondition was "an event id came back". Proving real writer
    // contention needs a second runtime on one root, which the adapter does not
    // expose and which the plan forbids adding for the benchmark alone.
    expect(runtimeIds).not.toContain('active-writer-contention')
    for (const spec of WORKLOAD_CATALOG)
      expect(spec.postconditions).not.toContain('writer-contention-observed')
  })

  it('the eight-room workload runs eight rooms and the same-room workload runs one', () => {
    expect(workloadById('eight-room-concurrent-load').roomCount).toBe(8)
    expect(workloadById('same-room-serialized-load').roomCount).toBe(1)
  })

  it('records a timer-control workload that is never subtracted from samples', () => {
    const timer = full.find(workload => workload.role === 'timer-control')
    expect(timer).toBeDefined()
    expect(timer!.runner).toBe('runtime')
  })
})

describe('controller workloads', () => {
  const full = workloadsForSuite('performance-v2')

  it('covers the text controller families', () => {
    const textIds = full.filter(workload => workload.runner === 'text-controller').map(workload => workload.workloadId)
    expect(textIds).toEqual(expect.arrayContaining([
      'text-inert-control',
      'text-active-memory',
      'text-same-room-queue',
      'text-eight-room-parallelism',
    ]))
  })

  it('covers the voice controller families including all four barge-in points', () => {
    const voiceIds = full.filter(workload => workload.runner === 'voice-controller').map(workload => workload.workloadId)
    expect(voiceIds).toEqual(expect.arrayContaining([
      'voice-inert-control',
      'voice-active-memory',
      'voice-first-generated-chunk',
      'voice-first-tts-request',
      'voice-first-playback-queue',
      'voice-playback-drain',
      'barge-in-before-provider-response',
      'barge-in-during-streamed-generation',
      'barge-in-during-tts',
      'barge-in-during-playback',
      'provider-timeout',
      'tts-failure',
    ]))
  })

  it('every controller workload has a matched inert-control or active counterpart for memory overhead claims', () => {
    // text and voice each declare exactly one inert-control and one active-memory workload.
    const text = full.filter(workload => workload.runner === 'text-controller')
    const voice = full.filter(workload => workload.runner === 'voice-controller')
    expect(text.filter(workload => workload.role === 'inert-control')).toHaveLength(1)
    expect(text.filter(workload => workload.operation === 'text active memory')).toHaveLength(1)
    expect(voice.filter(workload => workload.role === 'inert-control')).toHaveLength(1)
    expect(voice.filter(workload => workload.operation === 'voice active memory')).toHaveLength(1)
  })
})

describe('barge-in cancellation predicate', () => {
  const bargeInPoints = [
    'barge-in-before-provider-response',
    'barge-in-during-streamed-generation',
    'barge-in-during-tts',
    'barge-in-during-playback',
  ]

  it('each barge-in workload names the distinct stage its driver fires at', () => {
    expect(bargeInPoints.map(id => workloadById(id).triggerStage)).toEqual([
      'before-provider-response',
      'streamed-generation',
      'tts',
      'playback',
    ])
  })

  it('every barge-in workload requires the full cancellation postcondition set', () => {
    const required = [
      'provider-abort-signal-fired',
      'playback-stopped',
      'no-stale-commit',
      'generation-cancelled',
      'no-cancelled-segment-delivered',
      'controller-accepts-next-turn',
    ]
    for (const id of bargeInPoints) {
      const workload = workloadById(id)
      for (const postcondition of required)
        expect(workload.postconditions, `${id} must require ${postcondition}`).toContain(postcondition)
    }
  })

  it('no workload uses an acoustic-qualification label', () => {
    for (const workload of WORKLOAD_CATALOG) {
      expect(workload.operation).not.toMatch(/acoustic/i)
      expect(workload.operation).not.toMatch(/barge-in qualification/i)
    }
  })
})

describe('catalog shape', () => {
  it('every workload parses against the strict schema', () => {
    for (const workload of WORKLOAD_CATALOG)
      expect(() => v.parse(workloadSpecSchema, workload)).not.toThrow()
  })

  it('throws when looking up an unknown workload id', () => {
    expect(() => workloadById('does-not-exist')).toThrow(/unknown workload id/)
  })

  it('no workload carries prompt, transcript, snowflake, or path content', () => {
    for (const workload of WORKLOAD_CATALOG) {
      const serialized = JSON.stringify(workload)
      expect(serialized).not.toMatch(/\b\d{17,20}\b/) // snowflake
      expect(serialized).not.toMatch(/prompt text|transcript|generated text/i)
      // Filesystem paths look like `/abs/path`, `C:\path`, or a relative `./`/`../`;
      // a lone slash inside a phrase like "inert/active" is not a path.
      expect(serialized).not.toMatch(/(?:^|["\s])(\.\/|\.\.\/|[A-Za-z]:\\|\/(?:home|Users|root|tmp|var|opt|etc)\b)/)
      expect(serialized).not.toMatch(/\bdiscord:(?:guild|dm|user):/) // durable id
    }
  })
})
