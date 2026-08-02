Legend for "MUST?": Y = MUST, N = SHOULD/MAY. "Test?" flags MUSTs lacking a test with `‼ MISSING`.

| Req ID | Requirement | Evidence | Decision | Spec section | Schema/API | Backlog task | Test | Metric | Rollout gate | MUST? | Flag |
|---|---|---|---|---|---|---|---|---|---|---|---|
| REQ-MEM-001 | Single memory authority via transport-neutral MemoryPort; text/voice stop owning process-local histories | Baseline item 1; EV-001 | ADR-002 | 10.6 | `MemoryPort` | BL-001, BL-009 | TEST-MEM-001 | % writes via MemoryPort | M1 | Y | — |
| REQ-OPS-001 | M1 = in-process; standalone service deferred | Baseline item 2; risk A; EV-001 | ADR-001 | 10.16 | n/a | BL-002, BL-003 | TEST-OPS-001 | # standalone-service deployments (must be 0 in M1) | M1 | Y | — |
| REQ-EVENT-001 | Discord user ID is durable Discord identity key | Baseline item 3; EV-002, EV-003 | ADR-003 | 10.2 | `person.discord_user_id` | BL-004 | TEST-ID-001 | identity-continuity pass rate | M1 | Y | — |
| REQ-EVENT-002 | Actor snapshot on every inbound event | Baseline item 4 | ADR-004 | 10.2, 10.4 | `actor_snapshot` | BL-006 | TEST-EVENT-001 | % events with snapshot | M1 | Y | — |
| REQ-EVENT-003 | Current identity vs historical presentation distinguished | Baseline item 5 | ADR-004 | 10.2 | `alias.valid_until`; `actor_snapshot` | BL-005, BL-006 | TEST-ID-002 | historical display correctness | M1 | Y | — |
| REQ-SCOPE-001 | Scoped aliases (platform/char-global/guild/room/private) | Baseline item 6 | ADR-005 | 10.2 | `alias.scope` | BL-005 | TEST-SCOPE-001 | scope-policy pass rate | M1 | Y | — |
| REQ-PRIV-001 | No alias-collision merge; opaque prompt refs | Baseline item 7; EV-002 | ADR-005, ADR-010 | 10.2, 10.7 | `alias` unique; opaque handle | BL-005, BL-027 | TEST-ID-001, TEST-SEC-004 | collision-merge incidents | M1 | Y | — |
| REQ-EVENT-004 | Group voice: one attributable event per speaker; no synthetic author | Baseline item 8; EV-010 | ADR-006 | 10.4 | `raw_event.person_id` NOT NULL for voice | BL-008 | TEST-EVENT-002 | % group-voice events with real person | M1 | Y | — |
| REQ-SCOPE-002 | Physical vs logical rooms distinct; cross-channel via bindings | Baseline item 9 | ADR-005 | 10.3 | `logical_room`, `room_binding` | BL-023 | TEST-SCOPE-002 | cross-room leak count | M1 | Y | — |
| REQ-MEM-002 | Person memory may cross text/voice in scope; no transcript copy | Baseline item 10 | ADR-008 | 10.5, 10.8 | `semantic_fact`, `episodic_memory` | BL-019, BL-020 | TEST-MEM-002 | cross-modal retrieval success | M1 | Y | — |
| REQ-MEM-003 | Layered memory (raw/recent/summary/semantic/episodic/procedural) | Baseline item 11; EV-009 | ADR-008 | 10.5, 10.8 | separate tables | BL-009…BL-021 | TEST-MEM-003 | layer-separation invariants | M1 | Y | — |
| REQ-MEM-004 | Durable facts: provenance/confidence/temporal/supersession | Baseline item 12 | ADR-009 | 10.8 | `semantic_fact` | BL-019, BL-030 | TEST-MEM-004 | fact-supersession correctness | M1 | Y | — |
| REQ-DELIVERY-001 | Delivery separate from generation and persistence | Baseline item 13; EV-006 | ADR-007 | 10.4 | `response.state`, `event_lifecycle` | BL-013, BL-014, BL-015 | TEST-DEL-001 | atomicity-assumption incidents (must be 0) | M1 | Y | — |
| REQ-DELIVERY-002 | Many-to-many causal relations | Baseline item 14; EV-008, EV-010 | ADR-014 | 10.4 | `response_cause` | BL-012 | TEST-DEL-003 | multi-cause response coverage | M1 | Y | — |
| REQ-DELIVERY-003 | Interrupted/failed/unheard/partial not normal turn | Baseline item 15; EV-006 | ADR-007 | 10.4 | `response.state` enum | BL-014, BL-015, BL-016 | TEST-DEL-002 | % partial treated as delivered (must be 0) | M1 | Y | — |
| REQ-RETRIEVAL-001 | Retrieved memory untrusted; hardened prompt serialization | Baseline item 16 | ADR-010 | 10.7 | prompt envelope | BL-027, BL-028 | TEST-SEC-001…004 | injection pass rate | M1 | Y | — |
| REQ-RETRIEVAL-002 | Auth→exact→temporal→lexical→(vector gated) | Baseline item 17; EV-012 | ADR-011 | 10.9 | pipeline | BL-024, BL-026 | TEST-RETR-001 | stage-order invariants | M1 | Y | — |
| REQ-MEM-005 | Enrichment off voice-critical path | Baseline item 18 | ADR-008 | 10.4 | `enrichment_scheduled` state | BL-018 | TEST-MEM-005 | voice-path latency p99 | M1 | Y | — |
| REQ-SCOPE-003 | Explicit isolation/authorization for DM/guild/person/character/room/unbound | Baseline item 19 | ADR-005 | 10.3 | `AuthContext` | BL-022, BL-023 | TEST-SCOPE-003 | unauthorized-read count (must be 0) | M1 | Y | — |
| REQ-PRIV-002 | Forget/correction/export/retention/backup/cache/summary/embedding deletion specified | Baseline item 20; EV-009 | ADR-012 | 10.8, 10.11 | `forget_log`, cascade | BL-029…BL-035 | TEST-FORGET-001 | deletion-completeness score | M1 | Y | — |
| REQ-EVAL-001 | Benchmark all listed dimensions | Baseline item 21 | (no ADR; eval program) | 10.14 | eval harness | BL-038 | TEST-EVAL-* | benchmark coverage | M2 | Y | ‼ MISSING (M2-bound; M1 must have harness skeleton) |
| REQ-OPS-002 | No silent fallback to ephemeral pretending write succeeded | Baseline item 22 | ADR-016 | 10.6, 10.13 | MemoryPort errors | BL-009 | TEST-OPS-002 | silent-fallback count (must be 0) | M1 | Y | — |
| REQ-OPS-003 | Multilingual/CJK retrieval first-class | Risk M; EV-007 | ADR-011 | 10.9 | tokenizer config | BL-025 | TEST-MULTI-001 | CJK recall | M1 | Y | — |
| REQ-OPS-004 | Guild member update handling; intents reviewed | Risk H; EV-011 | (open) | 10.2 | `actor_snapshot` updates | BL-006 | TEST-OPS-003 | snapshot freshness | M1 | Y | ‼ MISSING (intent availability unverified → OQ-BLOCK-004) |
| REQ-DELIVERY-004 | Snapshot version as evidence, not lock | Risk B; ADR-015 | ADR-015 | 10.4 | `response.snapshot_version` | BL-011 | TEST-DEL-004 | concurrent-append handling | M1 | Y | — |

Flagged MUSTs lacking test or operational verification:
- REQ-EVAL-001 (M1 harness skeleton required; full benchmark M2).
- REQ-OPS-004 (blocked on OQ-BLOCK-004 intent availability).

All other MUSTs have at least one TEST-* and one metric.

---
