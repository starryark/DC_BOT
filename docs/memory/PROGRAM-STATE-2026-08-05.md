# DC_BOT shared memory — implementation state

**Compiled:** 2026-08-05 from the working tree at `4087409`
**Qualified runtime SHA:** `86ca5cfc674997820fe4d1f235d1d16f30ce1470` — operator-qualified, not independently reviewed

> A narrow slice of memory is qualified. Most of the program is still dark.
>
> The A8 gate closed today against one commit and one configuration. What that
> sentence covers is considerably smaller than "the bot has memory".

| | |
| --- | --- |
| Qualified commit | `86ca5cfc` — 12 of 12 scenarios, operator-attested |
| Active feature flags | **5 of 16** |
| Services consuming memory | **1 of 7** (`discord-bot` only) |
| SQLite schema | v8, eight checksummed forward migrations |
| Tests | 845 across 71 files |
| Open red-team blockers | 1 (`FIND-010`, gateway intent assumptions) |

---

## 1. What "qualified" actually covers

The soak proved that **visible and audible delivery agree with the durable
record** for a deliberately narrow capability: durable shared recent context
across text and voice, gated on delivery state, scoped to configured rooms,
with working export and deletion. That is the whole of it.

The `active` profile turns on five of sixteen feature flags. The remaining
eleven are implemented to varying depth, contractually specified, and switched
off — several are hard-gated behind ADRs and reject calls with
`UNSUPPORTED_CAPABILITY` rather than degrade silently.

| Flag | State | Note |
| --- | --- | --- |
| `durableEvents` | **on** | active profile |
| `actorSnapshots` | **on** | active profile |
| `roomBindings` | **on** | active profile |
| `sharedRecentContext` | **on** | active profile |
| `deliveryLifecycle` | **on** | active profile |
| `preferredAliases` | off | built in domain + persistence, not enabled |
| `explicitSemanticMemory` | off | refuses and records the refusal |
| `summaries` | off | gated |
| `autoExtraction` | off | gated |
| `fulltextRetrieval` | off | gated |
| `vectorRetrieval` | off | ADR-011 |
| `onDemandRecall` | off | gated |
| `relationshipHypotheses` | off | ADR-011 |
| `remoteTransport` | off | ADR-001 |
| `degradedStatelessMode` | off | not usable — spool protocol unimplemented |
| `durableWriteSpool` | off | not usable — spool protocol unimplemented |

Two are worth naming explicitly:

- **Explicit semantic memory is off.** "Remember this" refuses and records the
  refusal. The character has continuity of conversation, not a fact store.
- **Degraded mode cannot be activated** until its spool protocol is implemented,
  so the documented fallback for a failing authority does not yet exist in
  usable form.

---

## 2. Gate ladder

The program's gate table lives in `implementation-status.md`, which has not been
touched since 2026-08-02 and still reads "not started" for G4 through G8.
Meanwhile the A-series work shipped delivery lifecycle, text/voice integration,
context assembly and privacy controls, and the soak exercised all four. **The
frozen table materially understates the codebase.**

| Gate | Frozen table (2026-08-02) | Observable today | Formal sign-off |
| --- | --- | --- | --- |
| Entry · G1 Domain | passed | Contract package, no Discord or DB imports | recorded |
| G2 technical | complete | Persistence, ownership guard, boundary tests | recorded |
| G2 operational | pending | Soak now supplies host/writer/storage/backup evidence | `OQ-EVIDENCE-003` open |
| G3 Identity | IMP-301A only | Actor snapshots live and enabled in `active` | `FIND-010` open |
| G4 Event / delivery | not started | Full lifecycle shipped; 25 deliveries, 0 unresolved | not updated |
| G5 Text / voice | not started | One authority for both; cross-modality recall proven | not updated |
| G6 Context assembly | not started | Manifests, injection-safe serializer, 150 items in soak | not updated |
| G7 Privacy | not started | Status, show, export, forget; 34 verified tombstones | not updated |
| G8 Evaluation | not started | No benchmark harness; `REQ-EVAL-001` still missing | genuinely open |

Read the third column as **capability, not authorization**. G4 through G7 have
formal acceptance criteria in the backlog that no one has walked through and
signed; the soak is strong evidence toward them, not a substitute for the
record. **G8 is the one that is genuinely untouched** — there is no evaluation
harness at all.

---

## 3. Three things that are true right now and easy to get wrong

### The shipped configuration is not the qualified configuration

*Since `4087409`.* The soak ran under `BOT_INPUT_POLICY=half_duplex` with
barge-in disabled. Talk-over interruption was enabled afterwards as a product
decision, so the voice-interruption path is outside the qualification.
Everything the soak established about memory still holds — none of it depends on
the input policy — but scenario 8's cancellation was driven by an explicit
command, not acoustically. A governance test now fails if the config drifts from
the docs again.

### Two documents both present as current status

`implementation-status.md` calls itself "the live status page" and is frozen at
2026-08-02. `CURRENT.md` is genuinely current. A reader who opens the first one
will conclude that half the program does not exist.

### Operational approval is still pending

G2 operational deployment needs an authorized operations owner to record host,
writer, storage, backup and soak evidence in a versioned artifact. The soak now
produces most of that evidence, but no owner sign-off exists. Active memory is
qualified as a capability and remains **unapproved as a deployment**.

---

## 4. What live execution caught that the test suite did not

Five defects surfaced only under a real soak, against a suite that was green
throughout. This is the strongest argument the program has for keeping the gate
expensive.

| ID | Failure | Why the suite missed it | Fixed in |
| --- | --- | --- | --- |
| DEFECT-001 | Bot denied hearing anything said aloud | Serializer dropped modality; a spoken turn was byte-identical to a typed one | `c2ee231` |
| DEFECT-003 | Detailed requests returned 2–14 characters | Thinking tokens billed against the output ceiling; severity ran opposite to intent | `808c107` |
| DEFECT-004 | Every voice reply recorded `failed` while sounding correct | Output repository takes a whole-set declaration, not an append log | `519583a` |
| DEFECT-005 | A transient upstream 503 killed the process | Error reporter re-raised inside a catch; no error sink on the gateway client | `86ca5cfc` |
| *Process* | A report passed all seven machine assertions on recycled windows | Assertions check internal consistency, not whether windows belong to the run | documented |

The last row is the uncomfortable one. An earlier attestation copied a previous
run's windows forward and rewrote a voice failure as a pass; every automated
check still went green. **The machine gate cannot detect a fabricated
observation** — only the ≥1s non-touching window rule enforced at recording
time, and someone reading the notes.

---

## 5. Where the effort has actually gone

| Package | Files | Tests | Role |
| --- | ---: | ---: | --- |
| `memory-domain` | 10 | 212 | Identity, rooms, authorization, causality, delivery, MemoryPort |
| `memory-sqlite` | 16 | 138 | Migrations v1–v8, repositories, unit-of-work, backup, writer guard |
| `discord-bot` | 45 | 495 | Adapters, orchestration, providers, soak tooling, docs governance |
| **Total** | **71** | **845** | Plus 17 approved ADRs and 27 program artifacts |

Worth noting what this shape implies: the domain and persistence layers are
heavily specified and heavily tested, and the defects all landed in the **seam
between them and Discord** — serialization, adapters, provider error handling.
That is where the next ones will be too.

---

## 6. What would move this forward

These are recommendations, not decisions already taken.

- **Reconcile the status documents.** Either retire `implementation-status.md`
  as a dated artifact or bring its gate table forward. Right now it actively
  misleads.
- **Walk G4–G7 acceptance criteria and record them.** The capability is there
  and soak-tested; the paperwork is what is missing, and it is cheap relative to
  what it unblocks.
- **Decide on operational approval.** The soak produces most of what
  `OQ-EVIDENCE-003` asks for. Someone has to sign it, or active memory stays
  permanently "qualified but not approved".
- **Build the evaluation harness.** G8 is genuinely empty and blocks any claim
  about retrieval quality, latency targets, or the vector/graph gates behind it.
- **Re-qualify if barge-in stays.** A fresh candidate and twelve-scenario run
  under the new input policy, or accept that voice interruption is unqualified.
- **Point the runtime root somewhere permanent.** Live use currently writes into
  the qualification evidence tree, mixing operational data with an audit
  artifact.

---

## Method and limits

Compiled by reading the working tree, not by trusting the program's own status
pages — which is how the stale gate table in §2 surfaced.

Two limits on what is above:

1. The "observable today" column in §2 is a reading of the code against gate
   *descriptions*, not against the formal acceptance criteria in artifact 21.
   Treat it as evidence toward those gates, not a verdict on them.
2. §6 is recommendation, not plan of record.

Sources: `docs/memory/{CURRENT.md,implementation-status.md,continuation-blocker-report.md,g2-technical-continuation-scope.md}`,
`docs/memory/evidence/`, `airi/services/discord-bot/src/memory/{profile,feature-flags}.ts`,
`airi/packages/memory-{domain,sqlite}/`, and the run tree for
`t002-86ca5cfc-20260805b`.
