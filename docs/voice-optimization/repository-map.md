# Repository Map — voice optimization (Optimize.md Wave 0, Agent 0A)

Recorded before any source edit, per Optimize.md §19.

## Checkout state at time of writing

| Repo | Path | Commit | Branch |
|------|------|--------|--------|
| Outer | `DC_BOT` | `45678d1` | `main` |
| Nested | `DC_BOT/airi` | `2ae95253d` | `main` |

`airi/` and `GPT-SoVITS/` are **orphan gitlinks** (mode `160000`, no
`.gitmodules`). Bot source is version-controlled by `airi/.git`, not by the
outer repo — matching runtime-v2 decision D007. Commits touching the bot land
in the nested repo.

### Uncommitted user files — preserved, not modified

Outer repo: `Optimize.md` (untracked), gitlink drift on `GPT-SoVITS` and `airi`.
Nested repo: a large uncommitted working tree under `services/discord-bot/`
(`.config`, `.env`, `src/config.ts`, `src/orchestration/`, `src/providers/`,
`src/voice/`, `src/services.ts`, `vitest.config.ts` and more are untracked or
modified). None of these were reset, stashed, cleaned, or overwritten.

### Relationship to the `new_archetecture` branch

The outer branch `new_archetecture` carries **documentation only**
(`docs/runtime-v2/**`, `Proposal.md`). Runtime V2 **Wave 1 source** is not in
the working tree; it exists on the nested branch `discord-bot-wip-backup`
(commit `33d5f00fc`, "pre-restore snapshot"). Per the operator's decision this
work builds on the **current tree**, not on a wholesale Wave 1 restore. The
single exception is the character subsystem — see `decisions.md` D-V02.

## Component locations (verified)

All paths relative to `airi/services/discord-bot/`.

| Component | Path |
|-----------|------|
| Voice transport / capture / playback | `src/voice/voice-manager.ts` |
| Voice types (session, capture, utterance) | `src/voice/types.ts` |
| Discord adapter (owns client + VoiceManager) | `src/adapters/airi-adapter.ts` |
| Conversation controller (orchestrator) | `src/orchestration/conversation-controller.ts` |
| Guild history session | `src/orchestration/guild-session.ts` |
| Per-guild serialization queue | `src/orchestration/turn-queue.ts` |
| Speech chunker | `src/orchestration/speech-chunker.ts` |
| Turn telemetry | `src/orchestration/telemetry.ts` |
| Gemini brain provider | `src/providers/brain/gemini.ts` |
| Brain system prompt | `src/providers/brain/prompt.ts` |
| GPT-SoVITS TTS provider | `src/providers/tts/gpt-sovits.ts` |
| TTS language routing | `src/providers/tts/language.ts` |
| Qwen ASR HTTP client | `src/providers/asr/qwen-http.ts` |
| Configuration loader (sole `process.env` reader) | `src/config.ts` |
| Shared service registry | `src/services.ts` |
| Slash commands | `src/bots/discord/commands/` |
| Avatar relay publisher | `src/avatar/publisher.ts` |

Logging is `useLogg(<scope>).useGlobalConfig()` from `@guiiai/logg`; global
format/level set in `src/index.ts`. Tests are inline `*.test.ts` beside source;
`vitest.config.ts` globs `src/**/*.test.ts`. Package scripts: `start`
(`tsx --env-file=.env --env-file-if-exists=.config --env-file-if-exists=.env.local`),
`test` (`vitest run`), `typecheck` (`tsc --noEmit`).

## Every `AudioPlayer` call site (Optimize.md §9 tasks 2–3)

| Site | File:line | Note |
|------|-----------|------|
| `createAudioPlayer(...)` | `voice-manager.ts:518` | **Inside `playAudioStream`** — a new player is built per call, not one per guild |
| `audioPlayer.play(resource)` | `voice-manager.ts:534` | The only `play()` in the codebase |
| `player.stop()` | `voice-manager.ts:548` | In `cleanupAudioPlayer` |
| `cleanupAudioPlayer` (destroys active) | `voice-manager.ts:516` | Called at the **top of `playAudioStream`** |
| `cleanupAudioPlayer` | `voice-manager.ts:594` | `teardownSession` |
| `stopPlayback` | `voice-manager.ts:393` | Barge-in, from `onPcmPacket` |
| `stopPlayback` | `conversation-controller.ts:215` | `onBargeIn` |
| `playAudioStream` | `conversation-controller.ts:201` | Per synthesized chunk |
| `playAudioStream` | also reachable from `/voice-test` via `services.ts` | debug command |

## One complete turn, traced

```
receiver.speaking 'start'      voice-manager.ts:240  handleSpeakingStart
  → subscribeMember            voice-manager.ts:318  opus decode pipeline
  → onPcmPacket                voice-manager.ts:366  per 20 ms packet
      · barge-in check                        :383
      · max-utterance force-finalize          :400
      · scheduleFinalize (restart timer)      :407
  → finalizeUtterance          voice-manager.ts:431  after endSilenceMs
  → emit 'utterance'                          :480
ConversationController.onUtterance             :58   NOT queue-gated
  → handleUtterance                            :63
      · convertOpusToWav + asr.transcribe      :70
      · empty-transcript early return          :83
      · abortGeneration(guildId)               :93   barge-in finalize
      · queues.get(guildId).enqueue(...)      :106
  → generateAndSpeak                          :114
      · session.addUserTurn(...)              :132  ← history mutation (user)
      · brain.generate(...)                   :138
      · for await chunkStream(stream)         :143
          → synthesizeAndPlay                 :151
              · resolveTtsLanguage            :186
              · tts.synthesize                :200
              · voice.playAudioStream         :201  ← RESOLVES AT PLAY START
      · session.addModelTurn(fullReply)       :157  ← history mutation (model)
```

### Where a queued task is considered complete

`turn-queue.ts` resolves the enqueued closure when `generateAndSpeak` returns.
`generateAndSpeak` returns once the Gemini stream is exhausted and the last
`synthesizeAndPlay` has returned. Because `playAudioStream` resolves at play
start (below), **the queue considers a turn complete while its audio is still
playing** — the next turn is free to start and overwrite it.

### Does `voice.playAudioStream()` resolve at playback start or end?

**Start.** `voice-manager.ts:509-535` is `async` but contains no `await` after
`play()`; it returns once `audioPlayer.play(resource)` has been *invoked*.
Completion is only observed by a `stateChange` listener that logs
`Audio playback done` (`:526-532`). Nothing awaits that listener.

## Conversation-history mutation points

| Site | File:line |
|------|-----------|
| `session.addUserTurn(turn.userName, turn.text)` | `conversation-controller.ts:132` |
| `session.addModelTurn(fullReply.trim())` | `conversation-controller.ts:155` |
| `history.push({ role: 'user' ... })` | `guild-session.ts:34` |
| `history.push({ role: 'model' ... })` | `guild-session.ts:42` |
| `GuildSession.clear()` | `guild-session.ts:51` (no production caller) |

The user turn is committed **before** generation starts; the model turn only if
the generation was not aborted. An aborted or rate-limited turn therefore leaves
an unmatched user message in history — the pairing defect Optimize.md §10 Step 7
requires fixing.

## Existing test utilities

`conversation-controller.test.ts` builds hand-rolled fakes (a fake
`VoiceManager` extending `EventEmitter`, fake ASR/brain/TTS providers) rather
than `vi.mock`. `publisher.test.ts` injects a fake socket via the
`createSocket` option. There is **no existing mock of `@discordjs/voice`** —
Wave 1A must introduce one. `resetConfigCache()` (`config.ts`) exists for
per-test config isolation.
