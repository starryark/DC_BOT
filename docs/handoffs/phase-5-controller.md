# Phase 5 Handoff — Conversation Controller (full loop)

## Files changed
- **New** `src/orchestration/conversation-controller.ts` — `ConversationController` wiring utterance → ASR → guild queue → Gemini → chunker → TTS → playback.
- **New** `src/orchestration/speech-chunker.ts` — multilingual sentence/clause chunker (`SpeechChunker` + `chunkStream`).
- **New** `src/orchestration/turn-queue.ts` — per-guild FIFO (`GuildTurnQueue`/`GuildTurnQueueRegistry`).
- **New** `src/orchestration/telemetry.ts` — `TurnTimer` (per-turn stage latency, plan.md §37).
- **Rewritten** `src/index.ts` — direct mode: constructs Asr/Brain/Tts/VoiceManager + `Services`, wires Gemini contents resolver, instantiates `ConversationController`, keeps AIRI adapter for Discord client + commands.
- **Modified** `src/adapters/airi-adapter.ts` — `voiceManager` now public (so index.ts can subscribe to its events).

## Pipeline (plan.md §30)
```
voice 'utterance'
  → asr.transcribe (immediate, concurrent)
  → empty? skip Gemini
  → abortGeneration(guildId)        # barge-in finalize
  → guildTurnQueue (one at a time)
    → session.addUserTurn
    → brain.generate (streaming)
      → SpeechChunker
      → tts.synthesize (per chunk)
      → voice.playAudioStream
    → session.addModelTurn
  → TurnTimer.finish (logs all stages)
```

## Concurrency (plan.md §31)
- ASR runs the instant an utterance finalizes — concurrent across users.
- Per guild, exactly ONE generate+playback runs at a time (`GuildTurnQueue`). One guild cannot block another.
- `voice.on('bargeIn')` → stop playback + abort TTS **immediately**; generation aborts only when a real utterance finalizes (`abortGeneration` in `handleUtterance`), so keyboard clicks don't kill useful work (plan.md §32).

## Instrumentation (plan.md §37)
`TurnTimer` logs per turn: `turnId, guildId, userId, audioDurationMs, endpointDelayMs, asrMs, asrLanguage, geminiFirstTokenMs, geminiCompleteMs, ttsFirstAudioMs, ttsCompleteMs, playbackStartedMs, totalUserStopToAudioMs`.

## Tests run
- `pnpm -F @proj-airi/discord-bot typecheck` → **PASS** (exit 0).
- Monorepo-wide stale-import check for `pipelines/tts` and old `summon` internals → clean.

## NOT done / deferred to runtime
The full-loop runtime acceptance (plan.md §53 DoD) requires the **GPU environment** that this session could not stand up:
- `qwen3-asr` Python service needs a venv with `qwen-asr` + CUDA torch (machine has Python 3.13; qwen-asr needs <3.13). Unit tests written but not run here.
- GPT-SoVITS needs conda + multi-GB pretrained model download (`GPT_SOVITS_KURISU_SETUP.md`). `install.ps1` requires conda, which isn't installed.
- Gemini needs a real `GEMINI_API_KEY`.

All code is complete, wired, and typechecks. The operator must: (1) run `GPT_SOVITS_KURISU_SETUP.md`, (2) create the `qwen3-asr` venv + run its server, (3) fill `.env`, then `pnpm -F @proj-airi/discord-bot start`.

## Known follow-ups
- Barge-in generation-abort fires on every finalized utterance in a busy guild, which is correct but means a second human turn always supersedes the first's in-flight reply. Intended per plan.md §32.
- `voice-test.ts` requires `/summon` first (bot must be in the channel) — documented in the reply message.
- discord-bot's now-unused deps (`@huggingface/transformers`, `@xsai/*`, `@proj-airi/audio`) remain in package.json; confirmed unused in src, safe to remove in a cleanup pass.
