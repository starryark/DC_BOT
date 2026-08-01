import type { Cubism2Motions } from './dori-model-json'

import { describe, expect, it } from 'vitest'

import { buildDoriModelJson, emotionAliasGroupsFor } from './dori-model-json'

function motionsFrom(...groupNames: string[]): Cubism2Motions {
  return Object.fromEntries(groupNames.map(name => [name, [{ file: `data/motions/${name}.mtn` }]]))
}

/** The shape every Bestdori `model.json` has, trimmed to what the builder reads. */
function doriModelJson(motions: Cubism2Motions) {
  return {
    version: 'Sample 1.0.0',
    layout: { center_x: 0, center_y: 0, width: 2 },
    hit_areas_custom: { body_x: [-0.3, 0.2], head_x: [-0.25, 1] },
    model: 'data/model.moc',
    physics: 'data/physics.json',
    textures: ['data/textures/texture_00.png', 'data/textures/texture_01.png'],
    motions,
    expressions: [{ name: 'smile01', file: 'data/expressions/smile01.exp.json' }],
  }
}

describe('dORI model.json builder', () => {
  it('keeps every original motion group and adds the emotion aliases beside them', () => {
    const motions = motionsFrom('idle01', 'smile01', 'smile02', 'sad01', 'angry01', 'bow')

    const built = buildDoriModelJson(doriModelJson(motions), 'Tomori Takamatsu — live_default')
    const builtMotions = built.motions as Cubism2Motions

    expect(builtMotions.smile01).toEqual([{ file: 'data/motions/smile01.mtn' }])
    expect(builtMotions.bow).toEqual([{ file: 'data/motions/bow.mtn' }])
    expect(builtMotions.Happy).toEqual([
      { file: 'data/motions/smile01.mtn' },
      { file: 'data/motions/smile02.mtn' },
    ])
    expect(builtMotions.Sad).toEqual([{ file: 'data/motions/sad01.mtn' }])
    expect(builtMotions.Angry).toEqual([{ file: 'data/motions/angry01.mtn' }])
  })

  it('passes file references through untouched and replaces hit_areas_custom with a name', () => {
    const source = doriModelJson(motionsFrom('idle01'))

    const built = buildDoriModelJson(source, 'Sakiko Togawa — casual-2023')

    expect(built.model).toBe('data/model.moc')
    expect(built.physics).toBe('data/physics.json')
    expect(built.textures).toEqual(['data/textures/texture_00.png', 'data/textures/texture_01.png'])
    expect(built.expressions).toEqual([{ name: 'smile01', file: 'data/expressions/smile01.exp.json' }])
    expect(built.layout).toEqual({ center_x: 0, center_y: 0, width: 2 })
    expect(built.version).toBe('Sample 1.0.0')
    expect(built.name).toBe('Sakiko Togawa — casual-2023')
    expect(built).not.toHaveProperty('hit_areas_custom')
  })

  it('builds Idle from the idle and no-face loops but not the one-shot head turns', () => {
    const aliases = emotionAliasGroupsFor(motionsFrom(
      'idle01',
      'nf01',
      'nnf01',
      'nf_left01',
      'nf_right01',
      'nnf_left01',
      'nnf_right01',
    ))

    expect(aliases.Idle).toEqual([
      { file: 'data/motions/idle01.mtn' },
      { file: 'data/motions/nf01.mtn' },
      { file: 'data/motions/nnf01.mtn' },
    ])
  })

  it('never pulls alternate-persona or ingameV2 motions into an emotion group', () => {
    const aliases = emotionAliasGroupsFor(motionsFrom(
      'mts_smile01',
      'mts_sad01',
      'mts_idle01',
      'maskon_idle01',
      'maskoff',
      'smile01_ingameV2',
    ))

    expect(aliases).toEqual({})
  })

  it('omits an emotion group the model has no motion for', () => {
    const aliases = emotionAliasGroupsFor(motionsFrom('idle01', 'smile01'))

    expect(Object.keys(aliases)).toEqual(['Idle', 'Happy'])
    expect(aliases).not.toHaveProperty('Angry')
    expect(aliases).not.toHaveProperty('Curious')
  })

  it('lets Think and Question share the thinking motions', () => {
    const aliases = emotionAliasGroupsFor(motionsFrom('thinking01', 'thinking02', 'odoodo01'))

    expect(aliases.Think).toEqual([
      { file: 'data/motions/thinking01.mtn' },
      { file: 'data/motions/thinking02.mtn' },
    ])
    expect(aliases.Question).toEqual([
      { file: 'data/motions/odoodo01.mtn' },
      { file: 'data/motions/thinking01.mtn' },
      { file: 'data/motions/thinking02.mtn' },
    ])
    expect(aliases.Awkward).toEqual([{ file: 'data/motions/odoodo01.mtn' }])
  })

  it('covers the Japanese-named motions the costumes actually ship', () => {
    const aliases = emotionAliasGroupsFor(motionsFrom(
      'niya01',
      'niyake',
      'wink01',
      'ando01',
      'pui01',
      'bored',
      'scared01',
    ))

    expect(aliases.Happy).toEqual([
      { file: 'data/motions/ando01.mtn' },
      { file: 'data/motions/niya01.mtn' },
      { file: 'data/motions/niyake.mtn' },
      { file: 'data/motions/wink01.mtn' },
    ])
    expect(aliases.Awkward).toEqual([
      { file: 'data/motions/bored.mtn' },
      { file: 'data/motions/pui01.mtn' },
    ])
    expect(aliases.Surprise).toEqual([{ file: 'data/motions/scared01.mtn' }])
  })

  it('falls back to serious motions for costumes with no thinking motion', () => {
    const aliases = emotionAliasGroupsFor(motionsFrom('idle01', 'serious01', 'serious02'))

    expect(aliases.Think).toEqual([
      { file: 'data/motions/serious01.mtn' },
      { file: 'data/motions/serious02.mtn' },
    ])
    expect(aliases.Question).toEqual(aliases.Think)
  })

  it('emits an exact-case Idle group so AIRI prefers it over idle01', () => {
    const built = buildDoriModelJson(doriModelJson(motionsFrom('idle01', 'nf01')), 'Anon Chihaya — casual-2023')
    const groupNames = Object.keys(built.motions as Cubism2Motions)

    expect(groupNames.find(group => group.toLowerCase() === 'idle')).toBe('Idle')
    expect(groupNames).toContain('idle01')
  })
})
