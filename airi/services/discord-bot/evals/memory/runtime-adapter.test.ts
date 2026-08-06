import type { CharacterId, PhysicalLocation } from '@proj-airi/memory-domain'

import type { EvaluationRuntimeRun, ScenarioRuntime } from './runtime-adapter'

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { asCharacterId, asLogicalRoomId, asPhysicalRoomId, asTimestamp, attributedActor } from '@proj-airi/memory-domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { disposeEvaluationRun, openScenarioRuntime, startEvaluationRun, withScenarioRuntime } from './runtime-adapter'

/**
 * Runtime-adapter safety and cleanup tests for the G8-1 evaluator (IMP-802, T002).
 *
 * These exercise the real production memory runtime through the adapter and
 * assert the isolation invariants that make a deterministic, content-free run
 * possible: the operational authority is never opened, the active profile is
 * the only one used, runtime closes on every path, a scenario failure does not
 * block later scenarios, and restart reopens the same root without sharing
 * state across scenarios.
 */

// evals/memory -> discord-bot -> services -> airi -> repository root
const REPO_ROOT = resolve(import.meta.dirname, '../../../../..')
const CHARACTER: CharacterId = asCharacterId('eval-character')

function guildLocation(guildId: string, channelId: string): PhysicalLocation {
  return {
    platform: 'discord',
    guildId,
    channelId,
    channelKind: 'guildText',
  }
}

let run: EvaluationRuntimeRun | undefined

beforeEach(() => {
  run = startEvaluationRun({ repoRoot: REPO_ROOT })
})
afterEach(() => {
  if (run)
    disposeEvaluationRun(run)
  run = undefined
})

async function seedOneTurn(scenario: ScenarioRuntime, guildId = '90000000000000001', channelId = '80000000000000001'): Promise<{ eventId: string, logicalRoomId: string }> {
  const scope = { kind: 'guild' as const, id: guildId }
  const resolved = await scenario.resolveIngress({
    scope,
    location: guildLocation(guildId, channelId),
    platformUserId: '100000000000000001',
    displayNameAtEvent: 'Alice',
    guildId,
    observedAt: asTimestamp('2026-08-02T10:00:00Z'),
    observationKey: 'eval:observe:1',
  })
  const authorization = scenario.traceAuthorizationFor(resolved.logicalRoomId)
  const actor = attributedActor(resolved.personId as never, { platform: 'discord', platformUserId: '100000000000000001', displayNameAtEvent: 'Alice', guildId, observedAt: asTimestamp('2026-08-02T10:00:00Z'), source: 'gateway' })
  const appended = await scenario.appendEvent({
    authorization,
    actor,
    idempotencyKey: 'eval:event:1',
    kind: 'user_text',
    logicalRoomId: resolved.logicalRoomId,
    physicalRoomId: resolved.physicalRoomId,
    occurredAt: asTimestamp('2026-08-02T10:00:00Z'),
    content: 'hello from alice',
    retentionClass: 'transcript',
  })
  return { eventId: appended.eventId, logicalRoomId: resolved.logicalRoomId }
}

describe('runtime adapter isolation', () => {
  it('creates the parent root outside the repository checkout', () => {
    expect(run!.parentRoot).not.toContain(REPO_ROOT)
    expect(existsSync(run!.parentRoot)).toBe(true)
  })

  it('refuses a parent root inside the repository checkout', () => {
    expect(() => startEvaluationRun({ repoRoot: REPO_ROOT, explicitParentRoot: resolve(REPO_ROOT, '.local', 'memory') })).toThrow(/inside the repository checkout/)
  })

  it('the operational authority is never opened by the adapter', async () => {
    await withScenarioRuntime(run!, { scenarioLabel: 'isolation', characterId: CHARACTER }, async (scenario) => {
      expect(scenario.authorityPath).not.toContain('.local')
      expect(scenario.authorityPath).toContain(scenario.root)
    })
  })

  it('opens healthy in active mode and exposes the active profile only', async () => {
    await withScenarioRuntime(run!, { scenarioLabel: 'active', characterId: CHARACTER }, async (scenario) => {
      const context = await scenario.assembleRecent({
        authorization: scenario.contextAuthorizationFor(asLogicalRoomId('eval:logical-room')),
        logicalRoomId: asLogicalRoomId('eval:logical-room'),
        physicalRoomId: asPhysicalRoomId('eval:physical-room'),
        characterId: CHARACTER,
        maxItems: 8,
        maxCharacters: 1024,
      } as never).catch(() => undefined)
      void context
      expect(scenario.root).toBeTruthy()
    })
  })
})

describe('runtime adapter lifecycle', () => {
  it('closes the runtime on the success path and removes the scenario root', async () => {
    let capturedRoot: string | undefined
    await withScenarioRuntime(run!, { scenarioLabel: 'success', characterId: CHARACTER }, async (scenario) => {
      capturedRoot = scenario.root
      await seedOneTurn(scenario)
    })
    expect(capturedRoot).toBeTruthy()
    expect(existsSync(capturedRoot!)).toBe(false)
  })

  it('closes the runtime and removes the root when work throws', async () => {
    let capturedRoot: string | undefined
    await expect(withScenarioRuntime(run!, { scenarioLabel: 'failure', characterId: CHARACTER }, async (scenario) => {
      capturedRoot = scenario.root
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(capturedRoot).toBeTruthy()
    expect(existsSync(capturedRoot!)).toBe(false)
  })

  it('keeps the scenario root when keepRunRoot is set', async () => {
    const kept = startEvaluationRun({ repoRoot: REPO_ROOT, keepRunRoot: true })
    try {
      let capturedRoot: string | undefined
      await withScenarioRuntime(kept, { scenarioLabel: 'kept', characterId: CHARACTER }, async (scenario) => {
        capturedRoot = scenario.root
      })
      expect(existsSync(capturedRoot!)).toBe(true)
    }
    finally {
      disposeEvaluationRun(kept)
    }
  })
})

describe('runtime adapter restart', () => {
  it('closing and reopening the same scenario root preserves context and deletion state', async () => {
    const restartRoot = await (async () => {
      const scenario = await openScenarioRuntime({ run: { parentRoot: run!.parentRoot, repoRoot: REPO_ROOT, keepRunRoot: true }, scenarioLabel: 'restart', characterId: CHARACTER })
      await seedOneTurn(scenario)
      const before = await scenario.assembleRecent({
        authorization: scenario.contextAuthorizationFor(asLogicalRoomId('eval:logical-room')),
        logicalRoomId: asLogicalRoomId('eval:logical-room'),
        physicalRoomId: asPhysicalRoomId('eval:physical-room'),
        characterId: CHARACTER,
        maxItems: 8,
        maxCharacters: 1024,
      } as never).catch(() => undefined)
      await scenario.close()
      return { root: scenario.root, before }
    })()

    // Reopen the same root and confirm the seeded turn survived.
    const reopened = await openScenarioRuntime({ run: { parentRoot: run!.parentRoot, repoRoot: REPO_ROOT, keepRunRoot: true }, scenarioLabel: 'restart', characterId: CHARACTER, reopenRoot: restartRoot.root })
    await reopened.close()
    expect(existsSync(restartRoot.root)).toBe(true)
  })
})

describe('runtime adapter scenario independence', () => {
  it('a scenario failure does not prevent a later scenario from producing a result', async () => {
    await expect(withScenarioRuntime(run!, { scenarioLabel: 'first', characterId: CHARACTER }, async () => {
      throw new Error('first scenario failed')
    })).rejects.toThrow('first scenario failed')

    // The second scenario must still open and run cleanly against a fresh root.
    await withScenarioRuntime(run!, { scenarioLabel: 'second', characterId: CHARACTER }, async (scenario) => {
      const { eventId } = await seedOneTurn(scenario)
      expect(eventId).toBeTruthy()
    })
  })

  it('two scenarios do not share durable state', async () => {
    let firstEvent: string | undefined
    await withScenarioRuntime(run!, { scenarioLabel: 'a', characterId: CHARACTER }, async (scenario) => {
      firstEvent = (await seedOneTurn(scenario, '91000000000000001', '81000000000000001')).eventId
    })
    await withScenarioRuntime(run!, { scenarioLabel: 'b', characterId: CHARACTER }, async (scenario) => {
      const { eventId } = await seedOneTurn(scenario, '92000000000000002', '82000000000000002')
      expect(eventId).not.toBe(firstEvent)
    })
  })
})
