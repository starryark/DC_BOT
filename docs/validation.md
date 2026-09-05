# Extraction validation — 2026-09-05

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

No Discord login, cloud generation, model download, GPU run, or live voice
session was performed. The current baseline voice pipeline is retained;
full-duplex integration and conversation-level latency qualification remain
work described in `voice-model-integration.md`.
