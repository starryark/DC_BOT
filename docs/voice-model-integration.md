# Local voice-model integration

The Python service and TypeScript client are implemented. The Python checkout is
C:/Users/lyang/Voice_Model/repo; its docs/OPTIMIZATION_RUNTIME.md is the complete
operating and qualification guide. This project keeps gateway/DAVE/Opus,
character/persona, durable Discord memory and cloud reasoning. Python owns
independent decoded-source recognition, room revision authority and local speech.

## Runtime selection

VOICE_MODEL_MODE is off by default. Shadow mode streams decoded PCM while the
existing utterance route remains the response owner. Active mode uses only
Python-authorized turns for voice reasoning and returns streamed PCM through
the same authenticated connection. Set VOICE_MODEL_PORT (default 8766) and
VOICE_AGENT_BRIDGE_TOKEN to match the Python service. Active mode requires a
speech-capable service with verified GPU release control.

The client has finite source/audio/socket/request bounds. SSRC changes, decoder
resets, reconnects and unknown discontinuities retire old sources. Source sample
coordinates advance through dropped frames; loss is reported, not compressed.
Room reset clears the old room epoch on both sides. Decoder failures clear partial
audio and pending endpoint timers; callbacks and member lookups from a prior
connection cannot clear or repopulate a replacement session. A broken bridge
fails closed.

The Python protocol is voice-agent.discord-pcm.v1, non-canonical transport
records around the frozen voice-agent protocol. A speech request carries the
exact guild, stream, revision and floor epoch that authorized its response.
An old LLM task cannot use the guild's newer authority. Neutral pace/instruction
metadata is forwarded; unsupported conditioning is reported as degradation.

One credit gates PCM output. The client retains at most current speech plus one
lookahead and the text producer is bounded by pull. Safe phrase cuts protect
unfinished code, citations and numbers. The SDK receives explicit 48 kHz stereo
PCM, without a WAV accumulation stage. A final prepare/dispatch fence blocks
obsolete voice packets while preserving required codec silence.

The voice-test command uses an explicit gateway-command authority in active
mode. It checks that the caller and bot are in the same channel. It does not
manufacture an ASR observation, and its audio uses the controller's response
epoch and the same cancellation path.

## Verification

Run the Python script scripts/bridge_integration_smoke.py with --bot-repo pointing
here. It launches both real protocol implementations with synthetic models and
checks two speakers, cancellation, stale-revision refusal and replacement PCM.
No Discord login or hosted API call occurs.

Optional OpenAI escalation is enabled with OPENAI_ESCALATION_ENABLED,
OPENAI_API_KEY and OPENAI_ESCALATION_MODEL (default gpt-6-astra). Ordinary turns
stay on Gemini; detailed/high-reasoning turns use Responses. No provider change
is enabled by default.

Live DAVE/rejoin/loss tests, exact Kurisu compatibility, matched conditioned
latency/RTF, 30-minute sessions and blinded listening remain separate empirical
qualification. The conservative transport/endpoint S1 policy is explicitly
degraded; do not label these software checks as full-duplex human-quality proof.
