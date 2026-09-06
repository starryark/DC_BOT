import type { CacheType, ChatInputCommandInteraction } from 'discord.js'

import type { GptSoVitsLang } from '../../../providers/tts/types'

import { useLogg } from '@guiiai/logg'

import { config } from '../../../config'
import { resolveTtsLanguage } from '../../../providers/tts/language'
import { tryGetServices } from '../../../services'

const log = useLogg('VoiceTest').useGlobalConfig()

/**
 * `/voice-test` — standalone TTS test (plan.md §47). Synthesizes given text
 * and plays it into the caller's voice channel, without involving ASR or
 * Gemini. Used to verify the Kurisu voice + GPT-SoVITS path independently.
 *
 * Usage: `/voice-test language:ja text:"こんにちは。"`
 *        `/voice-test text:"你好, hello, こんにちは" language:auto`
 */
export async function handleVoiceTest(interaction: ChatInputCommandInteraction<CacheType>) {
  const services = tryGetServices()
  if (!services) {
    await interaction.reply('TTS services are not initialized.')
    return
  }

  const member = interaction.member
  const voiceChannel = (member as any)?.voice?.channel
  if (!voiceChannel) {
    await interaction.reply('Join a voice channel first, then use `/voice-test`.')
    return
  }

  const text = interaction.options.getString('text', true)
  const langRaw = interaction.options.getString('language')
  // An explicit choice (incl. `auto`) is honored directly; otherwise resolve
  // from the text so `/voice-test` works with no language given.
  const language: GptSoVitsLang = (langRaw as GptSoVitsLang | null)
    ?? resolveTtsLanguage({ text }).language

  await interaction.reply(`Synthesizing (${language}): ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`)

  try {
    // Ensure the bot is in the caller's voice channel.
    if (!services.voice.hasSession(interaction.guildId!)) {
      await interaction.followUp('Bot is not in a voice channel here. Use `/summon` first.')
      return
    }

    if (services.voice.currentChannelId(interaction.guildId!) !== voiceChannel.id) {
      await interaction.followUp('Join the same voice channel as the bot before running this test.')
      return
    }
    if (config().voiceModel.mode === 'active') {
      if (!services.controller)
        throw new Error('Voice controller unavailable')
      await services.controller.testVoice(interaction.guildId!, voiceChannel.id, interaction.user.id, interaction.id, text, language)
      return
    }
    const controller = new AbortController()
    const stream = await services.tts.synthesize({ text, language }, controller.signal)
    await services.voice.playAudioStream(interaction.guildId!, stream)
    log.withFields({ guildId: interaction.guildId, language }).log('voice-test playback started')
  }
  catch (error) {
    log.withError(error).error('voice-test failed')
    await interaction.followUp('Speech synthesis failed. Check the configured voice service.').catch(() => {})
  }
}
