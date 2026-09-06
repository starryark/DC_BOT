# discord_bot

Standalone Discord voice bot extracted from `DC_BOT/airi/services/discord-bot`.
The bot source lives directly in `src/`; installation covers this project and
seven small shared libraries in `packages/`.

## Setup

Use Node.js 24.14+ within the Node 24 release line and pnpm 10.33.0. From this directory:

```powershell
pnpm install --frozen-lockfile
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Set `DISCORD_TOKEN`, `GEMINI_API_KEY`, and an available `GEMINI_MODEL` in `.env`.
This local checkout already has the credentials and settings copied from the
original bot's `.env` and `.config`. `.env` is ignored by Git. The character
path is adjusted to `./characters`; other supplied settings are preserved.
The configuration order is `.env`, `.config`, then optional `.env.local`; later
files win, and existing process environment variables take precedence.
Put personal tuning overrides in `.env.local`.

```powershell
pnpm check
pnpm start
# Windows shortcut: .\start-bot.cmd
```

On Windows, `pnpm start` or `start-bot.cmd` starts the existing external ASR and
TTS installations, waits for readiness, and runs this project's Discord bot in
the current terminal. The default external folders are `../DC_BOT/qwen3-asr`
and `../DC_BOT/GPT-SoVITS`. Their environments and model files stay there.
Endpoints come from `ASR_BASE_URL` and `GPT_SOVITS_URL` (defaults:
`http://127.0.0.1:8765` and `http://127.0.0.1:9880`). Healthy running services are
reused. Newly started services run in hidden windows with logs under
`.local/services/`; the launcher stops only its own services when it exits.

If the external projects move, set `ASR_PROJECT_DIR` and
`GPT_SOVITS_PROJECT_DIR` in `.env.local`. Interpreter overrides are
`ASR_PYTHON` and `GPT_SOVITS_PYTHON`. The launcher detects the existing virtual
environments by default. It never starts the old Discord bot.

Use `pnpm start:bot` when you manage services yourself (also the direct entry
point on non-Windows hosts). To check the full local setup without posting to
Discord, run:

```powershell
.\start-bot.cmd -CheckOnly
# When services are already running:
pnpm runtime:check
```

The check loads the character, authenticates to the Discord gateway, makes a
small Gemini generation request, synthesizes a Japanese test sentence, converts
it through Discord's Opus path locally, and transcribes the result. It does not
register commands, send Discord messages, join voice channels, or play audio.

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

The original `../DC_BOT` is retained. Only its explicitly supplied `.env` and
`.config` were migrated; its optional `.env.local`, live memory databases,
caches, recordings, model repositories, and weights were not copied.
If continuing an existing memory deployment, use the retained memory backup/restore commands and the
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


The local Python voice-model bridge is now implemented as an opt-in voice path.
See [voice-model-integration.md](docs/voice-model-integration.md) for off/shadow/
active selection, streaming PCM, revision ownership and qualification limits.
The legacy default remains available. Existing local configuration is preserved.
