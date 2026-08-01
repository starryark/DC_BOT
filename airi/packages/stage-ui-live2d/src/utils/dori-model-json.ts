import {
  EmotionAngryMotionName,
  EmotionAwkwardMotionName,
  EmotionCuriousMotionName,
  EmotionHappyMotionName,
  EmotionNeutralMotionName,
  EmotionQuestionMotionName,
  EmotionSadMotionName,
  EmotionSurpriseMotionName,
  EmotionThinkMotionName,
} from '../constants/emotions'

/** One entry of a Cubism 2 `motions` group, as Bestdori writes it. */
export interface Cubism2MotionDefinition {
  file: string
  [key: string]: unknown
}

export type Cubism2Motions = Record<string, Cubism2MotionDefinition[]>

/**
 * Bestdori motion-group names that stand in for each AIRI emotion.
 *
 * AIRI plays an emotion by looking up a motion group named exactly after that
 * emotion (`Stage.vue` -> `EMOTION_EmotionMotionName_value`). Bestdori models
 * instead expose one group per motion file (`smile01`, `sad03`, `nf02`), so
 * without these aliases every emotion falls through to neutral.
 *
 * Every pattern is anchored, which is also what excludes the families that must
 * not drive emotions: `mts_smile01` (Mortis), `maskon_idle01` / `maskoff` (the
 * `event_297_story_01` models) and `smile01_ingameV2` all fail to match, so they
 * stay reachable only under their own group names. `nf_left01` and friends are
 * excluded the same way — they are one-shot head turns, not idle loops.
 */
const emotionMotionAliases: ReadonlyArray<readonly [string, readonly RegExp[]]> = [
  // `nf`/`nnf` are the "no-face"/"no-non-face" ambient loops every model ships.
  [EmotionNeutralMotionName, [/^idle\d*$/, /^nf\d+$/, /^nnf\d+$/]],
  // `kandou` 感動 moved, `niya`/`niyake` ニヤ smirk, `ando` 安堵 relief.
  [EmotionHappyMotionName, [/^smile\d+$/, /^sing\d+$/, /^kandou\d+$/, /^niya(ke|\d+)$/, /^wink\d+$/, /^ando\d+$/]],
  [EmotionSadMotionName, [/^sad\d+$/, /^cry\d+$/, /^sigh\d+$/]],
  [EmotionAngryMotionName, [/^angry\d+$/]],
  // `serious` stands in wherever a costume has no `thinking` motion at all,
  // which is every Uika (337) and Nyamu (340) model.
  [EmotionThinkMotionName, [/^thinking\d+$/, /^serious\d+$/]],
  [EmotionSurpriseMotionName, [/^surprised\d+$/, /^scared\d+$/]],
  // `shame` embarrassed, `odoodo` おどおど flustered, `pui` ぷい sulky turn-away.
  [EmotionAwkwardMotionName, [/^shame\d+$/, /^odoodo\d+$/, /^pui\d+$/, /^bored$/]],
  [EmotionQuestionMotionName, [/^thinking\d+$/, /^odoodo\d+$/, /^serious\d+$/]],
  // `mitore` 見とれ enthralled, `kime` 決め a deliberate "check this out" pose.
  [EmotionCuriousMotionName, [/^mitore\d+$/, /^kime\d+$/]],
]

/**
 * Builds the emotion-named alias groups for one model's motions.
 *
 * Aliases re-reference the original `.mtn` files rather than copying them; the
 * same file legitimately appears under several groups. A group with no matching
 * source motion is omitted entirely, so an emotion the model cannot express
 * leaves `motionManager.definitions` untouched instead of pointing at something
 * unrelated.
 */
export function emotionAliasGroupsFor(motions: Cubism2Motions): Cubism2Motions {
  const sourceGroupNames = Object.keys(motions).sort()
  const aliases: Cubism2Motions = {}

  for (const [emotionGroupName, patterns] of emotionMotionAliases) {
    const definitions = sourceGroupNames
      .filter(groupName => patterns.some(pattern => pattern.test(groupName)))
      .flatMap(groupName => (motions[groupName] ?? []).map(definition => ({ ...definition })))

    if (definitions.length > 0)
      aliases[emotionGroupName] = definitions
  }

  return aliases
}

/**
 * Rewrites a Bestdori `model.json` into the form AIRI packages into a ZIP.
 *
 * Every file reference is passed through untouched — the on-disk tree already
 * uses forward-slash `data/...` paths relative to `model.json`, which is exactly
 * what `Cubism2ModelSettings` and `validateLive2DZip` resolve against.
 *
 * Before:
 * - `{ "hit_areas_custom": {...}, "motions": { "smile01": [...] } }`
 *
 * After:
 * - `{ "name": "...", "motions": { "smile01": [...], "Happy": [...] } }`
 */
export function buildDoriModelJson(
  sourceModelJson: Record<string, unknown>,
  displayName: string,
): Record<string, unknown> {
  // `hit_areas_custom` is a downloader-injected constant, byte-identical across
  // every Bestdori model, and no Cubism runtime reads it.
  const { hit_areas_custom: _unusedHitAreas, ...passthrough } = sourceModelJson
  const sourceMotions = (passthrough.motions ?? {}) as Cubism2Motions

  return {
    ...passthrough,
    name: displayName,
    motions: {
      ...sourceMotions,
      ...emotionAliasGroupsFor(sourceMotions),
    },
  }
}
