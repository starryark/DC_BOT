# Discord Live2D Activity architecture

## Goal

Render AIRI's existing Live2D scene inside a Discord Activity in the same channel
as the voice bot. Phase 1 proves model loading, idle motion, auto blink, resize,
grid, mobile, and interactive PIP behavior without changing the voice pipeline.

## Constraint and target architecture

Discord bots do not have a documented camera-video API. The avatar is therefore
rendered locally in an Activity iframe:

`Discord bot audio → Discord voice`

`bot avatar intent → relay (later phase) → Activity → AIRI Live2D`

Phase 1 contains only the final Activity and renderer edge. The Activity obtains
guild/channel identity from the Embedded App SDK, never from URL parameters.

## Responsibilities

- `apps/discord-activity-live2d/src/discord`: Discord SDK lifecycle and layout.
- `apps/discord-activity-live2d/src/live2d`: thin AIRI renderer adapter.
- `apps/discord-activity-live2d/src/views`: responsive Activity presentation.
- `packages/stage-ui-live2d`: owns loading, animation, blink, gaze, and Live2D
  parameter writes.
- Later relay and bot publisher components own synchronized semantic state.

## State and synchronization

The persistent future state is behavior, speaking, expression, and active motion.
Mouth samples and one-shot motion events are transient. A later relay must send a
current snapshot to late joiners and isolate state by guild and voice channel.
Audio playback start—not TTS generation—will define the animation epoch.

## Security boundaries

The browser bundle may contain the public Discord client ID, but never Discord bot,
Gemini, relay publisher, or TTS secrets. The Activity must not read arbitrary local
paths. Model assets are deployable static assets with verified redistribution
rights. Activity viewers will not publish authoritative avatar state.

## Non-goals

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

## Phase 1 definition of done

The frontend builds, connects to the Discord host when configured, requests
interactive PIP, follows focused/grid/PIP layout updates, and mounts the actual
AIRI Live2D component. A licensed model must be supplied at
`VITE_LIVE2D_MODEL_URL` before visual runtime acceptance testing.
