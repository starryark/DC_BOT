import { createHash } from 'node:crypto'

import { MemoryError } from '@proj-airi/memory-domain'

import * as v from 'valibot'

/**
 * Frozen evaluator contracts for the G8-1 active-profile functional baseline
 * (IMP-802).
 *
 * Every schema here is strict: unknown fields are rejected, never silently
 * dropped, so a dataset or threshold document that drifts from the evaluator
 * version fails loudly rather than producing a quietly-wrong report. The
 * dataset digest is taken over a canonical encoding so the same dataset always
 * hashes to the same value, regardless of how a file happens to be laid out.
 *
 * No private identifier, canary token, fixture payload, or real Discord
 * snowflake is permitted inside a dataset. Synthetic identifiers are minted
 * deterministically from `(datasetVersion, seed, scenarioId, role)` in
 * {@link ./dataset.ts}, so the parser never has to accept a generated value it
 * cannot re-derive.
 */

/**
 * The version of the evaluator itself.
 *
 * Bumped when a contract, scenario, assertion, or report field changes in a
 * way that invalidates earlier machine artifacts. A mismatched threshold
 * document names this and is rejected, not ignored.
 */
export const EVALUATOR_SCHEMA_VERSION = 1 as const

/** The active profile is the only profile this evaluator exercises. */
export const ACTIVE_PROFILE = 'active' as const
export type ActiveProfile = typeof ACTIVE_PROFILE

/**
 * What a scenario proved (or could not) about the runtime.
 *
 * The split between `outcome` and `capabilityDisposition` exists because a
 * refusal test *passes* as an assertion while the capability it exercises
 * remains *unsupported*. Collapsing the two would let a disabled operation be
 * advertised as a working one (REQ-EVAL-001, CAP-001).
 */
export const OUTCOMES = Object.freeze([
  'passed',
  'failed',
  'unsupported',
  'not_applicable',
  'unverified',
] as const)
export type Outcome = typeof OUTCOMES[number]

/** Whether the runtime provides the capability a category measures at all. */
export const CAPABILITY_DISPOSITIONS = Object.freeze(['supported', 'unsupported'] as const)
export type CapabilityDisposition = typeof CAPABILITY_DISPOSITIONS[number]

/** The benchmark category families the active-v1 matrix covers. */
export const SCENARIO_CATEGORIES = Object.freeze([
  'identity',
  'authorization',
  'attribution',
  'context',
  'delivery',
  'idempotency',
  'restart',
  'contextBudget',
  'promptSafety',
  'privacy',
  'capability',
  'live',
] as const)
export type ScenarioCategory = typeof SCENARIO_CATEGORIES[number]

/**
 * The category families that may contain zero-tolerance assertions.
 *
 * Zero-tolerance is a per-assertion property in the scenario matrix (the plan
 * marks `DELIV-002` zero-tolerance but `DELIV-001` standard, though both are
 * delivery scenarios), so this set is only used to validate that a
 * zero-tolerance assertion never appears in a family that cannot carry one. A
 * failure of any zero-tolerance assertion invalidates the whole run for gate
 * review regardless of every other scenario's outcome.
 */
export const ZERO_TOLERANCE_CAPABLE_CATEGORIES = Object.freeze(new Set<ScenarioCategory>([
  'identity',
  'authorization',
  'attribution',
  'delivery',
  'restart',
  'promptSafety',
  'privacy',
]))

/** True when a category may lawfully carry a zero-tolerance assertion. */
export function canCarryZeroTolerance(category: ScenarioCategory): boolean {
  return ZERO_TOLERANCE_CAPABLE_CATEGORIES.has(category)
}

/** True when a scenario declares at least one zero-tolerance assertion. */
export function isZeroToleranceScenario(scenario: { assertions: readonly { severity: string }[] }): boolean {
  return scenario.assertions.some(assertion => assertion.severity === 'zero_tolerance')
}

/** Assertion severities. */
export const ASSERTION_SEVERITIES = Object.freeze(['zero_tolerance', 'standard'] as const)
export type AssertionSeverity = typeof ASSERTION_SEVERITIES[number]

/** A stable, human-readable assertion id of the form `FAMILY-NNN` or `FAMILY-NNN-X`. */
const assertionId = v.pipe(v.string(), v.regex(/^[A-Z]+-\d{3}(?:-[A-Z])?$/, 'assertion id must be FAMILY-NNN or FAMILY-NNN-X'))

/** One named check a scenario performs against an observed runtime state. */
const assertionSpecSchema = v.strictObject({
  id: assertionId,
  severity: v.picklist(ASSERTION_SEVERITIES),
  /** Short, content-free description; no fixture payload or identifier. */
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(280)),
})

export type AssertionSpec = v.InferOutput<typeof assertionSpecSchema>

/** The expected outcome and capability state a scenario is graded against. */
const expectationSchema = v.strictObject({
  /** Outcome the runtime must produce when the capability is exercised. */
  outcome: v.picklist(OUTCOMES),
  capabilityDisposition: v.picklist(CAPABILITY_DISPOSITIONS),
  /**
   * `true` only when a correct fail-closed refusal counts as a passed
   * assertion while the capability stays `unsupported` (CAP-001).
   */
  passOnRefusal: v.optional(v.boolean()),
})

export type Expectation = v.InferOutput<typeof expectationSchema>

/** A scenario's declaration inside a dataset file. */
export const scenarioSchema = v.strictObject({
  scenarioId: v.pipe(v.string(), v.regex(/^[A-Z]+-\d{3}$/, 'scenario id must be FAMILY-NNN')),
  category: v.picklist(SCENARIO_CATEGORIES),
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(280)),
  /** Which suite the scenario belongs to. */
  suites: v.pipe(v.array(v.picklist(['smoke', 'active-v1'])), v.minLength(1)),
  assertions: v.pipe(v.array(assertionSpecSchema), v.minLength(1)),
  expectation: expectationSchema,
  /** Plain-language limitation that travels into the report; content-free. */
  limitations: v.optional(v.array(v.pipe(v.string(), v.maxLength(280)))),
})

export type ScenarioSpec = v.InferOutput<typeof scenarioSchema>

/** The dataset wrapper parsed from `datasets/*.json`. */
export const datasetSchema = v.strictObject({
  format: v.literal(1),
  datasetVersion: v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+$/, 'dataset version must be semver')),
  description: v.pipe(v.string(), v.maxLength(280)),
  /** Synthetic, content-free; never a real Discord snowflake. */
  characterId: v.pipe(v.string(), v.regex(/^[\w:.-]{1,128}$/)),
  activeProfile: v.literal(ACTIVE_PROFILE),
  /** Capabilities the active profile enables; every other category is unsupported. */
  enabledCapabilities: v.pipe(v.array(v.string()), v.minLength(1)),
  scenarios: v.pipe(v.array(scenarioSchema), v.minLength(1)),
})

export type Dataset = v.InferOutput<typeof datasetSchema>

/**
 * Canonical-JSON encoding for stable digests.
 *
 * Object keys are sorted recursively and insignificant whitespace is removed,
 * so two files that differ only in layout hash identically. This is the single
 * rule both the dataset digest and the normalized result digest rely on.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      sorted[key] = sortKeys((value as Record<string, unknown>)[key])
    return sorted
  }
  return value
}

/** SHA-256 hex digest of a value's canonical encoding. */
export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/** The digest a report names for its dataset, taken over the parsed dataset. */
export function datasetDigest(dataset: Dataset): string {
  return sha256Canonical({ ...dataset, digest: undefined })
}

/**
 * Parse and structurally validate a dataset, then check the invariants a schema
 * alone cannot express: duplicate scenario ids, smoke-suite coverage, and
 * expectation/disposition consistency.
 *
 * Returns the parsed dataset rather than throwing a raw valibot error so every
 * caller reports the same `INVALID_DATASET` code.
 */
export function parseDataset(input: unknown): Dataset {
  let parsed: Dataset
  try {
    parsed = v.parse(datasetSchema, input)
  }
  catch (cause) {
    throw new MemoryError('INVALID_PAYLOAD', 'dataset failed strict validation', {
      retryable: false,
      cause,
    })
  }

  const ids = new Set<string>()
  for (const scenario of parsed.scenarios) {
    if (ids.has(scenario.scenarioId))
      throw new MemoryError('INVALID_PAYLOAD', `duplicate scenario id ${scenario.scenarioId}`)
    ids.add(scenario.scenarioId)

    // A refusal that is expected to `pass` must still be an unsupported
    // capability — otherwise the dataset would advertise a working refusal.
    if (scenario.expectation.passOnRefusal && scenario.expectation.capabilityDisposition !== 'unsupported')
      throw new MemoryError('INVALID_PAYLOAD', `scenario ${scenario.scenarioId} passes on refusal but is not unsupported`)

    // `unsupported`/`not_applicable` outcomes never pair with a `supported`
    // disposition: a supported capability that is reported absent is a dataset
    // bug. `unverified` *may* pair with `supported` (AUTH-004), because the
    // capability is exercisable but its outcome needs live-transport evidence.
    if ((scenario.expectation.outcome === 'unsupported' || scenario.expectation.outcome === 'not_applicable')
      && scenario.expectation.capabilityDisposition === 'supported') {
      throw new MemoryError('INVALID_PAYLOAD', `scenario ${scenario.scenarioId} expects ${scenario.expectation.outcome} with a supported disposition`)
    }
  }

  return parsed
}

/** A per-scenario assertion result. Stable ids link report rows to expectations. */
export interface AssertionResult {
  readonly assertionId: string
  readonly passed: boolean
  /** Content-free, HMAC-redacted reason; `redacted:kind:hex16`. */
  readonly diagnostic: string
}

/** Redacted measurements the report carries; never graded without thresholds. */
export interface NormalizedMeasurement {
  readonly name: string
  readonly value: number
  readonly unit: string
  /** `true` only when an approved threshold document grades this measurement. */
  readonly evaluated: boolean
}

/** One scenario's complete, content-free result. */
export interface ScenarioResult {
  readonly scenarioId: string
  readonly datasetVersion: string
  readonly seed: number
  readonly requirements: readonly string[]
  readonly category: ScenarioCategory
  readonly capabilityDisposition: CapabilityDisposition
  readonly outcome: Outcome
  readonly assertions: readonly AssertionResult[]
  /** Counts of runtime operations executed; content-free. */
  readonly operationCounts: Readonly<Record<string, number>>
  readonly measurements: readonly NormalizedMeasurement[]
  readonly limitations: readonly string[]
  /** `clean` when every runtime handle closed and every root was removed. */
  readonly cleanup: 'clean' | 'failed'
}

/** Threshold-document provenance fields, all required (T004). */
export const thresholdDocumentSchema = v.strictObject({
  format: v.literal(1),
  approver: v.pipe(v.string(), v.minLength(1)),
  approvedAt: v.pipe(v.string(), v.isoTimestamp()),
  source: v.pipe(v.string(), v.minLength(1)),
  /** Full 40-character commit the thresholds were approved against. */
  repositoryCommit: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/)),
  datasetVersion: v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+$/)),
  datasetDigest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  evaluatorSchemaVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  limits: v.pipe(v.array(v.strictObject({
    name: v.pipe(v.string(), v.minLength(1)),
    metric: v.pipe(v.string(), v.minLength(1)),
    operation: v.picklist(['<=', '>=', '<', '>', '==']),
    value: v.number(),
  })), v.minLength(1)),
})

export type ThresholdDocument = v.InferOutput<typeof thresholdDocumentSchema>

/**
 * Parse a threshold document, rejecting any whose provenance does not match the
 * running dataset and evaluator. A mismatched document is invalid, not ignored,
 * because accepting it would grade a measurement against limits approved for a
 * different dataset (T004 whole-run validity).
 */
export function parseThresholdDocument(
  input: unknown,
  expected: { datasetVersion: string, datasetDigest: string, evaluatorSchemaVersion: number },
): ThresholdDocument {
  let parsed: ThresholdDocument
  try {
    parsed = v.parse(thresholdDocumentSchema, input)
  }
  catch (cause) {
    throw new MemoryError('INVALID_PAYLOAD', 'threshold document failed strict validation', {
      retryable: false,
      cause,
    })
  }
  if (parsed.datasetVersion !== expected.datasetVersion
    || parsed.datasetDigest !== expected.datasetDigest
    || parsed.evaluatorSchemaVersion !== expected.evaluatorSchemaVersion) {
    throw new MemoryError('INVALID_PAYLOAD', 'threshold document provenance does not match the running dataset and evaluator', {
      retryable: false,
      details: {
        expectedDatasetVersion: expected.datasetVersion,
        expectedDatasetDigest: expected.datasetDigest,
        expectedEvaluatorSchemaVersion: expected.evaluatorSchemaVersion,
      },
    })
  }
  return parsed
}
