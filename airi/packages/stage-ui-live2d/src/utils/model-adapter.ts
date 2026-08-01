const cubism2ParameterIds: Record<string, string> = {
  ParamAngleX: 'PARAM_ANGLE_X',
  ParamAngleY: 'PARAM_ANGLE_Y',
  ParamAngleZ: 'PARAM_ANGLE_Z',
  ParamBodyAngleX: 'PARAM_BODY_ANGLE_X',
  ParamBodyAngleY: 'PARAM_BODY_ANGLE_Y',
  ParamBodyAngleZ: 'PARAM_BODY_ANGLE_Z',
  ParamBreath: 'PARAM_BREATH',
  ParamBrowLAngle: 'PARAM_BROW_L_ANGLE',
  ParamBrowLForm: 'PARAM_BROW_L_FORM',
  ParamBrowLX: 'PARAM_BROW_L_X',
  ParamBrowLY: 'PARAM_BROW_L_Y',
  ParamBrowRAngle: 'PARAM_BROW_R_ANGLE',
  ParamBrowRForm: 'PARAM_BROW_R_FORM',
  ParamBrowRX: 'PARAM_BROW_R_X',
  ParamBrowRY: 'PARAM_BROW_R_Y',
  ParamCheek: 'PARAM_CHEEK',
  ParamEyeBallX: 'PARAM_EYE_BALL_X',
  ParamEyeBallY: 'PARAM_EYE_BALL_Y',
  ParamEyeLOpen: 'PARAM_EYE_L_OPEN',
  ParamEyeROpen: 'PARAM_EYE_R_OPEN',
  ParamEyeSmile: 'PARAM_EYE_L_SMILE',
  ParamMouthForm: 'PARAM_MOUTH_FORM_01',
  ParamMouthOpenY: 'PARAM_MOUTH_OPEN_Y',
}

interface Cubism2CoreModel {
  getParamFloat: (idOrIndex: string | number) => number
  getParamIndex: (id: string) => number
  setParamFloat: (idOrIndex: string | number, value: number) => void
}

interface CompatibleCoreModel {
  getParameterDefaultValueById?: (id: string) => number
  getParameterValueById: (id: string) => number
  setParameterValueById: (id: string, value: number) => void
}

interface AdaptableInternalModel {
  coreModel: object
}

function isCubism2CoreModel(coreModel: object): coreModel is Cubism2CoreModel {
  return 'getParamFloat' in coreModel && 'setParamFloat' in coreModel
}

/**
 * Adds AIRI's version-neutral parameter contract to a loaded internal model.
 *
 * Cubism 2 uses uppercase underscore-separated IDs and `getParamFloat`, while
 * Cubism 3+ exposes the camel-cased parameter API AIRI historically called.
 * The adapter preserves native IDs used by packaged expression files.
 */
export function adaptInternalModel<TInternalModel extends AdaptableInternalModel>(
  internalModel: TInternalModel,
): TInternalModel & { coreModel: CompatibleCoreModel } {
  const coreModel = internalModel.coreModel as object
  if (!isCubism2CoreModel(coreModel))
    return internalModel as TInternalModel & { coreModel: CompatibleCoreModel }

  const compatibleCore = coreModel as Cubism2CoreModel & Partial<CompatibleCoreModel>
  const defaults = new Map<string, number>()
  const nativeId = (id: string) => cubism2ParameterIds[id] ?? id

  compatibleCore.getParameterValueById = (id: string) => {
    const resolvedId = nativeId(id)
    const value = compatibleCore.getParamFloat(resolvedId)
    if (!defaults.has(resolvedId))
      defaults.set(resolvedId, value)
    return value
  }
  compatibleCore.setParameterValueById = (id: string, value: number) => {
    compatibleCore.setParamFloat(nativeId(id), value)
  }
  compatibleCore.getParameterDefaultValueById = (id: string) => {
    const resolvedId = nativeId(id)
    if (!defaults.has(resolvedId))
      defaults.set(resolvedId, compatibleCore.getParamFloat(resolvedId))
    return defaults.get(resolvedId)!
  }

  return internalModel as TInternalModel & { coreModel: CompatibleCoreModel }
}
