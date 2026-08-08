# Candidate Handoff Contract

A `CANDIDATE_HANDOFF` is the portable representation of an implementation candidate when the evaluator cannot directly access the implementer's worktree.

It exists to make **local-only independent verification** possible without assuming contexts share a filesystem and without requiring a remote push.

## Required manifest

Create `candidate-handoff.json` or an equivalent machine-readable manifest containing:

- schema/version;
- repository `owner/name`;
- requested/base ref;
- exact base SHA;
- candidate SHA if a local or remote commit exists, otherwise `null`;
- packaging timestamp;
- worktree/status summary at packaging time when a checkout exists;
- transport representation and SHA-256;
- changed tracked files;
- added/untracked files included;
- deleted files;
- dependency/lockfile identities when relevant;
- tool/runtime versions actually used;
- commands actually executed with cwd and exit status;
- mandatory checks not executed and reason;
- publication authority in effect at packaging time.

## Accepted candidate representations

Use exactly one primary representation:

1. **Immutable shared commit** — repository + exact SHA accessible to evaluator.
2. **Git bundle** — contains the candidate commit/history needed to reconstruct from base.
3. **Binary-capable patch** — `git diff --binary` plus explicit untracked/addition payloads.
4. **Source archive** — deterministic archive of candidate files plus a complete manifest, used only when git-native transport is unavailable.

A text-only diff that omits untracked files is not a complete candidate if those files affect behavior.

## Integrity requirements

For every transported file/artifact record:

- logical role/path;
- byte size;
- SHA-256.

The manifest itself must also have a SHA-256 recorded in the handoff report.

If the transport includes generated benchmark/evidence artifacts, hash them separately and distinguish them from source candidate files.

## Reconstruction rule

The evaluator must prove that the candidate it evaluates corresponds exactly to the handoff:

- for a shared commit: verify repository and SHA;
- for a git bundle: import and verify candidate/base ancestry;
- for a patch: apply to the exact base SHA and verify the resulting changed-file hashes;
- for an archive: verify every manifest hash and record that git-history semantics were unavailable.

If reconstruction fails, evaluation is `INCOMPLETE`, not `FAIL` for product behavior.

## Unrelated-work rule

Do not package unrelated user changes silently.

If a mixed worktree exists, the handoff must identify included versus excluded changes. If safe separation cannot be established, stop packaging and report the ambiguity.

## Independence rule

Do not include implementer chain-of-thought or solution-persuasion material. Declarative implementation facts are allowed, including:

- files changed and why;
- commands/results;
- known limitations;
- candidate/base identities;
- migration/schema/dataset/analyzer versions.

The evaluator must derive its verdict from source spec, repository/candidate state, executable evidence, and the evaluation rubric.

## Minimal handoff report

Report:

- `CANDIDATE_HANDOFF_ID` (manifest SHA-256);
- base SHA;
- candidate SHA if any;
- representation type;
- representation SHA-256;
- included file count;
- known excluded/unrelated changes;
- checks already run;
- checks still required.
