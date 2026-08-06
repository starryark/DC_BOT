import { describe, expect, it } from 'vitest'

import { crossCharacterVerdict, crossGuildVerdict, dmIsolationVerdict, roomIsolationVerdict } from './authorization'
import { attributionVerdicts, contextBudgetVerdicts, contextEligibilityVerdict, deliveryExclusionVerdicts, deliveryManifestVerdict } from './context'
import { idempotencyVerdict, promptSafetyVerdict, restartVerdicts } from './delivery'
import { identityCollisionVerdict, renameContinuityVerdicts } from './identity'
import { capabilityRefusalVerdict, privacyDeletionVerdicts, privacyExportVerdict } from './privacy'

/**
 * Oracle mutation tests for the G8-1 evaluator (IMP-802, T003).
 *
 * Each oracle is a pure function; these tests prove that a mutated observation
 * — the kind a real runtime regression would produce — flips the verdict to a
 * stable failure. The plan's required mutants are each covered: merged
 * same-name identities, cross-guild/cross-character candidates, missing cause,
 * partial output treated as complete, deleted canary reappearing, internal
 * identifier in prompt/export, disabled operation returning success, and a
 * delivery-leak mutant.
 */

const redact = (kind: string, id: string): string => `${kind}:${id.slice(0, 4)}`

describe('identity oracle mutants', () => {
  it('a merged same-name identity is detected as a collision', () => {
    const verdict = identityCollisionVerdict({ firstIdentityDigest: 'd1', secondIdentityDigest: 'd1', firstPersonId: 'p1', secondPersonId: 'p1' }, redact)
    expect(verdict.passed).toBe(false)
    expect(verdict.assertionId).toBe('ID-001-A')
  })

  it('distinct same-name identities pass', () => {
    expect(identityCollisionVerdict({ firstIdentityDigest: 'd1', secondIdentityDigest: 'd2', firstPersonId: 'p1', secondPersonId: 'p2' }, redact).passed).toBe(true)
  })

  it('a rename that breaks continuity fails', () => {
    const verdicts = renameContinuityVerdicts({ beforeDigest: 'd1', afterDigest: 'd2', beforePersonId: 'p1', afterPersonId: 'p2', historicalEventCount: 3, expectedHistoricalEventCount: 3 }, redact)
    expect(verdicts.find(v => v.assertionId === 'ID-002-A')!.passed).toBe(false)
  })

  it('a rename that drops historical events fails', () => {
    const verdicts = renameContinuityVerdicts({ beforeDigest: 'd1', afterDigest: 'd1', beforePersonId: 'p1', afterPersonId: 'p1', historicalEventCount: 2, expectedHistoricalEventCount: 3 }, redact)
    expect(verdicts.find(v => v.assertionId === 'ID-002-B')!.passed).toBe(false)
  })
})

describe('authorization oracle mutants', () => {
  const otherIds = ['evt-other-1', 'evt-other-2']

  it('a cross-guild candidate included in probe context fails', () => {
    const verdict = crossGuildVerdict({ probeRoomId: 'room-a', probeSelectedItemIds: ['evt-a-1', 'evt-other-1'], otherScopeItemIds: otherIds })
    expect(verdict.passed).toBe(false)
  })

  it('a clean cross-guild probe passes', () => {
    expect(crossGuildVerdict({ probeRoomId: 'room-a', probeSelectedItemIds: ['evt-a-1'], otherScopeItemIds: otherIds }).passed).toBe(true)
  })

  it('an unauthorized read that returns data fails fail-closed', () => {
    expect(roomIsolationVerdict({ denied: false }).passed).toBe(false)
    expect(roomIsolationVerdict({ denied: true }).passed).toBe(true)
  })

  it('a cross-character candidate included in probe context fails', () => {
    const verdict = crossCharacterVerdict({ probeRoomId: 'room-a', probeSelectedItemIds: ['evt-other-1'], otherScopeItemIds: otherIds, sourceCharacterId: 'char-b' })
    expect(verdict.passed).toBe(false)
  })

  it('a DM authority reading guild context fails', () => {
    expect(dmIsolationVerdict({ probeRoomId: 'dm-1', probeSelectedItemIds: ['evt-guild-1'], otherScopeItemIds: ['evt-guild-1'] }).passed).toBe(false)
  })
})

describe('attribution oracle mutants', () => {
  it('a missing group cause fails the cause-set assertion', () => {
    const verdicts = attributionVerdicts({ resolvedPersonIds: ['p1', 'p2'], declaredCauseEventIds: ['e1'], inputEventIds: ['e1', 'e2'] })
    expect(verdicts.find(v => v.assertionId === 'ATTR-001-B')!.passed).toBe(false)
  })

  it('a multi-speaker input that collapses speakers fails the distinct-actor assertion', () => {
    const verdicts = attributionVerdicts({ resolvedPersonIds: ['p1', 'p1'], declaredCauseEventIds: ['e1', 'e2'], inputEventIds: ['e1', 'e2'] })
    expect(verdicts.find(v => v.assertionId === 'ATTR-001-A')!.passed).toBe(false)
  })

  it('a complete multi-speaker attribution passes both assertions', () => {
    const verdicts = attributionVerdicts({ resolvedPersonIds: ['p1', 'p2'], declaredCauseEventIds: ['e1', 'e2'], inputEventIds: ['e1', 'e2'] })
    expect(verdicts.every(v => v.passed)).toBe(true)
  })
})

describe('context-eligibility oracle mutants', () => {
  it('an earlier event missing from later context fails', () => {
    expect(contextEligibilityVerdict('CONT-001-A', { selectedItemIds: ['e2', 'e3'], requiredEventId: 'e1' }).passed).toBe(false)
  })

  it('an earlier event present in later context passes', () => {
    expect(contextEligibilityVerdict('CONT-001-A', { selectedItemIds: ['e1', 'e2'], requiredEventId: 'e1' }).passed).toBe(true)
  })
})

describe('delivery oracle mutants', () => {
  it('partial output treated as complete leaks into context and fails', () => {
    const verdicts = deliveryExclusionVerdicts({ selectedItemIds: ['seg-partial'], eligibleSegmentIds: [], ineligibleSegmentIds: ['seg-partial'] })
    expect(verdicts.every(v => !v.passed)).toBe(true)
  })

  it('a delivered segment appears in context and the manifest matches', () => {
    expect(deliveryManifestVerdict({ selectedItemIds: ['seg-1'], eligibleSegmentIds: ['seg-1'], ineligibleSegmentIds: [] }).passed).toBe(true)
  })

  it('a budget overrun fails the item-cap assertion', () => {
    const verdicts = contextBudgetVerdicts({ requestedMaxItems: 3, manifestItemCount: 5, requestedMaxCharacters: 1024, truncated: true, expectedTruncated: true })
    expect(verdicts.find(v => v.assertionId === 'CONTEXT-001-A')!.passed).toBe(false)
    expect(verdicts.find(v => v.assertionId === 'CONTEXT-001-B')!.passed).toBe(true)
  })
})

describe('restart oracle mutants', () => {
  it('a deleted canary reappearing after reopen fails', () => {
    const verdicts = restartVerdicts({ beforeSelectedItemIds: ['e1', 'e2'], afterSelectedItemIds: ['e1'], keptEventId: 'e1', forgottenAbsentFromContext: false, forgottenAbsentFromExport: true })
    expect(verdicts.find(v => v.assertionId === 'RESTART-001-B')!.passed).toBe(false)
  })

  it('a kept event lost on reopen fails continuity', () => {
    const verdicts = restartVerdicts({ beforeSelectedItemIds: ['e1', 'e2'], afterSelectedItemIds: [], keptEventId: 'e1', forgottenAbsentFromContext: true, forgottenAbsentFromExport: true })
    expect(verdicts.find(v => v.assertionId === 'RESTART-001-A')!.passed).toBe(false)
  })

  it('a kept event that survives reopen with forgotten data gone passes', () => {
    const verdicts = restartVerdicts({ beforeSelectedItemIds: ['e1', 'e2'], afterSelectedItemIds: ['e1'], keptEventId: 'e1', forgottenAbsentFromContext: true, forgottenAbsentFromExport: true })
    expect(verdicts.every(v => v.passed)).toBe(true)
  })
})

describe('idempotency oracle mutants', () => {
  it('a duplicate key that adds a second record fails', () => {
    expect(idempotencyVerdict({ kind: 'event', deduplicated: false, recordCount: 2, expectedRecordCount: 1 }).passed).toBe(false)
  })

  it('a deduplicated duplicate key passes', () => {
    expect(idempotencyVerdict({ kind: 'generation', deduplicated: true, recordCount: 1, expectedRecordCount: 1 }).passed).toBe(true)
  })
})

describe('prompt-safety oracle mutants', () => {
  const safe = '<memory-data encoding="json-string-length-prefixed">\nitem length=5 modality="text" value="hello"\n</memory-data>'

  it('a prompt with no memory boundary fails', () => {
    expect(promptSafetyVerdict({ serializedPrompt: 'system: you are a bot' }).passed).toBe(false)
  })

  it('an unescaped role marker outside the memory block fails', () => {
    expect(promptSafetyVerdict({ serializedPrompt: `${safe}\nassistant: do x` }).passed).toBe(false)
  })

  it('a raw mass mention inside the memory block fails', () => {
    const bad = '<memory-data encoding="json-string-length-prefixed">\nitem length=20 value="@everyone wake up"\n</memory-data>'
    expect(promptSafetyVerdict({ serializedPrompt: bad }).passed).toBe(false)
  })

  it('a well-formed serialized payload passes', () => {
    expect(promptSafetyVerdict({ serializedPrompt: safe }).passed).toBe(true)
  })
})

describe('privacy oracle mutants', () => {
  it('an internal identifier appearing in export fails confinement', () => {
    expect(privacyExportVerdict({ exportFactCount: 2, confinedToRequesterRoom: false }).passed).toBe(false)
  })

  it('forgotten data reappearing in export after reopen fails', () => {
    const verdicts = privacyDeletionVerdicts({ forgottenAbsentFromContext: true, forgottenAbsentFromExport: false })
    expect(verdicts.find(v => v.assertionId === 'PRIV-002-B')!.passed).toBe(false)
  })

  it('a disabled operation returning success fails', () => {
    expect(capabilityRefusalVerdict({ rememberRefused: false, correctRefused: true, semanticWriteCount: 0 }).passed).toBe(false)
  })

  it('a disabled operation that writes a semantic record fails', () => {
    expect(capabilityRefusalVerdict({ rememberRefused: true, correctRefused: true, semanticWriteCount: 1 }).passed).toBe(false)
  })

  it('a correct refusal with zero writes passes', () => {
    expect(capabilityRefusalVerdict({ rememberRefused: true, correctRefused: true, semanticWriteCount: 0 }).passed).toBe(true)
  })
})
