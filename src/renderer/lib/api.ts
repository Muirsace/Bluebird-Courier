import type { BluebirdCourierBridge } from '../../shared/types';

/**
 * 渲染层唯一数据入口：preload 暴露的用例门面。
 * 不使用 fetch / localStorage，一切数据都经 window.bluebirdCourier 获取。
 */
export function getApi(): BluebirdCourierBridge {
  return window.bluebirdCourier;
}
