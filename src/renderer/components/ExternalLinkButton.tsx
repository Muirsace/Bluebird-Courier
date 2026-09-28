import type { ReactNode } from 'react';
import type { GitHubExternalTarget } from '../../shared/types';
import { useGitHubExternal } from '../lib/external-link';

interface ExternalLinkButtonProps {
  target: GitHubExternalTarget;
  /** 无障碍名（同时作为悬停提示），要写清打开的是什么。 */
  label: string;
  className: string;
  children: ReactNode;
}

/**
 * 「在 GitHub 打开」控件：真 button + aria-label + focus-visible，打开失败就地报错。
 * 不导航当前 Electron 窗口，一切交给主进程的窄接口去调系统浏览器。
 */
export function ExternalLinkButton({ target, label, className, children }: ExternalLinkButtonProps) {
  const { open, error } = useGitHubExternal();

  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={() => void open(target)}
        className={`focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${className}`}
      >
        {children}
      </button>
      {error ? (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}
