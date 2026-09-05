export type { GuildVoiceSession, UserCaptureSession, VoiceManagerEvents, VoiceUtterance } from '../../../voice/types'
// The VoiceManager has been extracted to src/voice/voice-manager.ts and
// refactored into a pure voice transport (it no longer knows about STT or the
// AIRI server). It is re-exported here so the existing command-barrel import
// path (`../bots/discord/commands`) keeps working.
//
// See `src/voice/voice-manager.ts` for the implementation and
// `src/voice/types.ts` for the `utterance` / `bargeIn` events the transport
// now emits instead of calling `openaiTranscribe` / `airiClient.send` directly.
export { VoiceManager } from '../../../voice/voice-manager'
