import { describe, expect, it } from 'vitest'

import { adaptInternalModel } from './model-adapter'

describe('legacy Live2D model adapter', () => {
  it('maps AIRI parameter IDs onto the Cubism 2 core API', () => {
    const values = new Map<string, number>([
      ['PARAM_ANGLE_X', 3],
      ['PARAM_MOUTH_FORM_01', 0.25],
    ])
    const internalModel = adaptInternalModel({
      coreModel: {
        getParamFloat: (id: string | number) => values.get(String(id)) ?? 0,
        getParamIndex: () => 0,
        setParamFloat: (id: string | number, value: number) => values.set(String(id), value),
      },
    })

    expect(internalModel.coreModel.getParameterValueById('ParamAngleX')).toBe(3)
    expect(internalModel.coreModel.getParameterValueById('PARAM_MOUTH_FORM_01')).toBe(0.25)

    internalModel.coreModel.setParameterValueById('ParamMouthForm', 0.75)

    expect(values.get('PARAM_MOUTH_FORM_01')).toBe(0.75)
    expect(internalModel.coreModel.getParameterDefaultValueById?.('ParamAngleX')).toBe(3)
  })

  it('leaves a Cubism 3+ core model unchanged', () => {
    const coreModel = {
      getParameterValueById: () => 1,
      setParameterValueById: () => {},
    }

    const internalModel = adaptInternalModel({ coreModel })

    expect(internalModel.coreModel).toBe(coreModel)
  })
})
