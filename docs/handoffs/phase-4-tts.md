# Phase 4 Handoff — GPT-SoVITS / Kurisu TTS

## Files changed
### Node (discord-bot)
- **New** `src/providers/tts/types.ts` — `TtsProvider`, `TtsRequest`, `TtsLanguage`.
- **New** `src/providers/tts/language.ts` — `detectTextLanguageForTts` (script-based zh/ja/en) + `toGptSoVitsLang`.
- **New** `src/providers/tts/gpt-sovits.ts` — `GptSoVitsTtsProvider` calling native `api_v2 :9880 /tts` directly (no bridge). Streams the audio response body as a Node `Readable` for `playAudioStream`.
- **New** `src/services.ts` — `Services` container + `setServices`/`getServices`/`tryGetServices` (shared provider instances for adapter/commands/controller).
- **New** `src/bots/discord/commands/voice-test.ts` — `/voice-test` handler.
- **Modified** `src/bots/discord/commands/index.ts` — registered `/voice-test` (text + optional language options).
- **Modified** `src/adapters/airi-adapter.ts` — `voice-test` case in InteractionCreate switch.
- **Modified** `src/voice/voice-manager.ts` — added `hasSession(guildId)`.

### GPT-SoVITS env
- **New** `GPT-SoVITS/GPT_SoVITS/configs/tts_infer_kurisu.yaml` — `custom:` block pointing at the trained Kurisu v2Pro weights.
- **New** `GPT_SOVITS_KURISU_SETUP.md` (at DC_BOT root) — exact setup/run/verify steps.

## Public interfaces
- `GptSoVitsTtsProvider.synthesize({text, language}, signal): Promise<Readable>` — returns a WAV byte stream.
- `/voice-test text:<...> [language:ja|zh|en]` — standalone TTS test (plan.md §47).

## Configuration added
`GPT_SOVITS_URL`, `GPT_SOVITS_REF_AUDIO`, `GPT_SOVITS_PROMPT_TEXT`, `GPT_SOVITS_PROMPT_LANG`, `GPT_SOVITS_STREAMING_MODE`, `GPT_SOVITS_REQUEST_TIMEOUT_MS` (in `config.ts` + `.env.example`).

## Verified facts
- TTS-KurisuMakise = GPT-SoVITS v2Pro (HF card bysq/TTS-KurisuMakise). Compatible with local GPT-SoVITS HEAD `d523079`.
- **Trained model + reference audio simultaneously = the normal mode** (`inference_cli.py:30-42`, `TTS.py:1131-1137`). The trained weights load once; `ref_audio_path` conditions each request.
- api_v2 `/tts` params (verified from `api_v2.py` `TTS_Request`): `text`, `text_lang`, `ref_audio_path`, `prompt_text`, `prompt_lang`, `media_type` (wav/raw/ogg/aac), `streaming_mode` (0/1/2/3), `speed_factor`, `text_split_method`, + more. Hard-required: `text`, `text_lang`, `ref_audio_path`, `prompt_lang`.
- Kurisu trained on zh/ja only → bot voice defaults to `ja`.

## Known issues / NOT done in this session
- **GPT-SoVITS environment NOT stood up here.** `conda` is not installed on this machine, and the installer (`install.ps1`) requires it to create the Python+CUDA env and download multi-GB pretrained models. `GPT-SoVITS/pretrained_models/` is still empty (no base v2Pro/bert/hubert models). This is a genuine blocker for runtime — the operator must run the steps in `GPT_SOVITS_KURISU_SETUP.md`. The TTS **code** is complete and typechecks; only the runtime env is pending.
- Phase 4 runtime acceptance (`/voice-test` plays Kurisu) therefore cannot be verified in this session — it depends on the env step above. The code path is ready and will work once GPT-SoVITS is running on :9880 with the Kurisu config.
- GPU confirmed: RTX 5060 Ti (Blackwell sm_120), 16 GB VRAM → use `CU128`.

## Tests run
- `pnpm -F @proj-airi/discord-bot typecheck` → **PASS**.

## Integration instructions
- `index.ts` (Phase 5) constructs `new GptSoVitsTtsProvider()`, puts it in the `Services` container, and calls `setServices(...)`.
- `/voice-test` reads `tryGetServices()`; full loop (Phase 5) uses the same instance.
- Playback: `await services.voice.playAudioStream(guildId, await services.tts.synthesize({text, language}, signal))`.
