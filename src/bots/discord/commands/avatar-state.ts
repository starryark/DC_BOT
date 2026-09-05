import type { CacheType, ChatInputCommandInteraction, GuildMember } from 'discord.js'

import { parseBehavior } from '@proj-airi/discord-avatar-protocol'
import { PermissionFlagsBits } from 'discord.js'

import { config } from '../../../config'
import { getServices } from '../../../services'

export async function handleAvatarState(interaction: ChatInputCommandInteraction<CacheType>): Promise<void> {
  if (!config().avatar.debugCommandEnabled) {
    await interaction.reply({ content: 'Avatar state preview is disabled.', ephemeral: true })
    return
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: 'Manage Server permission is required.', ephemeral: true })
    return
  }
  const guildId = interaction.guildId
  if (!guildId) {
    await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true })
    return
  }
  const services = getServices()
  const channelId = services.avatar.activeChannel(guildId)
  let member = interaction.member
  if (!member || !('voice' in member)) {
    try {
      member = await interaction.guild?.members.fetch(interaction.user.id) ?? null
    }
    catch {
      await interaction.reply({ content: 'Unable to verify your voice channel.', ephemeral: true })
      return
    }
  }
  const memberChannelId = (member as GuildMember | null)?.voice.channelId
  if (!channelId || memberChannelId !== channelId) {
    await interaction.reply({ content: 'Join the bot’s current voice channel first.', ephemeral: true })
    return
  }
  let behavior
  try {
    behavior = parseBehavior(interaction.options.getString('behavior', true))
  }
  catch {
    await interaction.reply({ content: 'Invalid avatar behavior.', ephemeral: true })
    return
  }
  if (services.avatar.activeChannel(guildId) !== channelId
    || !services.avatar.setBehavior(guildId, channelId, behavior)) {
    await interaction.reply({ content: 'The avatar session changed; try again.', ephemeral: true })
    return
  }
  await interaction.reply({ content: `Avatar behavior set to **${behavior}**.`, ephemeral: true })
}
