<script setup lang="ts">
import type { SpeechProviderWithExtraOptions } from '@xsai-ext/providers/utils'

import { errorMessageFrom } from '@moeru/std'
import {
  SpeechPlayground,
  SpeechProviderSettings,
} from '@proj-airi/stage-ui/components'
import { useSpeechStore } from '@proj-airi/stage-ui/stores/modules/speech'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { Callout, FieldCheckbox, FieldInput, FieldRange, FieldSelect } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

/** Shape of the bridge's `/v1/health` payload. */
interface BridgeHealth {
  status: string
  voices_path: string
  ffmpeg: boolean
  default_format: string
  upstream: { url: string, reachable: boolean, latency_ms?: number, error?: string }
  weights: { sovits: string | null, gpt: string | null }
  voices: { count: number, ids: string[] }
  problems: string[]
  setup_hint?: string
}

const providerId = 'gpt-sovits'
const defaultModel = 'gpt-sovits-tts'

const { t } = useI18n()
const speechStore = useSpeechStore()
const providersStore = useProvidersStore()
const { providers } = storeToRefs(providersStore)

const health = ref<BridgeHealth | null>(null)
const healthError = ref('')
const voicesLoading = ref(false)

const availableVoices = computed(() => speechStore.availableVoices[providerId] || [])

/**
 * Two-way binding onto one key of the persisted provider config.
 *
 * The settings shell owns `baseUrl` / `apiKey`; everything GPT-SoVITS specific is
 * written straight into the same credentials object so it reaches the request
 * through the provider's allow-list.
 */
function configField<T>(key: string, fallback: T) {
  return computed<T>({
    get: () => (providers.value[providerId]?.[key] as T | undefined) ?? fallback,
    set: (value) => {
      providers.value[providerId] ??= {}
      providers.value[providerId][key] = value
    },
  })
}

const textLang = configField<string>('textLang', 'auto')
const speed = configField<number>('speed', 1)
const stripNarration = configField<boolean>('stripNarration', true)
const topK = configField<number>('topK', 15)
const topP = configField<number>('topP', 1)
const temperature = configField<number>('temperature', 1)
const textSplitMethod = configField<string>('textSplitMethod', '')
const repetitionPenalty = configField<number>('repetitionPenalty', 1.35)
const sampleSteps = configField<number>('sampleSteps', 32)
const seed = configField<number>('seed', -1)

// NOTICE:
// The accepted language codes depend on the GPT-SoVITS generation loaded in the
// upstream process (v2 added Korean and Cantonese).
// Root cause: api_v2 validates against the resident version, not a stable list.
// The bridge forwards the rejection as a 502 naming the accepted values, so a
// stale option here fails loudly rather than producing wrong audio.
const textLangOptions = [
  { value: 'auto', label: 'auto' },
  { value: 'auto_yue', label: 'auto (Cantonese-aware)' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'yue', label: 'Cantonese' },
  { value: 'all_zh', label: 'Chinese only' },
  { value: 'all_ja', label: 'Japanese only' },
]

// NOTICE:
// The persisted config uses an empty string for "auto", because
// `pickGptSoVitsRequestOptions` (packages/stage-ui/src/stores/providers.ts) drops
// empty values, and an absent `text_split_method` is what tells the bridge to
// apply its own policy (short chat fragments unsplit).
//
// reka-ui reserves the empty string for clearing a Select, and throws on a
// `SelectItem` whose value is `''`, so the option list cannot use the persisted
// sentinel directly. `textSplitMethodSelection` below maps between the two.
const AUTO_TEXT_SPLIT_METHOD = 'auto'

const textSplitMethodOptions = [
  { value: AUTO_TEXT_SPLIT_METHOD, label: 'auto (recommended)' },
  { value: 'cut0', label: 'cut0 — no split' },
  { value: 'cut1', label: 'cut1 — every 4 sentences' },
  { value: 'cut2', label: 'cut2 — every 50 characters' },
  { value: 'cut3', label: 'cut3 — on Chinese period' },
  { value: 'cut4', label: 'cut4 — on English period' },
  { value: 'cut5', label: 'cut5 — on any punctuation' },
]

/**
 * Widget-facing view of {@link textSplitMethod}.
 *
 * Reads a persisted `''` (and a missing key) as the auto sentinel, and writes it
 * back as `''` so the request keeps omitting the field entirely.
 */
const textSplitMethodSelection = computed<string>({
  get: () => textSplitMethod.value || AUTO_TEXT_SPLIT_METHOD,
  set: (value) => {
    textSplitMethod.value = value === AUTO_TEXT_SPLIT_METHOD ? '' : value
  },
})

const sampleStepsOptions = [4, 8, 16, 32].map(value => ({ value, label: String(value) }))

const bridgeOffline = computed(() => !!healthError.value)
const noVoiceProfiles = computed(() => !!health.value && health.value.voices.count === 0)

async function refreshHealth() {
  healthError.value = ''

  const baseUrl = (providers.value[providerId]?.baseUrl as string | undefined)?.trim()
  if (!baseUrl)
    return

  try {
    const response = await fetch(`${baseUrl}health`)
    if (!response.ok)
      throw new Error(`HTTP ${response.status} ${response.statusText}`)

    health.value = await response.json() as BridgeHealth
  }
  catch (error) {
    health.value = null
    healthError.value = errorMessageFrom(error) ?? 'unknown error'
  }
}

async function reloadVoices() {
  voicesLoading.value = true

  try {
    await refreshHealth()
    await providersStore.fetchModelsForProvider(providerId)
    await speechStore.loadVoicesForProvider(providerId)
  }
  catch (error) {
    console.error('[GPT-SoVITS Settings] failed to load voices:', error)
  }
  finally {
    voicesLoading.value = false
  }
}

onMounted(reloadVoices)

async function handleGenerateSpeech(input: string, voiceId: string) {
  const provider = await providersStore.getProviderInstance(providerId) as SpeechProviderWithExtraOptions<string, Record<string, unknown>>
  if (!provider)
    throw new Error('Failed to initialize speech provider')

  const providerConfig = providersStore.getProviderConfig(providerId)
  const model = providerConfig.model as string | undefined || defaultModel

  return await speechStore.speech(provider, model, input, voiceId, { ...providerConfig })
}
</script>

<template>
  <Callout
    v-if="bridgeOffline"
    theme="orange"
    :label="t('settings.pages.providers.provider.gpt-sovits.bridge.offline_title')"
  >
    <div :class="['flex', 'flex-col', 'gap-1']">
      <span>{{ t('settings.pages.providers.provider.gpt-sovits.bridge.offline') }}</span>
      <span :class="['text-xs', 'opacity-70', 'break-all']">{{ healthError }}</span>
    </div>
  </Callout>

  <Callout
    v-else-if="noVoiceProfiles"
    theme="violet"
    :label="t('settings.pages.providers.provider.gpt-sovits.bridge.no_voices_title')"
  >
    <div :class="['flex', 'flex-col', 'gap-1']">
      <span>{{ t('settings.pages.providers.provider.gpt-sovits.bridge.no_voices') }}</span>
      <span :class="['text-xs', 'opacity-70', 'break-all']">{{ health?.voices_path }}</span>
      <span v-for="problem in health?.problems" :key="problem" :class="['text-xs', 'opacity-70']">{{ problem }}</span>
    </div>
  </Callout>

  <Callout
    v-else-if="health"
    theme="lime"
    :label="t('settings.pages.providers.provider.gpt-sovits.bridge.ready_title')"
  >
    <div :class="['flex', 'flex-col', 'gap-1', 'text-sm']">
      <span>
        {{ t('settings.pages.providers.provider.gpt-sovits.bridge.ready', { count: health.voices.count }) }}
      </span>
      <span :class="['text-xs', 'opacity-70', 'break-all']">{{ health.upstream.url }}</span>
      <span v-for="problem in health.problems" :key="problem" :class="['text-xs', 'opacity-70']">{{ problem }}</span>
    </div>
  </Callout>

  <SpeechProviderSettings
    :provider-id="providerId"
    :default-model="defaultModel"
    :placeholder="t('settings.pages.providers.provider.gpt-sovits.fields.field.api-key.placeholder')"
  >
    <template #voice-settings>
      <div :class="['flex', 'flex-col', 'gap-4']">
        <FieldSelect
          v-model="textLang"
          :label="t('settings.pages.providers.provider.gpt-sovits.fields.field.text-lang.label')"
          :description="t('settings.pages.providers.provider.gpt-sovits.fields.field.text-lang.description')"
          :options="textLangOptions"
        />
        <FieldRange
          v-model="speed"
          :label="t('settings.pages.providers.provider.common.fields.field.speed.label')"
          :description="t('settings.pages.providers.provider.common.fields.field.speed.description')"
          :min="0.5"
          :max="2"
          :step="0.05"
        />
        <FieldCheckbox
          v-model="stripNarration"
          :label="t('settings.pages.providers.provider.gpt-sovits.fields.field.strip-narration.label')"
          :description="t('settings.pages.providers.provider.gpt-sovits.fields.field.strip-narration.description')"
        />
      </div>
    </template>

    <template #advanced-settings>
      <div :class="['flex', 'flex-col', 'gap-4']">
        <FieldRange
          v-model="topK"
          :label="t('settings.pages.providers.provider.gpt-sovits.fields.field.top-k.label')"
          :description="t('settings.pages.providers.provider.gpt-sovits.fields.field.top-k.description')"
          :min="1"
          :max="100"
          :step="1"
        />
        <FieldRange
          v-model="topP"
          :label="t('settings.pages.providers.provider.gpt-sovits.fields.field.top-p.label')"
          :description="t('settings.pages.providers.provider.gpt-sovits.fields.field.top-p.description')"
          :min="0"
          :max="1"
          :step="0.01"
        />
        <FieldRange
          v-model="temperature"
          :label="t('settings.pages.providers.provider.gpt-sovits.fields.field.temperature.label')"
          :description="t('settings.pages.providers.provider.gpt-sovits.fields.field.temperature.description')"
          :min="0.05"
          :max="1.5"
          :step="0.01"
        />
        <FieldRange
          v-model="repetitionPenalty"
          :label="t('settings.pages.providers.provider.gpt-sovits.fields.field.repetition-penalty.label')"
          :description="t('settings.pages.providers.provider.gpt-sovits.fields.field.repetition-penalty.description')"
          :min="1"
          :max="2"
          :step="0.01"
        />
        <FieldSelect
          v-model="textSplitMethodSelection"
          :label="t('settings.pages.providers.provider.gpt-sovits.fields.field.text-split-method.label')"
          :description="t('settings.pages.providers.provider.gpt-sovits.fields.field.text-split-method.description')"
          :options="textSplitMethodOptions"
        />
        <FieldSelect
          v-model="sampleSteps"
          :label="t('settings.pages.providers.provider.gpt-sovits.fields.field.sample-steps.label')"
          :description="t('settings.pages.providers.provider.gpt-sovits.fields.field.sample-steps.description')"
          :options="sampleStepsOptions"
        />
        <FieldInput
          v-model="seed"
          type="number"
          :label="t('settings.pages.providers.provider.gpt-sovits.fields.field.seed.label')"
          :description="t('settings.pages.providers.provider.gpt-sovits.fields.field.seed.description')"
        />
      </div>
    </template>

    <template #playground>
      <SpeechPlayground
        :available-voices="availableVoices"
        :generate-speech="handleGenerateSpeech"
        :api-key-configured="true"
        :voices-loading="voicesLoading"
        :use-ssml="false"
        :default-text="t('settings.pages.providers.provider.gpt-sovits.playground.default-text')"
      />
    </template>
  </SpeechProviderSettings>
</template>

<route lang="yaml">
  meta:
    layout: settings
    stageTransition:
      name: slide
</route>
