export type FailureDataState = 'preserve_previous' | 'empty';
/** 有旧资料时保留可浏览内容，否则展示首次失败空状态。 */
export function resolveFailureState(hasPreviousData: boolean): FailureDataState { return hasPreviousData ? 'preserve_previous' : 'empty'; }
export const failureState = resolveFailureState;
export const getFailureDataState = resolveFailureState;
