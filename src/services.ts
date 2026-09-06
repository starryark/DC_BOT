import type { ConversationController } from './orchestration/conversation-controller'
import type { AvatarPublisher } from './avatar/publisher'
import type { AsrProvider } from './providers/asr/types'
import type { BrainProvider } from './providers/brain/types'
import type { TtsProvider } from './providers/tts/types'
import type { VoiceManager } from './voice/voice-manager'

/**
 * The set of providers + the voice transport, wired together by `index.ts`.
 * Kept as a plain object so the adapter, commands, and controller can share
 * the same instances without a DI framework.
 */
export interface Services {
  controller?: ConversationController
  voice: VoiceManager
  asr: AsrProvider
  brain: BrainProvider
  tts: TtsProvider
  avatar: AvatarPublisher
}

let services: Services | null = null

export function setServices(s: Services): void {
  services = s
}

export function getServices(): Services {
  if (!services)
    throw new Error('Services have not been initialized. Call setServices() at startup.')
  return services
}

export function tryGetServices(): Services | null {
  return services
}
