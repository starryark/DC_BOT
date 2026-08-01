# Baseline Findings — voice optimization (Optimize.md Wave 0, Agent 0B)

Evidence gathered from `bot_log .txt`, `bot_log_2 .txt`, `Inference_Log.txt`,
`Inference_Log_2.txt` and a read of the current source. No production code was
changed to produce this document.

## 1. Quantified log evidence

| Metric | Value | Source |
|--------|-------|--------|
| Total GPT-SoVITS syntheses recorded | 24 | `Synthesizing` lines, both bot logs |
| Syntheses ≤ 16 characters | **19 / 24 (79 %)** | `chars=` histogram |
| Smallest synthesis | **2 characters** | `chars=2` |
| Syntheses ≥ 25 characters | 5 (25, 32, 51, 59, 62) | histogram |
| Gemini `429 RESOURCE_EXHAUSTED` | 8 | both bot logs |
| Observed `retryDelay` values | `50s`, `37s` | error payloads |
| Observed `quotaMetric` | `generativelanguage.googleapis.com/generate_content_free_tier_requests` | error payloads |
| Barge-in events | 1 | `Barge-in detected` |
| GPT-SoVITS `naive_infer` fallback | **17 / 17 (100 %)** | inference logs |

Chunk-size histogram (characters × occurrences):

```
 2×1   4×2   6×5   7×1   8×2   9×2  10×1  11×1  12×1
13×1  15×1  16×1  25×1  32×1  51×1  59×1  62×1
```

## 2. Playback replacement — the cut-off defect

`@discordjs/voice` destroys and replaces the active resource when
`AudioPlayer.play()` is called while another resource is playing. The current
implementation makes that the *normal* path rather than an exceptional one.

`src/voice/voice-manager.ts:509-535`:

1. `playAudioStream()` calls `cleanupAudioPlayer(session)` **first** (`:516`),
   which invokes `player.stop()` on whatever is currently playing.
2. It then constructs a **new** `AudioPlayer` per call (`:518`) instead of
   reusing one persistent player per guild.
3. It calls `audioPlayer.play(resource)` (`:534`) and returns. The method is
   `async` but has no `await` after the call, so **the returned promise resolves
   at play start, not at playback end**.

The controller awaits that promise per chunk
(`conversation-controller.ts:201`), so chunk *N+1* is synthesized and played
while chunk *N* is still audible — cutting chunk *N* off mid-sentence.

Reproduced in the log (chunk 2 synthesis begins 4.4 s before the first
`Audio playback done`):

```
09:47:34.397  Synthesizing chars=6
09:47:38.844  Synthesizing chars=10
09:47:40.415  Audio playback done  elapsed=1647
09:47:42.668  Audio playback done  elapsed=2034
09:47:42.952  Synthesizing chars=4
```

### Race windows identified

| # | Window | Consequence |
|---|--------|-------------|
| R1 | `cleanupAudioPlayer` → `play()` on a **new** player | active resource destroyed mid-sentence |
| R2 | `playAudioStream` resolves at start | the turn-queue task completes while audio still plays; the next turn begins immediately |
| R3 | Old player's `stateChange` listener still attached after replacement | a stale `idle` event clears `session.activeAudioPlayer` belonging to the *new* playback (`:529` guards identity, but the listener itself is never removed until `cleanupAudioPlayer`) |
| R4 | `audioPlayer.on(...)` registered per call | listener growth proportional to chunk count for the lifetime of a player |
| R5 | Barge-in stops playback but not synthesis | see §4 |

## 3. Async functions that resolve too early

| Function | Resolves when | Should resolve when |
|----------|---------------|---------------------|
| `VoiceManager.playAudioStream` | `play()` invoked | resource reaches `Idle` or errors |
| `ConversationController.generateAndSpeak` | last `synthesizeAndPlay` returned | all accepted playback completed |
| turn-queue task | `generateAndSpeak` returned | same as above |

## 4. Barge-in behaviour today

`onPcmPacket` (`voice-manager.ts:383-396`) triggers on a single packet whose
average amplitude exceeds `BARGE_IN_THRESHOLD`, calls `stopPlayback`, and emits
`bargeIn`. The controller's `onBargeIn` (`conversation-controller.ts:215`)
stops playback and aborts the active TTS request — but the Gemini generation is
only aborted later, when a human utterance *finalizes*
(`conversation-controller.ts:93`). In the log, synthesis continues on the very
next line after a barge-in:

```
09:47:51.453  Barge-in detected
09:47:51.454  Synthesizing chars=8
```

Interruption therefore affects the player but not reliably the rest of the
pipeline: queued chunks, in-flight generation and already-completed TTS results
survive.

## 5. Gemini request amplification

Six `Generating response` events occur within ~15 s in the sample above, driven
by short fragments. Fragment transcripts observed include `嗯。`, `我。`,
`Hello.`, and many `Empty transcription, skipping` lines. Nothing filters
fillers or duplicates before the model call, and nothing suppresses calls after
a quota failure — the 8 recorded 429s were followed by further attempts.

Current endpointing defaults (`config.ts`): `endSilenceMs 650`,
`minUtteranceMs 250`, `maxUtteranceMs 30000`. Utterances of ~0.4–0.9 s
routinely finalize into single-word or filler transcripts.

## 6. Conversation-history pairing defect

The user turn is committed before generation
(`conversation-controller.ts:132`); the assistant turn only on success
(`:155`). An abort or a 429 leaves an unmatched user message in history, which
is then replayed as context on every subsequent turn.

## 7. TTS conditioning (context for later waves)

`GPT_SOVITS_PROMPT_TEXT` is empty in `.config`, so every request takes the
`Prompt free is not supported batch_infer! switch to naive_infer` path — 17/17
of the successful syntheses in the inference logs. This is runtime-v2 D008 and
is **not** in the Wave 0–2 scope recorded here; it is noted so that no latency
conclusion is drawn from streaming-mode comparisons before it is fixed.

## 8. Reproduction procedures

- **Cut-off / overlap**: `/summon`, ask a question that yields ≥ 3 sentences,
  stay silent. Expect a later chunk to truncate an earlier one. Deterministic
  unit reproduction: enqueue three playbacks concurrently and assert `play()`
  is called three times with an intervening `Idle` each.
- **Busy-input churn**: speak once, then speak again before the first audio
  starts. Today both utterances reach ASR and Gemini.
- **Quota**: force a 429 from a stub brain provider; today the next utterance
  issues another request immediately.
