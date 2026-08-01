# 02 — Public Contracts (Runtime V2)

> **Status: FROZEN by the Integration Lead at the Wave 0 integration gate.**
> These are the shared TypeScript interfaces every specialist agent implements
> against. Names follow local conventions; **semantics are fixed**. If a
> specialist cannot implement correctly against this contract, it MUST stop,
> record the required contract change in `docs/runtime-v2/04-decisions.md`, and
> surface it — it must NOT silently create a competing abstraction.
>
> All code is TypeScript, lives under `airi/services/discord-bot/src/`, and is
> consumed only inside the discord-bot package (no cross-package consumers yet).
> `import type` is used for interface-only imports.

---

## 1. Input events (`src/orchestration/events.ts`)

ASR is a provider operation performed **after** a voice event is received.
Downstream conversation code depends on `InputEvent`, never on Discord message
or voice classes.

```ts
export type InputEvent =
  | VoiceInputEvent
  | DiscordMentionInputEvent
  | SlashCommandInputEvent
  | ActivityInteractionInputEvent

export interface BaseInputEvent {
  /** Unique id for this input event (e.g. `${turnId}:in`). */
  eventId: string
  /** The turn this input belongs to. Assigned by the orchestrator. */
  turnId: string

  guildId?: string
  channelId?: string
  userId: string
  displayName: string

  timestamp: number
}

export interface VoiceInputEvent extends BaseInputEvent {
  type: 'voice'
  voiceChannelId: string
  /** 16 kHz mono PCM16, exactly as emitted by the VoiceManager today. */
  pcm: Buffer
  sampleRate: 16000
}

export interface DiscordMentionInputEvent extends BaseInputEvent {
  type: 'discord-mention'
  messageId: string
  /** Mention text already stripped of the bot's application mention. */
  text: string
}

export interface SlashCommandInputEvent extends BaseInputEvent {
  type: 'slash-command'
  commandName: string
  // subcommand/args may be added later; do not over-design now.
}

export interface ActivityInteractionInputEvent extends BaseInputEvent {
  type: 'activity'
  activitySessionId: string
  action: string
  payload?: unknown
}
```

**Compatibility note:** today's `VoiceUtterance` (`src/voice/types.ts`) carries
`guildId, channelId, userId, displayName, pcm, sampleRate, startedAt, endedAt`.
The voice adapter converts a `VoiceUtterance` into a `VoiceInputEvent` (carrying
`startedAt`/`endedAt` through if needed for telemetry, but the orchestrator's
contract is the `InputEvent` shape above).

---

## 2. Conversation rooms (`src/orchestration/room-id.ts`, `src/orchestration/room.ts`)

Replaces guild-only history (`GuildSession`, per `00-current-state.md` §4.9).

### 2.1 Room id helpers

```ts
export type ConversationRoomId = string

export function textRoom(guildId: string, channelId: string): ConversationRoomId {
  return `guild:${guildId}:text:${channelId}`
}
export function threadRoom(guildId: string, threadId: string): ConversationRoomId {
  return `guild:${guildId}:thread:${threadId}`
}
export function voiceRoom(guildId: string, voiceChannelId: string): ConversationRoomId {
  return `guild:${guildId}:voice:${voiceChannelId}`
}
```

### 2.2 Conversation room state

A room owns recent exact turns + an optional running summary. It does NOT own
long-term memory (memory is a separate subsystem, §9).

```ts
export interface ConversationTurn {
  turnId: string
  role: 'user' | 'assistant'
  /** Speaker display name for user turns; undefined for assistant. */
  speaker?: string
  text: string
  /** Detected/source language hint ('zh' | 'en' | 'ja' | 'und' | ...). */
  language?: string
  timestamp: number
}

export interface ConversationRoom {
  id: ConversationRoomId
  characterId: string

  recentTurns: ConversationTurn[]
  runningSummary?: string

  /** Active character mode (e.g. 'amadeus'); undefined = default. */
  activeMode?: string

  createdAt: number
  updatedAt: number
}
```

**Invariants (master plan §4):**
- Two separate channels in the same guild MUST NOT share recent history.
- Two users speaking sequentially in one voice room MUST share that room's history.
- Explicit room binding (Wave 3B) lets a voice room and a text channel share a
  logical room; unbound channels stay isolated.

### 2.3 Room store interface

```ts
export interface RoomStore {
  get(roomId: ConversationRoomId): ConversationRoom | undefined
  getOrCreate(roomId: ConversationRoomId, characterId: string): ConversationRoom
  appendTurn(roomId: ConversationRoomId, turn: ConversationTurn): void
  setRunningSummary(roomId: ConversationRoomId, summary: string): void
  setActiveMode(roomId: ConversationRoomId, mode: string | undefined): void
  clear(roomId: ConversationRoomId): void
}
```

Initial implementation is **in-memory** (process lifetime), mirroring today's
`GuildSessionRegistry`. Persistence of *context* is not required in Wave 1;
*persistent memory* is Wave 4 and is a different subsystem.

---

## 3. Output: semantic `TurnOutput` events (`src/orchestration/output.ts`)

The brain/orchestrator no longer returns one finished string. It emits a stream
of semantic events. Consumers are `DiscordTextSink`, `SpeechSink`, `AvatarSink`,
and telemetry.

```ts
export type TurnOutput =
  | { type: 'text.delta'; text: string }
  | { type: 'speech.segment'; segmentId: string; text: string }
  | { type: 'avatar.action'; action: AvatarAction }
  | { type: 'pause'; durationMs: number }
  | { type: 'final' }
```

`AvatarAction` (the parsed, internal representation of an ACT token — see §8):

```ts
export interface AvatarAction {
  emotion?: string            // 'happy' | 'sad' | 'angry' | 'think' | 'surprised' | 'awkward' | 'question' | 'curious' | 'neutral'
  intensity?: number          // 0..1
  motionHint?: string         // free-text short motion, e.g. '眉をひそめる'
}
```

**Critical rule (master plan §5):** ACT tokens are one possible LLM-output
*encoding*, parsed immediately into `AvatarAction`. ACT markup MUST NEVER reach:
- GPT-SoVITS
- Discord visible replies
- memory summaries
- ordinary conversation history

---

## 4. Delivery policy (`src/orchestration/delivery.ts`)

Input medium and output medium are decoupled. The decision is represented
explicitly, not hidden in scattered `if (event.type === ...)`.

```ts
export interface DeliveryPolicy {
  text: boolean
  speech: boolean
  avatar: boolean
}
```

Default policy (master plan §10):

| Input | text | speech | avatar |
|-------|------|--------|--------|
| Voice | (no Discord text by default) | ✓ | ✓ if available |
| Discord `@mention` | ✓ | ✗ (do NOT speak into VC by default) | ✓ if related Activity active |
| Activity interaction | Activity-visible | optionally, if bound VC session | ✓ |

---

## 5. Character subsystem (`src/character/types.ts`, `card-schema.ts`, `character-registry.ts`, `prompt-compiler.ts`)

### 5.1 `CharacterRuntime` (the immutable, normalized character)

```ts
export interface CharacterRuntime {
  id: string
  name: string

  identity: {
    description: string
    personality: string
    scenario: string
    systemPrompt: string
    postHistoryInstructions: string
  }

  voice: VoiceProfile
  asr: AsrCharacterProfile

  avatar?: AvatarProfile
  lorebook?: CharacterLorebook

  outputProtocol?: OutputProtocolProfile
}
```

Supporting profiles (sourced from `extensions.dc_bot` — see §7):

```ts
export interface VoiceProfile {
  provider: string                 // 'gpt-sovits'
  voiceId: string                  // 'kurisu'
  referenceAudio: string           // asset path, relative to card dir
  referenceTextFile?: string       // e.g. 'reference.txt'
  referenceText?: string           // resolved transcript contents
  promptLanguage: string           // 'ja'
}

export interface AsrCharacterProfile {
  hotwords: string[]               // e.g. ['牧瀬紅莉栖', 'クリスティーナ', ...]
}

export interface AvatarProfile {
  renderer: string                 // 'live2d'
  displayModelId?: string
}

export interface OutputProtocolProfile {
  type: string                     // 'act-v1'
  emotions: string[]
  allowDelay: boolean
}

export interface CharacterLorebook {
  // CCv3 character_book entries; activated by keyword/binding for prompt compile.
  entries: LorebookEntry[]
}
export interface LorebookEntry {
  keys: string[]
  content: string
  extensions?: Record<string, unknown>
  enabled?: boolean
  insertionOrder?: number
}
```

### 5.2 `CharacterRegistry`

```ts
export interface CharacterRegistry {
  /** Load + validate + normalize a CCv3 card; returns an immutable runtime. */
  load(characterId: string): CharacterRuntime
}
```

Responsibilities (master plan §6): load card, validate CCv3, normalize optional
fields, resolve application extensions, resolve assets, return immutable
`CharacterRuntime`.

It MUST NOT: call Gemini, call TTS, call ASR, manage Discord, or write memory.

### 5.3 `PromptCompiler` (single source of prompt composition)

Recommended ordering (master plan §8):

```
runtime safety / output-format instructions
        ↓
character system_prompt
        ↓
description
personality
scenario
        ↓
activated lorebook entries
        ↓
retrieved long-term memories
        ↓
room running summary
        ↓
recent exact conversation turns
        ↓
current input
        ↓
post_history_instructions
```

```ts
export interface CompiledPrompt {
  systemInstruction: string
  contents: import('@google/genai').Content[]
}

export interface CompiledPromptMetrics {
  approximateTokens: number
  recentTurnCount: number
  memoryCount: number
  loreEntryCount: number
}

export interface PromptCompiler {
  compile(input: {
    character: CharacterRuntime
    room: ConversationRoom
    currentInput: InputEvent
    /** Normalized text of the current input (ASR result for voice, stripped mention text for text). */
    currentInputText: string
    memories?: MemoryRecord[]
  }): { prompt: CompiledPrompt; metrics: CompiledPromptMetrics }
}
```

`creator_notes` is NOT automatically injected into prompts. Prompt behavior
primarily uses the semantic card fields: `system_prompt`, `description`,
`personality`, `scenario`, `character_book`, `post_history_instructions`.

---

## 6. Provider abstractions (`src/providers/**`)

These already exist today and are PRESERVED. Specialists extend, not replace.

```ts
// src/providers/brain/types.ts
export interface BrainTurn {
  guildId: string
  roomId: ConversationRoomId      // ★ Wave 1: replace guildId-only scoping
  userId: string
  userName: string
  language: string
  text: string
}
export interface BrainProvider {
  generate(turn: BrainTurn, signal: AbortSignal): AsyncIterable<string>
}
```

> **Wave 1 contract note:** the `BrainTurn` gains a `roomId`. The
> `setContentsProvider` resolver (wired in `index.ts`) switches from
> `sessions.get(turn.guildId)` to the room-scoped store. This is a controlled,
> centrally-coordinated change — the Integration Lead wires it.

```ts
// src/providers/asr/types.ts
export interface AsrInput { wav: Buffer; sampleRate: number; prompt?: string }
export interface AsrResult { text: string; language: string; inferenceMs: number }
export interface AsrProvider {
  transcribe(input: AsrInput): Promise<AsrResult>
  health(): Promise<{ ready: boolean }>
}
```

> **Wave 2B/5 note:** `AsrInput` gains an optional `prompt` (context/hotwords).
> The HTTP contract `POST /v1/transcribe` stays stable with `{ text, language }`
> and gains an optional request `prompt` property.

```ts
// src/providers/tts/types.ts
export interface TtsRequest { text: string; language?: GptSoVitsLang }
export interface TtsProvider {
  synthesize(request: TtsRequest, signal: AbortSignal): Promise<import('node:stream').Readable>
}
```

---

## 7. Card schema: `extensions.dc_bot` (`src/character/card-schema.ts`)

A DC_BOT-specific extension is added to `Makise Kurisu/card.json`. It MUST NOT
store: API keys, Discord tokens, absolute user paths, ports, or CUDA device
selection (those stay deployment config).

```jsonc
{
  "extensions": {
    "airi": { /* preserve existing AIRI fields verbatim */ },
    "dc_bot": {
      "outputProtocol": {
        "type": "act-v1",
        "emotions": ["happy","sad","angry","think","surprised","awkward","question","curious","neutral"],
        "allowDelay": true
      },
      "voice": {
        "provider": "gpt-sovits",
        "voiceId": "kurisu",
        "referenceAudio": "害羞示范.wav",
        "referenceTextFile": "reference.txt",
        "promptLanguage": "ja"
      },
      "asr": {
        "hotwords": ["牧瀬紅莉栖","クリスティーナ","アマデウス","岡部倫太郎","未来ガジェット研究所"]
      },
      "avatar": {
        "renderer": "live2d",
        "displayModelId": "display-model-0-BFdupzrCE8y9q0Vofel"
      }
    }
  }
}
```

**Card validation rules:**
- `spec === 'chara_card_v3'` and `spec_version === '3.0'` (warn-but-accept minor).
- Required `data` fields: `name`, `system_prompt`. Others optional.
- Unknown CCv3 fields MUST survive parsing (preserve-and-ignore).
- `extensions.airi` preserved verbatim.
- `extensions.dc_bot` normalized; missing optional fields get safe defaults
  (e.g. `outputProtocol.emotions` falls back to the canonical list).
- The ACT protocol currently in `creator_notes` is MOVED into
  `extensions.dc_bot.outputProtocol`. `creator_notes` is kept on the card but is
  NOT treated as automatic system-prompt content.

---

## 8. Output protocol parser (`src/character/output-protocol/**`, Wave 6)

Parses one LLM-output encoding (ACT-v1) into `AvatarAction` + clean text.

Input:
```
<|ACT:"emotion":{"name":"question","intensity":0.7},"motion":"眉をひそめる"|>
そんなこと、本当に可能だと思ってるの？
```

Output:
```ts
{ type: 'avatar.action', action: { emotion: 'question', intensity: 0.7, motionHint: '眉をひそめる' } }
// + clean speech/text:
//   そんなこと、本当に可能だと思ってるの？
```

**Robustness:** malformed ACT content MUST NOT break the turn. Fallback: treat
malformed control syntax as stripped/ignored metadata; preserve safe visible
content. NEVER `eval`/`JSON.parse` arbitrary LLM output blindly — parse with a
strict, bounded parser. Optional `<|DELAY:n|>` maps to `{ type: 'pause', durationMs }`
when `outputProtocol.allowDelay` is true.

---

## 9. Memory subsystem (`src/memory/**`, Wave 4)

Context (§2) and memory are DIFFERENT subsystems.

```ts
export interface MemoryRecord {
  id: string
  characterId: string
  scope:
    | { type: 'user'; userId: string }
    | { type: 'room'; roomId: ConversationRoomId }
    | { type: 'guild'; guildId: string }
  text: string
  sourceTurnIds: string[]
  salience: number
  confidence: number
  createdAt: number
  updatedAt: number
  lastAccessedAt?: number
  tags: string[]
}

export interface MemoryQuery {
  characterId: string
  scope?: MemoryRecord['scope']
  text: string
  limit?: number
}

export interface MemoryStore {
  search(query: MemoryQuery): Promise<MemoryRecord[]>
  save(record: MemoryRecord): Promise<void>
  update(id: string, patch: Partial<MemoryRecord>): Promise<void>
  forget(id: string): Promise<void>
}
```

Initial implementation: **SQLite + FTS5 + recency + salience** (no vector DB).
Search score begins as `scope match + lexical relevance + recency + salience`,
with a deterministic max retrieval count/token budget. An embedding column may
be added later. Memory extraction/summarization runs AFTER the user receives
their response and MUST NOT block audio.

---

## 10. Attention policy (`src/orchestration/attention/**`, Wave 2D)

```ts
export interface AttentionDecision {
  type: 'respond' | 'observe' | 'ignore'
  reason: string
  confidence?: number
}

export interface AttentionPolicy {
  decide(input: { asrText: string; room: ConversationRoom; recentTurns: ConversationTurn[] }): AttentionDecision
}
```

First implementation is deterministic heuristics (no second LLM). Filtering
occurs BEFORE expensive generation: empty ASR → ignore; known filler only →
ignore/observe; explicit character name or active exchange → respond.

---

## 11. Turn cancellation (`src/orchestration/turn.ts`)

A turn-scoped abort hierarchy. Every async provider accepts `AbortSignal` (or is
wrapped so stale results are ignored).

```
Room turn AbortController
    ├── Gemini
    ├── TTS request
    ├── queued speech chunks
    └── avatar speech events
```

Barge-in: human starts meaningful speech → cancel current bot speaking turn →
stop playback → abort pending TTS → discard stale output → accept new human turn.
An old turn can NEVER resume speaking after a new conversation turn has begun.

---

## 12. Observability / telemetry (`src/observability/**`, Wave 1C)

One `turnId` is traced through every stage (master plan §16). Use monotonic time
for durations; log stage durations separately. Do NOT treat
`user-stop → audio` as the only latency metric.

Stages traced per turn (the baseline's gaps — `prompt_compile_ms`,
`speech_segment_ready_ms`, `tts_first_byte_ms`, `total_turn_ms` per
`03-performance-baseline.md` §7.1 — are filled in here):

```
Discord receive → endpoint finalized → ASR begin/end → attention decision →
prompt compile → LLM request → LLM first token → LLM complete →
TTS request → TTS first byte → TTS first PCM → playback queued →
playback start → playback end → memory work → avatar events
```

---

## 13. Non-goals for the public contracts (do not over-build now)

- No cross-package publishing of these types (they live in the discord-bot
  package until Wave 8 relocation).
- No second LLM for attention.
- No vector database before SQLite retrieval is insufficient.
- No live video streaming for Live2D.
- No giant repo relocation before Runtime V2 is stable.
