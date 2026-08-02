/**
 * Shared-memory rollout flags and the rollback state machine
 * (`artifacts/19-rollout-feature-flags-rollback.md` §9.1, §10; IMP-002).
 *
 * Everything here is a pure function over a {@link MemoryFeatureFlags} record.
 * The env reads live in `config()` (`src/config.ts`) like every other runtime
 * setting; this module owns only the *policy*: which combinations are legal,
 * which rollback transitions are legal, and what the resulting posture is.
 *
 * The policy exists because the dangerous state is not "a flag is wrong" but
 * "durable writes continue while the bot reads unrelated ephemeral history".
 * That is split-brain memory (RISK-001): the durable store accumulates events
 * the bot never used, and when durable reads come back the bot "remembers"
 * things it never experienced.
 */

/**
 * The 16 rollout flags of `19-rollout-feature-flags-rollback.md` §9.1.
 *
 * Every flag defaults to `false`. Rollout stage R1 is "code merged, runtime
 * disabled", so an operator who sets nothing gets exactly today's behavior.
 */
export interface MemoryFeatureFlags {
  /** `FF-DURABLE-EVENTS` — routes raw event ingestion to the durable store. */
  durableEvents: boolean
  /** `FF-ACTOR-SNAPSHOTS` — attaches identity snapshots to events at ingest. */
  actorSnapshots: boolean
  /** `FF-PREFERRED-ALIASES` — scoped alias resolution for addressing/display. */
  preferredAliases: boolean
  /** `FF-SHARED-RECENT-CONTEXT` — recent context reads/writes use the shared durable store. */
  sharedRecentContext: boolean
  /** `FF-ROOM-BINDINGS` — logical room resolution. */
  roomBindings: boolean
  /** `FF-DELIVERY-LIFECYCLE` — durable tracking of assistant delivery states. */
  deliveryLifecycle: boolean
  /** `FF-SUMMARIES` — generation and retrieval of conversation summaries. */
  summaries: boolean
  /** `FF-EXPLICIT-SEMANTIC-MEMORY` — storage/retrieval of explicitly commanded facts. */
  explicitSemanticMemory: boolean
  /** `FF-AUTO-EXTRACTION` — background extraction of semantic facts. */
  autoExtraction: boolean
  /** `FF-FULLTEXT-RETRIEVAL` — lexical/full-text recall. */
  fulltextRetrieval: boolean
  /** `FF-VECTOR-RETRIEVAL` — vector recall. Gated on a benchmark (ADR-011). */
  vectorRetrieval: boolean
  /** `FF-ON-DEMAND-RECALL` — recall triggered automatically rather than on demand. */
  onDemandRecall: boolean
  /** `FF-RELATIONSHIP-HYPOTHESES` — experimental graph construction. Gated (ADR-011). */
  relationshipHypotheses: boolean
  /** `FF-REMOTE-TRANSPORT` — MemoryPort over HTTP instead of in-process. Gated (ADR-001). */
  remoteTransport: boolean
  /** `FF-DEGRADED-STATELESS-MODE` — global fallback: halt memory reads, spool writes. */
  degradedStatelessMode: boolean
  /** `FF-DURABLE-WRITE-SPOOL` — queue durable writes so they survive transient store failure. */
  durableWriteSpool: boolean
}

/** All flags off: rollout stage R1, runtime disabled, today's behavior. */
export const MEMORY_FLAGS_ALL_OFF: Readonly<MemoryFeatureFlags> = Object.freeze({
  durableEvents: false,
  actorSnapshots: false,
  preferredAliases: false,
  sharedRecentContext: false,
  roomBindings: false,
  deliveryLifecycle: false,
  summaries: false,
  explicitSemanticMemory: false,
  autoExtraction: false,
  fulltextRetrieval: false,
  vectorRetrieval: false,
  onDemandRecall: false,
  relationshipHypotheses: false,
  remoteTransport: false,
  degradedStatelessMode: false,
  durableWriteSpool: false,
})

/**
 * States of the rollback state machine (`19-…` §10.1).
 *
 * - `ephemeral` (S0) — no durable writes; the legacy process-local histories are authoritative.
 * - `durableShadow` (S1) — durable shadow writes; reads still come from the legacy histories.
 * - `durableActive` (S2) — the durable store is the source of truth for recent context.
 * - `degradedStateless` (S3) — memory reads halted, writes spooled to disk for later backfill.
 *
 * `degradedStateless` deliberately takes precedence over the other three: once
 * the operator has declared the durable authority unusable, the bot is
 * stateless regardless of which read tiers are nominally enabled.
 */
export type MemoryRolloutState = 'ephemeral' | 'durableShadow' | 'durableActive' | 'degradedStateless'

/**
 * Why a flag combination or rollback transition was rejected.
 *
 * - `missingPrerequisite` — a tier was enabled before the tier it reads from.
 * - `gateNotMet` — the flag's evidence gate (benchmark / topology ADR) is unmet.
 * - `splitBrain` — durable writes would continue under ephemeral reads.
 * - `unspooledDegradedMode` — degraded mode with nowhere to defer writes.
 * - `illegalTransition` — not an edge of the rollback state machine.
 */
export type MemoryFlagViolationCode
  = | 'missingPrerequisite'
    | 'gateNotMet'
    | 'splitBrain'
    | 'unspooledDegradedMode'
    | 'illegalTransition'

/** A single rejected aspect of a proposed flag set or transition. */
export interface MemoryFlagViolation {
  code: MemoryFlagViolationCode
  /** The flag the operator must change; `null` when the whole transition is illegal. */
  flag: keyof MemoryFeatureFlags | null
  /** Operator-facing explanation, including the remedy. */
  detail: string
}

/**
 * Tier prerequisites, in rollout-stage order (`19-…` §9.2 stages 1-11).
 *
 * A tier may only be enabled once every tier it reads from is enabled, so a
 * rollback of a lower tier can never leave a higher tier reading a store that
 * is no longer being written.
 */
const PREREQUISITES: Partial<Record<keyof MemoryFeatureFlags, readonly (keyof MemoryFeatureFlags)[]>> = {
  actorSnapshots: ['durableEvents'],
  preferredAliases: ['actorSnapshots'],
  roomBindings: ['durableEvents'],
  sharedRecentContext: ['durableEvents', 'roomBindings'],
  deliveryLifecycle: ['durableEvents'],
  summaries: ['sharedRecentContext'],
  explicitSemanticMemory: ['durableEvents'],
  autoExtraction: ['explicitSemanticMemory'],
  fulltextRetrieval: ['durableEvents'],
  onDemandRecall: ['fulltextRetrieval'],
  vectorRetrieval: ['fulltextRetrieval'],
  relationshipHypotheses: ['vectorRetrieval'],
}

/**
 * Flags whose evidence gate is unmet for milestone 1, with the decision that
 * holds them shut. These are refused even when their prerequisites are
 * satisfied: the gate is evidence, not configuration.
 */
const M1_GATED: Partial<Record<keyof MemoryFeatureFlags, string>> = {
  vectorRetrieval: 'ADR-011: vector retrieval requires an accepted benchmark (IMP-607) before it may be enabled',
  relationshipHypotheses: 'ADR-011: graph/relationship work requires an accepted benchmark before it may be enabled',
  remoteTransport: 'ADR-001: milestone 1 is in-process only; a standalone runtime requires the topology decision at IMP-806',
}

/**
 * Classify a flag set into a rollback-state-machine state.
 *
 * Note the precedence: `degradedStatelessMode` wins over everything, because
 * it is the operator's assertion that durable reads must not happen at all.
 */
export function rolloutStateOf(flags: MemoryFeatureFlags): MemoryRolloutState {
  if (flags.degradedStatelessMode)
    return 'degradedStateless'
  if (!flags.durableEvents)
    return 'ephemeral'
  return flags.sharedRecentContext ? 'durableActive' : 'durableShadow'
}

/**
 * Reject flag combinations that are unsafe on their own, independent of how
 * the system got there.
 *
 * Returns every violation rather than the first, so an operator editing
 * `.config` sees the whole problem in one startup log line.
 */
export function validateMemoryFlags(flags: MemoryFeatureFlags): MemoryFlagViolation[] {
  const violations: MemoryFlagViolation[] = []

  for (const [flag, required] of Object.entries(PREREQUISITES) as [keyof MemoryFeatureFlags, readonly (keyof MemoryFeatureFlags)[]][]) {
    if (!flags[flag])
      continue
    for (const prerequisite of required) {
      if (!flags[prerequisite]) {
        violations.push({
          code: 'missingPrerequisite',
          flag,
          detail: `${flag} requires ${prerequisite}; enable ${prerequisite} first or disable ${flag}`,
        })
      }
    }
  }

  for (const [flag, reason] of Object.entries(M1_GATED) as [keyof MemoryFeatureFlags, string][]) {
    if (flags[flag])
      violations.push({ code: 'gateNotMet', flag, detail: reason })
  }

  // Degraded mode defers writes instead of dropping them; without a spool
  // those writes are simply lost, which is the silent-loss failure ADR-016
  // and artifact 09 F-1 forbid.
  if (flags.degradedStatelessMode && flags.durableEvents && !flags.durableWriteSpool) {
    violations.push({
      code: 'unspooledDegradedMode',
      flag: 'durableWriteSpool',
      detail: 'degradedStatelessMode with durableEvents requires durableWriteSpool, otherwise deferred writes are lost',
    })
  }

  return violations
}

/**
 * Decide whether moving from `current` to `next` is a legal edge of the
 * rollback state machine (`19-…` §10.1, §10.2, TEST-OPS-001).
 *
 * The rule that matters: once the durable store is the source of truth
 * (`durableActive`), turning `sharedRecentContext` off must land in
 * `degradedStateless` or in a full revert that also stops durable writes.
 * Dropping back to shadow mode would resume ephemeral reads while durable
 * writes continue — the split-brain state.
 *
 * NOTICE:
 * `19-…` §10.1 draws `S2 -> S1` as a "Safe Revert", but §10.2 and the
 * testable acceptance criterion TEST-OPS-001 both require degraded mode or a
 * full revert in exactly that situation, and §11 RISK-001 names the shadow
 * configuration as the split-brain hazard. The acceptance criterion is the
 * binding text, so `durableActive -> durableShadow` is rejected here.
 * Recorded as deviation DEV-005 in `docs/memory/implementation-status.md`.
 * Removal condition: a superseding ADR that makes shadow-mode reads durable.
 */
export function validateRollback(current: MemoryFeatureFlags, next: MemoryFeatureFlags): MemoryFlagViolation[] {
  const violations = validateMemoryFlags(next)
  const from = rolloutStateOf(current)
  const to = rolloutStateOf(next)

  if (from === 'durableActive' && to === 'durableShadow') {
    violations.push({
      code: 'splitBrain',
      flag: 'sharedRecentContext',
      detail: 'disabling sharedRecentContext while durableEvents stays on resumes ephemeral reads under durable writes; '
        + 'enable degradedStatelessMode, or disable durableEvents for a full revert',
    })
  }

  if (from === 'durableShadow' && to === 'durableActive' && !next.deliveryLifecycle) {
    // Promoting the durable store to source of truth without delivery states
    // would let generated-but-undelivered output enter context as a normal
    // completed turn (ADR-007, FIND-012, FIND-013).
    violations.push({
      code: 'missingPrerequisite',
      flag: 'deliveryLifecycle',
      detail: 'sharedRecentContext may not become the source of truth without deliveryLifecycle; '
        + 'undelivered output would otherwise enter context as a completed turn',
    })
  }

  const legalEdges: Record<MemoryRolloutState, readonly MemoryRolloutState[]> = {
    ephemeral: ['ephemeral', 'durableShadow'],
    durableShadow: ['durableShadow', 'ephemeral', 'durableActive', 'degradedStateless'],
    durableActive: ['durableActive', 'ephemeral', 'degradedStateless'],
    degradedStateless: ['degradedStateless', 'durableActive', 'durableShadow', 'ephemeral'],
  }
  if (!legalEdges[from].includes(to)) {
    violations.push({
      code: 'illegalTransition',
      flag: null,
      detail: `${from} -> ${to} is not an edge of the rollback state machine`,
    })
  }

  return violations
}

/** What the flag set means for the running bot. */
export interface MemoryPosture {
  state: MemoryRolloutState
  /** True when any durable write path is active. */
  durableWritesEnabled: boolean
  /** True when memory may influence the model prompt. Always false outside `durableActive`. */
  promptUseEnabled: boolean
  /** True when writes must be spooled rather than applied directly. */
  spoolRequired: boolean
  /** Non-empty means the configuration is refused; the caller must fail closed. */
  violations: MemoryFlagViolation[]
}

/**
 * The single status surface the composition root reads.
 *
 * `promptUseEnabled` is false whenever `violations` is non-empty. That is the
 * fail-closed rule: a configuration we cannot validate never gets to shape a
 * prompt, because the alternative is a bot that quietly answers from a memory
 * tier nobody authorized (ADR-016).
 */
export function memoryPosture(flags: MemoryFeatureFlags): MemoryPosture {
  const violations = validateMemoryFlags(flags)
  const state = rolloutStateOf(flags)
  const healthy = violations.length === 0
  return {
    state,
    durableWritesEnabled: healthy && flags.durableEvents,
    promptUseEnabled: healthy && state === 'durableActive',
    spoolRequired: state === 'degradedStateless' || (healthy && flags.durableEvents && flags.durableWriteSpool),
    violations,
  }
}
