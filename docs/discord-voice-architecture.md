# Discord Voice Bot — Architecture Contract

This is the shared 2–4 page reference every build phase reads (plan.md §33).
It states the target architecture, provider interfaces, audio contract,
concurrency contract, language requirements, environment, and non-goals.

## Target architecture

```
Discord voice (per-user streams)
   ↓  AIRI VoiceManager (transport, refactored)
OpusDecoder → PCM16 / 16 kHz / mono
   ↓  per-user trailing-silence endpointing
VoiceUtterance event
   ↓  ConversationController
Local Qwen3-ASR :8765   (Python, CUDA)
   ↓  text + detected language
Gemini API (streaming)
   ↓  SpeechChunker (sentence/clause)
GPT-SoVITS api_v2 :9880 (Kurisu weights + reference clip)
   ↓  WAV/PCM
Discord playback queue (guild-scoped)
   ↓
voice channel
```

**Process separation:** Node `airi/services/discord-bot` · Python
`qwen3-asr/` · Python `GPT-SoVITS/api_v2.py` · external Gemini API.

The AIRI WebSocket server is **optional** (`BOT_BACKEND=airi`). Default is
`direct`, which bypasses it entirely for the voice hot path.

## Audio contract

- Capture: 16 kHz, mono, 16-bit little-endian PCM16 (from `OpusDecoder`).
- `VoiceUtterance.pcm` is raw PCM (no WAV header). ASR receives a WAV built by
  `convertOpusToWav` (prepends a 44-byte header; no resampling — already 16k).
- Playback: GPT-SoVITS returns WAV (`media_type=wav`); played via
  `createAudioResource(stream, { inputType: StreamType.Arbitrary })`.

## Provider interfaces (Node, in discord-bot)

```ts
// src/providers/asr/types.ts
interface AsrResult { text: string; language: 'zh'|'en'|'ja'|string; inferenceMs: number }
interface AsrProvider { transcribe(input: { wav: Buffer; sampleRate: 16000 }): Promise<AsrResult> }

// src/providers/brain/types.ts
interface BrainTurn { guildId: string; userId: string; userName: string; language: string; text: string }
interface BrainProvider { generate(turn: BrainTurn, signal: AbortSignal): AsyncIterable<string> }

// src/providers/tts/types.ts
interface TtsRequest { text: string; language: 'zh'|'en'|'ja' }
interface TtsProvider { synthesize(request: TtsRequest, signal: AbortSignal): Promise<Readable> }
```

No Discord class knows "Qwen", "Gemini", or "GPT-SoVITS" by name — only the
interfaces above.

## Concurrency contract

- **Capture is fully per-user, per-guild.** No global transcription timer, no
  cross-user buffer clears, no dropping audio while the bot speaks.
- **One LLM generation per guild at a time** (FIFO `AsyncQueue` per guild).
  ASR may run concurrently with generation; only the Gemini call is serialized.
- **Barge-in:** on genuine human utterance finalize → stop playback +
  `AbortController.abort()` TTS immediately; abort Gemini only after finalize
  (not on first noise packet) so keyboard clicks don't kill useful work.

## Language requirements

- Hard requirement: **English, Japanese, Mandarin Chinese**.
- Qwen3-ASR with `language=None` performs automatic language identification;
  its detected language is normalized to `zh|en|ja`.
- Gemini replies in the most recent speaker's language unless they request
  another.
- GPT-SoVITS maps `zh|en|ja` directly to its `text_lang`. **Note:** the Kurisu
  model was trained on zh/ja only — English output quality is limited.

## Environment

See `airi/services/discord-bot/.env.example`. Config is centralized in
`src/config.ts` (`config()`); nothing reads `process.env` for runtime config
directly. Loaded via `tsx --env-file=.env`.

## Non-goals (plan.md §52)

Do NOT: create a new Discord bot; reimplement RTP/Opus; mix users' audio; add
speaker diarization / WhisperX / pyannote; send local audio to cloud STT; use
unSpeech; add the Qwen ForcedAligner; put ASR in the Node process; reload
models per turn; run concurrent Gemini turns in one guild; hardcode API keys
or GPT-SoVITS reference paths; destroy existing AIRI adapter functionality.

## Dirty-tree preservation

`airi/` has uncommitted changes. Do NOT reset/clean/stash/`git restore`.
Specifically leave untouched: `packages/stage-ui/src/stores/providers.ts`,
`packages/stage-ui/src/libs/providers/source-metadata.ts`, `pnpm-lock.yaml`,
all `i18n`, `stage-ui-live2d`, `apps/stage-*`, and the untracked
`Proposal.md` / `Kurisu_model.md` / `GPT_SOLVITS_KURISU_MODEL.md` /
`gpt-sovits.vue`.
