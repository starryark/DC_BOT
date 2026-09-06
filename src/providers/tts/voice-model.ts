import type { VoiceModelBridge } from '../../voice/model-bridge'
import type { TtsProvider, TtsRequest } from './types'

/** Preserve the immutable authority captured for this response, never a guild's latest lease. */
export class VoiceModelTtsProvider implements TtsProvider {
  constructor(private readonly bridge: VoiceModelBridge) {}

  async synthesize(request: TtsRequest, signal: AbortSignal) {
    const authority = request.authority
    if (!authority || request.trace?.guildId !== authority.guild_id)
      throw new Error('Speech needs a matching authorized Discord room revision')
    return this.bridge.synthesize(authority, request.text, request.language, signal, request.prosody)
  }
}
