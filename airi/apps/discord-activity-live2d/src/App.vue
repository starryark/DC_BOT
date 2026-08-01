<script setup lang="ts">
import type { ActivityContext, ActivitySession } from './discord/sdk'

import { errorMessageFrom } from '@moeru/std'
import { computed, onMounted, onUnmounted, ref } from 'vue'

import StageView from './views/StageView.vue'

import { AvatarClient } from './avatar/client'
import { connectActivity } from './discord/sdk'
import { useAvatarStore } from './stores/avatar'

const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID?.trim()
const modelId = import.meta.env.VITE_LIVE2D_MODEL_ID?.trim() || 'airi-default'
const modelSrc = import.meta.env.VITE_LIVE2D_MODEL_URL?.trim() || '/models/airi/airi.model3.json'
const relayHttpUrl = import.meta.env.VITE_AVATAR_RELAY_HTTP_URL?.trim() || ''
const relayWsUrl = import.meta.env.VITE_AVATAR_RELAY_WS_URL?.trim() || ''

const context = ref<ActivityContext>({ layout: 'focused' })
const error = ref('')
const session = ref<ActivitySession>()
const isDiscordActivity = computed(() => Boolean(clientId))
const avatar = useAvatarStore()
let avatarClient: AvatarClient | undefined

onMounted(async () => {
  if (!clientId)
    return

  try {
    if (!relayHttpUrl || !relayWsUrl)
      throw new Error('Avatar relay URLs are not configured')
    session.value = await connectActivity(clientId, relayHttpUrl, nextContext => context.value = nextContext)
    if (!context.value.guildId || !context.value.channelId)
      throw new Error('Discord voice context is unavailable')
    avatarClient = new AvatarClient({
      url: relayWsUrl,
      getToken: session.value.getRelayToken,
      guildId: context.value.guildId,
      channelId: context.value.channelId,
      store: avatar,
    })
    avatarClient.start()
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? 'Unknown Discord SDK error'
  }
})

onUnmounted(() => {
  void session.value?.close()
  avatarClient?.close()
})
</script>

<template>
  <div class="app">
    <StageView
      :connected="Boolean(session) || !isDiscordActivity"
      :layout="context.layout"
      :model-id="modelId"
      :model-src="modelSrc"
      :avatar-status="avatar.status"
      :snapshot="avatar.snapshot"
    />

    <aside v-if="error" class="app__notice app__notice--error" role="alert">
      Discord connection failed: {{ error }}
    </aside>
    <aside v-else-if="!isDiscordActivity" class="app__notice">
      Local preview mode · set VITE_DISCORD_CLIENT_ID to connect to Discord
    </aside>
  </div>
</template>
