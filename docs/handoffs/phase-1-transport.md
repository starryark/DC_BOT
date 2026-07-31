# Phase 1 Handoff — Discord Voice Transport

## Files changed
- **New** `airi/services/discord-bot/src/voice/types.ts` — `VoiceUtterance`, `GuildVoiceSession`, `UserCaptureSession`, `VoiceManagerEvents`.
- **New** `airi/services/discord-bot/src/voice/voice-manager.ts` — `VoiceManager` (transport-only), `TypedVoiceEmitter`.
- **New** `airi/services/discord-bot/src/config.ts` — centralized `config()` + `AppConfig`.
- **New** `airi/services/discord-bot/.env.example` — all env keys.
- **Rewritten** `airi/services/discord-bot/src/bots/discord/commands/summon.ts` — now a thin re-export of the extracted `VoiceManager` (old 580-line class removed).
- **Modified** `src/bots/discord/commands/index.ts` — added `/leave` slash command.
- **Modified** `src/adapters/airi-adapter.ts` — `new VoiceManager(client)` (dropped `airiClient` arg); added `'leave'` case to `InteractionCreate` switch.

## Public interfaces
- `VoiceManager` extends `TypedVoiceEmitter`:
  - `on('utterance', (u: VoiceUtterance) => void)` — completed per-user utterance (16k mono PCM16).
  - `on('bargeIn', ({ guildId, userId, displayName }) => void)` — human voice detected while bot speaking.
  - `on('bargeInLevel', ...)` / `on('sessionStart'|'sessionEnd', ...)`.
  - `playAudioStream(guildId, stream)` — guild-scoped playback (replaces dead `playAudioStream(userId, ...)`).
  - `stopPlayback(guildId)`, `isPlaying(guildId)`.
  - `handleJoinChannelCommand(interaction)`, `handleLeaveChannelCommand(interaction)`.
- `config()` returns validated `AppConfig` (voice endpointing, asr, brain, tts, discord, airi).

## Configuration added
`VOICE_END_SILENCE_MS=650`, `VOICE_MIN_UTTERANCE_MS=250`, `VOICE_MAX_UTTERANCE_MS=30000`, `BARGE_IN_WINDOW_FRAMES=30`, `BARGE_IN_THRESHOLD=0.05`, `DEBUG_DUMP_AUDIO=false`, `BOT_BACKEND=direct`, `DISCORD_BOT_CLIENT_ID`. All others documented for later phases.

## Assumptions
- One Discord voice connection per guild (Discord's constraint) → keying sessions by `guildId` is correct.
- The old `AudioMonitor` class is no longer used by VoiceManager (replaced by direct per-packet endpointing in `onPcmPacket`); it remains in `utils/audio-monitor.ts` untouched in case other code uses it.
- `convertOpusToWav` (misnamed; just prepends a WAV header to already-decoded PCM) is reused for debug dumps; ASR provider will reuse it in Phase 2.

## Known issues
- `src/pipelines/tts.ts` (the misnamed STT file) still exports `openaiTranscribe`/`transcribe`/`WhisperLargeV3Pipeline`/`textFromResult` — all now dead (only `summon.ts` imported `openaiTranscribe`, and that import is gone). Removed in Phase 2.

## Tests run
- `pnpm -F @proj-airi/discord-bot typecheck` → **PASS** (after `pnpm install`).

## Integration instructions (for Phase 2+)
- The ConversationController (Phase 5) subscribes to `voiceManager.on('utterance', ...)` and calls `asr.transcribe({ wav: convertOpusToWav(u.pcm), sampleRate: 16000 })`.
- For Phase 2, a temporary adapter listener logs ASR results.
- Playback path: `voiceManager.playAudioStream(guildId, ttsStream)`.
