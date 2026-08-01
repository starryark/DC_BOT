# Decision Log — voice optimization (append-only)

Ids are `D-Vxx` to avoid colliding with `docs/runtime-v2/04-decisions.md`
(`D0xx`). Never edit a past decision in place — supersede it with a new one.

---

## D-V01 — Build on the current working tree, not on a Wave 1 restore  (Accepted)
- Date: 2026-07-31
- Context: Runtime V2 Wave 1 source is absent from the working tree; it exists
  only on the nested branch `discord-bot-wip-backup` (`33d5f00fc`). The tree in
  use is the pre-Wave-1 "restored" state (52 tests vs the handoff's 158).
- Decision: The operator chose the current tree as the base. No wholesale Wave 1
  restore of room-scoped context, the observability tracer, or the Wave 1
  controller rewiring.
- Consequences: Conversation context stays **guild-scoped** (`GuildSession`),
  which is what Optimize.md §6 specifies (`GuildConversationSession` keyed by
  `guildId`). Room-scoped context (runtime-v2 D003/D011) is deferred. The Wave 1
  handoffs remain accurate about the backup branch, not about this tree.

## D-V02 — Adopt Wave 1's character subsystem; retire the interim card module  (Accepted)
- Date: 2026-07-31
- Context: Two competing character-card implementations existed: the interim
  `providers/brain/character-card.ts` (single-file loader, strips ACT tokens)
  and Wave 1's `src/character/**` (CCv3 validation, lorebook, prompt compiler,
  ACT-v1 parser). The operator chose Wave 1's as authoritative.
- Decision: Port `src/character/{types,card-schema,character-registry,prompt-compiler}`
  and `src/character/output-protocol/act-v1-parser` plus their type closure
  (`src/orchestration/{room-id,events,output,room}.ts`) from `33d5f00fc`.
  Delete `providers/brain/character-card.ts` and its test.
- Consequences: Config moves from `CHARACTER_CARD_PATH` (single file) to
  `CHARACTER_PATH` + `CHARACTER_ID` (root dir + id), matching the 1A handoff's
  integration instructions. ACT tokens are parsed into avatar actions rather
  than stripped (runtime-v2 D006). The type closure brings `RoomStore` into the
  tree; it is **not** wired into the live path under D-V01 — the compiler is fed
  a room view adapted from the guild session.

## D-V03 — Delivery rules are emitted by the prompt compiler and outrank the card  (Accepted)
- Date: 2026-07-31
- Context: The Kurisu card sets Japanese as the default register; this is a
  multilingual voice bot whose output language must follow the most recent
  speaker. The card's `creator_notes` also demand ACT tokens that would be
  spoken aloud.
- Decision: The compiler's runtime/safety section carries the delivery rules
  (output-language-follows-speaker, TTS-safe plain text, no markdown/emoji/stage
  directions) and is declared to outrank character instructions on conflict.
  `creator_notes` is never injected.
- Consequences: The behaviour proven by the existing prompt tests is preserved
  across the character-runtime swap. `stripControlTokens` stays at the TTS
  boundary as a safety net even though ACT is now parsed upstream.

## D-V04 — Playback is owned by a scheduler inside VoiceManager, not a new service  (Accepted)
- Date: 2026-07-31
- Context: Optimize.md §9 Agent 1A permits either a full `VoicePlaybackController`
  or a simpler `playAudio(item)` provided the invariants hold. `VoiceManager`
  already owns the connection, the session map and teardown.
- Decision: Implement the scheduler as a cohesive unit owned by the guild voice
  session inside `src/voice/`, exposing `enqueue`/`cancelEpoch`/`stopAll`/
  `awaitDrained`. `VoiceManager.playAudioStream` becomes a thin wrapper that
  delegates, so `/voice-test` and the controller keep working.
- Consequences: No pass-through service layer (AGENTS.md module-design rule).
  The `AudioPlayer` is created once per voice session and subscribed once.

## D-V05 — Half-duplex admission is enforced in the controller, before ASR  (Accepted)
- Date: 2026-07-31
- Context: Optimize.md §5.1 requires that busy-state speech never invokes ASR.
  `VoiceManager` emits utterances without knowing conversational phase, and must
  not import the controller (circular dependency).
- Decision: `VoiceManager` stays a pure transport. The controller checks phase
  in its `utterance` handler as the first statement, before
  `convertOpusToWav`/`asr.transcribe`, and logs `input_discarded`.
- Consequences: PCM for a dropped utterance is discarded without conversion or
  network I/O. No new coupling in the transport layer.

## D-V06 — Barge-in is disabled by default and gated at the source  (Accepted)
- Date: 2026-07-31
- Context: Today a single loud PCM packet stops playback while generation and
  synthesis continue (`baseline-findings.md` §4), which is exactly the
  uncontrolled interruption Optimize.md §2.4 reports. Optimize.md §17 defers
  real barge-in past the first milestone.
- Decision: `BARGE_IN_ENABLED` defaults to `false`; the amplitude detector in
  `onPcmPacket` is gated on it. With half-duplex active, busy-state speech is
  dropped by admission instead.
- Consequences: Under defaults, playback can no longer be interrupted by
  keyboard noise. Enabling the flag restores the current detector; the full
  sustained-speech flow of §17 remains future work.
