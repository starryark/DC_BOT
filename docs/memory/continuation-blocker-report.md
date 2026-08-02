# Shared-memory implementation continuation blocker

Date: 2026-08-02  
Repository commit inspected: `5f02e0a75d7b0a7b3ba991c291fd960f44dcdfeb`  
Branch: `main`  
Access mode: writable checkout

## Decision

Do not begin `IMP-301` or later G3 production work yet.

The approved backlog makes passed G1 and G2 gates a precondition of `IMP-301`
(`artifacts/21-implementation-backlog.md`, lines 879-885). G1 has passed and the
technical work for IMP-201 through IMP-208 is complete, but G2 remains formally
pending (`docs/memory/implementation-status.md`, gate-status table).

This is a continuation blocker, not a failure of the completed persistence
implementation. Existing runtime memory flags remain disabled, so production
behavior is unchanged.

## Artifact-compliance and blocker table

| Master precondition | Evidence | Status |
|---|---|---|
| Integrated verdict is GO or CONDITIONAL GO | `artifacts/22-integrated-specification.md` records CONDITIONAL GO | Pass, subject to conditions |
| Critical findings are closed or explicitly conditioned | `docs/memory/implementation-status.md` records FIND-010 open and limited to G3/IMP-305 | Conditional; does not authorize IMP-305 |
| Initial topology/storage ADR exists | `artifacts/03-topology-storage-adr.md`; SQLite-first adapter is reflected in the implemented persistence packages | Pass for technical validation |
| Identity, scope, event, delivery, persistence, deletion, and degraded-mode semantics exist | Artifacts 05-16 and the integrated specification define them | Pass at specification level |
| First-increment MUST requirements map to tests | `artifacts/23-requirements-traceability-matrix.md` and completed IMP-001 through IMP-208 evidence | Pass for completed increments |
| Vector/graph work is gated | Integrated specification and rollout plan keep both disabled | Pass |
| Writable checkout exists | This report was written in the checkout | Pass |
| G2 is approved before IMP-301 | OQ-BLOCK-003 remains open | **Blocked** |

## Exact minimum evidence required to pass G2

An authorized operations owner must record all of the following in a versioned
decision/evidence artifact:

1. Milestone-one uses exactly one authoritative SQLite writer process.
2. The database resides on local, non-network storage with WAL support.
3. An operational backup destination is selected, writable by the bot service,
   access-controlled, and covered by the accepted retention/deletion policy.
4. A deployment-shaped workload and soak profile is defined and run using the
   intended host/storage topology. The report must include workload shape,
   duration, concurrency, database size, busy/locked failures, latency
   distribution, integrity-check result, checkpoint result, backup result, and
   recovery result.
5. The operations owner explicitly accepts or rejects SQLite as the M1 default
   using that evidence and marks OQ-BLOCK-003 resolved.
6. The G2 reviewer records the gate decision. A failed or inconclusive soak
   requires revisiting the approved storage/topology decision; it must not be
   hidden by an ephemeral fallback.

No source-code change is required merely to state these facts. They are
deployment/operator decisions and measurements that cannot be inferred from a
workstation test.

## Collection mechanism added 2026-08-02

Items 4-6 above previously had no defined way to be produced or recorded. That
gap is now closed; the evidence itself is not.

| Added | Path | What it does |
|---|---|---|
| Operational soak harness | `airi/packages/memory-sqlite/src/benchmark/g2-operational-soak.ts` (`pnpm -F @proj-airi/memory-sqlite benchmark:g2`) | Runs a deployment-shaped synthetic workload against a run-scoped SQLite database on an operator-nominated volume and emits JSON plus a Markdown report |
| Operator runbook | `docs/memory/g2-operational-evidence-runbook.md` | How to select paths, capture process/storage evidence, run short and long soaks, drill the restore, and complete the record |
| Acceptance template | `docs/memory/evidence/g2-operational-acceptance-template.md` | The signed artifact this blocker requires: topology, storage, backup destination, soak evidence, approved envelope, scope, sign-off, formal decision |

The harness is test-only. It creates its own synthetic database, refuses any
directory that already holds an unmarked database, refuses the OS temporary
directory, network shares, and the repository checkout, and has no override
flag. It opens no production database, enables no feature flag, changes no
Discord intent, and introduces no second SQLite writer.

**The harness cannot close this blocker.** Every run reports
`g2AutomaticallyPassed: false` and `productionApprovalImplied: false`, and no
measurement is reported as a pass unless an operator supplies an approved
threshold document; without one, results are `measured-not-evaluated`. Items 1-3
are deployment attestations the software cannot make at all, and item 5 is a
signature.

Still required, unchanged: an operator must run the soak on the deployment host
and volume, attach the process-inventory and storage-locality evidence, name the
real operational backup destination, approve an operating envelope, and sign the
acceptance record. `OQ-BLOCK-003` remains open until that signed record exists.

The ADR-003 `OPEN-BLOCK-007` technical remediation now exists:
`openAuthoritativeSqliteDatabase` holds a separate SQLite/VFS lease for the
canonical authority identity, refuses a live second process with a typed bounded
error, and releases on clean close or abrupt process termination. Focused real
cross-process tests cover refusal, owner health, clean release, crash recovery,
read-only access, and path identity. The G2 probe now expects
`expected-ownership-refusal`; any unexpected acquisition or probe infrastructure
failure remains adverse/inconclusive evidence.

This does not close `OQ-BLOCK-003`. An operator must still prove the deployed
process inventory and storage topology, run the deployment-shaped soak, approve
the operating envelope and backup destination, and obtain signatures.

## Additional G3 condition

Before `IMP-305` or any behavior that relies on guild member freshness,
OQ-BLOCK-004/FIND-010 must resolve which Discord gateway intents are approved
and define behavior when member state is unavailable. No new intent is approved
by this report. Earlier G3 tasks may only proceed after G2 passes and must keep
optional actor-presentation fields absent when unavailable; names may never be
used as identity fallback.

## Safe state and rollback

- Do not enable any memory feature flag.
- Do not open or migrate a production database.
- Do not add vectors, graph storage, a remote memory service, or a Discord
  gateway intent.
- No rollback is necessary for this documentation-only increment. Removing this
  report would revert the sole change, but would not resolve the underlying
  gate.
- The soak harness added on 2026-08-02 is test-only and unreferenced by any
  runtime path. Removing `src/benchmark/g2-*`, the `benchmark:g2` script, the
  runbook, and the acceptance template would revert it and would change no
  production behaviour.

## Next unblocked action

Collect and approve the six G2 evidence items above, following
`docs/memory/g2-operational-evidence-runbook.md` and recording the result in a
copy of `docs/memory/evidence/g2-operational-acceptance-template.md`. After the
gate is recorded as passed, begin `IMP-301` with actor-snapshot regression tests
before changing Discord ingress behavior.

`OQ-BLOCK-003` remains open. G2 remains unapproved. `IMP-301` remains blocked
pending completed operational evidence and formal sign-off.
