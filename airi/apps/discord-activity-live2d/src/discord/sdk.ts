import type { DiscordSDK } from '@discord/embedded-app-sdk'

import {
  Common,
  DiscordSDK as EmbeddedDiscordSDK,
  Events,
} from '@discord/embedded-app-sdk'

export type ActivityLayout = 'focused' | 'grid' | 'pip'

export interface ActivityContext {
  channelId?: string
  guildId?: string
  layout: ActivityLayout
}

export interface ActivitySession {
  context: ActivityContext
  getRelayToken: () => Promise<string>
  close: () => Promise<void>
}

function activityLayout(mode: number): ActivityLayout {
  if (mode === Common.LayoutModeTypeObject.PIP)
    return 'pip'
  if (mode === Common.LayoutModeTypeObject.GRID)
    return 'grid'
  return 'focused'
}

/**
 * Connects to the Discord host and follows its authoritative channel and layout context.
 * Authentication is intentionally deferred until a server-backed OAuth exchange exists.
 */
export async function connectActivity(
  clientId: string,
  relayHttpUrl: string,
  onContext: (context: ActivityContext) => void,
): Promise<ActivitySession> {
  const sdk: DiscordSDK = new EmbeddedDiscordSDK(clientId)
  await sdk.ready()

  const context: ActivityContext = {
    channelId: sdk.channelId ?? undefined,
    guildId: sdk.guildId ?? undefined,
    layout: 'focused',
  }
  onContext({ ...context })
  if (!context.guildId || !context.channelId)
    throw new Error('Discord did not provide a guild and channel context')

  await sdk.commands.setConfig({ use_interactive_pip: true })

  const onLayout = ({ layout_mode: mode }: { layout_mode: number }) => {
    context.layout = activityLayout(mode)
    onContext({ ...context })
  }
  await sdk.subscribe(Events.ACTIVITY_LAYOUT_MODE_UPDATE, onLayout)

  return {
    context,
    async getRelayToken() {
      const authorization = await sdk.commands.authorize({
        client_id: clientId,
        response_type: 'code',
        scope: ['identify', 'guilds.members.read'],
      })
      const response = await fetch(`${relayHttpUrl.replace(/\/$/, '')}/api/auth/discord`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: authorization.code,
          guildId: context.guildId,
          channelId: context.channelId,
        }),
      })
      if (!response.ok)
        throw new Error('Discord authentication was rejected')
      const credentials = await response.json() as { accessToken?: unknown, relayToken?: unknown }
      if (typeof credentials.accessToken !== 'string' || typeof credentials.relayToken !== 'string')
        throw new Error('Discord authentication returned invalid credentials')
      await sdk.commands.authenticate({ access_token: credentials.accessToken })
      return credentials.relayToken
    },
    async close() {
      await sdk.unsubscribe(Events.ACTIVITY_LAYOUT_MODE_UPDATE, onLayout)
      sdk.close(1000, 'Activity unmounted')
    },
  }
}
