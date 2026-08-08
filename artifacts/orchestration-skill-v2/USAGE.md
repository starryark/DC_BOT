# Usage — Orchestration Skill v2

Use this bundle when implementing repository changes under heterogeneous tool environments (GitHub connector only, local checkout, CI-backed environment, or mixed).

## 1. Start from capabilities, by phase

Do not ask “does this host have everything?” Ask “what does the next transition require?”

### Compile/spec only

Needs repository reads and task inputs. No local checkout, package manager, runtime, agent launcher, or GitHub write authority is required.

### Implementation

Prefer a writable checkout, but connector-backed exact file changes are acceptable when the user authorizes GitHub writes. Missing repository-native test tooling means the result stops at `PATCH_CREATED_UNVERIFIED`.

### Local verification

Requires the exact candidate in a runnable environment and the repository-approved command route. If the repo declares `pnpm@10.33.0`, use that version or a freshly repository-approved compatible route before claiming pnpm-based checks PASS.

### Independent verification

Requires a separate evaluator context and exact candidate transport. If filesystems are not shared and the candidate is not an authorized remote commit, produce a `CANDIDATE_HANDOFF`.

### Publication

Requires explicit user authority for the requested mutation. Connector permissions alone are not authorization.

## 2. Recommended compact role topology

Default:

1. **Preflight Analyst** — spec audit + repo mapping + capability/evidence gate.
2. **Implementer** — creates the smallest patch.
3. **Independent Verifier** — evaluates the exact candidate from an immutable SHA or candidate handoff.
4. **Evidence/Publisher** — records final evidence and performs authorized publication.

Add a second independent falsifier only when the source plan or task risk explicitly justifies it.

## 3. Example: GitHub connector, no local checkout or pnpm

Allowed:

- re-pin repository;
- direct-read exact files/directories;
- derive an implementation patch;
- create a review branch/commit through authorized GitHub connector writes;
- report `PATCH_CREATED_UNVERIFIED`.

Not allowed to claim:

- local typecheck/test/lint PASS;
- candidate runtime compatibility;
- independent verification unless another context can access the remote candidate or receives a candidate handoff.

This is useful partial completion, not a reason to refuse implementation outright.

## 4. Example: local-only candidate with independent review

Implementer:

- records base SHA/status;
- makes changes;
- runs available checks;
- creates local commit if useful;
- creates `CANDIDATE_HANDOFF` using git bundle, binary patch + additions, or deterministic source archive;
- records manifest and representation hashes.

Evaluator in a separate context:

- verifies handoff hash;
- reconstructs exact candidate from exact base;
- verifies changed-file hashes;
- runs required checks;
- returns PASS/FAIL/INCOMPLETE per criterion.

No remote branch is required.

## 5. Example: stale attachment names

If the runtime supplies `Plan(20260808).md` but an earlier handoff called the same content `Pasted markdown(9).md`, record both display names and one content SHA-256. Treat the logical role + content hash as identity. Do not create two competing plans solely because the platform renamed the attachment.

## 6. Reporting template

End every run with:

- Base: `<repo>@<sha>`
- Candidate: `<sha/branch/handoff-id or none>`
- Highest state: `<execution state>`
- Changed artifacts: `<paths>`
- Checks run: `<commands/results>`
- Checks not run: `<reason>`
- Independent verification: `<status/transport>`
- Publication: `<actions actually taken>`
- Next blocked transition: `<transition + missing capability/evidence>`

## 7. What not to do

- Do not require `pnpm`, `gh`, a direct-child agent launcher, or independent evaluator during compile/spec if that phase does not need them.
- Do not say a source patch failed merely because the host cannot execute the repository test toolchain.
- Do not claim “fresh context” as a provable property beyond the observed handoff/isolation conditions.
- Do not assume a new context can see another context's local files.
- Do not place stale task-specific factory requests or plans next to reusable skill files.
- Do not overwrite the default branch directly when a review branch/draft PR is a safer authorized publication route.
