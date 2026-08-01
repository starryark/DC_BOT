<script setup lang="ts">
import type { AvatarStateSnapshot } from '@proj-airi/discord-avatar-protocol'

import type { ActivityLayout } from '../discord/sdk'
import type { AvatarConnectionStatus } from '../stores/avatar'

import { computed, ref } from 'vue'

import DiscordLive2DStage from '../live2d/DiscordLive2DStage.vue'

const props = defineProps<{
  connected: boolean
  layout: ActivityLayout
  modelId: string
  modelSrc: string
  avatarStatus: AvatarConnectionStatus
  snapshot?: AvatarStateSnapshot
}>()

const modelState = ref<'pending' | 'loading' | 'mounted'>('pending')
const compact = computed(() => props.layout === 'pip' || props.layout === 'grid')
const effectiveBehavior = computed(() => props.snapshot?.connected ? props.snapshot.behavior : 'idle')
const speaking = computed(() => props.snapshot?.connected && props.snapshot.behavior === 'speaking')
</script>

<template>
  <main :class="['stage', `stage--${layout}`, { 'stage--compact': compact, 'stage--speaking': speaking }]">
    <div class="stage__glow" aria-hidden="true" />
    <div class="stage__avatar">
      <DiscordLive2DStage
        v-model:state="modelState"
        :model-id="modelId"
        :model-src="modelSrc"
        :behavior="effectiveBehavior"
      />
    </div>

    <div v-if="!compact" class="stage__status" role="status">
      <span
        :class="['stage__status-dot', { 'stage__status-dot--ready': connected && modelState === 'mounted' }]"
        aria-hidden="true"
      />
      {{ !connected ? 'Opening Discord Activity…' : avatarStatus === 'reconnecting' ? 'Reconnecting avatar…' : avatarStatus === 'disconnected' || snapshot?.connected === false ? 'Avatar session disconnected' : modelState === 'mounted' ? speaking ? 'AIRI is speaking' : `AIRI is ${effectiveBehavior}` : 'Loading Live2D model…' }}
    </div>
  </main>
</template>
