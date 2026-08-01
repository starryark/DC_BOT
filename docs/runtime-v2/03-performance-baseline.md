# 03 — Performance Baseline & Benchmark Specification (Runtime V2, Wave 0)

> Status: **READ-ONLY baseline.** Extracted from existing logs only. No services
> were run, no optimization performed. This document is the immutable baseline
> against which all later latency work is judged (master plan §14/§15/§20/§39).

Pipeline under measurement: **Discord voice → Qwen3-ASR → Gemini → GPT-SoVITS
(Kurisu v2Pro) → Discord voice** (the `direct` backend, `bot_log .txt` line 7).

## 0. Source material

| Artifact | What it contains | Captured span |
|---|---|---|
| `bot_log .txt` | Bot process log, session 1 | 2026-07-31 09:47–09:50 |
| `bot_log_2 .txt` | Bot process log, session 2 | 2026-07-31 10:56–10:58 |
| `Inference_Log.txt` | GPT-SoVITS `api_v2.py` stderr, session 1 | 19 `POST /tts` requests |
| `Inference_Log_2.txt` | GPT-SoVITS `api_v2.py` stderr, session 2 | 3 `POST /tts` requests |
| `airi/services/discord-bot/src/orchestration/telemetry.ts` | `TurnTelemetry` schema + `TurnTimer` (defines every field below) | — |

## 1. System configuration at capture time

| Item | Value | Evidence |
|---|---|---|
| LLM model | `gemini-3.6-flash` | every `[GeminiBrain] Generating response` line |
| LLM tier | Gemini **free tier** (rate-limited) | the many HTTP 429 `RESOURCE_EXHAUSTED` errors, `FreeTier` quota IDs |
| ASR backend | Qwen3-ASR (HTTP, `POST /v1/transcribe`) | `qwen-http.ts`; ASR model not named in bot log |
| TTS engine | GPT-SoVITS, version `v2Pro`, `is_half=True`, `device=cuda` | `Inference_Log.txt` config banner |
| TTS voice | Kurisu Makise trained weights `牧懒红莉栖-e15.ckpt` + `牧懒红莉栖_e4_s972.pth` | config banner |
| TTS reference conditioning | `ref_audio_path` set, **`prompt_text` empty** | triggers the `Prompt free is not supported` fallback (see §4) |
| TTS streaming mode | **`0`** (whole synthesis, no streaming) | every `[GptSoVitsTts] Synthesizing streamingMode=0` |
| TTS media format | `wav` (whole file), `text_split_method: 'cut5'` | `gpt-sovits.ts` request body |
| Endpointing | `VOICE_END_SILENCE_MS` trailing-silence, ~650 ms floor | `endpointDelayMs` ≈ 650 across all turns |
| Hardware | RTX 5060 Ti (Blackwell sm_120), 16 GB; combined VRAM ~8 GB | `RUNBOOK.md` §Prerequisites |

---

## 2. Per-stage latencies extracted from bot telemetry (the `turn telemetry` records)

`TurnTimer` (telemetry.ts) records, per turn, a `turn telemetry` log line with any
of: `audioDurationMs`, `endpointDelayMs`, `asrMs`, `asrLanguage`, `geminiFirstTokenMs`,
`geminiCompleteMs`, `ttsFirstAudioMs`, `ttsCompleteMs`, `playbackStartedMs`,
`totalUserStopToAudioMs`. All `*Ms` fields are measured **from `userStoppedAt`
(utterance end)**, so they are *cumulative since stop*, not inter-stage deltas
(see `markGeminiFirstToken`/`markTtsFirstAudio`/`markPlaybackStarted`).

**Coverage summary across both bot logs (43 turn-telemetry records total):**

| Outcome | Count | Meaning |
|---|---|---|
| Empty/noise transcription → skipped before LLM (`asrLanguage=und`) | 21 | `ConversationController: Empty transcription, skipping` |
| LLM (Gemini) failed with HTTP 429 quota | 7 | generation aborted, no TTS |
| LLM succeeded, TTS failed (NLTK `averaged_perceptron_tagger_eng` missing, English text) | 4 | no audio produced |
| TTS failed (GPT-SoVITS `ECONNREFUSED`, service not up) | 2 | session 2 first turn |
| **Complete turn: user stop → first bot audio measured** | **8** | the only turns with `totalUserStopToAudioMs` |
| └─ of which healthy warm (no retry/error in flight) | **7** | 1 turn (`1307831`) hit NLTK 400s twice before a 3rd synth succeeded |

> **Sample-size caveat.** Only 8 turns reached first audio, and only 7 are
> "clean" warm turns. This is far below the master plan's "≥20 warm turns"
> requirement for a trustworthy P50/P95 (§39). The P50/P95 below are computed by
> nearest-rank for the record, but **treat them as indicative, not statistically
> robust.** The raw per-turn numbers in the table are the authoritative baseline.

### 2.1 Complete turns (user-stop → first audio measured)

All times in **ms, cumulative since user stopped speaking.** `—` = field absent
(stage did not complete / was not reached in this turn).

| # | turnId (short) | lang | audioDur | endpoint | asr | gemFirst | gemComplete | ttsFirstAudio | playbackStarted | **userStop→Audio** | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `…1251833` | ja | 5200 | 660 | 758 | 2563 | 8886 | 6934 | 6934 | **6934** | warm; gemini still streaming when audio began |
| 2 | `…1261831` | zh | 960 | 651 | 841 | 3042 | — | 4159 | 4159 | **4159** | geminiComplete not recorded (next turn overlapped) |
| 3 | `…1266851` | zh | 556 | 656 | 714 | 3039 | 7049 | 3953 | 3953 | **3953** | warm |
| 4 | `…1272696` | zh | 3125 | 665 | 1068 | 3180 | 5476 | 4631 | 4631 | **4631** | warm |
| 5 | `…1307831` | ja | 1040 | 664 | 669 | 3522 | 17615 | 17593 | 17593 | **17593** | **ANOMALY**: TTS 400'd (NLTK) twice before 3rd synth; exclude from warm stats |
| 6 | `…1352370` | zh | 541 | 651 | 719 | 2561 | 5338 | 3604 | 3604 | **3604** | warm |
| 7 | `…1373628` | zh | 3717 | 657 | 950 | 3324 | 5038 | 5029 | 5029 | **5029** | warm |
| 8 | `…5461375` | ja | 1242 | 656 | 872 | 3429 | 15205 | 8813 | 8813 | **8813** | **the master-plan reference turn (§1.2)**; gemini slow |

Full turnIds all share guild `616847428351688705` and suffix `-3596`.

### 2.2 Aggregated stats (nearest-rank P95 — indicative only)

| Stage (since user stop) | Healthy warm (n=7) min | P50 | P95 | max | All 8 (incl anomaly) P50 | P95 |
|---|---|---|---|---|---|---|
| endpointDelayMs | 651 | **656** | 665 | 665 | 656 | 665 |
| asrMs | 714 | **841** | 1068 | 1068 | 799 | 1068 |
| geminiFirstTokenMs | 2561 | **3042** | 3429 | 3429 | 3111 | 3522 |
| geminiCompleteMs | 5038 | **6262** | 15205 | 15205 | 7049 | 17615 |
| ttsFirstAudioMs | 3604 | **4631** | 8813 | 8813 | 4830 | 17593 |
| playbackStartedMs | 3604 | **4631** | 8813 | 8813 | 4830 | 17593 |
| **totalUserStopToAudioMs** | 3604 | **4631** | 8813 | 8813 | 4830 | 17593 |

> `ttsCompleteMs` is **never present** in any log line — the `markTtsComplete()`
> hook is defined in telemetry.ts but the conversation controller does not call
> it, so "TTS request → full response" is not directly measurable from bot
> telemetry. It can only be inferred from the GPT-SoVITS-side log (§3).

### 2.3 Key observations from the turn telemetry

1. **`ttsFirstAudioMs` frequently precedes `geminiCompleteMs`** (turns 1, 2, 3,
   4, 7, 8). This is expected and correct: `speech-chunker.ts` starts TTS on the
   first streamed sentence boundary while Gemini keeps generating the rest. The
   pipeline is *already pipelining* LLM→TTS at the chunk level. The latency win
   is therefore *not* "wait less for Gemini" but "TTS chunk 1 must start sooner
   and play sooner."
2. **`playbackStartedMs == ttsFirstAudioMs` in every recorded turn** — there is
   no measurable Discord playback-startup gap beyond first PCM in mode 0
   (whole-WAV playback). This is a coarse clock (second-resolution source), so
   treat sub-100 ms gaps as "not measurable here."
3. **Endpointing is a hard ~650 ms floor.** It is present in all 43 records and
   is essentially constant — it is the configured trailing-silence window, not a
   variable cost. It cannot be optimized away without changing the endpointing
   policy.
4. **ASR is healthy and warm: ~0.7–1.1 s**, consistent with `RUNBOOK.md`'s
   "~1 s steady-state / ~23 s cold first call." The first turn of each session
   (e.g. `…1251833` asrMs=758) is already warm, so these logs captured no cold
   ASR start.
5. **Gemini TTFT dominates the early budget:** ~2.6–3.5 s before the first token.
   This is the single largest pre-TTS contributor and is on the **free-tier**
   model.

---

## 3. GPT-SoVITS-side timings (`Inference_Log*.txt`)

GPT-SoVITS prints one timing line per successful synthesis, four space-separated
seconds values, in the order printed after `############ Synthesize Audio ############`:

```
<bert/text?> <bert_feat?> <t2s semantic-token> <vits synth>
```

Column labels are inferred from the surrounding stage banners (`Extract Text BERT
Features`, `Predict Semantic Token`, `Synthesize Audio`); they are not explicitly
named by GPT-SoVITS, so label them as "stage 1–4" when in doubt.

**17 successful synthesis rows** (14 in `Inference_Log.txt`, 3 in `Inference_Log_2.txt`):

| Statistic | stage1 (s) | stage2 (s) | stage3 t2s (s) | stage4 vits (s) | **row sum (s)** |
|---|---|---|---|---|---|
| min | 0.000 | 0.003 | 0.337 | 0.116 | 0.549 |
| mean | 0.300 | 0.051 | 0.886 | 0.459 | 1.696 |
| P50 (median) | 0.000 | 0.004 | 0.838 | 0.307 | 1.333 |
| max | 2.898 | 0.348 | 1.888 | 1.709 | 5.020 |

**Warm only** (stage1 < 0.5 s — excludes the 2 cold/first-synth rows where stage1
≈ 2.2–2.9 s is the model warmup): **n=15**, row-sum min **0.549 s**, mean
**1.316 s**, P50 **1.223 s**, max **3.945 s**.

### 3.1 Mapping bot-side `ttsFirstAudioMs` to GPT-SoVITS-side time

In `streaming_mode=0` (whole synthesis) the bot does not play *any* audio until
the **entire** WAV for a chunk is returned. So for a single-chunk turn, bot-side
`ttsFirstAudioMs` minus the moment TTS request was issued should be close to the
GPT-SoVITS row-sum for that chunk. The logs do not stamp the TTS *request* time
on the bot side, so this decomposition cannot be done per-turn from existing
telemetry. **Recommendation for the benchmark harness (§6): record
`tts_first_byte_ms` and `tts_first_pcm_ms` explicitly.**

### 3.2 The dominant slow stage is the t2s semantic-token prediction (stage3)

Stage3 (t2s) P50 ≈ **0.84 s** and dominates every warm synthesis; VITS synthesis
(stage4) P50 ≈ **0.31 s**. Stage1/2 are negligible once warm. This is consistent
with the `naive_infer` fallback (§4) — batch inference is being abandoned in
favor of slower naive inference on every request.

---

## 4. The `Prompt free is not supported batch_infer` fallback

**This fallback fires on essentially every successful synthesis.**

| Log | `Prompt free … switch to naive_infer` occurrences | successful `POST /tts` 200 OK | fallback rate |
|---|---|---|---|
| `Inference_Log.txt` | 14 | 14 (of 19 requests; 5 were NLTK 400s) | **100% of 200s** |
| `Inference_Log_2.txt` | 3 | 3 | **100% of 200s** |
| **Total** | **17** | **17** | **17 / 17 = 100%** |

**Root cause (confirmed in `gpt-sovits.ts` request body and the config):** the
bot sends `prompt_text: cfg.promptText` and `prompt_lang`. The Kurisu config /
request leaves `prompt_text` **empty** (the "Prompt free" case). When the prompt
transcription is absent, GPT-SoVITS' batch path refuses to run and falls back to
`naive_infer`, which is slower than `batch_infer`. Master plan §1.2 and §40
"Experiment A — GPT-SoVITS correct prompt_text" identify this as the **first**
optimization target. **Fixing the reference prompt conditioning is expected to
remove this fallback and is a prerequisite to any fair streaming-mode benchmark.**

### 4.1 Other GPT-SoVITS errors seen (not fallback, but they corrupted the baseline sample)

- **HTTP 400 `averaged_perceptron_tagger_eng not found`** — fires whenever the
  synthesized text is English (NLTK tagger resource is missing). This caused 4 of
  the bot-side TTS failures and the `1307831` 17.6 s anomaly (two 400s then a
  successful Japanese synth). It is an environment gap, not a latency
  characteristic; `setup-gpt-sovits.cmd` is meant to provision it.
- **`fetch failed ECONNREFUSED 127.0.0.1:9880`** — session 2 turn 1: GPT-SoVITS
  was not up yet. Environment/timing, not latency.

---

## 5. Baseline metrics record (master plan §15 / §39)

Reported as **raw observations + indicative P50/P95**. Sample size (n) is given
per row; rows with n < 20 should not be treated as reliable percentiles.

| §39 metric | Bot-side source | n | Raw range (ms) | P50 (indicative) | P95 (indicative) | Notes |
|---|---|---|---|---|---|---|
| `endpoint_ms` | endpointDelayMs | 8 | 651–665 | 656 | 665 | constant; trailing-silence policy floor |
| `asr_ms` | asrMs | 8 | 669–1068 | 799 | 1068 | warm; no cold start captured |
| `prompt_compile_ms` | — | 0 | — | — | — | **not instrumented** (no Gemini prompt-assembly timer) |
| `brain_ttft_ms` | geminiFirstTokenMs | 8 | 2561–3522 | 3111 | 3522 | free-tier gemini-3.6-flash |
| `brain_complete_ms` | geminiCompleteMs | 7 | 5038–17615 | 7049 | 17615 | highly variable; turn 8 = 15205, turn 5 = 17615 |
| `speech_segment_ready_ms` | (implied = ttsFirstAudioMs pre-TTS) | 0 | — | — | — | **not separately instrumented** |
| `tts_first_byte_ms` | — | 0 | — | — | — | **not instrumented**; infer from GPT-SoVITS stage sums |
| `tts_first_pcm_ms` | ttsFirstAudioMs (mode 0 = whole WAV) | 8 | 3604–17593 | 4830 | 17593 | in mode 0, first PCM = full chunk return |
| `playback_start_ms` | playbackStartedMs | 8 | 3604–17593 | 4830 | 17593 | == ttsFirstAudioMs in all rows |
| `user_stop_to_audio_ms` | **totalUserStopToAudioMs** | 8 | 3604–17593 | 4830 | 17593 | **the key UX metric** |
| `total_turn_ms` | (geminiCompleteMs is closest) | 7 | 5038–17615 | 7049 | 17615 | no explicit end-of-turn stamp |

**TTS request → full response** (§15 item) is not directly in bot telemetry
(`ttsCompleteMs` is never emitted). Inferred GPT-SoVITS-side total per synthesis
(§3): warm P50 ≈ **1.22 s**, max ≈ **3.95 s**.

**The master-plan headline baseline (§1.2) is reproduced exactly** by turn
`…5461375` in `bot_log_2 .txt`: endpoint 656, ASR 872, Gemini first token 3429,
first audible TTS 8813, Gemini complete 15205 — i.e. **user-stop → first audio ≈
8.8 s.** This is the highest-quality complete Japanese turn in the logs and is
the canonical baseline number.

### 5.1 Where the ~8.8 s goes (decomposition of the reference turn `…5461375`)

```
user stops speaking ......................... 0 ms
+ endpointDelay (trailing silence) ......... 656 ms   (7%)   policy floor
+ asrMs (Qwen inference, overlaps endpoint)  872 ms   (cumulative; ~216 ms net over endpoint)
geminiFirstTokenMs ........................ 3429 ms   (39%)  LLM TTFT — biggest single chunk
ttsFirstAudioMs ........................... 8813 ms   (100%) TTS chunk-1 ready + played
geminiCompleteMs .......................... 15205 ms  (—)    LLM still finishing after audio began
```

The **~5.4 s gap between Gemini first token (3.4 s) and first audio (8.8 s)** is
the combined cost of: (a) waiting for the first chunk boundary to form in the
speech chunker, (b) issuing the GPT-SoVITS HTTP request, (c) full whole-file
synthesis in mode 0 (t2s + VITS, ~1.2–1.9 s on the TTS side per §3), and (d) the
`naive_infer` fallback penalty (§4). Closing this gap is the central Wave-2
target.

---

## 6. Fixed benchmark fixtures (master plan §14/§0B Task) — SPECIFICATIONS

These are **specifications to be created later** by the benchmark harness; **no
audio is generated in this read-only wave.** Each fixture is a short input WAV
(16 kHz mono PCM16, the format Qwen3-ASR consumes — see `qwen-http.ts` and
`convertOpusToWav`) plus its expected transcript and the latency stages it is
meant to exercise. Store under `docs/runtime-v2/fixtures/` (or a benchmark
fixtures dir chosen by the harness owner) when materialized.

| Fixture ID | Duration | Target lang | Intended content / purpose | Latency stages it should exercise |
|---|---|---|---|---|
| `ja-short` | ~1.0–1.5 s | `ja` | A short Japanese greeting, e.g. 「こんにちは。」 or 「おはよう。」 | endpoint, asr, brain_ttft, tts_first_pcm, user_stop_to_audio. Baseline comparable to turn `…5461375`. |
| `en-short` | ~1.0–1.5 s | `en` | A short English utterance, e.g. "Hello. How are you?" | Same stages **plus** the English/NLTK frontend path (must not regress to 400 / `naive_infer` only). Stress the `averaged_perceptron_tagger_eng` path. |
| `zh-short` | ~1.0–1.5 s | `zh` | A short Mandarin utterance, e.g. "你好，你会说中文吗？" | Same stages; exercises the Han-script `text_lang=zh` route and CJK chunker boundaries (`.?！。`). |
| `ja-long-10-15s` | 10–15 s | `ja` | A multi-sentence Japanese utterance (≥3 sentences), e.g. a self-introduction or a 3-clause question. | Endpointing on longer audio, ASR on longer audio, **multi-chunk** brain_complete vs tts_first_pcm (chunk pipelining), total_turn_ms. Exposes whether streaming TTS helps on longer turns. |
| `noise-filler` | 0.5–1.0 s | `und`/noise | Breath, "uh", mic rustle, or low-amplitude noise — non-speech or sub-250 ms speech. | Exercises the **empty/filler rejection path**: should be filtered *before* Gemini (master plan §2D). Expected outcome: no LLM call, no TTS. This fixture guards the "don't waste a Gemini turn on noise" property and must **not** be billed to `user_stop_to_audio_ms`. |

**Fixture requirements when materialized:**

- 16 kHz, mono, PCM16 WAV (matches `AsrInput.wav` consumed by `qwen-http.ts`).
- Each fixture must ship a **ground-truth transcript** and **expected detected
  language** so ASR regressions are caught alongside latency.
- `noise-filler` must declare expected `text == ""` / `language == "und"`.
- Fixtures must be **deterministic and checked in** so P50/P95 across runs are
  comparable. Record `speech segment length` and `TTS text length` metadata per
  run (§7).

---

## 7. Metrics schema that future benchmarks MUST capture (master plan §39)

Every benchmark run (≥20 short + ≥5 long after warmup, per §39) must emit one
record per turn with **all** of the following. Columns marked "current gap" are
not produced by today's `TurnTimer` and must be added by the Wave-1 telemetry
work (Subagent 1C) or by the benchmark harness.

### 7.1 Latency fields (milliseconds, cumulative since user-stop unless noted)

| Field | Definition | Current bot source | Status |
|---|---|---|---|
| `endpoint_ms` | utterance end → first ASR call | endpointDelayMs | present |
| `asr_ms` | ASR inference time (inter-stage) | asrMs | present |
| `prompt_compile_ms` | time to assemble Gemini `contents` + system prompt | — | **gap: add timer** |
| `brain_ttft_ms` | user-stop → first Gemini token | geminiFirstTokenMs | present |
| `brain_complete_ms` | user-stop → Gemini stream end | geminiCompleteMs | present (sometimes) |
| `speech_segment_ready_ms` | user-stop → first chunk boundary ready for TTS | — | **gap: add timer at speech-chunker emit** |
| `tts_first_byte_ms` | TTS request issued → first response byte | — | **gap: instrument in gpt-sovits.ts** |
| `tts_first_pcm_ms` | TTS request issued → first playable PCM | ttsFirstAudioMs (in mode 0) | present in mode 0; redefine for streaming |
| `playback_start_ms` | user-stop → Discord playback begins | playbackStartedMs | present |
| `user_stop_to_audio_ms` | **the key UX metric** | totalUserStopToAudioMs | present |
| `total_turn_ms` | user-stop → playback fully complete | — | **gap: add timer (ttsCompleteMs / playback done)** |

> Note on semantics: today's `*Ms` fields are *cumulative since user-stop*
> (see `markGeminiFirstToken` etc.). `asr_ms` is the lone **inter-stage**
> exception (it is the ASR provider's own inference time). The schema above
> preserves the existing cumulative convention for the `*_ms` wall-clock
> fields and adds `tts_first_byte_ms` as an inter-stage TTS-internal metric.
> Document this distinction in the harness.

### 7.2 Metadata fields (per run / per turn)

| Field | Why it matters | Example values from this baseline |
|---|---|---|
| `asr_backend` | which ASR engine | `qwen3-asr-http` |
| `asr_prompt_size` | context/hotword size fed to ASR | not configured (0) |
| `model` | LLM model | `gemini-3.6-flash` (free tier) |
| `tts_streaming_mode` | GPT-SoVITS mode | `0` (whole synthesis) |
| `tts_media_format` | transport format | `wav` |
| `tts_text_length` | chars synthesized per chunk | 2–62 (from `chars=` log fields) |
| `speech_segment_length` | input audio ms | 417–5200 (audioDurationMs) |
| `character_prompt_token_estimate` | prompt/compiler cost proxy | not measured |

---

## 8. Performance gate targets (master plan §20)

These are the gates later waves must hit. They are **not** achievable with the
current `streaming_mode=0` + `naive_infer` + free-tier-Gemini configuration.

| Gate | Target | vs baseline (~8.8 s / warm P50 4.6 s) |
|---|---|---|
| Minimum goal | user-stop → first audible response **reduced substantially from ~8.8 s** | requires TTS conditioning fix + streaming |
| Suggested milestone | **P50 < 5.0 s** | within reach on warm turns once TTS streams and Gemini TTFT holds ~3 s |
| Stretch | **P50 < 3.0–4.0 s** | needs Gemini TTFT reduction *and* TTS first-playable < 2 s |
| Subsystem target | **TTS request → first playable audio < ~2 s warm** | current whole-synth warm P50 ≈ 1.22 s on the GPT-SoVITS side *but only after* the request is issued; the bot-side gap from first-token to first-audio is ~5.4 s, so this target is about cutting request-to-first-PCM, not raw synth time |

**Quality constraint (master plan §20 closing):** the targets are performance
gates, *not* license to degrade voice quality. Multilingual quality must be
preserved for Japanese, English, and Mandarin.

### 8.1 What the baseline implies for the path to the gates

1. **Fix GPT-SoVITS reference conditioning first** (§4 / Experiment A). It removes
   the `naive_infer` fallback that inflates every synthesis and is a prerequisite
   for a fair streaming-mode comparison (Experiment B). This alone should lower
   the TTS contribution.
2. **Move off `streaming_mode=0`.** In mode 0 the bot cannot play *any* audio
   until the whole chunk WAV returns, so `tts_first_pcm_ms` is bounded below by
   the full GPT-SoVITS row-sum. Streaming modes (1–3) are required to cut
   `tts_first_pcm_ms` below the full-synth time (Experiment B/C).
3. **Reduce Gemini TTFT (~3 s) and/or overlap it with TTS.** TTFT is the largest
   pre-TTS cost and is on the free-tier model. The chunker already pipelines
   LLM→TTS, so the remaining lever is earlier first-token (model choice / tier)
   and earlier first-chunk-boundary (chunker tuning).
4. **Filter noise/filler turns before Gemini** (§6 `noise-filler` fixture, §2D).
   21 of 43 logged turns were empty transcriptions and several real turns were
   burned on Gemini 429s — these must not enter the latency budget.

---

## 9. Caveats and known limitations of this baseline

- **Small n.** Only 8 complete turns (7 clean warm). P50/P95 are indicative, not
  robust. The master plan's ≥20-warm-turn benchmark (§39) has not yet been run.
- **Free-tier Gemini with heavy 429ing.** 7 of the logged turns failed on
  `RESOURCE_EXHAUSTED`, and even successful turns may have been slowed by
  throttling. TTFT/complete numbers may not reflect a paid-tier model.
- **English TTS was broken** during capture (missing NLTK resource), so there is
  **no clean English complete turn** in the logs. The `en-short` fixture (§6)
  exists precisely to close this gap.
- **No cold starts captured.** Both bot sessions show warm ASR from turn 1; the
  documented ~23 s ASR cold start (`RUNBOOK.md`) is not in this dataset.
- **`prompt_compile_ms`, `speech_segment_ready_ms`, `tts_first_byte_ms`,
  `total_turn_ms` are not instrumented today** (§7.1 gaps). The benchmark
  harness / Wave-1 telemetry must add them before percentiles for those stages
  are meaningful.
- **Bot-side and TTS-side logs are not time-correlated** at sub-second
  resolution, so per-turn decomposition of the LLM→TTS gap is inferred, not
  measured.
