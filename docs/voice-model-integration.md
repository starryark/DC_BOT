# External voice-model integration

## References and observed state

- Research: [deep-research-report.md](deep-research-report.md), especially
  “The target repository boundary should look like this”. Its embedded research
  citations are preserved; they are not independently revalidated here.
- Working Python checkout: `C:/Users/lyang/Voice_Model/repo`.
- Read that checkout's `AGENTS.md`, `HANDOFF.md`, `docs/ARCHITECTURE.md`,
  `docs/PROTOCOL.md`, and `docs/COMPONENT_CONTRACTS.md` before changing it.
- Source revisions at extraction are recorded in `extraction-manifest.json`.

The current checkout has revision authority, protocol/adapter contracts,
S1 interaction policy and advisory TurnSense, FunASR acoustic/ASR adapters,
VoxCPM and Qwen3 speech adapters, and provider-neutral reasoning boundaries.
Its September 5 handoff records local model characterizations and training
progress while leaving matched TTS comparisons, reference corpora, and empirical
acceptance open. The extracted bot currently has no implemented service bridge
to those Python adapters.

## Ownership

| This TypeScript project | External Python voice service |
| --- | --- |
| Discord gateway and per-guild/member lifecycle | Audio framing, AEC/VAD, acoustic evidence |
| Opus transport and playback scheduling | Streaming ASR and transcript revisions |
| Character/persona and durable Discord memory | S1/floor decisions and revision authority |
| Existing cloud reasoning adapter | Local TTS adapters and GPU admission/cancellation |

Keep model weights, Python environments, training datasets, and heavyweight
inference dependencies in their own project. The eventual bridge should use
PCM frames and structured events, with bounded queues and cancellation, through
a versioned local streaming transport. Do not treat `VOICE_MODEL_ROOT` or an
invented endpoint as an already implemented runtime setting.

## Implementation sequence

1. Agree a versioned service protocol against the Python checkout's canonical
   contracts. The research's `audio.frame`, `asr.revision`, `turn.committed`,
   `speech.cancel`, and `tts.chunk` labels are illustrative, not a frozen wire
   schema. Preserve session/guild/member mapping, turn/revision identity,
   monotonic timestamps, and sample coordinates. Distinguish source identity
   from bot response epochs and define reconnect and discontinuity semantics.
2. Expose continuous 10–20 ms capture frames while preserving the current
   utterance provider as the explicitly selected baseline. Preserve per-user
   state, bounded admission, and sample accounting under overload.
3. Add playback render-reference feedback and implement real echo/near-end
   evidence or an explicit degraded policy. Missing takeover/completion
   observations must remain unknown; deterministic fixtures do not establish
   that real acoustic adapters can drive the S1 policy.
4. Connect provisional ASR revisions and authoritative turn commitment to the
   existing streamed reasoning adapter. Propagate supersession/cancellation to
   reasoning, TTS admission, queued playback, and the final outgoing packet.
5. Bound unsynthesized speech text as well as the retained one-chunk TTS
   lookahead. Keep model choices replaceable and qualify real streaming support.
6. Replay multilingual turns, hesitations, echo, overlap, backchannels, and
   interruptions. Measure first/last voiced frames, ASR revisions, turn commit,
   first semantic token/PCM, packet submission, and the final obsolete packet.
   Report distributions and hardware/conditioning context for model trials.

This directory extraction does not change latency policy, select model weights,
implement the protocol, or claim full-duplex readiness.
