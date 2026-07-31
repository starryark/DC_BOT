# Multilingual GPT-SoVITS Output — Implementation Plan

## Root cause (verified against repo + logs)

A **partial fix already exists** in the checkout. The remaining defects are specific:

1. **Language routing is incomplete.** `language.ts` has only a per-chunk script heuristic (`detectTextLanguageForTts`); it has **no `normalizeLanguage`**, **no `auto` fallback**, and the controller **discards `turn.language`** (`conversation-controller.ts:170` calls `this.ttsLanguage(text)` using text only). Han-only fragments (`今日`) and short chunks are mis-routed; there is no way to honor a Chinese turn when the persona leans Japanese. Verified: `language.ts` + controller.

2. **NLTK English is broken at runtime.** `GPT-SoVITS/nltk_data/taggers/` is **empty** and the running GPT-SoVITS process never searches it — `start-bot.ps1` sets `$env:NLTK_DATA` but does not export it into the child PowerShell that runs `api_v2.py` (the traceback searched `.venv/nltk_data`, not `GPT-SoVITS/nltk_data`). The only NLTK resource the English frontend needs is `averaged_perceptron_tagger_eng` (it bundles its own `cmudict.rep`). Verified by reading `text/english.py`.

3. **Startup race.** `start-bot.ps1` launches ASR + GPT-SoVITS + bot back-to-back with no readiness wait → `ECONNREFUSED 9880`. GPT-SoVITS loads the model synchronously before `uvicorn.run`, so a TCP-connect probe on 9880 is a valid readiness signal; ASR exposes `GET /health` returning `ready:true`. No health endpoint exists on GPT-SoVITS. Verified by reading `api_v2.py`.

4. **`.config` is silently ignored.** The user split config into `.config`, but the `start` script is `tsx --env-file=.env --env-file-if-exists=.env.local` — it never loads `.config`. (GPT-SoVITS `auto` IS supported — first entry in both v1/v2 language lists — so an `auto` fallback is valid.)

## Decisions (best-judgment defaults)

- **Config**: wire `.config` into the `start` script so the user's stated split actually works.
- **Python env**: auto-detect whichever interpreter exists (conda `GPTSoVits` or `.venv`), and make `NLTK_DATA` reach the child process.
- **Language policy**: mirror-the-speaker — carry ASR language as a turn-level hint, strengthen the prompt, allow strong text-evidence override, fall back to `auto`.

---

## Phase A — Language normalization + resolver (NEW `language.ts`)

Rewrite `src/providers/tts/language.ts` to be the single authoritative layer:

- Constrained type: `export type GptSoVitsLang = 'zh' | 'en' | 'ja' | 'auto'` (keep `TtsLanguage = 'zh'|'en'|'ja'` in `types.ts` for the provider interface; `auto` is a resolver output, not a TTS input language).
- `normalizeLanguage(raw: string | undefined | null): GptSoVitsLang` — maps `en/en-US/en-GB→en`, `zh/zh-CN/zh-TW/cmn→zh`, `ja/ja-JP/jp→ja`, `und/undefined/unsupported→auto`. Only aliases that can actually occur (ASR emits `zh|en|ja|und` + 2-char fallback).
- `detectTextLanguageForTts(text)` — keep the existing script heuristic but return `GptSoVitsLang`, and make it return `auto` (not a forced guess) when text is punctuation-only / too short / Han-only-ambiguous, per §11/§28.
- `resolveTtsLanguage(opts: { text: string; inputLanguageHint?: string }): GptSoVitsLang` — precedence: strong text evidence (kana→ja, latin-dominant→en, han-with-context) → normalized ASR hint → `auto`. This is the one function callers use.
- `toGptSoVitsLang(lang)` stays a passthrough seam.

## Phase B — Carry language through orchestration

`src/orchestration/conversation-controller.ts`:
- In `generateAndSpeak`, compute `const turnLang = normalizeLanguage(turn.language)` once and thread it into each `synthesizeAndPlay` call (replacing the current text-only `this.ttsLanguage(text)`).
- `synthesizeAndPlay(guildId, text, turnLang, parentSignal, timer)` calls `resolveTtsLanguage({ text, inputLanguageHint: turnLang })` and passes the result as `TtsRequest.language`. When the resolver returns `auto`, send `language: 'auto'` (the provider accepts it).
- Log per-chunk resolution: `asrLanguage`/`resolvedTextLanguage`/`source` (text-detection | asr-hint | auto).

`src/bots/discord/commands/voice-test.ts`:
- Accept the existing optional `language` (zh/en/ja) and add an `'auto'` choice. When absent, call `resolveTtsLanguage({ text })`.

`src/providers/brain/prompt.ts`: lightly strengthen the mirroring instruction so Gemini defaults to the speaker's language while still honoring explicit requests (no persona rewrite).

## Phase C — GPT-SoVITS provider diagnostics

`src/providers/tts/gpt-sovits.ts`:
- Accept `'auto'` as a valid `text_lang`.
- Split the log into `textLanguage` + `promptLanguage` (instead of one ambiguous `language`).
- Improve error messages: `ECONNREFUSED` → "GPT-SoVITS TTS service unavailable at <url>"; HTTP 400 → surface the server message; detect the NLTK `averaged_perceptron_tagger_eng` substring and emit a setup-specific hint.

## Phase D — NLTK provisioning (Phase 3 of proposal)

- `setup-gpt-sovits.ps1`: verify the download actually populated `nltk_data/taggers/averaged_perceptron_tagger_eng/` (add an existence check after the `nltk.downloader` call; re-run / throw if missing). Keep it the only required resource.
- `start-bot.ps1`: pass `$env:NLTK_DATA` into the GPT-SoVITS child process environment (it currently sets it in the parent shell only). Add an interpreter auto-detect that considers the conda env path as well as `.venv`/`runtime`.
- Add a startup verification that `g2p('English')` works **with `NLTK_DATA` exported**, mirroring real runtime conditions.

## Phase E — Service readiness (Phase 7 of proposal)

`start-bot.ps1`: after launching ASR and GPT-SoVITS, **wait** (bounded, configurable timeout, default ~180s for cold CUDA) before launching the bot:
- ASR: poll `GET /health` until `ready:true` (real endpoint).
- GPT-SoVITS: poll TCP-connect on 9880 until it accepts (valid since the model loads synchronously before uvicorn binds). No expensive `/tts` calls.
- On timeout: print a clear error and do NOT launch the bot into a known-broken state. Skip the wait if the port is already listening (reuse-existing path preserved). Visible service terminals preserved. ASR readiness gated independently; bot readiness does NOT depend on Gemini.

## Phase F — Config wiring

- `package.json` `start`: add `--env-file=.config` so the user's `.config` is actually loaded (secrets stay in `.env`).
- `.env.example`: document `GPT_SOVITS_TEXT_LANG` fallback semantics (optional; default `auto`) and the `prompt_lang` vs `text_lang` distinction. Add the new value to `.config` too.

## Phase G — Tests (Phase 6 of proposal)

- `language.test.ts`: expand to cover `normalizeLanguage` (en/en-US/zh/zh-CN/ja/ja-JP/und/undefined/unsupported→auto), `resolveTtsLanguage` precedence (strong text wins, ASR hint as fallback, `auto` for ambiguous/short/punctuation), and short-chunk stability (`嗯？`, `OK.`).
- `gpt-sovits.test.ts` (NEW): mock `fetch`, verify the request body sends `text_lang` = resolved target and `prompt_lang` = config `ja` independently, for ja/zh/en/auto. This is the regression guard against the original bug.
- `conversation-controller` orchestration test (NEW, using existing fakes pattern): ASR `language=zh` + Gemini `"你好，有什么事吗？"` → TTS receives target `zh`; ASR `und` → `auto`; explicit-switch case (`zh` + English text → en or auto, never blindly zh).

## Phase H — Docs

- `README.md` / `RUNBOOK.md`: document the `prompt_lang` vs `text_lang` distinction, the `auto` fallback, `/voice-test language:auto`, multilingual examples, and the new readiness behavior. No secrets committed.

---

## Files changed (summary)

| File | Why |
|---|---|
| `src/providers/tts/language.ts` | Add `normalizeLanguage`, `resolveTtsLanguage`, `auto` support (core fix) |
| `src/providers/tts/types.ts` | Keep `TtsLanguage`; resolver outputs `GptSoVitsLang` incl. `auto` |
| `src/orchestration/conversation-controller.ts` | Carry turn-language hint into TTS; use resolver |
| `src/providers/tts/gpt-sovits.ts` | Accept `auto`; split text/prompt lang logs; better errors |
| `src/bots/discord/commands/voice-test.ts` + `index.ts` | Add `auto` choice; use resolver |
| `src/providers/brain/prompt.ts` | Strengthen speaker-mirroring |
| `src/providers/tts/language.test.ts` | Normalization + resolver unit tests |
| `src/providers/tts/gpt-sovits.test.ts` (NEW) | Request-field separation regression tests |
| `src/orchestration/conversation-controller.test.ts` (NEW) | ASR→TTS propagation |
| `package.json` | `start` loads `.config` |
| `.env.example`, `.config` | Document `GPT_SOVITS_TEXT_LANG`, prompt/text lang distinction |
| `setup-gpt-sovits.ps1` | Verify NLTK download populated; robustness |
| `start-bot.ps1` | Export NLTK_DATA to child; auto-detect interpreter; bounded readiness wait for ASR + GPT-SoVITS |
| `README.md`, `RUNBOOK.md` | Multilingual + readiness docs |

## Validation plan (Phase 31)
- `pnpm --filter @proj-airi/discord-bot typecheck`
- `pnpm --filter @proj-airi/discord-bot test`
- (If services up) direct `/tts` smoke: ja/zh/en/auto per §22 — run only if available, reported honestly
- I will NOT run the full live Discord conversation (needs real token + working Gemini quota); any blocked test is reported as blocked, not passed.

## Out of scope (§36)
No Gemini/Qwen/GPT-SoVITS replacement, no Kurisu retrain, no cloud TTS, no Gemini quota fix, no AIRI adapter rewrite.

## Deliverables on completion
A. Root-cause report · B. Changed-files list · C. Language-routing design · D. Config semantics (prompt_lang vs text_lang) · E. Test results (honest) · F. Remaining limitations (Gemini quota may block live e2e; mixed Han-only fragments remain inherently ambiguous).