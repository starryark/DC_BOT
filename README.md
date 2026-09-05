# discord_bot

Standalone Discord voice bot extracted from `DC_BOT/airi/services/discord-bot`.
The bot source lives directly in `src/`; installation covers this project and
seven small shared libraries in `packages/`.

## Setup

Use Node.js 24.14+ within the Node 24 release line and pnpm 10.33.0. From this directory:

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
```

Set `DISCORD_TOKEN`, `GEMINI_API_KEY`, and an available `GEMINI_MODEL` in `.env`.
The configuration order is `.env`, `.config`, then optional `.env.local`; later
files win, and existing process environment variables take precedence.
Put personal tuning overrides in `.env.local`.

```powershell
pnpm check
pnpm start
# Windows shortcut: .\start-bot.cmd
```

The launcher starts the Discord process in this directory. It uses separately
running ASR and TTS services configured by `ASR_BASE_URL` and `GPT_SOVITS_URL`
(defaults: `http://127.0.0.1:8765` and `http://127.0.0.1:9880`).
`GPT_SOVITS_REF_AUDIO` is resolved by the TTS server, relative to that server's
working directory; the supplied value supports the existing external GPT-SoVITS
installation. Set it to the reference clip on your TTS server when changing hosts.

Enable Message Content Intent for the Discord application and grant the bot
the text and voice permissions it uses. Join a voice channel, use `/summon`,
and use `/leave` when finished. `/voice-test` checks TTS and playback.

## Layout

| Path | Purpose |
| --- | --- |
| `src/` | Discord gateway, voice capture/playback, orchestration, providers, persona, memory |
| `packages/` | Memory domain/SQLite, avatar protocol, optional AIRI client and its protocol/transport dependencies |
| `characters/` | The existing Kurisu character card; large avatar models remain external |
| `config/` | TTS voice-profile configuration template |
| `scripts/`, `evals/` | Existing operator commands, benchmarks, regression tests, synthetic evaluation fixtures |
| `docs/deep-research-report.md` | The supplied architecture research, preserved as a reference snapshot |
| `docs/voice-model-integration.md` | External voice-model location, ownership boundary, and remaining integration work |
| `docs/extraction-manifest.json` | Source revisions and copied-file provenance |
| `docs/validation.md` | Extraction checks and the limits of offline validation |

Shared packages keep their original names to preserve imports. They expose
TypeScript source to `tsx` and Vitest, so no AIRI build, frontend toolchain,
Electron application, or external workspace link is required. Their upstream
MIT notice is retained in `LICENSE`. `THIRD_PARTY_NOTICES.md` records attribution.

## Current behavior

This extraction preserves the current Qwen ASR → streamed Gemini text →
GPT-SoVITS voice path, including response cancellation, playback completion,
persona, and memory commands. `.config` currently uses half duplex, 900 ms
endpoint silence, a 300 ms group window, and GPT-SoVITS streaming mode 0.
The report's realtime/full-duplex design remains implementation work.

`C:/Users/lyang/Voice_Model/repo` remains the separate Python voice project.
Its environments, training data, checkpoints, and evidence are not dependencies
of installing or testing this TypeScript project. No voice-model server is
started by this launcher; see the integration document before adding a bridge.

The original `../DC_BOT` is retained. Secrets, personal overrides, live memory
databases, caches, recordings, model repositories, and weights were not copied.
Configure this project explicitly before starting it. If continuing an existing
memory deployment, use the retained memory backup/restore commands and the
intended runtime root rather than starting a second writer against a live store.

## Development

`pnpm typecheck` checks the bot and every included package. `pnpm test` runs
the bot, evaluation, and shared-library tests with four workers. `pnpm check`
runs both. Tests use fake providers and synthetic data; they do not establish
live Discord connectivity, model quality, or full-duplex latency.

All original `memory:*` commands and `benchmark:voice` remain available in
`package.json`. Benchmarks requiring ASR, TTS, or a cloud model must be run
with those services configured.

The original memory program's documentation-governance test remains with
`DC_BOT`: it checks that repository's historical evidence, release status,
runbooks, and backlog rather than bot behavior. Those documents and that test
are outside this extraction. Runtime and adapter regression tests are retained.
