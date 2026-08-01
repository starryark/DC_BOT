<script setup lang="ts">
import type { AvatarBehavior } from '@proj-airi/discord-avatar-protocol'

import Live2D from '@proj-airi/stage-ui-live2d/components/scenes/Live2D.vue'

import { useLive2dParams } from '@proj-airi/stage-ui-live2d/stores/model-parameters'
import { storeToRefs } from 'pinia'
import { watch } from 'vue'

import { availableBehaviorMotion } from '../stores/avatar'

const props = withDefaults(defineProps<{
  modelId?: string
  modelSrc: string
  behavior?: AvatarBehavior
}>(), {
  modelId: 'airi-default',
  behavior: 'idle',
})

const state = defineModel<'pending' | 'loading' | 'mounted'>('state', { default: 'pending' })
const { currentMotion, availableMotions } = storeToRefs(useLive2dParams())

watch([() => props.behavior, availableMotions], ([behavior, motions]) => {
  const groups = motions.map(motion => motion.motionName)
  const group = availableBehaviorMotion(behavior, groups)
  if (group)
    currentMotion.value = { group }
}, { immediate: true })
</script>

<template>
  <Live2D
    v-model:state="state"
    :model-id="modelId"
    :model-src="modelSrc"
    :mouth-open-size="0"
    :now-speaking="false"
  />
</template>
