import type { Dataset, ScenarioSpec } from './contracts'

import { createHash } from 'node:crypto'

import { MemoryError } from '@proj-airi/memory-domain'

import { parseDataset, sha256Canonical } from './contracts'

/**
 * Deterministic synthetic-value generation and the active-v1 dataset.
 *
 * Every generated identifier, canary token, idempotency key, and timestamp is
 * derived from `(datasetVersion, seed, scenarioId, role)` through a stable
 * hash. The evaluator never consults `Math.random`, `Date.now`, or a UUID
 * generator for an *expected* value; volatile runtime values may be recorded,
 * but they are excluded from the normalized digest in {@link ./report.ts}.
 *
 * The synthetic identifiers are deliberately shaped like real Discord
 * snowflakes (17-20 digits) so the adapter exercises the production parser
 * paths, but they are drawn from a synthetic-only range and never reach a
 * report: the redaction scan in {@link ./report.ts} treats any bare long digit
 * run as prohibited content.
 */

/**
 * The documented stable baseline seed. Used as the CLI default and in every
 * evidence record, so a run's identity is reproducible from its commit + seed.
 */
export const DEFAULT_SEED = 20260802

/** Active-v1 dataset identity; the digest is verified at parse time. */
export const ACTIVE_V1_VERSION = '1.0.0'

/** Stable hash input namespace; `role` keeps unrelated values uncorrelated. */
export function syntheticHash(datasetVersion: string, seed: number, scenarioId: string, role: string): string {
  return createHash('sha256').update(`${datasetVersion}\0${seed}\0${scenarioId}\0${role}`).digest('hex')
}

/**
 * A synthetic Discord snowflake drawn from a range real Discord has not reached.
 *
 * Snowflakes are millisecond timestamps shifted left 22 bits; the values here
 * are kept under 18 digits and above 17 so they pass the parser's shape check
 * without colliding with anything Discord could ever issue. The same input
 * always yields the same snowflake.
 */
export function syntheticSnowflake(datasetVersion: string, seed: number, scenarioId: string, role: string): string {
  const hex = syntheticHash(datasetVersion, seed, scenarioId, role)
  // Take 52 bits (13 hex chars) and mask into the [10^16, 10^17) synthetic band.
  const bits = BigInt(`0x${hex.slice(0, 13)}`) & 0xFFFFFFFFFFFFFn
  return String(10_000_000_000_000_000n + (bits % 80_000_000_000_000_000n))
}

/** A stable idempotency key for a scenario operation; content-free token shape. */
export function syntheticIdempotencyKey(datasetVersion: string, seed: number, scenarioId: string, role: string): string {
  return `key-${syntheticHash(datasetVersion, seed, scenarioId, role).slice(0, 24)}`
}

/** A canary token planted in a fixture payload to detect leakage; never reported. */
export function syntheticCanary(datasetVersion: string, seed: number, scenarioId: string, role: string): string {
  return `canary-${syntheticHash(datasetVersion, seed, scenarioId, role).slice(0, 16)}`
}

/**
 * A deterministic RFC 3339 UTC timestamp inside a scenario's window.
 *
 * Ordering is driven by `offsetSeconds` and, as a fallback, by a trailing
 * integer in `role` (so `t1`, `t2`, `evt-3` order naturally without callers
 * passing offsets). A larger offset always produces a later timestamp: the hash
 * contributes only a per-scenario base that is constant across roles, so two
 * timestamps in the same scenario are ordered by their offset alone.
 *
 * The base epoch is fixed, so the same seed reproduces the same timeline.
 */
export function syntheticTimestamp(datasetVersion: string, seed: number, scenarioId: string, role: string, offsetSeconds = 0): string {
  // Per-scenario base: every timestamp in one scenario shares it, so offsets
  // within the scenario are strictly monotonic. Different scenarios get
  // different bases so their windows never touch.
  const scenarioBase = Number(BigInt(`0x${syntheticHash(datasetVersion, seed, scenarioId, 'scenario-base').slice(0, 12)}`) % 3600n)
  const base = 1_800_000_000_000 + seed * 1000 + scenarioBase * 1000
  // A trailing integer in the role (t1, evt-2, seg-3) contributes to ordering
  // so legacy callers that named roles sequentially get monotonic timestamps.
  const roleSuffix = Number(/(\d+)\D*$/.exec(role)?.[1] ?? 0)
  const effectiveOffset = offsetSeconds + roleSuffix
  return new Date(base + effectiveOffset * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * The scenario matrix documented in the G8-1 plan §5.
 *
 * Each row's expectation encodes the disposition the plan names. Refusal
 * scenarios (CAP-001) pass while remaining `unsupported`; every deferred
 * category (CAP-002, LIVE-*) is explicitly classified rather than omitted, so
 * the report can never pass a capability by saying nothing about it.
 *
 * Add a row here and it appears in every suite it lists; the parser rejects a
 * dataset whose smoke suite drops a required scenario.
 */
const ACTIVE_V1_SCENARIOS: readonly ScenarioSpec[] = Object.freeze([
  {
    scenarioId: 'ID-001',
    category: 'identity',
    title: 'Two people with the same visible name remain distinct',
    suites: ['smoke', 'active-v1'],
    assertions: [{ id: 'ID-001-A', severity: 'zero_tolerance', description: 'same-name speakers resolve to distinct durable persons' }],
    expectation: { outcome: 'passed', capabilityDisposition: 'supported' },
  },
  {
    scenarioId: 'ID-002',
    category: 'identity',
    title: 'A presentation rename preserves continuity and historical evidence',
    suites: ['active-v1'],
    assertions: [
      { id: 'ID-002-A', severity: 'zero_tolerance', description: 'current display updates without creating a new person' },
      { id: 'ID-002-B', severity: 'standard', description: 'historical events remain attributable to the same person' },
    ],
    expectation: { outcome: 'passed', capabilityDisposition: 'supported' },
  },
  {
    scenarioId: 'AUTH-001',
    category: 'authorization',
    title: 'Guild-scoped data never enters another guild context or export',
    suites: ['smoke', 'active-v1'],
    assertions: [{ id: 'AUTH-001-A', severity: 'zero_tolerance', description: 'cross-guild context and export are empty of the other guild' }],
    expectation: { outcome: 'passed', capabilityDisposition: 'supported' },
  },
  {
    scenarioId: 'AUTH-002',
    category: 'authorization',
    title: 'Logical-room and unbound-room isolation fail closed',
    suites: ['active-v1'],
    assertions: [{ id: 'AUTH-002-A', severity: 'zero_tolerance', description: 'a room without scope grant denies context reads' }],
    expectation: { outcome: 'passed', capabilityDisposition: 'supported' },
  },
  {
    scenarioId: 'AUTH-003',
    category: 'authorization',
    title: 'Character-scoped data never enters another character context',
    suites: ['active-v1'],
    assertions: [{ id: 'AUTH-003-A', severity: 'zero_tolerance', description: 'a second character sees no first-character context' }],
    expectation: { outcome: 'passed', capabilityDisposition: 'supported' },
  },
  {
    scenarioId: 'AUTH-004',
    category: 'authorization',
    title: 'Synthetic DM authority scope stays isolated from guild scope',
    suites: ['active-v1'],
    assertions: [{ id: 'AUTH-004-A', severity: 'standard', description: 'DM authority does not read guild context' }],
    expectation: { outcome: 'unverified', capabilityDisposition: 'supported' },
    limitations: ['live DM transport is explicitly unverified; only the authority scope is exercised'],
  },
  {
    scenarioId: 'ATTR-001',
    category: 'attribution',
    title: 'Multi-speaker input preserves each actor and the complete cause set',
    suites: ['active-v1'],
    assertions: [
      { id: 'ATTR-001-A', severity: 'zero_tolerance', description: 'each speaker resolves to a distinct attributed actor' },
      { id: 'ATTR-001-B', severity: 'zero_tolerance', description: 'the generation cause set names every triggering event' },
    ],
    expectation: { outcome: 'passed', capabilityDisposition: 'supported' },
  },
  {
    scenarioId: 'CONT-001',
    category: 'context',
    title: 'Text input is eligible for later voice context in the same room',
    suites: ['active-v1'],
    assertions: [{ id: 'CONT-001-A', severity: 'standard', description: 'a later voice-context manifest includes the text event' }],
    expectation: { outcome: 'passed', capabilityDisposition: 'supported' },
  },
  {
    scenarioId: 'CONT-002',
    category: 'context',
    title: 'Voice input is eligible for later text context in the same room',
    suites: ['active-v1'],
    assertions: [{ id: 'CONT-002-A', severity: 'standard', description: 'a later text-context manifest includes the voice event' }],
    expectation: { outcome: 'passed', capabilityDisposition: 'supported' },
  },
  {
    scenarioId: 'DELIV-001',
    category: 'delivery',
    title: 'Completed eligible output enters context with exact manifest identity',
    suites: ['active-v1'],
    assertions: [{ id: 'DELIV-001-A', severity: 'standard', description: 'delivered segment ids in context equal the manifest ids' }],
    expectation: { outcome: 'passed', capabilityDisposition: 'supported' },
  },
  {
    scenarioId: 'DELIV-002',
    category: 'delivery',
    title: 'Partial, failed, and unknown-after-crash output never enters context',
    suites: ['smoke', 'active-v1'],
    assertions: [
      { id: 'DELIV-002-A', severity: 'zero_tolerance', description: 'partially delivered segment is excluded from completed context' },
      { id: 'DELIV-002-B', severity: 'zero_tolerance', description: 'failed delivery is excluded from completed context' },
      { id: 'DELIV-002-C', severity: 'zero_tolerance', description: 'unknown-after-crash delivery is excluded from completed context' },
    ],
    expectation: { outcome: 'passed', capabilityDisposition: 'supported' },
  },
  {
    scenarioId: 'IDEMP-001',
    category: 'idempotency',
    title: 'Duplicate idempotency keys do not duplicate durable records',
    suites: ['active-v1'],
    assertions: [
      { id: 'IDEMP-001-A', severity: 'standard', description: 'duplicate event append is deduplicated' },
      { id: 'IDEMP-001-B', severity: 'standard', description: 'duplicate generation begin is deduplicated' },
      { id: 'IDEMP-001-C', severity: 'standard', description: 'duplicate delivery begin is deduplicated' },
    ],
    expectation: { outcome: 'passed', capabilityDisposition: 'supported' },
  },
  {
    scenarioId: 'RESTART-001',
    category: 'restart',
    title: 'Close and reopen the same root preserves context and deletion state',
    suites: ['smoke', 'active-v1'],
    assertions: [
      { id: 'RESTART-001-A', severity: 'standard', description: 'reopened context matches pre-close context' },
      { id: 'RESTART-001-B', severity: 'zero_tolerance', description: 'forgotten data stays absent after reopen' },
    ],
    expectation: { outcome: 'passed', capabilityDisposition: 'supported' },
  },
  {
    scenarioId: 'CONTEXT-001',
    category: 'contextBudget',
    title: 'Item and character budgets select the expected manifest and truncation',
    suites: ['active-v1'],
    assertions: [
      { id: 'CONTEXT-001-A', severity: 'standard', description: 'item budget caps the selected manifest length' },
      { id: 'CONTEXT-001-B', severity: 'standard', description: 'character budget sets truncation as expected' },
    ],
    expectation: { outcome: 'passed', capabilityDisposition: 'supported' },
  },
  {
    scenarioId: 'PROMPT-001',
    category: 'promptSafety',
    title: 'Role markers, mass mentions, bidi, and malicious aliases stay untrusted',
    suites: ['smoke', 'active-v1'],
    assertions: [{ id: 'PROMPT-001-A', severity: 'zero_tolerance', description: 'payload serializes as length-prefixed data with no chat role' }],
    expectation: { outcome: 'passed', capabilityDisposition: 'supported' },
  },
  {
    scenarioId: 'PRIV-001',
    category: 'privacy',
    title: 'Status, show, and export expose only requester authorized room data',
    suites: ['active-v1'],
    assertions: [{ id: 'PRIV-001-A', severity: 'zero_tolerance', description: 'export carries only the requester room facts' }],
    expectation: { outcome: 'passed', capabilityDisposition: 'supported' },
  },
  {
    scenarioId: 'PRIV-002',
    category: 'privacy',
    title: 'Forget then close/reopen never re-exposes deleted data',
    suites: ['smoke', 'active-v1'],
    assertions: [
      { id: 'PRIV-002-A', severity: 'zero_tolerance', description: 'forgotten data is absent from context after reopen' },
      { id: 'PRIV-002-B', severity: 'zero_tolerance', description: 'forgotten data is absent from export after reopen' },
    ],
    expectation: { outcome: 'passed', capabilityDisposition: 'supported' },
  },
  {
    scenarioId: 'CAP-001',
    category: 'capability',
    title: 'Remember and correct return disabled-capability outcome with no mutation',
    suites: ['smoke', 'active-v1'],
    assertions: [{ id: 'CAP-001-A', severity: 'standard', description: 'remember and correct return capability_disabled and write nothing' }],
    expectation: { outcome: 'passed', capabilityDisposition: 'unsupported', passOnRefusal: true },
  },
  {
    scenarioId: 'CAP-002',
    category: 'capability',
    title: 'Deferred retrieval categories are explicitly classified',
    suites: ['active-v1'],
    assertions: [{ id: 'CAP-002-A', severity: 'standard', description: 'every deferred category has an explicit disposition' }],
    expectation: { outcome: 'unsupported', capabilityDisposition: 'unsupported' },
    limitations: [
      'vector, graph, remote, degraded, spool, summary, extraction, lexical, and semantic are unsupported in the active profile',
    ],
  },
  {
    scenarioId: 'LIVE-001',
    category: 'live',
    title: 'Live Discord DM ingress and delivery',
    suites: ['active-v1'],
    assertions: [{ id: 'LIVE-001-A', severity: 'standard', description: 'requires live transport evidence outside this harness' }],
    expectation: { outcome: 'unverified', capabilityDisposition: 'unsupported' },
    limitations: ['live Discord DM transport is not exercised by this deterministic harness'],
  },
  {
    scenarioId: 'LIVE-002',
    category: 'live',
    title: 'Acoustic barge-in cancellation under shipped configuration',
    suites: ['active-v1'],
    assertions: [{ id: 'LIVE-002-A', severity: 'standard', description: 'requires acoustic evidence outside G8-1' }],
    expectation: { outcome: 'unverified', capabilityDisposition: 'unsupported' },
    limitations: ['acoustic barge-in is outside the G8-1 scope'],
  },
  {
    scenarioId: 'LIVE-003',
    category: 'live',
    title: 'Provider latency, cost, and deployment-host performance',
    suites: ['active-v1'],
    assertions: [{ id: 'LIVE-003-A', severity: 'standard', description: 'requires provider and deployment evidence outside this harness' }],
    expectation: { outcome: 'unverified', capabilityDisposition: 'unsupported' },
    limitations: ['provider latency, cost, and host performance are not measured here'],
  },
])

/** The smoke-suite subset the plan §5 names as the minimum coverage. */
export const SMOKE_SUITE_REQUIRED_IDS = Object.freeze([
  'ID-001',
  'AUTH-001',
  'DELIV-002',
  'RESTART-001',
  'PROMPT-001',
  'PRIV-002',
  'CAP-001',
])

/** Scenarios belonging to a named suite, in matrix order. */
export function scenariosForSuite(dataset: Dataset, suite: 'smoke' | 'active-v1'): readonly ScenarioSpec[] {
  return dataset.scenarios.filter(scenario => scenario.suites.includes(suite))
}

/** The active-v1 dataset object, before strict parsing. */
export function activeV1DatasetObject(): unknown {
  return {
    format: 1,
    datasetVersion: ACTIVE_V1_VERSION,
    description: 'G8-1 active-profile functional baseline scenario matrix',
    characterId: 'eval-character',
    activeProfile: 'active',
    enabledCapabilities: [
      'durableEvents',
      'actorSnapshots',
      'roomBindings',
      'sharedRecentContext',
      'deliveryLifecycle',
    ],
    scenarios: ACTIVE_V1_SCENARIOS,
  }
}

/** Parse and validate the active-v1 dataset; throws on any invariant breach. */
export function activeV1Dataset(): Dataset {
  return parseDataset(activeV1DatasetObject())
}

/** Canonical-JSON digest of the active-v1 dataset; stable across file layout. */
export function activeV1Digest(): string {
  return sha256Canonical(activeV1DatasetObject())
}

/** The parsed dataset for a suite name; `active-v1` is the whole matrix. */
export function datasetForSuite(suite: 'smoke' | 'active-v1'): { dataset: Dataset, scenarios: readonly ScenarioSpec[] } {
  const dataset = activeV1Dataset()
  const scenarios = scenariosForSuite(dataset, suite)
  if (suite === 'smoke') {
    const present = new Set(scenarios.map(scenario => scenario.scenarioId))
    for (const required of SMOKE_SUITE_REQUIRED_IDS) {
      if (!present.has(required))
        throw new MemoryError('INVALID_PAYLOAD', `smoke suite is missing required scenario ${required}`)
    }
  }
  return { dataset, scenarios }
}
