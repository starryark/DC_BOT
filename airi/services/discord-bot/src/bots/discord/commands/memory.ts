import type { CacheType, ChatInputCommandInteraction } from 'discord.js'

import type { IngressActorEvidence } from '../../../memory/discord-actor-snapshot'
import type { PrivacyMemoryAuthority, PrivacyOperation } from '../../../memory/privacy-authority'

import { Buffer } from 'node:buffer'

export async function handleMemory(interaction: ChatInputCommandInteraction<CacheType>, actorEvidence: IngressActorEvidence, privacy?: PrivacyMemoryAuthority): Promise<void> {
  if (!privacy) {
    await interaction.reply({ content: 'Durable memory is disabled.', ephemeral: true })
    return
  }
  await interaction.deferReply({ ephemeral: true })
  try {
    const subcommand = interaction.options.getSubcommand()
    let operation: PrivacyOperation
    if (subcommand === 'remember')
      operation = { kind: 'remember', predicate: interaction.options.getString('key', true), value: interaction.options.getString('value', true) }
    else if (subcommand === 'correct')
      operation = { kind: 'correct', factId: interaction.options.getString('fact', true), value: interaction.options.getString('value', true) }
    else if (subcommand === 'forget')
      operation = { kind: 'forget' }
    else if (subcommand === 'export')
      operation = { kind: 'export' }
    else if (subcommand === 'show')
      operation = { kind: 'show' }
    else operation = { kind: 'status' }
    const result = await privacy.execute({ operation, actorEvidence, discordUserId: interaction.user.id, guildId: interaction.guildId ?? undefined, channelId: interaction.channelId, channelKind: interaction.channel?.isDMBased() ? 'dm' : interaction.channel?.isThread() ? 'thread' : 'guildText', observedAt: interaction.createdTimestamp })
    await interaction.editReply({ content: result.message, ...(result.attachment ? { files: [{ attachment: Buffer.from(result.attachment.data, 'utf8'), name: result.attachment.name }] } : {}) })
  }
  catch (error) {
    await interaction.editReply(`Memory operation failed: ${memoryErrorMessage(error)}`)
  }
}

function memoryErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string')
    return error.message
  return 'unknown error'
}
