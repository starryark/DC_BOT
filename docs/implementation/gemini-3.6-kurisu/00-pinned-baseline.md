# Wave 0A pinned baseline

Captured on 2026-08-01 in `C:\Users\lyang\Code\DC_BOT`. This document records the repository as observed; Wave 0A made no production-code changes.

## Repository identity

| Item | Observed value |
| --- | --- |
| Branch | `main` |
| Full commit SHA | `262877ddcc56738587c4e6c47e2aa4ccd1ffa15a` |
| Commit date | `2026-08-01T04:41:38-07:00` |
| Commit subject | `modified character card` |
| Origin | `https://github.com/starryark/DC_BOT.git` |
| Node | `v24.14.0` |
| Package manager | `pnpm 10.33.0` (also pinned by `airi/package.json`) |
| Workspace root used for commands | `C:\Users\lyang\Code\DC_BOT\airi` |
| Lockfile | `airi/pnpm-lock.yaml`, tracked, clean, lockfile version `9.0` |

The initial working tree was clean relative to tracked files and synchronized with `origin/main`; the only status entry was the already-present untracked plan:

```text
## main...origin/main
?? Plan.md
```

## Verification commands and complete diagnostics

### Typecheck

Command:

```powershell
pnpm --filter @proj-airi/discord-bot typecheck
```

Exit code: `0`.

```text
> @proj-airi/discord-bot@ typecheck C:\Users\lyang\Code\DC_BOT\airi\services\discord-bot
> tsc --noEmit
```

Contrary to the concern recorded in `Plan.md`, the pinned snapshot is not currently type-broken.

### Unit tests

Command:

```powershell
pnpm --filter @proj-airi/discord-bot test
```

Exit code: `1`.

```text
> @proj-airi/discord-bot@ test C:\Users\lyang\Code\DC_BOT\airi\services\discord-bot
> vitest run

 RUN  v4.1.4 C:/Users/lyang/Code/DC_BOT/airi/services/discord-bot

 ❯ src/character/character-registry.test.ts (15 tests | 1 failed) 52ms
     × loads the live card with no extensions.dc_bot into a full runtime 31ms

 Test Files  1 failed | 25 passed (26)
      Tests  1 failed | 297 passed (298)
   Start at  05:05:35
   Duration  5.17s (transform 4.04s, setup 0ms, import 7.08s, tests 4.77s, environment 7ms)

C:\Users\lyang\Code\DC_BOT\airi\services\discord-bot:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @proj-airi/discord-bot@ test: `vitest run`
Exit status 1

 Failed Tests 1

 FAIL  src/character/character-registry.test.ts > fileCharacterRegistry — LIVE Kurisu card (compatibility) > loads the live card with no extensions.dc_bot into a full runtime
AssertionError: expected [ '牧瀬紅莉栖', 'アマデウス', '比屋定真帆', …(7) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "牧瀬紅莉栖",
+   "アマデウス",
+   "比屋定真帆",
+   "アレクシス・レスキネン",
+   "ヴィクトル・コンドリア大学",
+   "岡部倫太郎",
+   "クリスティーナ",
+   "未来ガジェット研究所",
+   "世界線",
+   "タイムリープ",
+ ]

 ❯ src/character/character-registry.test.ts:71:34
     69|
     70|     // asr hotwords default to [].
     71|     expect(runtime.asr.hotwords).toEqual([])
       |                                  ^
     72|
     73|     // avatar displayModelId picked up from the AIRI extension.
```

The failure is a stale test assumption, not a loader failure. `Makise Kurisu/card.json` now has `extensions.dc_bot.asr.hotwords` with the ten received values. It also has `extensions.dc_bot.interaction`, with default response language `ja`, pronunciation profile `makise-amadeus-v2`, and entity records. The test name and comments still claim the live card has no `extensions.dc_bot`.

## Contract inventory

| Symbol | Declared in | Used in | Current problem |
| --- | --- | --- | --- |
| `CharacterRuntime.interaction` | `src/character/types.ts:151` | Constructed in `character-registry.ts:168,182`; consumed in `conversation-controller.ts:216,440,453,457` | No compiler problem in this snapshot. The plan's missing-property warning is stale. |
| `CharacterInteractionProfile` | `src/character/types.ts:116` | Card normalization in `card-schema.ts:372-399`; input-understanding API/tests; `CharacterRuntime.interaction` | Declared and wired. No current type error. |
| `CharacterEntityProfile` | `src/character/types.ts:106` | Card normalization in `card-schema.ts:380-396`; entity recognition in `input-understanding.ts`; speech substitution in `providers/tts/pronunciation.ts` | Declared and consumed. No current type error. |
| `SupportedLanguage` | `src/character/types.ts:104` | Input language normalization/resolution and TTS pronunciation preparation | Declared as `'ja' | 'zh' | 'en'`; no current type error. |
| `TtsRequest.pronunciationProfileVersion` | `src/providers/tts/types.ts:26` | Passed by `conversation-controller.ts:457`; included in cache identity via the controller/cache path | Declared optional and accepted. No current excess-property error. |
| `AsrCharacterProfile.hotwords` | `src/character/types.ts:44-46` | Normalized by `card-schema.ts:365`; populated by `character-registry.ts:159`; asserted in registry tests | Card-to-runtime loading works, but `AsrProvider.transcribe` accepts only `AsrInput` (`wav`, `sampleRate`), so hotwords are not forwarded to an ASR request/decoder. The stale live-card test currently fails because it expects `[]`. |

## Read-only audit conclusions

1. The public contracts described as missing in the plan have already landed at the pinned commit, and the package typecheck is green.
2. The checked-in live Kurisu card has moved ahead of `character-registry.test.ts`: it contains both ASR hotwords and an interaction profile.
3. The sole test failure is the compatibility test's obsolete expectation that the live card has no `extensions.dc_bot` and therefore no hotwords.
4. ASR hotwords currently stop at `CharacterRuntime.asr`; the provider boundary has no request field for them, consistent with the plan's statement that decoder-level hotwords remain unwired.
5. No contract or production fix was applied during this audit.
