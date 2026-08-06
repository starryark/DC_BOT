import type { Dataset, ScenarioResult, ThresholdDocument } from './contracts'
import type { MeasurementEvaluation } from './thresholds'

import { EVALUATOR_SCHEMA_VERSION, isZeroToleranceScenario, OUTCOMES, sha256Canonical } from './contracts'
import { prohibitedContentFindings } from './redaction'
import { evaluateMeasurements } from './thresholds'

/**
 * Report assembly for the G8-1 evaluator (IMP-802, T004).
 *
 * Produces three artifacts: a machine-readable summary, scenario JSON Lines,
 * and a Markdown report. Every artifact is content-free: identifiers are
 * redacted before they reach a report, and a redaction scan rejects any
 * artifact that still carries a snowflake, canary, path, fixture payload, or
 * redaction key.
 *
 * The normalized digest excludes volatile fields (absolute paths, wall-clock
 * timestamps, elapsed-time noise, process ids, platform separators) so two runs
 * of the same seed reproduce byte-identical artifacts.
 */

/** One whole-run summary, written to `summary.json`. */
export interface EvaluationSummary {
  readonly format: 1
  readonly evaluatorSchemaVersion: number
  readonly datasetVersion: string
  readonly datasetDigest: string
  readonly seed: number
  readonly activeProfile: 'active'
  readonly commitSha: string
  readonly platform: string
  readonly generatedAt: string
  readonly counts: {
    readonly total: number
    readonly byOutcome: Readonly<Record<string, number>>
    readonly byCapabilityDisposition: Readonly<Record<string, number>>
  }
  readonly applicablePassed: number
  readonly applicableTotal: number
  readonly zeroToleranceFailures: readonly string[]
  readonly unsupportedCategories: readonly string[]
  readonly unverifiedCategories: readonly string[]
  readonly notApplicableCategories: readonly string[]
  readonly cleanupFailures: number
  readonly limitations: readonly string[]
  readonly thresholdProvenance?: {
    readonly approver: string
    readonly approvedAt: string
    readonly repositoryCommit: string
  }
  readonly approval: { readonly thresholdsApproved: boolean, readonly signedDecision: boolean }
  readonly normalizedResultDigest: string
  readonly measurementStatus: 'measured_not_evaluated' | 'evaluated'
}

/** Whole-run inputs to the report builder. */
export interface ReportInputs {
  readonly dataset: Dataset
  readonly datasetDigest: string
  readonly seed: number
  readonly commitSha: string
  readonly platform: string
  readonly generatedAt: string
  readonly results: readonly (ScenarioResult & { elapsedMs: number })[]
  readonly thresholds?: ThresholdDocument
  readonly limitations?: readonly string[]
}

/** The built report artifacts. */
export interface BuiltReport {
  readonly summary: EvaluationSummary
  readonly scenarioJsonl: string
  readonly markdown: string
  readonly redactionFindings: readonly string[]
}

/**
 * Assemble every report artifact from run results.
 *
 * The summary counts are derived purely from the results; the normalized digest
 * excludes volatile fields so equal-seed runs match. The redaction scan runs
 * over every artifact and surfaces any prohibited content as a finding the CLI
 * turns into a nonzero exit (code 4).
 */
export function buildReport(inputs: ReportInputs): BuiltReport {
  const { dataset, datasetDigest, seed, commitSha, platform, generatedAt, results, thresholds } = inputs
  const byOutcome: Record<string, number> = {}
  const byCapability: Record<string, number> = {}
  for (const outcome of OUTCOMES)
    byOutcome[outcome] = 0
  byCapability.supported = 0
  byCapability.unsupported = 0

  const zeroToleranceFailures: string[] = []
  const unsupportedCategories: string[] = []
  const unverifiedCategories: string[] = []
  const notApplicableCategories: string[] = []
  let cleanupFailures = 0
  let applicablePassed = 0
  let applicableTotal = 0

  for (const result of results) {
    byOutcome[result.outcome] = (byOutcome[result.outcome] ?? 0) + 1
    byCapability[result.capabilityDisposition] = (byCapability[result.capabilityDisposition] ?? 0) + 1

    if (result.cleanup === 'failed')
      cleanupFailures += 1

    // Applicable scenarios contribute to the pass-rate denominator.
    if (result.outcome === 'passed' || result.outcome === 'failed') {
      applicableTotal += 1
      if (result.outcome === 'passed')
        applicablePassed += 1
    }

    if (result.outcome === 'unsupported')
      unsupportedCategories.push(result.scenarioId)
    if (result.outcome === 'unverified')
      unverifiedCategories.push(result.scenarioId)
    if (result.outcome === 'not_applicable')
      notApplicableCategories.push(result.scenarioId)

    // Zero-tolerance failures: any failed assertion on a zero-tolerance scenario.
    const spec = dataset.scenarios.find(s => s.scenarioId === result.scenarioId)
    if (spec && isZeroToleranceScenario(spec)) {
      for (const assertion of result.assertions) {
        if (!assertion.passed) {
          const severity = spec.assertions.find(a => a.id === assertion.assertionId)?.severity
          if (severity === 'zero_tolerance')
            zeroToleranceFailures.push(`${result.scenarioId}/${assertion.assertionId}`)
        }
      }
    }
  }

  const allMeasurements = results.flatMap(result => result.measurements ?? []).filter((m): m is NonNullable<typeof m> => m != null)
  const evaluations: readonly MeasurementEvaluation[] = evaluateMeasurements(allMeasurements, thresholds)
  const evaluated = evaluations.some(e => e.status !== 'measured_not_evaluated')

  const normalized = normalizeForDigest(dataset, results, { datasetDigest, seed })
  const normalizedResultDigest = sha256Canonical(normalized)

  const summary: EvaluationSummary = {
    format: 1,
    evaluatorSchemaVersion: EVALUATOR_SCHEMA_VERSION,
    datasetVersion: dataset.datasetVersion,
    datasetDigest,
    seed,
    activeProfile: 'active',
    commitSha,
    platform,
    generatedAt,
    counts: { total: results.length, byOutcome: Object.freeze(byOutcome), byCapabilityDisposition: Object.freeze(byCapability) },
    applicablePassed,
    applicableTotal,
    zeroToleranceFailures: Object.freeze(zeroToleranceFailures),
    unsupportedCategories: Object.freeze(unsupportedCategories),
    unverifiedCategories: Object.freeze(unverifiedCategories),
    notApplicableCategories: Object.freeze(notApplicableCategories),
    cleanupFailures,
    limitations: Object.freeze(inputs.limitations ?? defaultLimitations(dataset)),
    ...(thresholds ? { thresholdProvenance: { approver: thresholds.approver, approvedAt: thresholds.approvedAt, repositoryCommit: thresholds.repositoryCommit } } : {}),
    approval: { thresholdsApproved: evaluated, signedDecision: false },
    normalizedResultDigest,
    measurementStatus: evaluated ? 'evaluated' : 'measured_not_evaluated',
  }

  const scenarioJsonl = results.map(result => JSON.stringify(redactResult(result))).join('\n').concat('\n')
  const markdown = renderMarkdown(summary, results, dataset)
  const redactionFindings = scanAllArtifacts(summary, scenarioJsonl, markdown)

  return { summary, scenarioJsonl, markdown, redactionFindings }
}

/**
 * The normalized shape digested for reproducibility.
 *
 * Volatile fields are stripped: elapsed time, absolute paths, wall-clock
 * timestamps, and process ids never enter the digest. Scenario order is fixed
 * by dataset order, so shuffling execution does not change a result's
 * contribution to the digest.
 */
function normalizeForDigest(dataset: Dataset, results: readonly (ScenarioResult & { elapsedMs: number })[], meta: { datasetDigest: string, seed: number }): unknown {
  const byId = new Map(results.map(r => [r.scenarioId, r]))
  return {
    datasetVersion: dataset.datasetVersion,
    datasetDigest: meta.datasetDigest,
    seed: meta.seed,
    scenarios: dataset.scenarios.map((spec) => {
      const result = byId.get(spec.scenarioId)
      return result && {
        scenarioId: result.scenarioId,
        category: result.category,
        capabilityDisposition: result.capabilityDisposition,
        outcome: result.outcome,
        cleanup: result.cleanup,
        assertions: result.assertions.map(a => ({ assertionId: a.assertionId, passed: a.passed })),
        operationCounts: result.operationCounts,
      }
    }),
  }
}

/** Strip volatile fields from a per-scenario result before writing JSONL. */
function redactResult(result: ScenarioResult & { elapsedMs: number }): Record<string, unknown> {
  // Elapsed time is volatile and is dropped from the published line.
  return {
    scenarioId: result.scenarioId,
    datasetVersion: result.datasetVersion,
    seed: result.seed,
    requirements: result.requirements,
    category: result.category,
    capabilityDisposition: result.capabilityDisposition,
    outcome: result.outcome,
    assertions: result.assertions,
    operationCounts: result.operationCounts,
    measurements: result.measurements,
    limitations: result.limitations,
    cleanup: result.cleanup,
  }
}

/** Scan every published artifact for prohibited content. */
function scanAllArtifacts(summary: EvaluationSummary, scenarioJsonl: string, markdown: string): readonly string[] {
  const findings = new Set<string>()
  for (const rule of prohibitedContentFindings(JSON.stringify(summary)))
    findings.add(rule)
  for (const rule of prohibitedContentFindings(scenarioJsonl))
    findings.add(rule)
  for (const rule of prohibitedContentFindings(markdown))
    findings.add(rule)
  return Object.freeze([...findings])
}

function defaultLimitations(dataset: Dataset): readonly string[] {
  const limitations = [
    'G8 functional baseline; G8 is not passed and no deployment approval is implied.',
    'Unsupported future capabilities and live transport checks remain explicit.',
    'Measurements are measured_not_evaluated unless an approved threshold document is supplied.',
  ]
  const deferred = dataset.scenarios.filter(s => s.expectation.outcome === 'unsupported' || s.expectation.outcome === 'unverified')
  if (deferred.length > 0)
    limitations.push(`${deferred.length} scenario(s) are unsupported or unverified and excluded from the applicable pass-rate denominator.`)
  return Object.freeze(limitations)
}

/** Render the content-free Markdown report. */
function renderMarkdown(summary: EvaluationSummary, results: readonly (ScenarioResult & { elapsedMs: number })[], dataset: Dataset): string {
  const lines: string[] = []
  lines.push('# G8-1 functional baseline report')
  lines.push('')
  lines.push(`- Dataset: \`${dataset.datasetVersion}\` (digest \`${summary.datasetDigest}\`)`)
  lines.push(`- Seed: \`${summary.seed}\``)
  lines.push(`- Active profile: \`${summary.activeProfile}\``)
  lines.push(`- Commit: \`${summary.commitSha}\``)
  lines.push(`- Platform: \`${summary.platform}\``)
  lines.push(`- Generated: \`${summary.generatedAt}\``)
  lines.push(`- Normalized result digest: \`${summary.normalizedResultDigest}\``)
  lines.push(`- Measurement status: \`${summary.measurementStatus}\``)
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push(`- Applicable pass rate: \`${summary.applicablePassed}/${summary.applicableTotal}\``)
  lines.push(`- Zero-tolerance failures: \`${summary.zeroToleranceFailures.length}\``)
  lines.push(`- Unsupported categories: \`${summary.unsupportedCategories.length}\``)
  lines.push(`- Unverified categories: \`${summary.unverifiedCategories.length}\``)
  lines.push(`- Cleanup failures: \`${summary.cleanupFailures}\``)
  lines.push(`- Thresholds approved: \`${summary.approval.thresholdsApproved}\``)
  lines.push(`- Signed decision: \`${summary.approval.signedDecision}\``)
  lines.push('')
  lines.push('## Counts by outcome')
  lines.push('')
  lines.push('| Outcome | Count |')
  lines.push('|---|---|')
  for (const outcome of OUTCOMES)
    lines.push(`| ${outcome} | ${summary.counts.byOutcome[outcome] ?? 0} |`)
  lines.push('')
  lines.push('## Scenario results')
  lines.push('')
  lines.push('| Scenario | Category | Capability | Outcome | Cleanup |')
  lines.push('|---|---|---|---|---|')
  for (const result of results) {
    const spec = dataset.scenarios.find(s => s.scenarioId === result.scenarioId)
    lines.push(`| ${result.scenarioId} | ${spec?.category ?? result.category} | ${result.capabilityDisposition} | ${result.outcome} | ${result.cleanup} |`)
  }
  lines.push('')
  lines.push('## Limitations')
  lines.push('')
  for (const limitation of summary.limitations)
    lines.push(`- ${limitation}`)
  lines.push('')
  return lines.join('\n')
}

/** True when the whole run is valid for gate review (no blocking condition). */
export function runIsValidForGate(summary: EvaluationSummary): boolean {
  return summary.zeroToleranceFailures.length === 0
    && summary.cleanupFailures === 0
    && summary.counts.total > 0
}
