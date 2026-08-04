# DC_BOT Refined Next-Step Plan — Existing Token, Character-Identity Gate, and A8 Qualification

- **Repository:** `starryark/DC_BOT`
- **Default branch:** `main`
- **Observed current candidate:** `ef447a8b71a77d98bb6565ab6361186769beedcc`
- **Requested credential posture:** Reuse the existing `DISCORD_TOKEN`; do not create, rotate, duplicate, print, or commit a second Discord credential.
- **Qualification target:** One exact source commit and one fixed operator configuration, followed by the private thirteen-scenario soak, independent review, and an accurate A8 record.
- **Current decision:** The existing-token change is valid, but T002 is **blocked by a character-identity preflight**. The tracked character configuration uses `Makise Kurisu`, while memory identifiers and binding-file `characterId` values reject whitespace. Under the pinned code, a successfully loaded character is passed to `asCharacterId` without normalization. The candidate must not be called executable until the effective private configuration proves a valid token-shaped character ID or a minimal fix is committed and a new candidate is frozen.
- **Confidence:** High for repository contracts and the newly identified character-ID conflict; live Discord, provider, backup, observer, and reviewer facts remain external and unverified.

## 1. Refined decision

### Existing Discord token

The runbook's phrase “dedicated credential installed only in a private guild” describes the credential's **scope**, not its age or novelty. Reusing the existing `DISCORD_TOKEN` is acceptable when all of the following are true:

1. the application is installed only in the private qualification guild;
2. the bot is stopped before `prepare`;
3. the token remains in its existing private secret source;
4. no token value or token-derived value is written to the binding, configuration manifest, run state, report, attestation, review, logs, or repository.

No second Discord application or token is required.

### Newly discovered blocker

The tracked configuration sets `CHARACTER_ID=Makise Kurisu`. The character registry returns the configured folder ID as `character.id`. `src/index.ts` passes a successfully loaded `character.id` directly to `asCharacterId`, while the memory-domain ID contract and room-binding schema allow only `[A-Za-z0-9_:.-]` and reject whitespace.

Consequences:

- a normal load of the tracked `Makise Kurisu` card can fail before the Discord adapter starts, even when memory is off, because function arguments are evaluated before `createMemoryRuntime`;
- a binding file cannot use `Makise Kurisu`;
- a binding file using `Makise-Kurisu` will not match a runtime that passes `Makise Kurisu`;
- the previous plan's instruction to “use the runtime character ID” is insufficient because it does not prove that the effective ID is valid.

Therefore the safe sequence is:

```text
T001A character-identity gate / candidate decision
  → T002 private soak with existing token
    → T003 independent same-SHA review
      → T004 A8 outcome record
```

## 2. Non-goals

- Do not create or rotate a Discord token.
- Do not expose the existing token to the reviewer.
- Do not weaken identifier validation, room isolation, delivery, deletion, backup, migration, rollback, or redaction rules.
- Do not enable semantic memory, summaries, extraction, full-text/vector retrieval, graph features, remote transport, degraded mode, or default memory flags.
- Do not treat a local workaround as equivalent to the tracked default configuration unless its complete safe configuration is fixed, privately recorded, and reviewed.
- Do not begin `prepare` while the character-identity gate is unresolved.
- Do not claim the documentation-only promotion commit was the runtime commit that passed the soak.

## 3. T001A — Resolve the effective memory character identity and freeze the actual candidate

- **Depends on:** None.
- **Primary paths:** `airi/services/discord-bot/.config`; `airi/services/discord-bot/src/index.ts`; `airi/services/discord-bot/src/character/character-registry.ts`; `airi/packages/memory-domain/src/ids.ts`; `airi/services/discord-bot/src/memory/room-bindings.ts`.
- **Purpose:** Prove that the exact environment used for the soak produces one valid memory `CharacterId` and that the private binding file uses that same ID.

### 3.1 No-Discord preflight

Run from `airi/services/discord-bot` with the same environment-file order as `pnpm start`. This command loads configuration and the character card, applies the candidate's exact character-ID expression, and validates it without opening Discord or the memory database:

```bash
pnpm exec tsx \
  --env-file=.env \
  --env-file-if-exists=.config \
  --env-file-if-exists=.env.local \
  -e "import { asCharacterId } from '@proj-airi/memory-domain'; import { config } from './src/config.ts'; import { FileCharacterRegistry } from './src/character/character-registry.ts'; const cfg=config(); const character=cfg.character.root.trim()==='' ? undefined : new FileCharacterRegistry().load(cfg.character.id); asCharacterId(character?.id ?? cfg.character.id.replaceAll(' ','-')); process.stdout.write('memory character id preflight passed\n');"
```

Do not suppress or reinterpret a failure. Preserve the error in private operator evidence.

### 3.2 Decision branches

#### Branch A — Effective private configuration already passes

This is possible only if an existing local environment changes the effective character configuration so the loaded `character.id` is already a valid memory token. Record, privately:

- the effective non-secret character ID;
- the character source digest or immutable source reference;
- the safe configuration manifest described in T002;
- confirmation that the binding file uses the exact same character ID.

Then retain candidate `ef447a8b71a77d98bb6565ab6361186769beedcc`.

#### Branch B — Tracked configuration fails, as repository inspection predicts

Return to candidate hardening and create a new candidate SHA. The preferred minimal correction is:

1. derive one memory character ID from the configured character key with the existing token-safe transformation before constructing the memory runtime;
2. reuse that exact value for `createMemoryRuntime`, the text memory adapter, and the voice memory adapter;
3. keep the character card's folder/display identity separate from the memory identifier;
4. add a test covering a successfully loaded character whose configured folder ID contains a space;
5. add a binding test proving the normalized memory ID matches the binding and starts in active mode;
6. update the runbook to name the memory identifier expected in `binding.characterId`;
7. rerun the complete T001 verification ladder and freeze the resulting full SHA.

A representative implementation direction is to compute one value such as:

```ts
const memoryCharacterId = asCharacterId(cfg.character.id.replaceAll(' ', '-'))
```

and pass `memoryCharacterId` consistently to all memory components. The coding agent must inspect existing tests and choose the narrowest consistent implementation; this line is a design direction, not authorization to skip tests.

#### Branch C — No-code constraint is absolute

Stop as blocked unless the existing private environment already satisfies Branch A. An external aliased character directory and local `CHARACTER_ID` override could make the candidate start, but it would add an external character source not bound by the repository commit or soak tool. That path must not be presented as equivalent to qualifying the tracked configuration. It requires explicit user acceptance, a private immutable digest of the entire aliased character source, and reviewer reconciliation.

### 3.3 Acceptance criteria

- The preflight exits zero.
- The effective memory character ID satisfies the domain ID contract.
- The private binding file uses that exact ID.
- The character source and effective safe configuration are fixed before `prepare`.
- If source changes were required, a new full candidate SHA is recorded and all later commands use it.
- `git status --porcelain` is empty before T002.

## 4. T002 — Provision, prepare, and execute the private soak with the existing token

- **Depends on:** T001A.
- **Concurrency:** Sequential. No bot process, bootstrap process, report process, or configuration edit may overlap `prepare` or the live run.
- **Primary paths:** `airi/services/discord-bot/.env.local`; the external runtime root; external binding file; external evidence directory; active-soak runbook and stages.

### 4.1 External prerequisites

Before any database bootstrap:

- existing `DISCORD_TOKEN` is present in its existing secret source and is not printed;
- the Discord application is confirmed to belong to exactly one private qualification guild;
- the bot process is stopped;
- private text, thread, voice, unbound-canary, and DM test locations are available;
- ASR, model generation, TTS, and Discord playback are available;
- one human observer and one independent reviewer are assigned;
- an operator-only absolute runtime root and evidence directory exist outside the checkout;
- an external version-1 binding file is ready and confined to one guild;
- a **real verified v7 backup** exists for scenario 12.

Keep the two backups distinct:

1. `prepare` creates the **pre-soak backup of the current authority** and binds its digest to the run;
2. scenario 12 uses a separate **verified v7 backup** for restore, forward migration, and obligation replay.

The prepare-created backup does not satisfy the v7 prerequisite.

### 4.2 Operator-local configuration

Create or update `airi/services/discord-bot/.env.local` only after T001A. At minimum:

```dotenv
MEMORY_MODE=active
MEMORY_RUNTIME_ROOT=<absolute-private-runtime-root>
MEMORY_BINDING_FILE=<absolute-private-binding-file>
```

Add character overrides only when T001A explicitly selected and documented an approved private configuration. Do not duplicate `DISCORD_TOKEN` merely for the soak. Confirm `.env.local` is ignored:

```bash
git check-ignore -q .env.local
```

### 4.3 Safe configuration manifest

Do not hash or publish a token-containing `.env` file. Instead create a canonical private JSON manifest from non-secret effective values:

- candidate SHA;
- memory mode and expanded memory profile;
- memory character ID;
- binding-file SHA-256;
- resolved runtime-root and evidence-directory references in the private copy;
- backend, ASR/model/TTS provider and model identifiers;
- input policy;
- tracked `.config` blob SHA;
- character-source digest or immutable reference;
- v7 backup digest;
- operator confirmation that the existing token source and one-guild application scope were unchanged.

Store a SHA-256 of the canonical manifest in the operator and reviewer evidence. Any change to a listed value after this point aborts the run.

### 4.4 Filesystem protection

On POSIX, create private roots under `umask 077` and verify the runtime root, binding file, evidence directory, authority, run state, and backups are not group- or world-accessible. On Windows, use an operator-only ACL and record the ACL/protection regime privately.

### 4.5 Binding preflight

The binding file must:

- use version 1;
- declare at least one binding;
- use valid 17–20 digit Discord snowflakes;
- include at least two locations per binding;
- contain no DM location;
- remain within exactly one guild across the whole file;
- contain no overlapping location for the same character;
- use the exact T001A memory character ID;
- omit the unbound-guild canary channel used by scenario 5.

Run a no-Discord parser and identity reconciliation before bootstrap. Any parser, guild, or character mismatch is a hard stop.

### 4.6 Authority bootstrap

The operator CLI cannot initialize a missing authority. If `authority/memory.sqlite` does not exist, use the existing SQLite API once, without Discord, after filesystem and character/binding preflights:

```bash
pnpm exec tsx \
  --env-file=.env \
  --env-file-if-exists=.config \
  --env-file-if-exists=.env.local \
  -e "import { mkdirSync } from 'node:fs'; import { resolve } from 'node:path'; import { openAuthoritativeSqliteDatabase } from '@proj-airi/memory-sqlite'; import { resolveMemoryRuntimePaths } from './src/memory/runtime-paths.ts'; const root=process.env.MEMORY_RUNTIME_ROOT?.trim(); if (!root) throw new Error('MEMORY_RUNTIME_ROOT is required'); const repoRoot=resolve(process.cwd(),'../../..'); const paths=resolveMemoryRuntimePaths(repoRoot,root); mkdirSync(paths.authorityDirectory,{recursive:true,mode:0o700}); const handle=openAuthoritativeSqliteDatabase(paths.authority); handle.close(); process.stdout.write('authority initialized\n');"
```

If the authority already exists, do not recreate it. Run:

```bash
pnpm memory:integrity -- --root "$MEMORY_RUNTIME_ROOT"
```

Abort on integrity failure.

### 4.7 Candidate and preparation gate

Immediately before `prepare`:

```bash
git rev-parse HEAD
git status --porcelain
```

Expected: the T001A candidate full SHA and no status output.

Then run:

```bash
pnpm memory:active-soak -- prepare \
  --run-id <unique-run-id> \
  --commit <T001A-candidate-sha> \
  --root <absolute-runtime-root> \
  --binding-file <absolute-binding-file> \
  --out <absolute-evidence-directory>
```

Confirm the returned run state privately records:

- exact candidate SHA;
- schema v8;
- active mode;
- thirteen scenario IDs;
- expected binding digest;
- pre-soak backup digest;
- expected protection regime.

### 4.8 Live execution

Start the bot only after `prepare` succeeds:

```bash
pnpm start
```

Execute all thirteen runbook scenarios in strictly separate, non-touching windows with the human observer:

1. startup binding reconciliation;
2. empty-history text;
3. bound text/voice recall;
4. bound parent/thread behavior;
5. unbound guild-channel isolation;
6. DM isolation;
7. restart continuity;
8. multi-segment text delivery;
9. completed and cancelled voice playback;
10. privacy status/show/export;
11. disabled remember/correct;
12. forget, deletion verification, v7 restore, migration, and obligation replay;
13. stopped-process active-to-off rollback.

Preserve the tracked half-duplex policy. Pace voice scenarios so speech sent while the bot is thinking or speaking is not mistaken for a memory failure.

Stop immediately on any source/configuration change, process-ownership conflict, provider outage that prevents a required scenario, room/DM leakage, missing or late manifest, digest mismatch, unresolved delivery, semantic write, deletion failure, v7 restore/replay failure, rollback failure, raw identifier leakage, or machine/human disagreement.

### 4.9 Report and local verification

Stop the bot before reporting:

```bash
pnpm memory:active-soak -- report \
  --state <absolute-private-run-state.json> \
  --attestation <absolute-private-attestation.json>

pnpm memory:active-soak -- verify \
  --report <absolute-redacted-report.json> \
  --commit <T001A-candidate-sha>
```

### 4.10 T002 acceptance criteria

- existing token used; no second token/application created;
- candidate SHA and safe configuration manifest unchanged;
- all thirteen unique non-touching scenarios pass;
- machine and human evidence agree;
- real forget request and tombstone exist in scenario 12;
- the separate v7 restore/migration/replay passes;
- rollback contains no post-off generation evidence;
- report verifies at the exact candidate SHA;
- no private artifact or token is tracked;
- worktree remains clean.

## 5. T003 — Independent same-SHA review

- **Depends on:** Complete T002 evidence.
- **Reviewer independence:** Reviewer did not implement the report tooling and was not the primary observer.
- **Token handling:** The reviewer does not receive `DISCORD_TOKEN`.

Provide:

- candidate SHA;
- runbook;
- redacted report and digest;
- operator attestation and observer record;
- safe configuration-manifest digest;
- binding, pre-soak backup, v7 backup, and character-source digests;
- defect/rerun records;
- secure private access needed to reconcile redacted identifiers with the bound authority and backups.

The reviewer checks out the exact candidate and runs:

```bash
pnpm memory:active-soak -- verify \
  --report <absolute-redacted-report.json> \
  --commit <candidate-sha>
```

The reviewer must also confirm that the memory character ID, binding digest, character-source digest, candidate SHA, and safe configuration manifest remained fixed from preflight through report.

**Decision:** dated, attributable, and unambiguous `accept` or `reject`. Any requested source, test, runbook, tracked configuration, or identity-normalization change creates a new candidate and returns to T001A.

## 6. T004 — Record the A8 outcome

- **Depends on:** T003 decision.
- **Promotion targets:** `docs/memory/CURRENT.md`; `docs/memory/evidence/evidence-index.md`; redacted report; reviewer decision; sanitized defect/rerun record when applicable.

Commit only sanitized artifacts. Record:

- qualified candidate SHA;
- execution date and safe run identity;
- schema version;
- binding, pre-soak backup, v7 backup, character-source, safe configuration, and report digests as appropriate;
- observer and reviewer roles;
- machine assertion summary;
- accepted or rejected outcome.

On acceptance, close only A8 for the exact candidate and tested configuration. State that defaults remain off and broader rollout is not authorized. On rejection, leave A8 open and name the failed condition and corrective task.

The later documentation commit is not the qualified runtime SHA.

## 7. Risks and stop conditions

- **C001 — Existing-token wording:** Resolved. “Dedicated” means private-guild-scoped; it does not require a newly created token.
- **C002 — Character identity mismatch:** Critical and unresolved until T001A passes. Do not run `prepare` before resolution.
- **R001 — Hidden local environment:** `.env` or `.env.local` may change the effective character or provider configuration. Derive and manifest effective safe values; do not assume tracked `.config` is the whole configuration.
- **R002 — Configuration not machine-bound by the soak tool:** Use the canonical safe configuration manifest and independent reconciliation.
- **R003 — Guild membership is external:** Record a private operator confirmation that the application is present in exactly one guild.
- **R004 — Runtime-root privacy:** Protect both runtime and evidence roots; `prepare` directly hardens the evidence directory but not every external configuration source.
- **R005 — Backup confusion:** The pre-soak v8 backup and the scenario-12 v7 backup are separate requirements.
- **R006 — External roles:** Observer and independent reviewer must be assigned before preparation.
- **R007 — Half-duplex timing:** Do not edit tracked policy to make the scenario easier; pace the test or abort.
- **R008 — No CI status on candidate:** Reproduce and record repository-native tests, typechecks, lint, benchmarks, secret scan, and diff checks locally before the live run.

## 8. Verification ladder

1. **Repository identity:** Confirm `main`/candidate SHA and clean worktree.
2. **Character identity:** Run T001A no-Discord preflight and binding identity reconciliation.
3. **Safe configuration:** Generate canonical non-secret manifest and digests.
4. **Private filesystems:** Verify POSIX modes or Windows ACLs.
5. **Authority:** Bootstrap only if absent, then run integrity.
6. **Prepare:** Bind candidate, root, guild binding, current backup, schema, and scenarios.
7. **Live matrix:** Execute thirteen distinct scenarios with observer.
8. **Report/verify:** Produce the content-free report and verify exact SHA/schema.
9. **Independent review:** Same-SHA verifier run and private reconciliation.
10. **Promotion record:** Commit only sanitized evidence; verify defaults remain off.

## 9. Coding-agent contract

- **Order:** T001A → T002 → T003 → T004.
- **Do not edit during T002/T003:** source, tests, dependencies, lockfiles, migrations, checksums, runbook, tracked `.config`, gateway intents, providers, token, default flags, or private evidence.
- **Do not continue when:** character-ID preflight fails; candidate/worktree/config digest changes; token fails; application is not private-guild-only; bot is running; authority integrity fails; binding identity/guild rules fail; v7 backup is unavailable; a scenario fails; evidence leaks; reviewer is not independent; or any fix requires a candidate change.
- **Definition of done:** one executable candidate and fixed safe configuration pass all thirteen scenarios with the existing token, an independent reviewer accepts or rejects the same SHA, and the sanitized A8 record accurately preserves the result.

## 10. Evidence additions from refinement

- **E018:** `airi/services/discord-bot/.config` sets `CHARACTER_ID=Makise Kurisu`.
- **E019:** `FileCharacterRegistry` returns `id: characterId`, preserving the configured space-bearing folder identity.
- **E020:** `src/index.ts` passes `character?.id` directly to `asCharacterId` when the card loads; the space-to-hyphen fallback applies only when no character is loaded.
- **E021:** `memory-domain/src/ids.ts` rejects whitespace in all domain IDs.
- **E022:** `room-bindings.ts` applies the same token-shaped rule to `binding.characterId` and later requires exact equality with the runtime character ID.
- **C002 conclusion:** Under the tracked configuration and successful character-card load, the pinned candidate is not proven startable and its binding identity is contradictory. This must be resolved before the private soak.
