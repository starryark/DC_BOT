# SUBAGENT_BRIEFS — IMP-606 lexical/full-text retrieval

## Operating rule for every role

Every role is a **direct child of the master orchestrator** and must not spawn another agent. If the host lacks a direct-child invocation primitive, execute the role through a **separate genuinely fresh-context handoff** with only the listed inputs. This is a transport fallback, not permission for the master or implementation context to impersonate an independent role.

All roles must preserve:

- repository/candidate identity separation;
- local-only publication authority;
- `PASS`, `FAIL`, `INCOMPLETE` semantics from `COMPILED_SPEC.md` and `EVALUATION_RUBRIC.md`;
- direct-read-over-code-search repository lookup rule;
- no chain-of-thought transfer between implementation and independent evaluators.

## Spec Auditor

### Mission

Audit whether the generated IMP-606 packet faithfully captures Plan.md and whether any requirement, dependency, invariant, gate, stop condition, or publication restriction is missing, contradictory, or improperly promoted from unverified evidence.

### Inputs

- `Plan.md` / supplied IMP-606 plan identity and hash.
- `COMPILED_SPEC.md`.
- `TASK_SKILL.md`.
- `ARTIFACT_CONTRACT.md` only to verify packet schema when supplied.

### Required checks

- Every explicit Plan invariant and non-goal appears in the normalized spec.
- IMP-606 task dependency sequence and IMP-804 boundary are preserved.
- The formal IMP-601 prerequisite is not silently marked satisfied without repository-owned acceptance evidence.
- Performance-v2 measurement identity/policy is kept separate from retrieval-quality policy.
- Every future exact path not verified at the pin is marked `PROPOSED/UNRESOLVED`.
- Local-only publication is explicit.
- Gates admit `INCOMPLETE`; no missing evidence becomes a pass.

### Output

`SPEC_AUDIT` containing:

- final verdict: `PASS`, `FAIL`, or `INCOMPLETE`;
- contradiction list;
- missing/duplicated requirements;
- misclassified fact list;
- exact source references for every finding;
- required packet correction, if any.

### Forbidden

- Code edits.
- Repository writes.
- Implementation design preference beyond source-backed correction.
- Accepting unverified assumptions because they appear likely.
- Remote GitHub mutation.

## Repo Cartographer

### Mission

Independently re-pin the repository/candidate and prove the exact paths, symbols, test surfaces, import/call paths, command ownership, runtime capability-advertisement path, and drift relevant to IMP-606.

### Inputs

- `Plan.md`.
- `REPO_CONTEXT.md` as a seed map only.
- Current repository read access and local checkout if available.

### Required checks

- Resolve current `main` and local candidate HEAD/status.
- Direct-read every known contract/migration/runtime/evaluation surface at the exact SHA.
- Inventory `memory-sqlite/src/schema/`, `src/repositories/`, and `discord-bot/evals/memory/` directly.
- Trace imports/call sites for authorization/scope, source lifecycle, deletion, correction, delivery eligibility, SQLite composition, runtime health/capability advertisement, and evaluation runtime adapter.
- Determine the exact supported package-manager commands/cwd.
- Establish whether any newly created migration/retrieval paths now exist.
- Record drift from the packet rather than relying on stale context.

### Output

`REPO_AUDIT` containing:

- remote and local/candidate SHA;
- clean/dirty status and unrelated local changes;
- verified paths/symbols and blob/commit identities where useful;
- direct import/call map for retrieval ownership;
- focused and full test surfaces;
- package scripts/cwd;
- exact current capability-advertisement path;
- drift findings and packet corrections;
- unresolved paths/ownership.

### Forbidden

- Code edits.
- Relying on stale `REPO_CONTEXT.md` without checking head.
- Using code-search misses as proof of absence.
- Creating a future filename simply because the plan suggested it.
- Remote GitHub mutation.

## Evidence / Runtime Gatekeeper

### Mission

Decide whether the first modifying task and later analyzer/promotion gates are actually executable from authoritative evidence and host capabilities.

### Inputs

- `COMPILED_SPEC.md`.
- `REPO_CONTEXT.md`.
- `SPEC_AUDIT` and `REPO_AUDIT`.
- Local checkout/runtime/tool probes.
- Repository-owned prerequisite/evidence documents.
- Any external IMP-606 analyzer/retrieval artifacts, manifests, logs, dataset digests, or policy documents.

### Required checks

- Verify Plan/runtime input hashes and candidate identity.
- Verify formal IMP-601 prerequisite evidence; code shape alone is not sufficient if repository policy requires acceptance evidence.
- Freeze source/index eligibility from repository-owned contracts.
- Verify local checkout, clean/dirty state, shell, `git`, `pnpm@10.33.0` or repository-approved replacement, Node/runtime, SQLite/FTS feature support, writable external output, and independent-evaluator transport.
- Confirm no required external artifact is missing or substituted.
- Verify any retrieval-quality/latency thresholds are approved artifacts before using them; absence means measurement-only.

### Output

`EVIDENCE_GATE` containing:

- capability matrix;
- prerequisite evidence identities/hashes;
- index-eligibility source matrix;
- actual SQLite/FTS/analyzer feature probe;
- external artifact inventory and hashes/digests;
- per-gate `PASS`/`FAIL`/`INCOMPLETE`;
- final first-modifying-task status: `READY` or `BLOCKED`;
- exact blocking evidence if not ready.

### Forbidden

- Optimizing or editing code.
- Manufacturing missing policy, dataset, analyzer result, threshold, or prerequisite evidence.
- Treating a local non-authoritative FTS probe as candidate-runtime proof.
- Converting missing evidence into PASS.
- Remote publication.

## Implementation Agent

### Entry condition

Run **only after** the Evidence / Runtime Gatekeeper reports the required modifying gates `PASS` and first modifying task `READY`.

### Mission

Implement IMP-606 only: the smallest authorization-safe SQLite lexical retrieval path behind existing `MemoryPort.searchMemory`, with lifecycle-correct derived indexing, explicit analyzer profiles, truthful runtime wiring, and a multilingual baseline inside existing evaluation ownership.

### Inputs

- `TASK_SKILL.md`.
- `COMPILED_SPEC.md`.
- `REPO_CONTEXT.md` updated from `REPO_AUDIT`.
- Concrete `EVIDENCE_GATE` findings.
- Exact local checkout/candidate.

### Implementation boundaries

- Reuse existing public retrieval contract.
- Resolve exact new filenames from current package conventions before creation.
- Authorization/scope/temporal/lifecycle predicates must constrain candidates before lexical ranking.
- Preserve original evidence text; normalization is derived.
- Leave migrations v1-v8 untouched; only additive next migration.
- Keep `fulltextRetrieval` default false.
- Keep vectors, graph, learned reranking, on-demand recall, relationship hypotheses, and remote transport out of scope.
- Extend `airi/services/discord-bot/evals/memory/` rather than creating a disconnected evaluation framework.
- Do not invent quality/latency policy thresholds.

### Required output

Patch plus focused tests plus `IMPLEMENTATION_REPORT` containing:

- exact starting and ending local SHA/worktree state;
- invariant-by-invariant implementation mapping;
- files created/changed and why each is in scope;
- migration/index/analyzer/dataset versions;
- exact commands/cwd/exit codes actually executed;
- focused/full test results;
- feature/capability state;
- limitations/unresolved items;
- local candidate SHA if frozen for measurement.

### Forbidden

- Threshold/policy/workload weakening.
- Fixture/test weakening or suppression.
- Unrelated refactors or provider/voice/generation/delivery/topology changes.
- Changes to migration v1-v8/checksums.
- Broad unauthorized search followed by post-filtering.
- Unevidenced CJK capability advertisement.
- Remote publication unless a later explicit user authorization changes the publication contract.

## Verification Agent

### Mission

Independently evaluate the exact candidate against the source-derived spec and rubric without receiving the implementer's reasoning transcript.

### Inputs

- `COMPILED_SPEC.md`.
- `EVALUATION_RUBRIC.md`.
- `REPO_CONTEXT.md`/`REPO_AUDIT`.
- Exact candidate repository state/diff/SHA.
- Required runtime/analyzer/dataset/evidence artifacts.
- `IMPLEMENTATION_REPORT` only for declarative facts such as commands/files/identities, not hidden reasoning.

### Required checks

- Re-pin candidate and confirm diff scope.
- Re-run focused migration/retrieval/lifecycle/runtime/eval tests and required package typecheck/test commands.
- Verify authorization-before-candidate behavior, not merely final filtered results.
- Verify source evidence immutability and hit provenance.
- Verify migration history and rollback/rebuild.
- Verify runtime advertisement and flag-off prior behavior.
- Reproduce multilingual measurements from the exact dataset/analyzer/index/candidate identities.
- Check that retrieval measurements are not presented as policy thresholds/G8/deployment approval.
- Verify publication compliance.

### Output

`VERIFICATION_REPORT` containing:

- exact candidate and environment identity;
- exact commands/cwd/exit codes/results;
- criterion-by-criterion `PASS`, `FAIL`, or `INCOMPLETE` matching `EVALUATION_RUBRIC.md`;
- artifact hashes/digests used;
- discrepancies from implementer report;
- final verdict.

### Forbidden

- Editing implementation/tests during the same evaluation pass to make them pass.
- Accepting implementer assertions without reproduction where reproduction is required.
- Receiving or using implementer chain-of-thought as evidence.
- Averaging a required failure away.
- Remote publication.

## Independent Falsifier

### Mission

Attempt to disprove the candidate by finding authorization leakage, lifecycle races, analyzer/capability misrepresentation, ranking/profile gaming, benchmark gaming, scope drift, or unrelated behavioral regression even when ordinary tests pass.

### Inputs

- Same evidence class as Verification Agent.
- `EVALUATION_RUBRIC.md` including adversarial checks.
- No implementer reasoning transcript.

### Required attacks

- Cross-guild/cross-room/private terms that exist only in unauthorized material; inspect counts/snippets/rank/timing/log behavior where testable.
- Temporal boundary probes (`since`/`until`, superseded/current/as-of states).
- Delete/redact/correct immediately before search, rollback/failure injection, and rebuild after lifecycle changes.
- Mixed-script/no-space queries, names/aliases, punctuation/width/case/normalization edge cases.
- Requests for unsupported CJK/vector/graph modes to ensure typed failure rather than false emptiness.
- Profile-score perturbation to expose direct raw score addition.
- Repeated candidate rebuild/measurement to expose nondeterminism.
- Dataset/fixture modifications that would improve reported metrics without improving behavior.
- Capability-advertisement mismatch between constants, composition, feature flags, and actual analyzer evidence.
- Diff scan for migration rewrites, threshold relaxation, test disabling, unrelated behavior, or remote-publication artifacts.

### Output

`FALSIFICATION_REPORT` containing:

- attempted counterexamples and exact reproduction steps;
- observed results/evidence;
- policy/benchmark/test gaming checks;
- semantic regression findings;
- missing cases/evidence;
- criterion-linked `PASS`/`FAIL`/`INCOMPLETE` findings;
- final verdict.

### Forbidden

- Assuming correctness because tests pass.
- Editing the implementation or fixtures to create a pass.
- Receiving implementer reasoning transcript.
- Treating an unexercised attack as PASS.
- Remote publication.

## Evidence / Documentation Agent

### Entry condition

Run only after both independent Verification and Independent Falsifier reports PASS all required criteria and the exact candidate identity is frozen.

### Mission

Update local evidence/documentation truthfully for the exact verified candidate and produce a promotion audit without changing product code or publishing remotely.

### Inputs

- Exact verified candidate SHA.
- `VERIFICATION_REPORT`.
- `FALSIFICATION_REPORT`.
- Retrieval benchmark/dataset/analyzer/index manifests and hashes.
- Existing repository evidence/status conventions.
- Publication contract.

### Required checks

- Preserve measured-code, evidence-documentation, and candidate identities separately.
- State language capability limits exactly as analyzer evidence supports.
- Record dataset/analyzer/index versions/digests and reproduction commands.
- Do not call IMP-606 measurements G8 pass, deployment approval, or threshold-policy success.
- Do not imply IMP-804 is completed; at most record that its prerequisite lexical baseline is available if the spec is satisfied.
- Reconcile stale status text only with source-backed current evidence.

### Output

Local evidence/docs patch plus `PROMOTION_AUDIT` containing:

- exact changed evidence/docs files;
- candidate/evidence hashes and identities;
- claim→evidence mapping;
- limitations/unsupported capabilities;
- publication compliance audit;
- final promotion `PASS`/`FAIL`/`INCOMPLETE`.

### Forbidden

- Product/runtime/test implementation changes.
- Claim promotion beyond evidence.
- Inventing missing reviewer/policy/threshold approval.
- Rewriting historical evidence identities.
- Remote branch/push/PR/issue/comment/label/merge/release mutation under current authority.
