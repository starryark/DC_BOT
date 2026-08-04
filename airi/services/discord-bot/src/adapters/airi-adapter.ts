import type { Discord } from '@proj-airi/server-shared/types'
import type { Interaction } from 'discord.js'

import type { PrivacyMemoryAuthority } from '../memory/privacy-authority'
import type { DiscordTextMemoryObserver } from '../memory/text-observer'
import type { TextMentionResponder } from '../orchestration/mention-responder'

import { env } from 'node:process'

import { useLogg } from '@guiiai/logg'
import { Client as ServerChannel } from '@proj-airi/server-sdk'
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js'

import { handleAvatarState, handleMemory, handlePing, handleVoiceTest, registerCommands, VoiceManager } from '../bots/discord/commands'
import { buildDiscordActorEvidence } from '../memory/discord-actor-snapshot'

const log = useLogg('DiscordAdapter').useGlobalConfig()

export interface DiscordAdapterConfig {
  discordToken?: string
  airiToken?: string
  airiUrl?: string
}

// Define Discord configuration type
interface DiscordConfig {
  token?: string
  enabled?: boolean
}

// Type guard to safely validate the configuration object
function isDiscordConfig(config: unknown): config is DiscordConfig {
  if (typeof config !== 'object' || config === null)
    return false
  const c = config as Record<string, unknown>
  return (typeof c.token === 'string' || typeof c.token === 'undefined')
    && (typeof c.enabled === 'boolean' || typeof c.enabled === 'undefined')
}

function normalizeDiscordMetadata(discord?: Discord): Discord | undefined {
  if (!discord)
    return undefined

  if (!discord.guildMember)
    return discord

  const { guildMember } = discord

  return {
    ...discord,
    guildMember: {
      id: guildMember.id ?? guildMember.displayName ?? guildMember.nickname ?? '',
      nickname: guildMember.nickname ?? guildMember.displayName ?? '',
      displayName: guildMember.displayName ?? guildMember.nickname ?? '',
    },
  }
}

const ALLOWED_MENTIONS = { parse: [] as [], repliedUser: false }
const MAX_ROUTED_OUTPUT_LENGTH = 12_000

/** Split Discord output without exceeding its message limit. */
export function chunkDiscordText(text: string, maximum = 1900): string[] {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 2000)
    throw new RangeError('Discord chunk size must be between 1 and 2000')

  const chunks: string[] = []
  let remaining = text.trim()
  while (remaining.length > maximum) {
    const window = remaining.slice(0, maximum + 1)
    const paragraph = window.lastIndexOf('\n\n')
    const newline = window.lastIndexOf('\n')
    const space = window.lastIndexOf(' ')
    const splitAt = paragraph > 0
      ? paragraph
      : newline > 0
        ? newline
        : space > 0
          ? space
          : maximum
    chunks.push(remaining.slice(0, splitAt).trimEnd())
    remaining = remaining.slice(splitAt).trimStart()
  }
  if (remaining)
    chunks.push(remaining)
  return chunks
}

export class DiscordAdapter {
  private airiClient: ServerChannel
  private discordClient: Client
  private discordToken: string
  /** Exposed so the direct-mode orchestrator in index.ts can subscribe to utterances. */
  voiceManager: VoiceManager
  private isReconnecting = false
  private mentionResponder?: TextMentionResponder
  private textMemoryObserver?: DiscordTextMemoryObserver
  private privacyMemory?: PrivacyMemoryAuthority

  constructor(config: DiscordAdapterConfig) {
    this.discordToken = config.discordToken || env.DISCORD_TOKEN || ''

    // Initialize Discord client
    this.discordClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [Partials.Channel],
    })

    // Initialize AIRI client
    this.airiClient = new ServerChannel({
      name: 'discord',
      possibleEvents: [
        'input:text',
        'input:text:voice',
        'input:voice',
        'module:configure',
        'output:gen-ai:chat:message',
      ],
      token: config.airiToken,
      url: config.airiUrl,
    })

    this.voiceManager = new VoiceManager(this.discordClient)

    this.setupEventHandlers()
  }

  setMentionResponder(responder: TextMentionResponder): void {
    this.mentionResponder = responder
  }

  setTextMemoryObserver(observer: DiscordTextMemoryObserver): void {
    this.textMemoryObserver = observer
  }

  setPrivacyMemory(authority: PrivacyMemoryAuthority | undefined): void {
    this.privacyMemory = authority
  }

  private setupEventHandlers(): void {
    // Handle configuration from UI
    this.airiClient.onEvent('module:configure', async (event) => {
      if (this.isReconnecting) {
        log.warn('A reconnect is already in progress, skipping this configuration event.')
        return
      }
      this.isReconnecting = true
      try {
        log.log('Received Discord configuration:', event.data.config)

        if (isDiscordConfig(event.data.config)) {
          const config = event.data.config as DiscordConfig
          const { token, enabled } = config

          if (enabled === false) {
            if (this.discordClient.isReady) {
              log.log('Disabling Discord bot as per configuration...')
              await this.discordClient.destroy()
            }
            return
          }

          // If enabled, but no token is provided, stop the bot if it's running.
          if (!token) {
            log.warn('Discord bot enabled, but no token provided. Stopping bot.')
            if (this.discordClient.isReady) {
              await this.discordClient.destroy()
            }
            return
          }

          // Connect or reconnect if token changed or client is not ready.
          if (this.discordToken !== token || !this.discordClient.isReady) {
            this.discordToken = token
            if (this.discordClient.isReady) {
              log.log('Reconnecting Discord client with new token...')
              await this.discordClient.destroy()
            }
            log.log('Connecting Discord client...')
            await this.discordClient.login(this.discordToken)
            log.log('Discord client connected.')
          }
        }
        else {
          log.warn('Invalid Discord configuration received, skipping...')
        }
      }
      catch (error) {
        log.withError(error as Error).error('Failed to apply Discord configuration.')
      }
      finally {
        this.isReconnecting = false
      }
    })

    // Handle input from AIRI system
    this.airiClient.onEvent('input:text', async (event) => {
      log.log('Received input from AIRI system:', event.data.text)
      // Process Discord-related commands
      // For now, we'll just log the input
    })

    // Handle output from AIRI system (IA response)
    this.airiClient.onEvent('output:gen-ai:chat:message', async (event) => {
      try {
        const message = (event.data as { message?: { content: string } }).message
        const discordContext = (event.data)['gen-ai:chat'].input.data.discord

        if (message?.content && discordContext?.channelId) {
          const channel = await this.discordClient.channels.fetch(discordContext.channelId)
          if (channel?.isTextBased() && 'send' in channel && typeof channel.send === 'function') {
            for (const chunk of chunkDiscordText(message.content.slice(0, MAX_ROUTED_OUTPUT_LENGTH)))
              await channel.send({ content: chunk, allowedMentions: ALLOWED_MENTIONS })
          }
        }
      }
      catch (error) {
        log.withError(error as Error).error('Failed to send response to Discord')
      }
    })

    // Set up Discord event handlers
    this.discordClient.once(Events.ClientReady, async (readyClient) => {
      log.log(`Discord bot ready! User: ${readyClient.user.tag}`)
      // Register commands dynamically using the authenticated client's ID and token
      await registerCommands(this.discordToken, readyClient.user.id)
    })

    this.discordClient.on(Events.MessageCreate, async (message) => {
      if (message.author.bot || message.system || message.webhookId)
        return

      const botUser = this.discordClient.user
      if (!botUser)
        return

      let referencedMessage: Awaited<ReturnType<typeof message.fetchReference>> | undefined
      if (message.reference?.messageId) {
        try {
          referencedMessage = await message.fetchReference()
        }
        catch {
          // Deleted, inaccessible, and partial references must not discard the input.
        }
      }

      const isDirectMessage = message.guildId === null
      const directlyMentioned = message.mentions.users.has(botUser.id)
      const repliesToBot = referencedMessage?.author.id === botUser.id
      if (!isDirectMessage && !directlyMentioned && !repliesToBot)
        return

      const mentionPattern = new RegExp(`<@!?${botUser.id}>`, 'g')
      const text = message.content.replace(mentionPattern, '').trim()
      const event = {
        type: 'discord-mention' as const,
        eventId: `${message.id}:in`,
        turnId: message.id,
        guildId: message.guildId ?? undefined,
        channelId: message.channelId,
        userId: message.author.id,
        displayName: message.member?.displayName ?? message.author.displayName,
        actorEvidence: buildDiscordActorEvidence({
          userId: message.author.id,
          username: message.author.username,
          globalName: message.author.globalName,
          guildNickname: message.member?.nickname,
          displayName: message.member?.displayName ?? message.author.displayName,
          avatarUrl: message.author.avatarURL(),
          guildId: message.guildId ?? undefined,
          observedAtEpochMs: message.createdTimestamp,
          source: 'gateway',
        }),
        timestamp: message.createdTimestamp,
        messageId: message.id,
        text,
      }

      try {
        if (this.mentionResponder) {
          await this.textMemoryObserver?.admit(event, { isDirectMessage, isThread: message.channel.isThread() })
          const preparedMemory = await this.textMemoryObserver?.prepareForModel(event)
          const refreshTyping = async (): Promise<void> => {
            try {
              await message.channel.sendTyping()
            }
            catch {
              // Typing is cosmetic and can fail when permissions change mid-turn.
            }
          }
          await refreshTyping()
          const typingInterval = setInterval(() => void refreshTyping(), 8000)
          try {
            const response = await this.mentionResponder.respond({
              event,
              context: {
                isDirectMessage,
                isThread: message.channel.isThread(),
                repliedToText: referencedMessage?.content,
              },
              memoryContext: preparedMemory?.context,
            })
            const chunks = chunkDiscordText(response)
            await this.textMemoryObserver?.generated(event, chunks)
            for (const [index, chunk] of chunks.entries()) {
              await this.textMemoryObserver?.delivering(event, index)
              const sent = index === 0
                ? await message.reply({ content: chunk, allowedMentions: ALLOWED_MENTIONS })
                : await message.channel.send({ content: chunk, allowedMentions: ALLOWED_MENTIONS })
              await this.textMemoryObserver?.deliveredSegment(event, index, sent.id)
            }
            await this.textMemoryObserver?.delivered(event)
          }
          finally {
            clearInterval(typingInterval)
          }
          return
        }

        const discord: Discord = normalizeDiscordMetadata({
          guildId: message.guildId ?? undefined,
          guildName: message.guild?.name,
          channelId: message.channelId,
          guildMember: {
            id: message.author.id,
            nickname: message.member?.nickname ?? message.author.displayName,
            displayName: message.member?.displayName ?? message.author.displayName,
          },
        })!
        this.airiClient.send({
          type: 'input:text',
          data: {
            text: text || '(The user mentioned you without adding a message.)',
            textRaw: message.content,
            discord,
          },
        })
      }
      catch (error) {
        await this.textMemoryObserver?.failed(event, error)
        log.withError(error as Error).withFields({
          guildId: message.guildId ?? 'dm',
          channelId: message.channelId,
          messageId: message.id,
        }).error('Failed to handle Discord text message')
      }
    })

    this.discordClient.on(Events.InteractionCreate, async (interaction: Interaction) => {
      if (!interaction.isChatInputCommand())
        return

      const member = interaction.member
      const actorEvidence = buildDiscordActorEvidence({
        userId: interaction.user.id,
        username: interaction.user.username,
        globalName: interaction.user.globalName,
        guildNickname: member && 'nickname' in member ? member.nickname : undefined,
        displayName: member && 'displayName' in member ? member.displayName : interaction.user.displayName,
        avatarUrl: interaction.user.avatarURL(),
        guildId: interaction.guildId ?? undefined,
        observedAtEpochMs: interaction.createdTimestamp,
        source: 'gateway',
      })
      log.withFields({ actorKind: actorEvidence.kind, platformUserId: interaction.user.id })
        .log(`Interaction received: /${interaction.commandName} from ${interaction.user.tag}`)

      switch (interaction.commandName) {
        case 'ping':
          await handlePing(interaction)
          break
        case 'memory':
          await handleMemory(interaction, actorEvidence, this.privacyMemory)
          break
        case 'summon':
          await this.voiceManager.handleJoinChannelCommand(interaction)
          break
        case 'leave':
          await this.voiceManager.handleLeaveChannelCommand(interaction)
          break
        case 'voice-test':
          await handleVoiceTest(interaction)
          break
        case 'avatar-state':
          await handleAvatarState(interaction)
          break
      }
    })
  }

  async start(): Promise<void> {
    log.log('Starting Discord adapter...')

    try {
      // Log in to Discord if token is available
      if (this.discordToken) {
        await this.discordClient.login(this.discordToken)
        log.log('Discord adapter started successfully')
      }
      else {
        log.warn('Discord token not provided. Waiting for configuration from UI.')
      }
    }
    catch (error) {
      log.withError(error).error('Failed to start Discord adapter')
      throw error
    }
  }

  async stop(): Promise<void> {
    log.log('Stopping Discord adapter...')
    try {
      await this.discordClient.destroy()
      this.airiClient.close()
      log.log('Discord adapter stopped')
    }
    catch (error) {
      log.withError(error).error('Error stopping Discord adapter')
      throw error
    }
  }
}
