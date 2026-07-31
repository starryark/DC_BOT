Yes. Since the audio bot is already built, I would add the avatar as a **Discord Activity attached to the same voice channel**, while keeping the existing bot account responsible for voice audio.

There is one important Discord limitation to design around:

**I would not implement this as a literal bot camera/video tile.** Discord's underlying Voice Gateway has video-related protocol support, but the current supported `@discordjs/voice` stack exposes sending/receiving **audio**, not a public bot-camera API. Discord has also moved voice/video onto DAVE E2EE, making a custom undocumented video sender substantially more fragile. ([Discord Docs][1])

The supported solution is a **Discord Activity**: an iframe application rendered directly inside Discord and launchable from a voice channel. This is actually a very good fit for AIRI because AIRI's Live2D implementation is already browser/WebGL/Vue based. Activities can run directly inside Discord, including voice channels, and Discord's SDK exposes channel/participant information and picture-in-picture behavior. ([Discord Docs][2])

So the resulting experience should be:

```text
Discord Voice Channel
│
├── AIRI bot
│     └── voice audio from GPT-SoVITS
│
└── AIRI Activity
      └── Live2D avatar
           ├── mouth movement
           ├── blink
           ├── eye movement
           ├── idle motions
           ├── expressions
           └── conversational motions
```

On desktop, users can keep the Activity visible alongside the call, including Discord's PIP-oriented Activity layout. It is not technically the bot's camera tile, but visually it is the supported way to get very close to the desired experience.

---

# 1. Reuse AIRI's renderer; do not rebuild Live2D

This is the biggest advantage of already having AIRI cloned.

Do **not** tell Codex to create a new Live2D renderer.

Reuse:

```text
AIRI/
└── packages/
    ├── stage-ui-live2d/
    └── model-driver-lipsync/
```

The existing AIRI `Live2D.vue` component already accepts:

```ts
mouthOpenSize?: number
nowSpeaking?: boolean
modelSrc?: string
modelId?: string
paused?: boolean
cursorPosition?: ...
```

and internally wires the model to AIRI's:

* eye tracking;
* idle animation;
* auto blink;
* forced idle eye animation;
* expression system;
* render scale;
* max FPS;
* shadows.

It also exposes the underlying canvas and a `captureFrame()` method. ([GitHub][3])

Most importantly, AIRI already has a final motion plugin specifically for lip sync:

```text
nowSpeaking == true
        ↓
ParamMouthOpenY = mouthOpenSize
```

and when speech finishes it performs a 200 ms release plus a short handoff period before returning mouth control to idle motions/expressions. ([GitHub][4])

That is exactly what you want.

So the renderer should consume AIRI, not fork it.

---

# 2. New target architecture

I would make the finished system look like this:

```text
                         DISCORD
┌─────────────────────────────────────────────────────────────┐
│                   Voice Channel                             │
│                                                             │
│  Bot audio participant             AIRI Activity            │
│  ┌─────────────────────┐           ┌─────────────────────┐  │
│  │ GPT-SoVITS speech   │           │ Actual AIRI Live2D │  │
│  │                     │           │ renderer            │  │
│  │ sent over Discord   │           │                     │  │
│  │ voice               │           │ blink / eyes        │  │
│  └─────────▲───────────┘           │ idle animation      │  │
│            │                       │ expressions         │  │
│            │                       │ mouth               │  │
│            │                       └──────────▲──────────┘  │
└────────────┼──────────────────────────────────┼─────────────┘
             │                                  │
             │                                  │ WebSocket
             │                                  │ avatar events
             │                                  │
┌────────────┴──────────────────────────────────┴─────────────┐
│                    Existing bot runtime                     │
│                                                            │
│ Discord → Qwen ASR → Gemini → GPT-SoVITS                  │
│                                   │                        │
│                                   ├─ Discord audio         │
│                                   │                        │
│                                   └─ Avatar timeline       │
│                                      ├ mouth               │
│                                      ├ speaking            │
│                                      ├ expression          │
│                                      └ motion              │
└───────────────────────────┬────────────────────────────────┘
                            │ outbound WebSocket
                            ▼
                 ┌─────────────────────┐
                 │ Avatar state relay  │
                 │                     │
                 │ guild/channel state │
                 │ latest snapshot     │
                 │ event fanout        │
                 └─────────────────────┘
```

The crucial idea is:

> **Do not stream rendered video. Stream animation state and let every Discord client render the AIRI Live2D model locally.**

This has huge advantages.

You avoid:

```text
Live2D
 ↓
canvas
 ↓
H264/VP8 encoder
 ↓
video RTP
 ↓
Discord video protocol
 ↓
DAVE encryption
```

Instead you send tiny events like:

```json
{
  "type": "avatar.mouth",
  "guildId": "...",
  "channelId": "...",
  "turnId": "...",
  "mouthOpen": 0.61,
  "atMs": 1480
}
```

Each Activity instance renders the actual Live2D model at 30/60 FPS locally.

---

# 3. Why an external relay is needed

Your bot can remain completely local.

But a Discord Activity cannot simply connect to:

```text
127.0.0.1:3000
```

on your PC for every viewer.

The Activity runs inside each participant's Discord client.

Discord Activities also run in a sandbox behind Discord's proxy and require public URL mappings for the application and external requests. Discord's official local-development guide recommends exposing the dev server through something like `cloudflared` and configuring Activity URL Mapping. ([Discord Docs][5])

Therefore there are two viable deployments.

### Development

```text
your PC
│
├── Discord bot
├── Activity dev server
└── avatar relay
        │
    cloudflared
        │
      Discord
```

### Production — preferred

```text
YOUR PC
────────────────────
Discord bot
Qwen
Gemini client
GPT-SoVITS
     │
     │ outbound WSS only
     ▼

PUBLIC SMALL SERVICE
────────────────────
Activity static app
Avatar state relay
     │
     ▼

Discord clients
```

Only avatar state needs to leave your machine.

Your:

* microphone audio;
* STT audio;
* GPT-SoVITS model;
* Gemini credentials;
* reference voice;
* local model paths

do not need to be exposed to the Activity.

---

# 4. Add three major components

I would add:

```text
apps/
└── discord-activity-live2d/

services/
└── discord-avatar-relay/

packages/
└── discord-avatar-protocol/
```

and extend:

```text
services/discord-bot/
└── src/avatar/
```

So roughly:

```text
repo/
├── AIRI/
│   └── packages/
│       ├── stage-ui-live2d/
│       └── model-driver-lipsync/
│
├── services/
│   ├── discord-bot/
│   ├── qwen3-asr/
│   └── discord-avatar-relay/
│
├── apps/
│   └── discord-activity-live2d/
│
└── packages/
    └── discord-avatar-protocol/
```

The initial repository-cartography agent should adjust these locations if your current workspace layout differs.

---

# 5. Shared avatar protocol first

Before anybody builds UI or bot changes, define the wire protocol.

Create something like:

```ts
export interface AvatarStateSnapshot {
  schemaVersion: 1

  guildId: string
  channelId: string

  connected: boolean
  speaking: boolean
  mouthOpen: number

  activeExpression?: string
  activeMotion?: {
    group: string
    index?: number
  }

  turnId?: string
  sequence: number
  updatedAt: number
}
```

And events:

```ts
type AvatarEvent =
  | AvatarSpeakingStart
  | AvatarSpeakingStop
  | AvatarMouthFrame
  | AvatarMotionPlay
  | AvatarExpressionSet
  | AvatarExpressionClear
  | AvatarLookAt
  | AvatarReset
```

Example:

```ts
interface AvatarMouthFrame {
  type: 'avatar.mouth'

  guildId: string
  channelId: string

  turnId: string
  sequence: number

  value: number

  // Relative to the associated playback epoch.
  mediaTimeMs: number
}
```

---

# 6. Separate persistent state from transient animation

This will prevent reconnect bugs.

Persistent snapshot:

```text
model
expression
speaking
current motion
bot state
```

Transient events:

```text
mouth frame
motion trigger
look target
gesture
```

When someone joins the Activity halfway through a conversation, the relay immediately sends:

```json
{
  "type": "avatar.snapshot",
  "speaking": true,
  "mouthOpen": 0.4,
  "expression": "happy"
}
```

They don't have to replay 600 old events.

---

# 7. States I would expose

Have the avatar use a very small internal state machine:

```ts
type AvatarBehaviorState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
```

Eventually:

```text
idle
 ↓ user speaks
listening
 ↓ ASR complete
thinking
 ↓ first TTS playback
speaking
 ↓ playback complete
idle
```

This creates a much more convincing avatar even before sophisticated emotion generation exists.

---

# 8. Subagent 0 — Repository Cartographer

This agent goes first.

Give it access to:

```text
current repo root

existing:
services/discord-bot/**
services/qwen3-asr/**

AIRI:
packages/stage-ui-live2d/**
packages/model-driver-lipsync/**
packages/stage-ui/**
packages/ui/**

workspace manifests
package.json
pnpm-workspace.yaml
```

Do **not** give it Discord Activity tutorials yet.

### Task

Produce:

```text
docs/avatar/repository-reuse-map.md
```

containing:

```text
Current git HEAD
Current dirty working tree
Existing voice bot architecture

Current outgoing TTS flow
Exact location where:
- GPT-SoVITS stream appears
- audio is converted for Discord
- AudioPlayer starts
- AudioPlayer becomes Idle

Existing turnId handling

AIRI:
- Live2D public exports
- required Pinia stores
- Live2D component dependencies
- model asset loading
- expression APIs
- motion APIs
- eye tracking
- idle animation
- lipsync entry points

Files that should be reused
Files requiring wrappers
Files that must not be copied
```

No modifications.

---

# 9. The Cartographer must inspect the local AIRI checkout

Do not let Codex rely blindly on upstream snippets from this plan.

Instruction:

```text
Treat the AIRI clone inside this repository as authoritative.

Before coding:
- locate the AIRI checkout;
- record its git revision;
- inspect its package manifests;
- inspect its local stage-ui-live2d implementation;
- inspect its current exports;
- inspect its model-driver-lipsync implementation;
- inspect any local modifications.

Never replace user modifications with upstream source.
```

The upstream version I inspected exposes exactly the pieces we want, but the local checkout determines actual integration details. AIRI's current Live2D component takes `mouthOpenSize`/`nowSpeaking` and already incorporates blink, idle, eye focus and expressions. ([GitHub][3])

---

# 10. Subagent 1 — Protocol Architect

Run after Cartographer.

Context:

```text
docs/avatar/repository-reuse-map.md

existing:
ConversationController interfaces
GuildVoiceSession
turn IDs
playback interface

NO full AIRI implementation
NO Gemini implementation
NO ASR code
```

### Ownership

Only:

```text
packages/discord-avatar-protocol/**
docs/avatar/protocol.md
```

Define:

```text
AvatarStateSnapshot
AvatarEvent
PublisherHello
ViewerHello
StateSubscribe
StateUnsubscribe
Heartbeat
ErrorResponse
```

Use something already standard in your repository—likely Zod if available—rather than adding a redundant schema package.

---

# 11. Every event needs identity

All events need:

```text
guildId
channelId
sequence
timestamp
```

Speech-specific events also need:

```text
turnId
ttsChunkId
```

Example:

```json
{
  "type": "avatar.speaking.start",
  "guildId": "123",
  "channelId": "456",
  "turnId": "turn-0174",
  "ttsChunkId": "chunk-2",
  "sequence": 817,
  "mediaTimeMs": 0
}
```

Never identify an avatar session using just `userId`.

The avatar belongs to the guild voice session.

---

# 12. Subagent 2 — Discord Activity Shell

Give it:

```text
discord-avatar-protocol public API

Discord official Activity docs

current repo frontend tooling
```

Do **not** give it Discord audio internals.

### Create

```text
apps/discord-activity-live2d/
├── src/
│   ├── main.ts
│   ├── App.vue
│   ├── discord/
│   │   ├── sdk.ts
│   │   ├── auth.ts
│   │   └── channel.ts
│   ├── avatar/
│   │   ├── avatar-client.ts
│   │   └── avatar-store.ts
│   └── views/
│       └── StageView.vue
├── package.json
└── vite.config.ts
```

Use:

```text
@discord/embedded-app-sdk
```

---

# 13. Activity bootstrap

The Activity should:

```text
instantiate DiscordSDK
       ↓
await ready()
       ↓
obtain guildId/channelId
       ↓
authenticate where required
       ↓
connect AvatarClient
       ↓
subscribe guildId/channelId
       ↓
mount AIRI Live2D
```

Discord's Activity SDK can retrieve the current channel and connected Activity participants. ([Discord Docs][5])

Don't derive the channel from a URL query parameter when Discord can provide the authoritative channel.

---

# 14. Activity layout

Design the Activity specifically for Live2D, not like a normal web page.

Full mode:

```text
┌─────────────────────────────────┐
│                                 │
│            LIVE2D               │
│                                 │
│                                 │
│                                 │
│            AIRI                 │
│                                 │
│                                 │
│ status: listening               │
└─────────────────────────────────┘
```

Compact/PIP mode:

```text
┌──────────────────┐
│                  │
│      LIVE2D      │
│                  │
└──────────────────┘
```

No configuration UI during normal operation.

---

# 15. Use Discord Activity PIP behavior

Have the Activity detect Discord layout changes and resize appropriately.

The Embedded App SDK exposes Activity layout-related events, and `setConfig()` can request interactive PIP behavior on supported clients. ([Discord Docs][6])

Codex should implement:

```text
full Activity
grid
PIP
mobile
```

as responsive layout modes rather than assuming 16:9.

---

# 16. Subagent 3 — AIRI Live2D Renderer

This is a different agent from the Activity shell.

Give it only:

```text
AIRI/packages/stage-ui-live2d/**
AIRI/packages/model-driver-lipsync/**
AIRI/package manifests

apps/discord-activity-live2d/src/avatar/**
protocol AvatarStateSnapshot
```

Do not give:

* Discord bot audio handling;
* ASR;
* Gemini;
* GPT-SoVITS implementation.

### Goal

Create a thin wrapper:

```text
DiscordLive2DStage.vue
```

around AIRI's existing:

```text
Live2D.vue
```

Something conceptually equivalent to:

```vue
<Live2D
  :model-src="modelSrc"
  :model-id="modelId"
  :mouth-open-size="avatar.mouthOpen"
  :now-speaking="avatar.speaking"
/>
```

Not a fork.

---

# 17. Do not duplicate AIRI animation logic

Explicit Codex instruction:

```text
Do not reimplement:
- auto blink
- eye movement
- idle eye focus
- idle animation
- Live2D parameter writes
- mouth release blending
- model loading
- expression stacking

unless repository inspection proves a required API cannot be reused.
```

AIRI already layers expressions and lip-sync into its per-frame motion pipeline. ([GitHub][4])

---

# 18. Model distribution

The Activity must be able to load the Live2D asset.

Do not reference:

```text
C:\Users\me\AIRI\models\...
```

from a browser.

Choose one of these after Cartographer inspects the model setup:

### Recommended

Package the selected model with the Activity's deployable assets:

```text
apps/discord-activity-live2d/public/models/airi/
```

if its license permits redistribution.

### Alternative

Serve model assets through the same Activity public service:

```text
/assets/live2d/{modelId}/...
```

Do not expose arbitrary filesystem paths.

And preserve whatever Cubism/model licensing requirements apply to the particular model.

---

# 19. Subagent 4 — Avatar Relay

Context:

```text
discord-avatar-protocol/**
deployment architecture
nothing from AIRI renderer except event types
```

Create:

```text
services/discord-avatar-relay/
```

Responsibilities:

```text
bot publisher connection
viewer Activity connections
session registry
state snapshots
event fanout
authentication
rate limiting
heartbeats
```

No model rendering.

No audio.

No Gemini.

---

# 20. Relay topology

Use:

```text
Bot
 └── WSS publish
       ↓
AvatarRelay
       ↓
 ┌─────┼─────┐
 ▼     ▼     ▼
A     B     C
Activity clients
```

A bot event should be broadcast to every Activity viewer subscribed to:

```text
guildId + channelId
```

---

# 21. Don't send animation frames at render FPS

Live2D might render at:

```text
60 FPS
```

Do not send:

```text
60 websocket messages/sec
```

for every property.

Mouth movement only needs around:

```text
20–25 updates/sec
```

AIRI's own browser lip-sync helper defaults to recalculating mouth openness at 40 ms intervals, about 25 FPS, with 120 ms smoothing. ([GitHub][7])

So use:

```env
AVATAR_MOUTH_HZ=25
```

The browser interpolates between samples.

---

# 22. Relay keeps only the latest mouth sample

If a client is slow:

```text
mouth=.20
mouth=.28
mouth=.41
mouth=.63
mouth=.51
```

don't queue all five.

Replace unsent mouth frames with:

```text
mouth=.51
```

Motion and expression events are different—they must remain ordered.

So classify events:

### Lossy/coalescible

```text
mouth
look target
continuous pose
```

### Reliable/ordered

```text
speaking start
speaking end
motion play
expression set
expression clear
reset
```

---

# 23. Relay security

Use two distinct authentication paths.

Bot publisher:

```text
AVATAR_RELAY_PUBLISH_TOKEN
```

or, better:

```text
HMAC signed publisher handshake
```

Activity viewer:

authenticate using the Discord Activity flow.

Never put:

```text
DISCORD_TOKEN
GEMINI_API_KEY
AVATAR_RELAY_PUBLISH_TOKEN
```

into Activity frontend JavaScript.

---

# 24. Don't trust client-provided guild IDs

The Activity may say:

```json
{
  "guildId": "123",
  "channelId": "456"
}
```

That should not automatically authorize a subscription.

Use the Activity authentication/session information to constrain what channel it can subscribe to.

The exact mechanism should follow the current Embedded App SDK/auth flow found in your installed SDK version.

---

# 25. Subagent 5 — Bot Avatar Publisher

Give this agent:

```text
existing ConversationController
existing TTS provider
existing Discord playback
GuildVoiceSession
turnId logic

protocol package
```

Do not give it AIRI renderer internals.

Create:

```text
services/discord-bot/src/avatar/
├── avatar-publisher.ts
├── avatar-session.ts
├── mouth-track.ts
├── playback-clock.ts
└── types.ts
```

---

# 26. Hook into existing lifecycle

The publisher should receive lifecycle events from the pipeline you've already built:

```text
human speaking
      ↓
avatar = listening

ASR complete / Gemini begins
      ↓
avatar = thinking

TTS begins playing
      ↓
avatar = speaking

TTS ends
      ↓
avatar = idle
```

That lets animation function independently from the exact providers.

---

# 27. Do not make the AvatarPublisher know Gemini

It should receive generic calls:

```ts
avatar.setBehavior('thinking')

avatar.startSpeech({
  turnId,
  chunkId,
  audio
})

avatar.stopSpeech({
  turnId
})

avatar.playExpression('happy')
```

Not:

```ts
avatar.onGeminiToken(...)
```

Same provider-independence as the previous architecture.

---

# 28. Lip-sync architecture

There are two levels.

## V1 — recommended

Derive a mouth envelope directly from the same PCM used for Discord playback.

```text
GPT-SoVITS output
       │
       ├──────────→ Discord encoder/player
       │
       └──────────→ PCM analyzer
                         ↓
                    25 Hz envelope
                         ↓
                    mouthOpen 0..1
```

Advantages:

* no duplicate audio download;
* no browser audio playback;
* no microphone permissions;
* correct TTS source;
* tiny bandwidth;
* simple.

---

# 29. Mouth analyzer

For each 40 ms PCM window:

```text
PCM samples
    ↓
RMS / peak energy
    ↓
noise floor
    ↓
compress nonlinear range
    ↓
clamp 0..1
    ↓
attack/release smoothing
```

Model it after AIRI's existing defaults.

AIRI's lip-sync helper uses:

```text
volume scale = 0.9
volume exponent = 0.7
update interval = 40 ms
smoothing window = 120 ms
```

as its defaults. ([GitHub][7])

Those are good initial tuning references even if the Node analyzer isn't running the exact browser AudioWorklet.

---

# 30. V2 — exact AIRI wLipSync fidelity

If you later want AIRI's phoneme-aware analysis rather than amplitude-only mouth movement, AIRI's `model-driver-lipsync` wraps wLipSync and extracts AEIOU weights plus a scalar mouth-open value from an `AudioNode`. ([GitHub][7])

Then investigate:

```text
TTS audio
  ↓
low-bitrate synchronized media stream
  ↓
Activity WebAudio AudioNode
  ↓
AIRI createLive2DLipSync()
```

But do **not** make this milestone 1.

It adds:

* duplicated TTS network transport;
* client audio buffering;
* additional synchronization;
* Activity browser audio policy concerns.

Amplitude-driven `mouthOpenSize` already uses AIRI's actual final Live2D mouth parameter pipeline.

---

# 31. Synchronization is the hard part

Audio follows:

```text
your PC
 ↓
Discord voice infrastructure
 ↓
listener
```

Avatar data follows:

```text
your PC
 ↓
relay
 ↓
Activity iframe
```

They have different latency.

Therefore do not publish mouth frames solely as "apply immediately."

Each speech run gets:

```text
playbackEpoch
turnId
chunkId
mediaTimeMs
```

Example:

```json
{
  "type": "avatar.mouth",
  "turnId": "abc",
  "ttsChunkId": "3",
  "mediaTimeMs": 840,
  "value": 0.68
}
```

---

# 32. Client-side animation jitter buffer

Activity maintains a small playback buffer:

```text
incoming events
      ↓
100–250 ms jitter buffer
      ↓
interpolated animation clock
      ↓
Live2D
```

Initial configuration:

```env
AVATAR_ANIMATION_DELAY_MS=180
```

Make it tunable.

Don't hardcode it.

You will calibrate based on actual Discord audio latency.

---

# 33. Synchronize to actual Discord playback, not TTS generation

Do not say:

```text
GPT-SoVITS returned audio
    → speaking.start
```

Audio could wait in the Discord playback queue.

Instead:

```text
audio resource begins AudioPlayer playback
       ↓
speaking.start(epoch)
```

And:

```text
AudioPlayer Idle
       ↓
speaking.stop
```

That lifecycle should already exist somewhere in your completed voice bot.

The Cartographer locates it.

---

# 34. Streaming TTS chunks need one continuous timeline

If Gemini creates:

```text
TTS chunk 1: "Sure."
TTS chunk 2: "Here's how it works."
TTS chunk 3: "First..."
```

don't reset the avatar to idle between every chunk.

Maintain:

```text
SpeechRun
    turnId
    chunks[]
    continuous playback clock
```

Only emit:

```text
speaking.stop
```

when:

* final queued chunk is exhausted, or
* playback is aborted.

---

# 35. Barge-in handling

Your existing bot supports interruption.

Add:

```text
Bot speaking
      ↓
user interrupts
      ↓
Discord AudioPlayer stopped
      ↓
current TTS aborted
      ↓
AvatarPublisher:
   cancel SpeechRun
   mouth=0
   speaking=false
   behavior=listening
```

Send `avatar.resetSpeech` immediately so Activity clients don't keep animating buffered mouth frames.

---

# 36. Subagent 6 — Motion & Expression Director

Do this only after basic Live2D + mouth sync works.

Context:

```text
AIRI motion/expression APIs
Avatar protocol
ConversationController public events
Gemini BrainResult contract
```

Not:

```text
Discord voice receive
ASR internals
relay internals
```

Create:

```text
services/discord-bot/src/avatar/
└── avatar-director.ts
```

---

# 37. First implement deterministic behavior

Do not immediately ask Gemini to control every animation.

Start with:

```text
idle       → AIRI idle motion
listening  → attentive pose
thinking   → thinking expression/motion
speaking   → speaking idle variant
interrupted→ surprised/listening transition
```

Then add emotional cues.

This makes bugs reproducible.

---

# 38. Reuse AIRI's idle behavior

AIRI already advertises and implements Live2D:

* auto blink;
* auto look;
* idle eye movement;
* model animation.

([GitHub][8])

Leave those locally autonomous.

You don't need the bot to broadcast:

```text
blink now
look left
blink now
look right
```

That would be pointless state traffic.

Each Activity renderer should generate those using AIRI itself.

---

# 39. What should cross the network

Send only high-level intent:

```text
speaking=true
mouth=.43

expression=happy
motion=wave

behavior=thinking
focus=speaker
```

Let AIRI solve the frame-by-frame animation.

This is an important architecture boundary.

---

# 40. Follow the current speaker

A nice later enhancement:

When Discord detects:

```text
Alice speaking
```

publish:

```json
{
  "type": "avatar.attention",
  "targetUserId": "alice"
}
```

The Activity SDK itself can expose voice-related speaking events to subscribed applications, including `SPEAKING_START` and `SPEAKING_STOP`. ([Discord Docs][6])

However, you already have speaker state in the bot.

For v1, make the bot authoritative so there aren't two independent speaking-state systems.

---

# 41. Gemini emotion cues: V2

Don't embed animation syntax into spoken output like:

```text
[happy][wave] That's wonderful!
```

Instead evolve your brain result to:

```ts
interface BrainResponseMetadata {
  emotion?: 'neutral' | 'happy' | 'sad' | 'surprised' | 'thinking'
  gesture?: 'none' | 'nod' | 'wave' | 'emphasis'
}
```

Keep:

```text
spoken text
```

separate from:

```text
avatar direction
```

If your Gemini provider already supports structured outputs, this can later be generated as a sidecar.

---

# 42. Don't let Gemini specify raw Live2D parameter values

Bad:

```json
{
  "ParamAngleX": 21.7,
  "ParamEyeLOpen": 0.2
}
```

Good:

```json
{
  "emotion": "happy",
  "gesture": "nod"
}
```

The AvatarDirector maps semantic cues to known-safe AIRI motions and expressions.

That keeps model-specific animation knowledge out of the LLM.

---

# 43. Subagent 7 — Discord Launch Integration

Context:

```text
existing bot commands
Activity app configuration
protocol public API
```

Goal:

make Activity discoverable alongside the voice bot.

Discord automatically provides a default Entry Point command when Activities are enabled, and Activities can be launched inside voice/text channels from the App Launcher. ([Discord Docs][5])

I would initially use:

```text
/summon
```

for audio bot connection and Discord's Activity:

```text
Launch
```

for avatar display.

---

# 44. Don't try to force-open the Activity

A Discord bot should not assume it can silently force every participant to open the UI.

The intended flow is:

```text
User joins voice channel
        ↓
/summon
        ↓
Bot joins audio

User launches AIRI Activity
        ↓
AIRI avatar appears

Other users join Activity
        ↓
same synchronized avatar state
```

The Activity can provide invite/share affordances for others.

---

# 45. Later UX optimization

Once it works, investigate a custom:

```text
/airi
```

entry-point interaction that:

1. ensures the voice bot is summoned;
2. launches the Activity.

Discord supports an Activity Entry Point/launch interaction flow, but Codex should verify the current `discord.js` interaction API before changing your already-working `/summon`. ([Discord Docs][5])

Don't destabilize `/summon` just for cleaner UX.

---

# 46. Subagent 8 — Integration Agent

This agent receives handoffs, **not every previous agent's full context**.

Give it:

```text
docs/avatar/architecture.md

docs/handoffs/
├── repository.md
├── protocol.md
├── activity.md
├── renderer.md
├── relay.md
├── publisher.md
├── director.md
└── launch.md
```

and the public interfaces.

Its job is strictly:

```text
connect pieces
resolve type mismatches
configuration plumbing
run integrated tests
```

Not redesign.

---

# 47. Subagent 9 — QA / Sync / Performance

Context:

```text
architecture
public interfaces
test commands
integrated implementation
```

Test matrix:

### Rendering

```text
Activity opens
model loads
idle works
blink works
eye animation works
resize works
PIP works
```

### Speech

```text
English TTS
Japanese TTS
Mandarin TTS
```

The lip-sync method itself is language-independent when driven by audio amplitude.

---

# 48. Speech synchronization tests

Generate deterministic TTS fixture:

```text
1 second silence
"one"
500 ms silence
"two"
500 ms silence
"three"
```

Record both:

```text
Discord audio
Activity screen
```

Measure visible mouth/audio offset.

Tune:

```text
AVATAR_ANIMATION_DELAY_MS
```

Don't tune by code intuition alone.

---

# 49. Multi-viewer test

Test:

```text
Desktop client A
Desktop client B
Browser client
Mobile client
```

All should see approximately the same:

```text
expression
motion
speaking state
```

Exact mouth frames can differ by a frame or two.

That's acceptable.

---

# 50. Reconnection cases

Test all of these:

```text
Activity refresh
relay restart
bot reconnect
voice disconnect
voice channel move
Activity joins while bot is already talking
Activity joins while idle
TTS aborted
Gemini error
GPT-SoVITS error
```

A snapshot message should recover visual state after reconnection.

---

# 51. Performance targets

Live2D:

```text
desktop: 60 FPS target
mobile: 30 FPS acceptable
```

Mouth events:

```text
20–25 Hz
```

Relay:

```text
<100 ms typical state propagation
```

Avatar state bandwidth should remain tiny—generally orders of magnitude lower than video.

---

# 52. Browser render budget

AIRI already has settings for:

```text
max FPS
render scale
```

exposed in the Live2D component's configuration path. ([GitHub][3])

Have the Discord wrapper select defaults depending on layout:

```text
Full:
60fps
1.0 render scale

PIP:
30fps
0.75 render scale

Mobile:
30fps
0.75 render scale
```

Avoid wasting GPU rendering a tiny PIP avatar at full resolution.

---

# 53. Logging

Use the same `turnId` that already follows:

```text
ASR → Gemini → TTS
```

and extend it through the avatar layer.

Logs:

```text
turnId
guildId
channelId

ttsChunkId

discordPlaybackStart
avatarSpeakingPublish

mouthSamplesGenerated
mouthSamplesPublished
mouthSamplesDropped

relayPublishLatency
activityReceiveLatency

avatarSpeechEnd
```

This makes A/V desync debuggable.

---

# 54. Shared context document

Create:

```text
docs/avatar/architecture.md
```

before specialist agents begin.

Keep it around 3–5 pages, containing only:

```text
Goal
Discord Activity constraint
target architecture
component responsibilities
wire protocol overview
state machine
A/V synchronization rules
security boundaries
file ownership
non-goals
definition of done
```

Every subagent reads that.

---

# 55. Context distribution

Use this matrix.

| Agent            |           Discord bot |               AIRI Live2D |   Activity docs |       Relay |     Gemini/TTS |
| ---------------- | --------------------: | ------------------------: | --------------: | ----------: | -------------: |
| Cartographer     |              relevant |                  relevant |              no |          no |     interfaces |
| Protocol         |            interfaces |                        no |         minimal |    concepts |             no |
| Activity shell   |                    no |                        no |        **full** |  client API |             no |
| Live2D renderer  |                    no | **full relevant subtree** |         minimal |    protocol |             no |
| Relay            |                    no |                        no |       auth only |    **full** |             no |
| Avatar publisher | **playback/TTS only** |                        no |              no |  client API |  TTS interface |
| Director         |       controller only |               motion APIs |              no |    protocol | brain metadata |
| Launch           |         commands only |                        no | **launch docs** |          no |             no |
| Integration      |     public interfaces |                 summaries |       summaries |   summaries |      summaries |
| QA               |        integrated app |               public APIs |      test facts | public APIs |       fixtures |

That keeps subagent contexts specialized.

---

# 56. Handoff contract

Every subagent writes:

```text
docs/handoffs/avatar/<agent>.md
```

with exactly:

```text
Files changed

Public interfaces

Behavior implemented

Configuration added

Assumptions

Known limitations

Tests executed

Integration steps
```

No long reasoning transcript.

Integration should consume those handoffs instead of rediscovering the entire codebase.

---

# 57. File ownership prevents merge conflicts

Assign ownership.

### Protocol agent

```text
packages/discord-avatar-protocol/**
```

### Activity agent

```text
apps/discord-activity-live2d/src/discord/**
```

### Live2D agent

```text
apps/discord-activity-live2d/src/live2d/**
```

### Relay agent

```text
services/discord-avatar-relay/**
```

### Publisher agent

```text
services/discord-bot/src/avatar/publisher*
services/discord-bot/src/avatar/mouth*
services/discord-bot/src/avatar/playback*
```

### Director agent

```text
services/discord-bot/src/avatar/director*
```

Only the Integration agent should touch shared bootstrap/config files after parallel work finishes.

---

# 58. Execution graph

Have Codex run agents like this:

```text
                ┌────────────────┐
                │  Cartographer  │
                └───────┬────────┘
                        ↓
                Architecture brief
                        ↓
                 Protocol Agent
                        │
       ┌────────────────┼─────────────────┐
       ↓                ↓                 ↓
 Activity Shell      Relay             Publisher
       │                                  │
       ↓                                  │
 Live2D Renderer                          │
       │                                  │
       └──────────────┬───────────────────┘
                      ↓
               Motion Director
                      ↓
               Launch Integration
                      ↓
              Integration Agent
                      ↓
                 QA / Sync
```

Do not run the renderer before the Cartographer and protocol tasks.

---

# 59. Phase 1 definition of done

First milestone has **no mouth animation**.

Only:

```text
Discord Activity launches
       ↓
actual AIRI Live2D model renders
       ↓
auto blink works
       ↓
idle movements work
       ↓
responsive layout works
```

Prove AIRI can run inside the Activity sandbox first.

---

# 60. Phase 2

Relay:

```text
bot:
avatar.setBehavior("thinking")
```

Activity changes visible state.

Test manual events:

```text
idle
listening
thinking
speaking
```

No TTS integration yet.

---

# 61. Phase 3

Wire speech boundaries:

```text
Discord playback starts
       ↓
nowSpeaking=true

Discord playback stops
       ↓
nowSpeaking=false
```

At this stage, mouth may simply open at:

```text
0.4
```

constantly while talking.

This proves lifecycle synchronization separately from PCM analysis.

---

# 62. Phase 4

Add real mouth envelope:

```text
GPT-SoVITS PCM
 ↓
mouth-track.ts
 ↓
25 Hz samples
 ↓
relay
 ↓
mouthOpenSize
 ↓
AIRI ParamMouthOpenY
```

This is when the avatar should start looking convincingly alive.

---

# 63. Phase 5

Expressions/motions:

```text
thinking
happy
surprised
emphasis
```

First deterministic.

Then optional Gemini metadata.

---

# 64. Phase 6

Improve A/V synchronization:

```text
playback epoch
relative media timestamps
jitter buffer
interpolation
configurable delay
```

Do this after functionality, not before.

---

# 65. Phase 7

Production deployment:

```text
Activity assets public
Relay public WSS
TLS
Discord URL mappings
publisher authentication
viewer authentication
rate limits
health endpoints
```

During local development Discord explicitly requires a publicly reachable mapped URL for Activity content, which is why a tunnel is convenient. ([Discord Docs][5])

---

# 66. Environment additions

Something like:

```env
# Avatar
AVATAR_ENABLED=true
AVATAR_RELAY_URL=wss://avatar.example.com/ws
AVATAR_RELAY_PUBLISH_TOKEN=

AVATAR_MOUTH_HZ=25
AVATAR_ANIMATION_DELAY_MS=180

# Activity
DISCORD_ACTIVITY_CLIENT_ID=
DISCORD_ACTIVITY_REDIRECT_URI=

# Live2D
LIVE2D_MODEL_ID=airi-default
LIVE2D_MAX_FPS=60
LIVE2D_RENDER_SCALE=1
```

Relay:

```env
PORT=8080
PUBLIC_BASE_URL=
PUBLISH_SECRET=
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
```

Never commit secrets.

---

# 67. Explicit non-goals for Codex

Put this verbatim in its architecture brief:

```text
DO NOT:

- implement undocumented Discord bot-camera RTP;
- automate a normal Discord user account;
- build a self-bot;
- replace @discordjs/voice;
- encode Live2D into H264/VP8 for milestone 1;
- stream rendered video frames through the relay;
- rewrite AIRI's Live2D renderer;
- duplicate AIRI blink/idle/eye animation;
- send raw Live2D parameter maps from Gemini;
- expose bot/Gemini secrets to the Activity;
- expose the user's local filesystem;
- expose GPT-SoVITS publicly;
- send microphone/STT audio to the avatar relay;
- let Activity clients publish authoritative avatar state;
- make every viewer run its own independent conversation state;
- add exact wLipSync audio duplication before basic mouth-envelope sync works;
- overwrite unrelated local AIRI changes.
```

Also, automating a normal Discord user account as a workaround for camera streaming would violate Discord's self-bot policy, so that should not be used as an escape hatch.

---

# 68. Final definition of done

I would require all of this before considering the feature complete:

* Existing Discord voice bot still functions unchanged.
* Existing Qwen/Gemini/GPT-SoVITS loop still works.
* AIRI Activity launches in the same voice channel.
* Actual AIRI Live2D renderer is reused rather than recreated.
* Correct Live2D model loads.
* Auto blink works.
* Idle eye movement works.
* Idle model motions work.
* Activity resizes cleanly.
* Compact/PIP presentation is usable.
* Bot's `listening` state reaches Activity.
* `thinking` state reaches Activity.
* `speaking` state reaches Activity.
* GPT-SoVITS audio produces mouth movement.
* Mouth closes correctly after playback.
* Multiple TTS chunks look like one continuous utterance.
* Barge-in immediately cancels stale lip animation.
* Expression changes work.
* Motion triggers work.
* Two viewers see the same major avatar state.
* Late Activity join receives a current snapshot.
* Relay reconnect restores state.
* Bot reconnect restores state.
* State is isolated between two guilds.
* State is isolated between two voice channels.
* No Discord/Gemini secrets are present in browser bundles.
* No raw speech audio goes through the relay.
* No transcript is sent to Activity unless deliberately enabled.
* Activity frontend builds.
* Discord bot typecheck/tests still pass.
* Relay tests pass.
* A/V offset is measured and configurable.

## The architecture I would choose

The key decision is:

```text
NOT:

AIRI Live2D
   ↓
render video
   ↓
encode video
   ↓
pretend bot has camera
   ↓
Discord video RTP
```

Instead:

```text
             existing local bot
                    │
       ┌────────────┴────────────┐
       │                         │
GPT-SoVITS audio           avatar state
       │                         │
       ▼                         ▼
Discord voice              tiny WSS relay
                                 │
                                 ▼
                         Discord Activity
                                 │
                                 ▼
                       AIRI Live2D renderer
                           locally rendered
```

This reuses AIRI in the place where AIRI is strongest: **browser-side graphics and animation**. AIRI itself explicitly leans heavily on browser technologies such as WebGPU/WebAudio/WebWorkers/WebAssembly and already supports browser/PWA rendering, which makes a Discord Activity much more natural than turning AIRI into a server-side video encoder. ([GitHub][8])

The first Codex milestone I would authorize is therefore only:

> **Get the existing AIRI `Live2D.vue` rendering correctly inside a Discord Activity in the same voice channel.**

Once that is stable, add relay state, then speech boundaries, then PCM-derived mouth motion, then expressions/motions, and only afterward spend time tuning sub-200-ms A/V synchronization.

[1]: https://docs.discord.com/developers/topics/voice-connections "Voice - Documentation - Discord"
[2]: https://docs.discord.com/developers/platform/activities "Activities - Documentation - Discord"
[3]: https://github.com/moeru-ai/airi/blob/main/packages/stage-ui-live2d/src/components/scenes/Live2D.vue "airi/packages/stage-ui-live2d/src/components/scenes/Live2D.vue at main · moeru-ai/airi · GitHub"
[4]: https://github.com/moeru-ai/airi/blob/main/packages/stage-ui-live2d/src/composables/live2d/motion-manager.ts "airi/packages/stage-ui-live2d/src/composables/live2d/motion-manager.ts at main · moeru-ai/airi · GitHub"
[5]: https://docs.discord.com/developers/activities/building-an-activity "Building Your First Activity in Discord - Documentation - Discord"
[6]: https://docs.discord.com/developers/developer-tools/embedded-app-sdk "Embedded App SDK Reference - Documentation - Discord"
[7]: https://github.com/moeru-ai/airi/blob/main/packages/model-driver-lipsync/src/live2d/index.ts "airi/packages/model-driver-lipsync/src/live2d/index.ts at main · moeru-ai/airi · GitHub"
[8]: https://github.com/moeru-ai/airi/blob/main/README.md?utm_source=chatgpt.com "airi/README.md at main · moeru-ai/airi · GitHub"
