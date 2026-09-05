# State-of-the-Art Discord Voice Bot Architecture for DC_BOT and voice-model

## Executive assessment

The two repositories are at very different maturity points.

`DC_BOT` is already a substantial production-oriented Discord application: it has per-guild/per-user capture state, streamed Gemini output, bounded TTS lookahead, response epochs, cancellation, playback completion tracking, character/persona support, durable memory work, ASR/TTS service boundaries, benchmarking infrastructure, and many explicit fixes for earlier race conditions. Its main voice path, however, is still fundamentally **utterance-oriented half-duplex**:

**Discord PCM → wait for utterance end → whole-utterance ASR → LLM text stream → sentence/chunk TTS → Discord playback.** fileciteturn36file0L2-L2

The shipped configuration reinforces this architecture: `BOT_INPUT_POLICY=half_duplex`, `VOICE_END_SILENCE_MS=900`, `VOICE_GROUP_WINDOW_MS=300`, `BARGE_IN_ENABLED=false`, and `GPT_SOVITS_STREAMING_MODE=0`. fileciteturn15file0L2-L2 In other words, before ASR/model latency is even counted, a normal voice turn deliberately carries about **1.2 seconds of post-speech waiting** from endpoint silence plus the group window. The repository itself comments that the group window is additive to endpoint silence. fileciteturn15file0L2-L2

That is now the dominant architectural limitation. The next important optimization is **not** shaving another few milliseconds from TypeScript, SQLite, or HTTP parsing. It is eliminating those serial stage boundaries.

`voice-model` is much more ambitious. It already embodies several ideas that are closer to current state-of-the-art interactive voice systems: streaming revisioned ASR, explicit source coordinates, bounded admission, supersession and cancellation semantics, a separate acoustic observation lane, a turn-taking policy operating on provisional hypotheses, advisory learned turn completion, streamed local TTS, and rigorous adapter/substitution contracts. fileciteturn27file0L2-L2 fileciteturn29file0L2-L2 fileciteturn28file0L2-L2

My central conclusion is:

> **Use `voice-model` as the interaction/runtime architecture that replaces DC_BOT's utterance-level voice loop, but do not transplant its present model choices or acoustic implementation unchanged.**

There are several concrete gaps in `voice-model` that matter more than model benchmarking. Most notably, its real FunASR acoustic engine currently emits no takeover probability, no completion probability, no overlap probability, and no near-end speaker probability, while its S1 interaction policy requires precisely takeover/completion evidence to interrupt or take a turn. fileciteturn56file0L2-L2 fileciteturn52file0L2-L2 fileciteturn53file0L2-L2 The deterministic tests hide this because their recorded/fake acoustic observations explicitly manufacture takeover/completion evidence. fileciteturn50file0L2-L2

For the supplied Ryzen 5 3600 + RTX 5060 Ti 16 GB machine, I would target this topology:

```text
                    ┌── Discord user A Opus ──┐
                    ├── Discord user B Opus ──┤
                    └────────────┬─────────────┘
                                 │
                         native Opus decode
                                 │
                  10–20 ms canonical PCM frames
                                 │
                  ┌──────────────┴──────────────┐
                  │                             │
          CPU realtime lane              GPU ASR lane
      AEC / VAD / floor state       streaming 0.6B ASR
      fast takeover detection       revisioned partials
                  │                             │
                  └───────────┬─────────────────┘
                              │
                 revision-aware S1 controller
                    │                     │
              keep listening       commit user turn
              / interrupt                 │
                    │                     ▼
                    │            cloud LLM streaming
                    │                     │
                    │          semantic speech chunker
                    │                     │
                    │              local GPU TTS
                    │              streaming audio
                    │                     │
                    └──── cancel ◄────────┤
                                          ▼
                                Discord playback
                                          │
                              render-reference tap
                                          │
                                          └──► AEC
```

This is much closer to the architecture OpenAI now describes for GPT-Live: media remains on a dedicated continuously running fast path, while frontier reasoning and tools are delegated asynchronously rather than being placed serially between listening and speaking. citeturn23view3

## What GPT‑6 Astra and current voice systems actually imply

There is an important correction to make about the OpenAI example in the question.

**GPT‑6 Astra itself is not an audio model.** OpenAI's current model documentation lists Astra with text input/output and image input, while audio and video are not supported inputs. citeturn19search0 Astra's headline capabilities are frontier reasoning and computer use; OpenAI's launch material describes its computer-use improvements and API availability, not a native audio-in/audio-out loop. citeturn18view0

The striking voice/computer-control behavior comes from OpenAI's **GPT-Live / ChatGPT live voice architecture around the frontier model**, not from piping microphone audio directly into `gpt-6-astra`. OpenAI describes GPT-Live as full duplex: incoming and outgoing media continue simultaneously, with an asynchronous delegation path to frontier intelligence. The same architecture underlies voice-driven computer control and agent coordination. citeturn23view3

That distinction is highly relevant to this project because it argues **for**, rather than against, the user's desired local/cloud split.

### The important SOTA lesson is architectural, not "use an audio LLM"

OpenAI explicitly contrasts the older cascade:

```text
speech
  ↓
STT
  ↓
LLM
  ↓
TTS
  ↓
speech
```

with a continuously operating full-duplex media path. It notes that a strict STT→LLM→TTS cascade accumulates serial latency and can discard acoustic information such as tone and pacing. citeturn23view3

That does **not** imply DC_BOT needs a giant end-to-end speech model locally. For this machine and the requirement that reasoning stay API-based, a better interpretation is:

**make the local speech/control layers continuous and concurrent, while retaining a cloud reasoning model.**

That means the local system should know that the user has started talking long before a transcript is final, should form provisional text while the user is still speaking, should be able to stop TTS from acoustic evidence without waiting for ASR or the LLM, and should begin preparing the cloud request as soon as the turn becomes sufficiently stable.

OpenAI's architecture also pre-initializes/prefills the frontier reasoning session so delegation does not pay the entire startup cost when the user asks a difficult question. citeturn24view0 The comparable optimization for DC_BOT is persistent provider/session state and stable context prefixes, not creating a logically fresh interaction stack for every utterance.

### Full duplex changes where latency matters

The current mental model in DC_BOT is largely:

> How quickly can we process a turn after the user has finished?

The SOTA question is instead:

> How much work can safely be completed **before it is certain the user has finished**, and how quickly can obsolete work be invalidated?

That is exactly why `voice-model`'s revision/authority work is valuable. Its ASR snapshots are provisional and revisioned, while S1 is explicitly allowed to reason over a provisional hypothesis; commitment happens as a consequence of taking the turn rather than being a prerequisite. fileciteturn29file0L2-L2

This is much more consequential than replacing one transcription benchmark winner with another.

## DC_BOT performance audit

### Endpointing is currently the largest deterministic latency tax

The voice manager does not expose continuous audio to the conversational controller. It accumulates decoded PCM for each Discord member, restarts a finalize timer for incoming packets, concatenates the full buffer, and only then emits a `VoiceUtterance`. fileciteturn41file0L2-L2 fileciteturn42file0L2-L2

The configuration then waits:

| Current decision | Shipped value | Consequence |
|---|---:|---|
| End-silence timer | 900 ms | ASR cannot begin until well after the user's last speech packet |
| Conversation group window | 300 ms | further delay before model dispatch |
| Input policy | `half_duplex` | speech during assistant work is discarded rather than interpreted |
| Acoustic barge-in | disabled | assistant cannot naturally yield |
| GPT-SoVITS streaming | mode `0` | first speech waits for non-streaming synthesis behavior |

These are current repository values. fileciteturn15file0L2-L2

The correct optimization is **not simply lowering `VOICE_END_SILENCE_MS` from 900 to 300**. That will cause exactly the fragmenting/mid-sentence problems the comment says the 900 ms value was introduced to prevent. fileciteturn15file0L2-L2

Instead, eliminate fixed silence as the sole turn-boundary authority:

```text
Today
last speech ─────────────── 900 ms ─── 300 ms ─── ASR ─── LLM
             dead time

Target
speech ──► VAD + partial ASR + semantic-turn estimator continuously
             │
last speech ─┴─► evidence converges ─► commit ─► LLM
```

A fixed timeout should remain only as a fail-safe upper bound.

### Qwen3-ASR is being used in its least voice-assistant-like mode

DC_BOT's TypeScript provider sends a complete WAV body to `/v1/transcribe` and receives a final JSON transcription. fileciteturn22file0L2-L2 The Python server loads one Qwen3-ASR model, serializes inference behind an `asyncio.Lock`, and calls `model.transcribe()` on the entire sample array. fileciteturn25file0L2-L2

So despite using a modern ASR family, the runtime behavior is offline transcription.

Qwen3-ASR itself now has 0.6B and 1.7B variants and supports streaming/offline recognition across broad multilingual coverage including Chinese, English, and Japanese. Its documented streaming implementation currently goes through vLLM and does not support batching or timestamps in that streaming path. citeturn24view1 vLLM's GPU support is Linux-oriented, so on this Windows workstation its supported route is WSL/Linux rather than native Windows. citeturn24view2

Therefore there are two sensible paths:

**Path A — fastest integration:** keep the current Qwen model but replace `/v1/transcribe` with a persistent streaming session running in WSL2/vLLM, receiving PCM frames and emitting provisional revisions.

**Path B — better SOTA bake-off:** benchmark Qwen3-ASR-0.6B against **NVIDIA Nemotron 3.5 ASR Streaming 0.6B**. NVIDIA's current model is a cache-aware FastConformer-RNNT specifically designed for streaming and supports configurable chunks down to 80 ms; its architecture reuses cached encoder context rather than repeatedly recomputing overlapping audio. citeturn23view0

For a Discord assistant, I would **not start with Qwen3-ASR 1.7B**. The 0.6B-class models are the more interesting operating point because the same 16 GB GPU also needs to keep TTS resident and responsive. Only move to 1.7B if your actual Japanese/Chinese/English Discord corpus shows a material recognition gain.

### The current TTS pipeline has good orchestration but the wrong serving mode

There is a good idea in DC_BOT that should be retained: TTS synthesis is bounded to **one future chunk** while the current chunk plays. That means the system overlaps synthesis with playback without allowing an unbounded pile of already-synthesized, obsolete audio. fileciteturn38file0L2-L2

But the configured GPT-SoVITS backend is `streaming_mode=0`. fileciteturn15file0L2-L2 The provider can consume an HTTP response as a stream and records first-audio-byte timing, but the request itself tells GPT-SoVITS to operate in the whole-synthesis mode selected earlier for correctness. fileciteturn33file0L2-L2

The more serious hidden issue is in the other direction: `runBoundedTtsPipeline()` eagerly drains the **entire LLM speech-event iterator** into `chunkQueue` while playback is slow. The code explicitly does this to avoid upstream HTTP timeout problems. fileciteturn38file0L2-L2

That means the system has bounded **audio** speculation but effectively unbounded **text-generation** consumption. Under a long answer, it can continue receiving model tokens far ahead of speech. A late interruption then discards a substantial amount of already-generated text/API work.

That should change to a **bounded semantic text queue**, ideally measured in expected seconds of future speech rather than just chunk count. For example:

```text
LLM may run ahead:
  1 current TTS chunk
+ 1 successor TTS chunk
+ at most ~1–2 seconds of unsynthesized speech text

Anything beyond that backpressures or pauses stream consumption.
```

That gives a meaningful upper bound to barge-in waste.

### The Opus decoder is a cheap repo-specific win

`DC_BOT` currently decodes every incoming Discord Opus packet using `opusscript`, a JavaScript/WASM implementation, inside the stream transform. fileciteturn61file0L2-L2

The discord.js voice documentation recommends `@discordjs/opus` ahead of `opusscript` for performance. citeturn21search0turn21search1

On a Ryzen 5 3600 where CPU time is valuable for AEC, VAD, resampling and turn detection, I would switch the receive path to the native Opus implementation and reserve `opusscript` as fallback. This is one of the few low-level optimizations that is worth doing before the large architectural rewrite.

### Barge-in needs echo control, not a better amplitude threshold

The present detector computes average amplitude of an inbound user's packet and interrupts when it exceeds `BARGE_IN_THRESHOLD`. Hysteresis re-arms below half the threshold. fileciteturn42file0L2-L2

The config itself correctly notes the failure mode: with loudspeakers, the assistant's own speech can travel acoustically into a participant's microphone and look indistinguishable from human speech to this detector. fileciteturn15file0L2-L2

The fix should be an actual **echo-reference path**.

WebRTC's Audio Processing Module is designed around a near-end capture stream plus the far-end/render stream and provides echo cancellation, noise suppression and automatic gain processing; it can be used independently of a WebRTC call. citeturn14search0turn14search1

For DC_BOT, the relevant topology is unusually convenient:

```text
GPT/Qwen TTS PCM ────────────────► Discord encoder/playback
       │
       └── exact render reference
                        │
Discord user PCM ──► AEC ─► VAD ─► takeover detector / ASR
```

Discord already identifies which subscription belongs to which member, so **do not add speaker diarization merely to identify the Discord participant**. The useful audio problem is echo discrimination, not speaker clustering. DC_BOT already maintains its receive state keyed by guild and user. fileciteturn41file0L2-L2

### The existing benchmark measures the wrong boundary for the next phase

`benchmark-voice.ts` is useful for endpoint service characterization: it measures TTS HTTP headers/first-byte/total time across streaming modes and text sizes and measures ASR request latency for supplied WAV files. fileciteturn62file0L2-L2

But after this redesign, those are no longer the decisive metrics.

The benchmark needs timestamp markers at:

```text
user first voiced frame
user last voiced frame
VAD tentative endpoint
first ASR partial
stable ASR revision
S1 TAKE_TURN
LLM request issued
LLM first semantic token
first TTS request
TTS first PCM
Discord resource admitted
first packet submitted
barge-in speech onset
cancel decision
last obsolete assistant packet
```

Without those markers it is possible to make ASR or TTS individually faster while the perceived interaction remains unchanged.

## voice-model decisions versus the current state of the art

`voice-model` deserves credit for getting several hard architectural decisions right. Its separation between **observations**, **revision authority**, **interaction decisions**, **reasoning**, and **speech effects** is a stronger foundation than DC_BOT's current monolithic turn flow. The repository also deliberately keeps model adapters behind replaceable protocols, which is exactly what is needed because the best 2026 ASR/TTS model is not sufficiently settled to bake into orchestration. fileciteturn14file0L2-L2

There are nevertheless some critical issues.

### The real acoustic implementation and S1 policy currently do not compose

This is the most important finding in the repository review.

The real `FunAsrAcousticEngine` emits:

- `speech_probability` from FSMN-VAD coverage;
- `overlap_probability=None`;
- `near_end_probability=None`;
- speaker evidence with `estimator: "none"` and `echo_reference_available: False`;
- prosodic fields containing only `duration_ms`, `rms_dbfs`, and `zero_crossing_rate`. fileciteturn56file0L2-L2

By contrast, the S1 evidence normalizer looks for:

`takeover`, `backchannel`, `completion`, `continuation`, `hesitation`, `uncertainty`, and near-end-user evidence. Missing signals explicitly remain `None`. fileciteturn51file0L2-L2

The S1 policy then requires:

- takeover ≥ 0.75 to `STOP_SPEAKING`;
- completion ≥ 0.85 plus semantic completion to take a user turn;
- backchannel ≥ 0.75 to recognize a non-takeover backchannel. fileciteturn52file0L2-L2 fileciteturn53file0L2-L2

Therefore, **with the present real acoustic engine, those paths are unreachable from the actual emitted prosody data**. TurnSense can contribute semantic completion, but it does not manufacture the missing acoustic completion/takeover score required by the ladder. fileciteturn29file0L2-L2

The repository's deterministic wiring demonstration uses manually constructed acoustic observations that contain `takeover_probability` and `completion_probability`, and the document explicitly says that scenario demonstrates wiring rather than real-model accuracy. fileciteturn50file0L2-L2

So this is not a tuning problem. It is an **unclosed model/interface gap**.

I would fix it before collecting a large acceptance corpus.

The S1 contract should distinguish signals into:

```text
Directly measured
  speech probability
  render-correlated echo probability
  overlap/talk-over evidence

Learned
  takeover intent probability
  backchannel probability
  acoustic end-of-turn probability

Advisory semantic
  complete / incomplete / invalid
```

Then every production analyzer must either generate the signal or declare the capability unsupported, and S1 must have an explicit degradation path for every unsupported combination.

### There is also a capability declaration inconsistency

`AcousticAdapterConfig` defaults `reports_overlap=True` and `reports_speaker_role=True`. fileciteturn48file0L2-L2 `SenseVoiceAcousticAnalyzer` uses those flags to advertise `OVERLAP_PROBABILITY`, `SPEAKER_ROLE_PROBABILITY`, and rich role evidence as supported. fileciteturn49file0L2-L2

But the shipped real engine sets overlap and near-end probability to `None` and reports `estimator: "none"`. fileciteturn56file0L2-L2

For a project whose strongest design principle is "capability honesty", that should be treated as a correctness defect. Either the real composition must set those flags false, or an actual estimator must be installed.

### The default streaming ASR configuration is not the production configuration you want

`FunAsrEngineConfig` presently defaults to:

```text
asr_model = paraformer-zh-streaming
device = cpu
chunk_ms = 600
encoder lookback = 4
decoder lookback = 1
```

fileciteturn48file0L2-L2

There are three problems for this project:

First, `paraformer-zh-streaming` is the wrong default for a system whose launch requirement is Mandarin/English/Japanese and code switching.

Second, a **600 ms decode chunk** fundamentally prevents genuinely fine-grained partial recognition: the engine cannot produce a model partial before it has accumulated the next model chunk. fileciteturn47file0L2-L2

Third, `cpu` ignores the 16 GB Blackwell GPU in the target machine.

This configuration makes sense as a conservative implementation default; it does not make sense as the performance-qualified deployment profile.

I would preserve the FunASR adapter contract while benchmarking three actual engines:

| Candidate | Why evaluate it | Main caveat |
|---|---|---|
| Nemotron 3.5 ASR Streaming 0.6B | cache-aware native streaming, small model, configurable 80–1120 ms chunks | target-machine runtime must be smoke-tested |
| Qwen3-ASR 0.6B streaming | strong zh/en/ja multilingual fit; already used in DC_BOT family | current streaming path is vLLM-only and therefore WSL/Linux on this workstation |
| current FunASR streaming stack | already integrated; useful low-risk baseline | current default model/config is not tri-language/SOTA deployment configuration |

Nemotron's streaming design and chunk choices are documented by NVIDIA. citeturn23view0 Qwen3-ASR's streaming constraints and language/model variants are documented by Qwen. citeturn24view1

The winner should be selected on **your Discord audio**, particularly spontaneous Japanese, Mandarin-English switches, names/entities from character cards, overlapping speech and cheap laptop/phone microphones—not public WER alone.

### TurnSense is correctly positioned as advisory

This is one of `voice-model`'s strongest decisions.

The model is not put directly inside the S1 decision call. The analyzer runs upstream and its prediction is revision-bound; malformed or stale advisory output cannot authorize a current action. fileciteturn29file0L2-L2

TurnSense's published model is small enough to be a reasonable CPU-side component; current model documentation describes a roughly 47M-parameter INT8 model with tens-of-milliseconds CPU inference rather than a heavyweight generative model. citeturn23view2

Keeping it off the hard barge-in path is correct. A user beginning to say "stop" must not wait for semantic end-of-turn inference before the assistant starts yielding.

Its correct role is:

```text
VAD/acoustic evidence:  "someone is really taking the floor"   → immediate stop
TurnSense:              "their thought appears complete"       → commit guidance
ASR/LLM semantics:      "what did they say / what should I do" → reasoning
```

### VoxCPM2 should remain a challenger, not become the permanent TTS choice

`voice-model` already calls VoxCPM2 a first candidate rather than the final winner, and explicitly leaves Qwen3-TTS as a co-shortlisted engine behind the same project-owned speech protocol. fileciteturn28file0L2-L2 That decision remains correct.

The current VoxCPM configuration defaults to a 2B model, CPU device, ten inference steps and 100 ms emitted PCM chunks. fileciteturn58file0L2-L2 Its engine does expose true incremental synthesis through `generate_streaming`; each blocking native generation step is put on the thread pool and raced against the project cancellation token. fileciteturn59file0L2-L2

Cancellation, however, is only **logically** immediate. The native model step already executing in the worker can continue consuming compute after the response is obsolete; its result is merely discarded. fileciteturn59file0L2-L2 On a single-GPU machine, that matters because stale TTS work can delay the ASR or replacement TTS turn immediately following a barge-in.

Qwen3-TTS now offers 0.6B and 1.7B models, Chinese/English/Japanese among its supported languages, streaming synthesis and voice-cloning Base variants; its official project describes dual-track streaming and very low first-audio latency under its tested configuration. citeturn22view0

For this 16 GB GPU I would therefore conduct a real three-way character-voice bake-off:

**Qwen3-TTS 0.6B Base vs Qwen3-TTS 1.7B Base vs VoxCPM2**, with the same Kurisu reference material and the same zh/en/ja/code-switched sentences.

Do not select on RTF alone. Score:

| Metric | Why it matters |
|---|---|
| speech-commit → first valid PCM | directly affects conversational responsiveness |
| sustained RTF | determines whether lookahead remains bounded |
| cancel → GPU actually available | affects barge-in replacement turn |
| speaker similarity | character identity |
| Japanese naturalness | particularly important for this persona |
| English stability | current GPT-SoVITS setup already notes an English-quality limitation |
| zh/en/ja code switching | project requirement |
| pronunciation/entity fidelity | character names and technical vocabulary |
| VRAM while ASR also resident | actual single-GPU feasibility |

### The Gemini adapter is more outdated than the model abstraction around it

`voice-model`'s provider contract is good; the concrete transport is not yet what I would ship for a low-latency conversational runtime.

The current adapter opens **one HTTP/1.1 connection per request** and explicitly closes it. Its own documentation says connection reuse, HTTP/2, production latency and reliability have not been validated. fileciteturn30file0L2-L2

By contrast, DC_BOT's newer brain provider uses the official `@google/genai` client and `generateContentStream`, with cancellation, first-token observation and pre-first-token retry handling. fileciteturn35file0L2-L2

That newer provider work should flow **back into** the provider implementation behind `voice-model`'s cleaner contract.

Google's current Interactions API also provides server-side conversational continuation using prior interaction state and is intended to improve continuation/cache behavior for new applications. citeturn13search1 Gemini also supports implicit caching for repeated prompt prefixes. citeturn13search0

I would therefore retain the provider-neutral S2 interface but implement:

```text
one long-lived API client
one logical conversation identity per Discord room/session
stable character/system prefix
explicit cancellation per revision
stream immediately
reuse prior interaction state where its retention/privacy semantics are acceptable
```

That is much closer to Astra/GPT-Live's "reasoning session already available when delegation happens" principle than reconnecting for every user turn. citeturn24view0

## Recommended architecture for the RTX 5060 Ti machine

The supplied hardware is actually a good fit for a **hybrid voice system**, provided the design treats the RTX 5060 Ti as one shared realtime resource instead of allowing independent Python services to compete for it arbitrarily.

### Keep these components local

**Opus decode, AEC, VAD, floor state and simple DSP** should remain CPU-side. The Ryzen 5 3600 is not a huge modern CPU, so the audio path should stay small, deterministic and frame-oriented. Silero VAD is a reasonable challenger to FSMN-VAD because its official implementation is explicitly aimed at lightweight streaming inference and reports sub-millisecond processing for small audio chunks on a CPU thread. citeturn15search2turn15search11

**ASR should be GPU-resident and genuinely streaming.** Start with a 0.6B-class model. Do not unload it between turns.

**TTS should also remain resident.** Qwen3-TTS 0.6B/1.7B and VoxCPM2 are small enough in parameter count that concurrent residency is worth attempting on a 16 GB card, but actual VRAM headroom has to be measured because activations, framework workspaces and audio-model auxiliaries matter in addition to raw weights. The candidate parameter sizes and supported streaming modes come from the respective project documentation. citeturn22view0turn23view1

**TurnSense should initially stay CPU-side.** That keeps the GPU available for the two workloads whose latency and quality benefit much more from it. Its current published CPU-scale size/latency makes that deployment shape plausible. citeturn23view2

### Introduce a GPU scheduler instead of independent greedy services

Right now it is easy to think of:

```text
ASR service owns GPU
TTS service owns GPU
```

The correct mental model for one 5060 Ti is:

```text
GPU
 ├─ persistent ASR model
 ├─ persistent TTS model
 └─ one realtime scheduling policy
```

Suggested priority:

```text
highest    ASR needed for current user speech
           replacement-turn first TTS packet
           current-turn first TTS packet
           ongoing TTS continuation
lowest     speculative successor TTS
```

When a human starts speaking, speculative TTS should lose immediately.

Do **not** let an abandoned VoxCPM/Qwen native generation step and a new ASR/TTS request freely contend. The model layer needs a generation epoch/request ID even below Python's coroutine layer, so stale outputs and stale queued kernels cannot acquire new work after cancellation.

### Replace hard endpointing with two-stage endpointing

Use:

**Acoustic endpoint candidate:** VAD indicates speech has stopped.

**Semantic endpoint confirmation:** TurnSense/ASR stability indicates the thought is complete.

Recommended project targets—not claims about any specific model—would be:

| Boundary | Target |
|---|---:|
| audio frame cadence | 10–20 ms |
| first VAD/start-of-speech reaction | <50 ms |
| assistant mute/stop after genuine barge-in | p95 <150 ms |
| provisional ASR cadence | ≤160 ms preferred |
| normal semantic endpoint after final speech | p50 <250 ms |
| long hesitation fallback | adaptive, up to ~700–900 ms |
| simple-turn speech start after endpoint | p50 <600 ms |
| obsolete synthesized-but-unplayed audio | ≤1 chunk |
| obsolete generated text | ≤~2 s expected speech |

The important property is the **adaptive range**. "Yes." should not incur 900 ms. "So I was thinking that..." should not be cut at 200 ms.

### Make partial transcripts first-class rather than an ASR implementation detail

`voice-model` already has the right primitive: full-snapshot partial revisions rather than concatenating unqualified token fragments. fileciteturn27file0L2-L2

Carry those revisions into DC_BOT.

For example:

```text
R41 PROVISIONAL: "Can you check"
R42 PROVISIONAL: "Can you check tomorrow's"
R43 PROVISIONAL: "Can you check tomorrow's weather"
R44 PROVISIONAL: "Can you check tomorrow's weather in Tokyo?"
                    ↑ stable + endpoint evidence

S1 commits R44
Cloud request starts
```

If R43 has already triggered harmless speculative work, R44 supersedes it. Anything capable of side effects remains authority-gated.

This is precisely where `voice-model`'s elaborate revision work pays off in perceived latency rather than merely protocol elegance.

### Use speculative preparation selectively

Do not send every ASR partial to an expensive frontier model.

Instead, before turn commitment you can safely do:

```text
resolve language
resolve character/entity pronunciation
retrieve local/durable context
prepare system prefix
prefetch/cache provider session
classify likely response length
warm TTS voice conditioning
```

Then the committed revision only has to send the final delta/context to the reasoning provider.

For truly low-risk conversational turns, an experimental lane could start cloud reasoning on a highly stable provisional transcript, but its output must remain **unspoken and side-effect-free** until revision authority commits it. This is the natural extension of `voice-model`'s authority model.

### Treat the network as part of the voice stack

The supplied machine is currently using an Intel Wireless-AC 7265 Wi-Fi adapter while its wired Gigabit Ethernet interface is disconnected.

Raw link bandwidth is irrelevant here; interactive audio/model streaming depends on latency stability, packet loss and jitter. OpenAI's WebRTC engineering work explicitly identifies stable round-trip time, low jitter and low packet loss as critical for responsive live voice. citeturn16search7

Before doing difficult model comparisons, perform the same end-to-end voice test on the wired Realtek interface. A model comparison is contaminated if one run happens during Wi-Fi retransmission/jitter.

### Do not enable HAGS/TDR tweaks as a "latency optimization"

The supplied machine has HAGS disabled and standard Windows timeout recovery behavior. I would leave those alone during initial qualification.

The workloads here are CUDA inference, not a game-rendering benchmark, and altering GPU scheduling/TDR behavior before obtaining reproducible ASR/TTS traces makes failures harder to attribute. The high-value work is model residency, request scheduling and pipeline overlap.

Similarly, do not overclock the mixed four-DIMM 48 GB configuration just to improve voice latency. CPU memory bandwidth is not the present critical path.

## Prioritized implementation and validation plan

The following order is intentionally different from "replace every old model first." It attacks the serialization points before expensive model selection.

| Priority | Concrete change | Expected impact | Why first |
|---|---|---|---|
| **Critical** | Feed live 10–20 ms PCM frames from `VoiceManager` into a session-level realtime input bus rather than only emitting completed `VoiceUtterance`s | Very high | prerequisite for every full-duplex feature |
| **Critical** | Port `voice-model` revision/authority + S1 boundaries into the DC_BOT runtime | Very high | permits safe partial work, supersession and interruption |
| **Critical** | Close the acoustic/S1 contract gap: real completion/takeover/backchannel evidence or explicit degradation policy | Very high | current real `voice-model` stack cannot exercise its intended S1 ladder |
| **Critical** | Add outgoing-audio render reference + AEC before barge-in/VAD | Very high | makes full-duplex usable without headphones |
| **High** | Replace offline `/v1/transcribe` with persistent streaming ASR | Very high | removes endpoint→ASR serial barrier |
| **High** | Bake off Nemotron 0.6B streaming vs Qwen3-ASR 0.6B vs current FunASR | High | selects deployment engine rather than adapter design |
| **High** | Turn on/replace with genuinely streamed local TTS; bake off Qwen3-TTS 0.6B/1.7B vs VoxCPM2 | High | first-audio latency and interruption quality |
| **High** | Introduce shared GPU scheduling/cancellation epochs | High | prevents stale TTS from blocking replacement speech |
| **High** | Bound LLM text lookahead instead of eagerly draining the complete stream | Medium-high | bounds cost and cancellation waste |
| **Medium** | Replace `opusscript` with `@discordjs/opus` native decoder | Medium CPU win | cheap and repository-specific |
| **Medium** | Move `voice-model` Gemini adapter from per-call HTTP/1.1 close to persistent official client/session path | Medium-high | removes repeated transport/setup cost |
| **Medium** | Run all qualification tests over wired Ethernet as well as Wi-Fi | Potentially high tail-latency win | removes network variance |
| **Afterward** | Tune VAD/semantic endpoint thresholds and TTS chunk dimensions from real conversations | High UX gain | values are meaningless before the architecture is continuous |

The biggest mistake would be to start by deciding "Qwen3-TTS beats VoxCPM" or "Nemotron beats Qwen ASR." The present DC_BOT pipeline can absorb hundreds of milliseconds to more than a second at boundaries **regardless of which model wins**.

### The new acceptance benchmark should be conversation-level

The existing service benchmark should remain, but a second benchmark should replay actual Discord-style sessions through the entire system. `voice-model` already has an unusually rigorous evaluation philosophy, including frozen corpora, hardware profiles and distinction between deterministic contract evidence and empirical model claims. Its current handoff explicitly says many production empirical acceptance phases remain blocked on real reference corpora, rather than pretending fixture results prove model quality. fileciteturn14file0L2-L2

For DC_BOT, build the empirical corpus around failure modes that matter to this specific bot:

```text
Japanese natural conversation
Mandarin conversation
English conversation
zh↔en, ja↔en, zh↔ja code switching

short answers:
  "yeah"
  "no"
  "wait"

hesitations:
  "I think... actually..."
  Japanese fillers
  Mandarin fillers

backchannels:
  "mhm"
  "yeah"
  "そう"
  "嗯"

true interruptions:
  "stop"
  "wait"
  correction mid-answer

false interruptions:
  cough
  keyboard
  chair noise
  assistant audio leaking through speakers

two Discord users:
  sequential turns
  overlap
  second user taking the floor

long model answer:
  interruption immediately
  interruption after several clauses
```

Measure distributions, not only averages. Voice quality is largely determined by p95/p99 awkward events: one assistant that talks over a user for a second every twenty interactions feels much worse than its mean latency suggests.

### The target repository boundary should look like this

I would eventually make `DC_BOT` consume `voice-model`-style capabilities through a narrow service protocol rather than copying Python implementation code into TypeScript:

```text
DC_BOT TypeScript
  Discord transport
  user identity / guild lifecycle
  playback scheduler
  character + memory integration
  cloud LLM adapter
              │
              │ local IPC / streaming RPC
              ▼
Realtime voice service
  audio framing
  AEC / VAD
  streaming ASR
  acoustic evidence
  TurnSense
  S1 policy / revisions
  streaming TTS
  GPU scheduler
```

The local transport should carry **PCM frames and structured events**, not WAV files.

A representative event protocol:

```text
audio.frame
speech.started
asr.revision
acoustic.revision
floor.takeover_candidate
turn.committed
speech.cancel
tts.chunk
tts.finished
```

Every event should carry `session_id`, `turn_id`, `revision_id` where applicable, monotonic timestamp, and source sample coordinates. That preserves the strongest parts of `voice-model` while avoiding a Python model process becoming responsible for Discord gateway concerns.

## Final technical judgment

The work already done in the repositories suggests that the difficult part of this project is no longer "how do I connect Discord to ASR and TTS?" DC_BOT solved that. The next problem is **interaction scheduling under uncertainty**.

The strongest existing decisions are:

`DC_BOT`'s response-epoch cancellation, per-user capture, playback completion semantics, streamed Gemini path and bounded one-chunk TTS speculation. fileciteturn36file0L2-L2 fileciteturn37file0L2-L2 fileciteturn38file0L2-L2

`voice-model`'s revision authority, provisional decision semantics, adapter isolation, explicit cancellation contracts, model-independent interfaces and separation of learned turn prediction from hard realtime floor control. fileciteturn27file0L2-L2 fileciteturn29file0L2-L2

The weakest existing decisions are:

`DC_BOT`'s 900 ms fixed endpoint + 300 ms grouping delay, whole-WAV ASR, half-duplex default, disabled barge-in and non-streaming GPT-SoVITS configuration. fileciteturn15file0L2-L2

`voice-model`'s current mismatch between the acoustic evidence its real engine produces and the evidence S1 needs, its over-optimistic acoustic capability defaults, its `paraformer-zh-streaming`/CPU/600-ms default ASR profile, its CPU-default VoxCPM profile, and its old one-connection-per-S2-request Gemini transport. fileciteturn56file0L2-L2 fileciteturn48file0L2-L2 fileciteturn58file0L2-L2 fileciteturn30file0L2-L2

The OpenAI GPT-Live/Astra work reinforces this direction rather than suggesting that everything should be replaced with a giant cloud audio model: keep the **media/control loop continuously alive**, and place powerful reasoning behind an asynchronous delegation boundary. Astra itself does not ingest audio; the live voice layer provides the realtime interaction machinery around frontier reasoning. citeturn19search0turn23view3

For this particular RTX 5060 Ti 16 GB workstation, my preferred near-term stack is therefore:

| Layer | Preferred direction |
|---|---|
| Discord receive | `@discordjs/opus`, per-user 10–20 ms PCM frames |
| Acoustic preprocessing | WebRTC-style AEC with exact bot render reference + lightweight CPU VAD |
| ASR | first bake-off: Nemotron 3.5 ASR Streaming 0.6B vs Qwen3-ASR 0.6B |
| Turn completion | TurnSense advisory + acoustic endpoint evidence |
| Floor control | `voice-model` revision-aware S1, after fixing its missing real evidence |
| LLM | streamed API model; persistent/session-aware provider transport |
| TTS | first bake-off: Qwen3-TTS 0.6B Base / 1.7B Base vs VoxCPM2 |
| GPU | both speech models resident, centrally scheduled, ASR/first-packet work prioritized |
| Playback | retain DC_BOT's epoch-aware scheduler and one-chunk audio lookahead |
| Network | qualify over wired Ethernet and Wi-Fi separately |
| Measurement | end-of-human-speech → first bot audio **plus** interruption/cancellation distributions |

That moves DC_BOT from a fast implementation of a classic voice-bot cascade toward the much more important 2026 goal: **a Discord participant that is always listening, can form and revise hypotheses while people speak, knows when to yield, can be interrupted naturally, starts useful work before every boundary is finalized, and abandons obsolete work almost immediately.**

## Open questions and limitations

The public model landscape is moving quickly, so the recommendation intentionally treats ASR and TTS models as **bake-off candidates rather than permanent architectural dependencies**. Qwen3-ASR's current streaming restrictions, Qwen3-TTS serving support, Nemotron runtime behavior, and model-framework compatibility should all be revalidated whenever their pinned revisions change. Current claims above are tied to the primary documentation inspected for this research. citeturn24view1turn22view0turn23view0

The most important empirical information still does not exist: comparative first-audio latency, Japanese/Chinese/English quality, concurrent ASR+TTS VRAM behavior, and interruption tails for these model candidates on the supplied RTX 5060 Ti. `voice-model` correctly distinguishes this missing empirical evidence from deterministic adapter correctness and documents that its remaining acceptance work is blocked on real corpora. fileciteturn14file0L2-L2

Consequently, model-specific claims such as "Qwen3-TTS 0.6B is the winner" or "Nemotron is faster on this 5060 Ti" would be premature. The high-confidence result of this review is architectural: **the current fixed endpoint/whole-ASR cascade is now the principal bottleneck, and `voice-model` contains most of the right abstractions to replace it, but its real acoustic evidence path must be completed before it can deliver the full-duplex behavior its contracts describe.**