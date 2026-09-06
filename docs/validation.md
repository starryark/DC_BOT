# Project validation — 2026-09-05

Environment: Windows, Node.js v24.14.0, pnpm 10.33.0.

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed; eight workspace projects, no dependency on the old checkout |
| `pnpm check` | Passed, including TypeScript checks for the bot and all seven shared packages |
| Vitest | 129 files passed; 1,854 tests passed; one existing Windows skip |
| Runtime imports | AIRI adapter, Gemini provider, voice manager, Davey, and libsodium loaded successfully |
| Workspace manifests | Every workspace dependency and source export resolves within this project; no unresolved catalog dependencies |
| Original repositories | `DC_BOT` and its AIRI checkout remained clean; Voice_Model's pre-existing work was not modified |

The skipped test checks POSIX owner-only filesystem permissions and already
uses `skipIf(process.platform === 'win32')` in `src/memory/active-soak-cli.test.ts`.

The unrelated historical documentation-governance suite remains in DC_BOT,
as recorded in `extraction-manifest.json`. All extracted runtime and adapter
regression tests ran, including memory-boundary tests against the new `src/`.

Installation reports the retained `opusscript`/`prism-media` peer-version warning
and disabled lifecycle scripts for `@google/genai` and `protobufjs`. Runtime
imports and the full test suite passed with this installation configuration.

## Credential migration and live provider check

After the user's request to migrate the existing configuration:

- Copied the original bot's `.env` byte-for-byte; verified Git ignores it and
  that neither credential occurs in tracked files.
- Preserved the original `.config` settings, adjusting `CHARACTER_PATH` to
  this project's `./characters` directory.
- Ran `start-bot.cmd -CheckOnly` successfully with the existing external model
  installations. Qwen ASR and GPT-SoVITS passed their readiness checks.
- Loaded the Kurisu card and authenticated to Discord with the production
  intent set; two guilds were visible.
- Streamed a real response from the configured `gemini-3.7-flash`, using the
  bot's configured casual generation profile.
- Synthesized a Japanese test sentence into 149,804 WAV bytes, encoded 118
  Discord Opus packets locally, decoded them to the bot's 16 kHz mono input
  format, and obtained a nonempty Japanese transcription from Qwen ASR.
- Verified the launcher stopped its own model processes after the check;
  no service remained listening on ports 8765 or 9880.

These checks sent no messages or audio to Discord and registered no commands.
They validate credentials, service startup, and the local audio conversion path;
they do not replace a live `/summon` conversation or establish full-duplex
latency/voice quality. The current baseline voice pipeline remains in use.


## Voice-model optimization integration

The final full bot suite passed 1874 tests with one skipped test across 134 files. TypeScript checking
passes, including the new bridge, packet fence, active-mode controller and
optional Responses provider. Focused cancellation, phrase-boundary and explicit
voice-test authority cases also pass. Five transport lifecycle cases cover
decoder/reset failure and stale events/member lookups after a rejoin.

The actual Python/TypeScript synthetic replay passes two turns, cancelled audio,
stale-revision refusal and replacement PCM. See the Python repository's
OPTIMIZATION_RUNTIME.md and generated evidence for stock-voice GPU measurements.
Live Discord/DAVE room behavior and exact Kurisu voice compatibility remain
separate qualification; no public session was started during implementation.
