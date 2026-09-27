import { useState } from 'react';
import type { GitHubExternalTarget, OpenExternalResult } from '../../shared/types';
import { getApi } from './api';

/** 打开失败的原因 → 面向用户的文案（主进程拒绝与系统打不开必须分开说）。 */
export function describeOpenFailure(reason: OpenExternalResult['reason']): string {
  return reason === 'invalid_target' ? '链接目标不合法，已阻止打开' : '无法打开系统浏览器，请稍后重试';
}

export interface GitHubExternal {
  /** 打开目标；成功返回 true，失败时把原因写进 error。 */
  open: (target: GitHubExternalTarget) => Promise<boolean>;
  error: string | null;
}

/** 外链打开的就地错误状态：失败不弹全局错误条，也不假装成功。 */
export function useGitHubExternal(): GitHubExternal {
  const [error, setError] = useState<string | null>(null);

  async function open(target: GitHubExternalTarget): Promise<boolean> {
    const result = await getApi().openGitHubExternal(target);
    if (result.ok) {
      setError(null);
      return true;
    }
    setError(describeOpenFailure(result.reason));
    return false;
  }

  return { open, error };
}
