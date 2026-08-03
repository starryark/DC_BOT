import { REST, Routes, SlashCommandBuilder } from 'discord.js'

import { config } from '../../../config'

export * from './avatar-state'
export * from './memory'
export * from './ping'
export * from './summon'
export * from './voice-test'

export async function registerCommands(token: string, clientId: string) {
  const rest = new REST()
  rest.setToken(token)
  const body = [
    new SlashCommandBuilder().setName('ping').setDescription('Replies with Pong!'),
    new SlashCommandBuilder().setName('summon').setDescription('Summons the bot to your voice channel'),
    new SlashCommandBuilder().setName('leave').setDescription('Makes the bot leave its current voice channel'),
    new SlashCommandBuilder()
      .setName('memory')
      .setDescription('Manage your memory in the current room')
      .addSubcommand(sub => sub.setName('status').setDescription('Show memory status'))
      .addSubcommand(sub => sub.setName('show').setDescription('Show your active facts in this room'))
      .addSubcommand(sub => sub.setName('export').setDescription('Export your memory from this room'))
      .addSubcommand(sub => sub.setName('forget').setDescription('Forget your data in this room'))
      .addSubcommand(sub => sub.setName('remember').setDescription('Remember an explicit fact').addStringOption(opt => opt.setName('key').setDescription('Fact name').setRequired(true)).addStringOption(opt => opt.setName('value').setDescription('Fact value').setRequired(true)))
      .addSubcommand(sub => sub.setName('correct').setDescription('Correct an existing fact').addStringOption(opt => opt.setName('fact').setDescription('Fact ID shown by /memory show').setRequired(true)).addStringOption(opt => opt.setName('value').setDescription('Replacement value').setRequired(true))),
    new SlashCommandBuilder()
      .setName('voice-test')
      .setDescription('Speak given text via GPT-SoVITS (Kurisu). Test TTS without ASR/Gemini.')
      .addStringOption(opt =>
        opt.setName('text').setDescription('Text to speak').setRequired(true),
      )
      .addStringOption(opt =>
        opt.setName('language')
          .setDescription('Language hint (defaults to auto-detect)')
          .addChoices(
            { name: 'Japanese', value: 'ja' },
            { name: 'Chinese', value: 'zh' },
            { name: 'English', value: 'en' },
            { name: 'Auto (let GPT-SoVITS detect per segment)', value: 'auto' },
          )
          .setRequired(false),
      ),
  ]
  if (config().avatar.debugCommandEnabled) {
    body.push(
      new SlashCommandBuilder()
        .setName('avatar-state')
        .setDescription('Preview an AIRI avatar behavior')
        .setDefaultMemberPermissions('32')
        .addStringOption(opt => opt
          .setName('behavior')
          .setDescription('Behavior to display')
          .setRequired(true)
          .addChoices(
            { name: 'Idle', value: 'idle' },
            { name: 'Listening', value: 'listening' },
            { name: 'Thinking', value: 'thinking' },
            { name: 'Speaking', value: 'speaking' },
          )),
    )
  }
  await rest.put(
    Routes.applicationCommands(clientId),
    { body },
  )
}
