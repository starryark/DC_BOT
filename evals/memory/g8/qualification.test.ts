import type { G8PerformanceRunFiles, G8QualificationInput } from './qualification'

import { describe, expect, it } from 'vitest'

import { qualifyG8 } from './qualification'
import {
  evaluationRunArtifacts,
  G8_CANDIDATE_COMMIT,
  greenBundle,
  OTHER_COMMIT,
  performanceRunFiles,
  performanceThresholdObject,
  priceDocumentFixture,
  priceDocumentObject,
  signoffObject,
  soakReportObject,
} from './qualification-fixtures'

/**
 * Aggregate G8 qualification matrix (artifact 21 §11.2).
 *
 * The green bundle is the positive control: a complete, explicitly synthetic
 * evidence set that must pass. Every other case mutates exactly one part of it,
 * so each blocker code is attributed to the defect under test rather than to an
 * incidentally broken bundle. The two named negative controls — historical
 * green evidence at a different candidate, and a provisional threshold offered
 * as an approval — are the two confusions this gate exists to refuse.
 */

const WORKLOAD_CATALOG_DIGEST = '03516345e6e1ab8355373135901cd47eb64ef4a2d275da6ff52204617400a10f'

/** Shape of the one recorded latency threshold: valid, compatible, and provisional in its own words. */
const PROVISIONAL_THRESHOLD_OBJECT = {
  format: 'performance-thresholds',
  schemaVersion: 2,
  contractId: 'performance-v2',
  contractDigest: WORKLOAD_CATALOG_DIGEST,
  source: 'docs/memory/evidence/imp-803-provisional-voice-delta-threshold-2026-08-13.md',
  approver: 'M1 gate owner (provisional; not an approved external latency objective)',
  approvedAt: '2026-08-13T00:00:00Z',
  provenance: 'PROVISIONAL, SMALL-SAMPLE, HOST-SCOPED. Supersede when an approved voice latency objective exists (artifact 16 section 10.1).',
  thresholds: [{
    workloadId: 'runtime-cold-open',
    metricId: 'runtime-cold-open.fixture-mean',
    statistic: 'mean',
    unit: 'milliseconds',
    comparator: 'lte',
    bound: 38,
  }],
}

function qualify(input: G8QualificationInput) {
  return qualifyG8(input)
}

function blockersOf(input: G8QualificationInput): readonly string[] {
  return qualify(input).blockers
}

/** Replace the gate-owner signoff's coverage; other signoffs stay intact. */
function withGateOwnerCover(input: G8QualificationInput, covers: { thresholdDocuments?: string[], priceDocuments?: string[] }): G8QualificationInput {
  const signoffs = input.signoffs!.map((signoff) => {
    const record = signoff as { role?: string }
    return record.role === 'gate-owner' ? signoffObject({ role: 'gate-owner', gateReadiness: { openQuestionsResolved: true, highRisksOwned: true }, covers }) : signoff
  })
  return { ...input, signoffs }
}

/** A valid signoff cover set that names no documents: approval over nothing. */
const EMPTY_COVER = { thresholdDocuments: [], priceDocuments: [] }

describe('qualifyG8 positive control', () => {
  it('passes the complete explicitly synthetic evidence bundle', () => {
    const result = qualifyG8(greenBundle().input)
    expect(result.status).toBe('pass')
    expect(result.blockers).toEqual([])
    expect(result.conditions.map(condition => condition.id)).toEqual([
      'functional',
      'multilingual',
      'performance',
      'cost',
      'drills',
      'signoffs',
      'gate-readiness',
    ])
    expect(result.candidateCommit).toBe(G8_CANDIDATE_COMMIT)
  })
})

// HISTORICAL-GREEN NEGATIVE CONTROL
// Evidence that qualified one commit says nothing about another. Qualifying the
// same green bundle at a different SHA must stay blocked, with every
// commit-bound family reporting staleness rather than being waived through.
describe('qualifyG8 historical-green negative control', () => {
  it('blocks otherwise green evidence when a different candidate is requested', () => {
    const blockers = blockersOf({ ...greenBundle().input, candidateCommit: OTHER_COMMIT })
    expect(blockers).toContain('functional_run_a_stale_candidate')
    expect(blockers).toContain('functional_run_b_stale_candidate')
    expect(blockers).toContain('multilingual_run_a_stale_candidate')
    expect(blockers).toContain('performance_run_a_stale_candidate')
    expect(blockers).toContain('drill_stale_candidate')
    expect(blockers).toContain('signoff_wrong_scope:privacy-lead')
    expect(blockers).toContain('signoff_wrong_scope:lifecycle-lead')
    expect(blockers).toContain('signoff_wrong_scope:security-reviewer')
    expect(blockers).toContain('gate_readiness_unasserted')
  })
})

describe('qualifyG8 missing evidence fails closed', () => {
  it('reports every family as missing when nothing is supplied', () => {
    const blockers = blockersOf({ candidateCommit: G8_CANDIDATE_COMMIT })
    expect(blockers).toContain('functional_missing')
    expect(blockers).toContain('multilingual_missing')
    expect(blockers).toContain('performance_missing')
    expect(blockers).toContain('performance_threshold_missing')
    expect(blockers).toContain('cost_document_missing')
    expect(blockers).toContain('drill_evidence_missing')
    expect(blockers).toContain('signoff_missing:privacy-lead')
    expect(blockers).toContain('signoff_missing:lifecycle-lead')
    expect(blockers).toContain('signoff_missing:security-reviewer')
    expect(blockers).toContain('gate_readiness_unasserted')
  })

  it('requires the drill report specifically', () => {
    const input = { ...greenBundle().input, soakReport: undefined }
    expect(blockersOf(input)).toContain('drill_evidence_missing')
  })

  it('requires one run of each performance pair, not just one', () => {
    const input = { ...greenBundle().input, performance: { ...greenBundle().input.performance!, runB: undefined } }
    expect(blockersOf(input)).toContain('performance_missing')
  })
})

describe('qualifyG8 rejects incompatible evidence schemas', () => {
  it('refuses an evaluation run naming an unknown dataset version', () => {
    const bundle = greenBundle().input
    const summary = JSON.parse(bundle.functional!.runA!.summaryJson) as Record<string, unknown>
    summary.datasetVersion = '99.0.0'
    const runA = { ...bundle.functional!.runA!, summaryJson: `${JSON.stringify(summary, null, 2)}\n` }
    const blockers = blockersOf({ ...bundle, functional: { ...bundle.functional!, runA } })
    expect(blockers).toContain('functional_run_a_invalid:dataset_invalid:dataset_version_not_recognized')
  })

  it('refuses a performance run whose manifest is not the current schema', () => {
    const bundle = greenBundle().input
    const manifest = JSON.parse(bundle.performance!.runA!.runManifestJson) as Record<string, unknown>
    manifest.schemaVersion = 1
    const runA = { ...bundle.performance!.runA!, runManifestJson: `${JSON.stringify(manifest, null, 2)}\n` }
    const blockers = blockersOf({ ...bundle, performance: { ...bundle.performance!, runA } })
    expect(blockers).toContain('performance_run_a_invalid:run_not_recomputable')
  })

  it('refuses a multilingual run supplied as functional evidence', () => {
    const bundle = greenBundle().input
    const wrongDataset = evaluationRunArtifacts({ dataset: 'multilingual-v1' })
    const blockers = blockersOf({ ...bundle, functional: { ...bundle.functional!, runA: wrongDataset } })
    expect(blockers).toContain('functional_run_a_wrong_dataset')
  })
})

// APPROVAL-CONFUSION NEGATIVE CONTROL
// A threshold document that parses, matches the contract, and is even bound to
// the runs is still not an approval. The one recorded latency threshold
// declares itself provisional in its own provenance; no signoff covers it, so
// it must not satisfy the approved-threshold requirement.
describe('qualifyG8 approval-confusion negative control', () => {
  it('does not accept the provisional latency threshold as approved evidence', () => {
    const bundle = greenBundle().input
    const blockers = blockersOf({ ...bundle, performance: { ...bundle.performance!, thresholds: PROVISIONAL_THRESHOLD_OBJECT } })
    expect(blockers).toContain('performance_threshold_unbound')
    expect(blockers).toContain('performance_threshold_not_approved')
    expect(blockersOf({ ...bundle, performance: { ...bundle.performance!, thresholds: PROVISIONAL_THRESHOLD_OBJECT } })).not.toContain('performance_threshold_document_invalid')
  })

  it('does not accept any threshold document a signoff fails to cover', () => {
    const blockers = blockersOf(withGateOwnerCover(greenBundle().input, EMPTY_COVER))
    expect(blockers).toContain('performance_threshold_not_approved')
    expect(blockers).toContain('cost_not_approved')
    expect(blockers.filter(blocker => blocker.endsWith('_threshold_not_approved')).length).toBeGreaterThanOrEqual(3)
  })

  it('does not accept a retrieval policy without the independent decision', () => {
    const bundle = greenBundle().input
    const blockers = blockersOf({ ...bundle, multilingual: { ...bundle.multilingual!, decision: undefined } })
    expect(blockers).toContain('retrieval_measured_not_evaluated')
  })
})

describe('qualifyG8 preserves measured_not_evaluated as non-qualifying', () => {
  it('blocks functional runs published without an approved threshold document', () => {
    const bundle = greenBundle().input
    const runA = evaluationRunArtifacts({ dataset: 'active-v1', generatedAt: '2026-08-16T01:00:00Z' })
    const runB = evaluationRunArtifacts({ dataset: 'active-v1', generatedAt: '2026-08-16T03:00:00Z' })
    const blockers = blockersOf({ ...bundle, functional: { runA, runB } })
    expect(blockers).toContain('functional_thresholds_not_evaluated')
  })

  it('blocks performance runs whose metrics were never evaluated against thresholds', () => {
    const bundle = greenBundle().input
    const runA = performanceRunFiles({ runId: 'perf-a-unbound', withThresholdBinding: false })
    const runB = performanceRunFiles({ runId: 'perf-b-unbound', withThresholdBinding: false, durationBaseMs: 7 })
    const blockers = blockersOf({ ...bundle, performance: { ...bundle.performance!, runA, runB } })
    expect(blockers).toContain('performance_metric_measured_not_evaluated')
    expect(blockers).toContain('performance_threshold_unbound')
  })

  // ROOT CAUSE:
  //
  // The aggregate previously trusted the evaluator summary's `evaluated`
  // status. Because normalized result identity intentionally excludes volatile
  // measurements, an uncovered row could be added without changing that digest
  // and the incomplete threshold document still qualified.
  //
  // Qualification now recomputes threshold coverage and verdicts from each
  // run's own scenario rows and compares them with the published summary.
  it('blocks a functional run whose published rows contain an uncovered measurement', () => {
    const bundle = greenBundle().input
    const lines = bundle.functional!.runA!.scenarioResultsJsonl.trimEnd().split('\n')
    const first = JSON.parse(lines[0]!) as { measurements: Array<{ name: string, value: number, unit: string, evaluated: boolean }> }
    first.measurements.push({ name: 'uncovered-elapsed-ms', value: 2, unit: 'ms', evaluated: false })
    lines[0] = JSON.stringify(first)
    const runA = { ...bundle.functional!.runA!, scenarioResultsJsonl: `${lines.join('\n')}\n` }

    const blockers = blockersOf({ ...bundle, functional: { ...bundle.functional!, runA } })
    expect(blockers).toContain('functional_thresholds_not_evaluated')
    expect(blockers).toContain('functional_run_a_invalid:measurement_evaluation_mismatch')
  })
})

describe('qualifyG8 drills', () => {
  it('blocks a historical soak report bound to a different commit', () => {
    const input = { ...greenBundle().input, soakReport: soakReportObject(OTHER_COMMIT) }
    const blockers = blockersOf(input)
    expect(blockers).toContain('drill_stale_candidate')
    expect(blockers).not.toContain('drill_failed')
  })

  it('blocks a soak report whose rollback drill did not pass', () => {
    const report = { ...soakReportObject(), rollback: { drillPassed: false } }
    expect(blockersOf({ ...greenBundle().input, soakReport: report })).toContain('drill_failed')
  })

  it('distinguishes a malformed soak report from an absent one', () => {
    expect(blockersOf({ ...greenBundle().input, soakReport: { format: 99 } })).toContain('drill_report_invalid')
    expect(blockersOf({ ...greenBundle().input, soakReport: undefined })).toContain('drill_evidence_missing')
  })
})

describe('qualifyG8 signoffs', () => {
  it('blocks when a required role signs off at a different candidate', () => {
    const bundle = greenBundle().input
    const signoffs = bundle.signoffs!.map((signoff) => {
      const record = signoff as { role?: string }
      return record.role === 'privacy-lead' ? signoffObject({ role: 'privacy-lead', candidateCommit: OTHER_COMMIT }) : signoff
    })
    const blockers = blockersOf({ ...bundle, signoffs })
    expect(blockers).toContain('signoff_wrong_scope:privacy-lead')
    expect(blockers).not.toContain('signoff_missing:privacy-lead')
  })

  it('blocks a required role that recorded a rejection', () => {
    const bundle = greenBundle().input
    const signoffs = [...bundle.signoffs!, signoffObject({ role: 'security-reviewer', decision: 'reject' })]
    const blockers = blockersOf({ ...bundle, signoffs })
    expect(blockers).toContain('signoff_rejected:security-reviewer')
  })

  it('distinguishes malformed signoff records from missing ones', () => {
    const bundle = greenBundle().input
    const blockers = blockersOf({ ...bundle, signoffs: [...bundle.signoffs!, { format: 2 }] })
    expect(blockers).toContain('signoff_records_invalid')
    expect(blockers).not.toContain('signoff_missing:privacy-lead')
  })

  it('blocks gate readiness that was never asserted, or asserted negatively', () => {
    const unasserted = withGateOwnerCover(greenBundle().input, EMPTY_COVER)
    // Recreate the gate-owner record without gateReadiness at all.
    const withoutAssertion = {
      ...greenBundle().input,
      signoffs: greenBundle().input.signoffs!.map((signoff) => {
        const record = signoff as { role?: string }
        return record.role === 'gate-owner' ? signoffObject({ role: 'gate-owner' }) : signoff
      }),
    }
    expect(blockersOf(unasserted)).not.toContain('gate_readiness_unasserted')
    expect(blockersOf(withoutAssertion)).toContain('gate_readiness_unasserted')

    const negative = {
      ...greenBundle().input,
      signoffs: greenBundle().input.signoffs!.map((signoff) => {
        const record = signoff as { role?: string }
        return record.role === 'gate-owner'
          ? signoffObject({ role: 'gate-owner', gateReadiness: { openQuestionsResolved: false, highRisksOwned: true } })
          : signoff
      }),
    }
    expect(blockersOf(negative)).toContain('gate_open_questions_unresolved')
    expect(blockersOf(negative)).not.toContain('gate_unowned_high_risks')
  })
})

describe('qualifyG8 freshness and identity beyond commit equality', () => {
  it('blocks a dirty worktree run', () => {
    const bundle = greenBundle().input
    const runA = evaluationRunArtifacts({ dataset: 'active-v1', generatedAt: '2026-08-16T01:00:00Z', withThresholds: true, dirtyWorktree: true })
    expect(blockersOf({ ...bundle, functional: { ...bundle.functional!, runA } })).toContain('functional_run_a_dirty_worktree')
  })

  it('blocks an eval pair that is not the same experiment', () => {
    const bundle = greenBundle().input
    const runB = evaluationRunArtifacts({ dataset: 'active-v1', generatedAt: '2026-08-16T03:00:00Z', withThresholds: true, seed: 42 })
    const blockers = blockersOf({ ...bundle, functional: { ...bundle.functional!, runB } })
    expect(blockers).toContain('functional_not_reproducible:seed')
    expect(blockers).toContain('functional_not_reproducible:normalizedResultDigest')
  })

  it('blocks a performance pair that is not reproducible', () => {
    const bundle = greenBundle().input
    const runB = performanceRunFiles({ runId: 'perf-b-other-seed', seed: 999, durationBaseMs: 7, withPriceBinding: true })
    expect(blockersOf({ ...bundle, performance: { ...bundle.performance!, runB } })).toContain('performance_not_reproducible:seed')
  })

  // A run that drops one workload's latency row and restates its own counts
  // still reconciles against its own artifacts, and its attempts are untouched,
  // so every same-seed check still matches. Only the pair's measurement
  // coverage shows that one run never measured what the other did.
  it('blocks a performance pair whose measurement coverage differs', () => {
    const bundle = greenBundle().input
    const runA = bundle.performance!.runA!
    const rows = runA.measurementsJsonl.split('\n').filter(line => line.trim() !== '')
    const summary = JSON.parse(runA.summaryJson) as { metricStatusCounts: { passed: number } }
    summary.metricStatusCounts.passed -= 1
    const thinned = {
      ...runA,
      measurementsJsonl: `${rows.slice(1).join('\n')}\n`,
      summaryJson: `${JSON.stringify(summary, null, 2)}\n`,
    }
    expect(blockersOf({ ...bundle, performance: { ...bundle.performance!, runA: thinned } }))
      .toContain('performance_pair_incompatible:metric-missing')
  })

  // Reproducibility compares two runs. Handed the same run twice — a copied
  // directory, or one path passed to both flags — every comparison matches
  // because there is only one run, so the pair proves nothing.
  it('blocks an evaluation pair that is one run supplied twice', () => {
    const bundle = greenBundle().input
    const runA = bundle.functional!.runA!
    expect(blockersOf({ ...bundle, functional: { ...bundle.functional!, runB: runA } }))
      .toContain('functional_pair_duplicate_run')
  })

  it('blocks a performance pair that is one run supplied twice', () => {
    const bundle = greenBundle().input
    const runA = bundle.performance!.runA!
    expect(blockersOf({ ...bundle, performance: { ...bundle.performance!, runB: runA } }))
      .toContain('performance_pair_duplicate_run')
  })

  it('blocks a performance pair measured on different hardware', () => {
    const bundle = greenBundle().input
    const runB = bundle.performance!.runB!
    const manifest = JSON.parse(runB.runManifestJson) as { environment: { cpuModel: string } }
    manifest.environment.cpuModel = 'g8-fixture-cpu-other'
    const relocated = { ...runB, runManifestJson: `${JSON.stringify(manifest, null, 2)}\n` }
    expect(blockersOf({ ...bundle, performance: { ...bundle.performance!, runB: relocated } }))
      .toContain('performance_pair_incompatible:cpu-model-mismatch')
  })

  it('blocks a performance run that did not complete the full suite', () => {
    const bundle = greenBundle().input
    const manifest = JSON.parse(bundle.performance!.runA!.runManifestJson) as { workloadsCompleted: string[] }
    manifest.workloadsCompleted = manifest.workloadsCompleted.slice(1)
    const runA = { ...bundle.performance!.runA!, runManifestJson: `${JSON.stringify(manifest, null, 2)}\n` }
    expect(blockersOf({ ...bundle, performance: { ...bundle.performance!, runA } })).toContain('performance_run_a_suite_incomplete')
  })

  it('blocks an eval threshold document approved against a different commit', () => {
    const bundle = greenBundle().input
    const thresholds = { ...(bundle.functional!.thresholds as Record<string, unknown>), repositoryCommit: OTHER_COMMIT, approver: 'other-approver' }
    const blockers = blockersOf({ ...bundle, functional: { ...bundle.functional!, thresholds } })
    expect(blockers).toContain('functional_threshold_stale')
    expect(blockers).toContain('functional_threshold_run_unbound')
  })
})

describe('qualifyG8 cost evidence', () => {
  it('blocks a price document no signoff covers', () => {
    const blockers = blockersOf(withGateOwnerCover(greenBundle().input, { thresholdDocuments: (greenBundle().input.signoffs!.find(s => (s as { role?: string }).role === 'gate-owner') as { covers?: { thresholdDocuments?: string[] } }).covers!.thresholdDocuments! }))
    expect(blockers).toContain('cost_not_approved')
  })

  it('blocks a price document outside its effective window', () => {
    const price = { ...priceDocumentObject(), effectiveStart: '2027-01-01T00:00:00Z' }
    expect(blockersOf({ ...greenBundle().input, priceDocument: price })).toContain('cost_not_effective')
  })

  it('blocks runs that never bound the price document', () => {
    const bundle = greenBundle().input
    const runA = performanceRunFiles({ runId: 'perf-a-unpriced' })
    const runB = performanceRunFiles({ runId: 'perf-b-unpriced', durationBaseMs: 7, completedAt: '2026-08-16T02:00:00Z' })
    const blockers = blockersOf({ ...bundle, performance: { runA, runB, thresholds: performanceThresholdObject() } })
    expect(blockers).toContain('cost_run_a_unbound')
    expect(blockers).toContain('cost_run_b_unbound')
  })

  it('blocks a run whose imported evidence carried no cost-eligible usage', () => {
    const bundle = greenBundle().input
    const runA = performanceRunFiles({ runId: 'perf-a-nocost', withPriceBinding: true, withBrainUsageSample: false })
    expect(blockersOf({ ...bundle, performance: { ...bundle.performance!, runA } })).toContain('cost_not_calculated')
  })

  it('blocks a run whose usage observation did not complete', () => {
    const bundle = greenBundle().input
    const runA = performanceRunFiles({ runId: 'perf-a-failed-usage', withPriceBinding: true, usage: { disposition: 'failed' } })
    expect(blockersOf({ ...bundle, performance: { ...bundle.performance!, runA } })).toContain('cost_not_calculated')
  })

  it('blocks when one run of the pair could not derive cost', () => {
    const bundle = greenBundle().input
    const runB = performanceRunFiles({ runId: 'perf-b-nocost', durationBaseMs: 7, completedAt: '2026-08-16T02:00:00Z', withPriceBinding: true, withBrainUsageSample: false })
    const result = qualify({ ...bundle, performance: { ...bundle.performance!, runB } })
    expect(result.status).toBe('blocked')
    expect(result.blockers).toContain('cost_not_calculated')
  })
})

// The cost condition recomputes the published amount from the supplied price
// document rather than trusting `costAvailability`. These cases are the ones a
// bare flag could not distinguish: evidence that is absent, unbound to the run's
// imports, or arithmetically wrong.
describe('qualifyG8 cost recomputation', () => {
  /** Rewrite one performance run's published summary. */
  function withSummary(files: G8PerformanceRunFiles, mutate: (summary: Record<string, unknown>) => void): G8PerformanceRunFiles {
    const summary = JSON.parse(files.summaryJson) as Record<string, unknown>
    mutate(summary)
    return { ...files, summaryJson: `${JSON.stringify(summary, null, 2)}\n` }
  }

  /** Rewrite one performance run's published manifest. */
  function withManifest(files: G8PerformanceRunFiles, mutate: (manifest: Record<string, unknown>) => void): G8PerformanceRunFiles {
    const manifest = JSON.parse(files.runManifestJson) as Record<string, unknown>
    mutate(manifest)
    return { ...files, runManifestJson: `${JSON.stringify(manifest, null, 2)}\n` }
  }

  it('recomputes the published amount for both runs of a green pair', () => {
    const result = qualify(greenBundle().input)
    const cost = result.conditions.find(condition => condition.id === 'cost')!
    expect(cost.status).toBe('pass')
    expect(cost.details).toHaveProperty('runACost')
    expect(cost.details).toHaveProperty('runBCost')
    expect((cost.details!.runACost as { currency: string }).currency).toBe('USD')
    expect((cost.details!.runACost as { amount: number }).amount).toBeCloseTo(1200 * 0.000001 + 340 * 0.000002, 12)
  })

  it('blocks available cost published with no evidence', () => {
    // ROOT CAUSE:
    //
    // The condition previously accepted `costAvailability === 'available'` as
    // proof, so a summary asserting availability qualified with nothing behind
    // it — a state the sanctioned producer could not even reach.
    //
    // Availability is now only a consistency indicator; the evidence is what is
    // verified.
    const bundle = greenBundle().input
    const runA = withSummary(bundle.performance!.runA!, (summary) => {
      delete summary.costEvidence
    })
    expect(blockersOf({ ...bundle, performance: { ...bundle.performance!, runA } })).toContain('cost_run_a_evidence_missing')
  })

  it('blocks evidence published beside an unavailable flag', () => {
    const bundle = greenBundle().input
    const runA = withSummary(bundle.performance!.runA!, (summary) => {
      summary.costAvailability = 'unavailable'
    })
    expect(blockersOf({ ...bundle, performance: { ...bundle.performance!, runA } })).toContain('cost_run_a_availability_inconsistent')
  })

  it('blocks a tampered total amount', () => {
    const bundle = greenBundle().input
    const runA = withSummary(bundle.performance!.runA!, (summary) => {
      (summary.costEvidence as { amount: number }).amount = 0.000001
    })
    expect(blockersOf({ ...bundle, performance: { ...bundle.performance!, runA } })).toContain('cost_run_a_amount_mismatch')
  })

  it('blocks a tampered dimension breakdown', () => {
    const bundle = greenBundle().input
    const runA = withSummary(bundle.performance!.runA!, (summary) => {
      const evidence = summary.costEvidence as { dimensions: Array<{ tokens: number }> }
      evidence.dimensions[0]!.tokens = 1
    })
    expect(blockersOf({ ...bundle, performance: { ...bundle.performance!, runA } })).toContain('cost_run_a_dimensions_mismatch')
  })

  it('blocks evidence whose embedded artifact digest does not recompute', () => {
    const bundle = greenBundle().input
    const runA = withSummary(bundle.performance!.runA!, (summary) => {
      (summary.costEvidence as { liveArtifactDigest: string }).liveArtifactDigest = 'f'.repeat(64)
    })
    expect(blockersOf({ ...bundle, performance: { ...bundle.performance!, runA } })).toContain('cost_run_a_artifact_digest_mismatch')
  })

  it('blocks evidence naming a sample the run never imported', () => {
    const bundle = greenBundle().input
    const runA = withManifest(bundle.performance!.runA!, (manifest) => {
      manifest.importedLiveArtifactDigests = ['e'.repeat(64)]
    })
    expect(blockersOf({ ...bundle, performance: { ...bundle.performance!, runA } })).toContain('cost_run_a_artifact_unimported')
  })

  it('blocks when the supplied price document is for another model', () => {
    const bundle = greenBundle().input
    const blockers = blockersOf({ ...bundle, priceDocument: priceDocumentObject({ model: 'some-other-model' }) })
    expect(blockers).toContain('cost_run_a_not_recomputable:model-mismatch')
    expect(blockers).toContain('cost_run_b_not_recomputable:model-mismatch')
  })

  it('blocks when the supplied price expired before the usage was observed', () => {
    const bundle = greenBundle().input
    const blockers = blockersOf({ ...bundle, priceDocument: priceDocumentObject({ effectiveEnd: '2026-08-16T00:00:00Z' }) })
    expect(blockers).toContain('cost_run_a_not_recomputable:price-expired')
  })

  it('blocks when the supplied price is not yet effective at the usage observation', () => {
    const bundle = greenBundle().input
    const blockers = blockersOf({ ...bundle, priceDocument: priceDocumentObject({ effectiveStart: '2027-01-01T00:00:00Z' }) })
    expect(blockers).toContain('cost_run_a_not_recomputable:price-effective-window-not-reached')
  })

  it('blocks when the supplied price is missing a dimension the usage needs', () => {
    // The runs were priced by a document that prices thinking tokens; the
    // document offered to the gate does not, so the amount cannot be reproduced.
    const thinkingPrice = priceDocumentFixture({
      dimensions: [
        { dimension: 'input', unit: 'token', pricePerUnit: 0.000001 },
        { dimension: 'output', unit: 'token', pricePerUnit: 0.000002 },
        { dimension: 'thinking', unit: 'token', pricePerUnit: 0.000004 },
      ],
    })
    const bundle = greenBundle().input
    const performance = {
      ...bundle.performance!,
      runA: performanceRunFiles({ runId: 'perf-a-thinking', withPriceBinding: true, priceDocument: thinkingPrice, usage: { thinkingTokens: 40 } }),
      runB: performanceRunFiles({ runId: 'perf-b-thinking', durationBaseMs: 7, completedAt: '2026-08-16T02:00:00Z', withPriceBinding: true, priceDocument: thinkingPrice, usage: { thinkingTokens: 40 } }),
    }
    expect(blockersOf({ ...bundle, performance })).toContain('cost_run_a_not_recomputable:missing-price-dimension')
  })
})

// The decision document binds the multilingual pair by name, so run order is
// part of that evidence. What must be order-independent is the decision
// itself: swapping a symmetric pair changes which physical directory the
// details name as run A, but never the status or any blocker. Signoff records
// carry no positional meaning at all, so there the whole output is compared.
describe('qualifyG8 determinism', () => {
  it('is independent of signoff order', () => {
    const bundle = greenBundle().input
    const first = qualify({ ...bundle, signoffs: [...bundle.signoffs!] })
    const reversed = qualify({ ...bundle, signoffs: [...bundle.signoffs!].reverse() })
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(first))
  })

  it('is independent of the order of one role\'s approval and rejection from the same source', () => {
    const bundle = greenBundle().input
    const approve = signoffObject({ role: 'privacy-lead', decision: 'approve' })
    const reject = signoffObject({ role: 'privacy-lead', decision: 'reject' })
    const others = bundle.signoffs!.filter(record => (record as { role?: string }).role !== 'privacy-lead')
    const forward = qualify({ ...bundle, signoffs: [approve, reject, ...others] })
    const backward = qualify({ ...bundle, signoffs: [reject, approve, ...others] })
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward))
  })

  it('decides identically with functional runs swapped', () => {
    const bundle = greenBundle().input
    const functional = bundle.functional!
    const first = qualify(bundle)
    const swapped = qualify({ ...bundle, functional: { ...functional, runA: functional.runB, runB: functional.runA } })
    expect(swapped.status).toBe(first.status)
    expect(swapped.blockers).toEqual(first.blockers)
  })

  it('decides identically with performance runs swapped', () => {
    const bundle = greenBundle().input
    const performance = bundle.performance!
    const first = qualify(bundle)
    const swapped = qualify({ ...bundle, performance: { ...performance, runA: performance.runB, runB: performance.runA } })
    expect(swapped.status).toBe(first.status)
    expect(swapped.blockers).toEqual(first.blockers)
  })

  it('decides identically with multilingual runs swapped and no ordered decision document', () => {
    const bundle = greenBundle().input
    const multilingual = bundle.multilingual!
    const first = qualify({ ...bundle, multilingual: { ...multilingual, decision: undefined } })
    const swapped = qualify({
      ...bundle,
      multilingual: { ...multilingual, runA: multilingual.runB, runB: multilingual.runA, decision: undefined },
    })
    expect(swapped.status).toBe(first.status)
    expect(swapped.blockers).toEqual(first.blockers)
  })
})

describe('qualifyG8 contract', () => {
  it('refuses a candidate that is not a full commit SHA', () => {
    expect(() => qualifyG8({ candidateCommit: 'abc123' })).toThrow(/40-character/)
  })

  it('distinguishes malformed evaluation evidence from absent evidence', () => {
    const bundle = greenBundle().input
    const runA = { ...bundle.functional!.runA!, summaryJson: '{ not json' }
    const blockers = blockersOf({ ...bundle, functional: { ...bundle.functional!, runA } })
    expect(blockers).toContain('functional_run_a_invalid:summary_not_json')
  })
})
