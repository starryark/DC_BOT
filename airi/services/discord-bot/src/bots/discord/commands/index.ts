import { REST, Routes, SlashCommandBuilder } from 'discord.js'

import { config } from '../../../config'

export * from './avatar-state'
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
