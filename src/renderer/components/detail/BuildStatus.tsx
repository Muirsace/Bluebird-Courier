import type { BuildInfo, BuildStatus } from '../../../shared/types';
import { formatRelativeTime } from '../../lib/time';
import { ExternalLinkButton } from '../ExternalLinkButton';

export const BUILD_LABELS: Record<BuildStatus, string> = {
  success: '构建通过',
  failure: '构建失败',
  pending: '构建中',
  neutral: '构建无结论',
  none: '无构建',
};

/** 徽章与左侧圆点共用的状态色（success / failure / pending / neutral / none）。 */
export const BUILD_TONES: Record<BuildStatus, { badge: string; dot: string }> = {
  success: { badge: 'border-success/40 bg-success-soft text-success', dot: 'bg-success' },
  failure: { badge: 'border-danger/40 bg-danger-soft text-danger', dot: 'bg-danger' },
  pending: { badge: 'border-warning/40 bg-warning-soft text-warning', dot: 'bg-warning' },
  neutral: { badge: 'border-strong bg-surface-raised text-secondary', dot: 'bg-muted' },
  none: { badge: 'border-strong bg-surface-raised text-muted', dot: 'bg-strong' },
};

interface BuildStatusBadgeProps {
  status: BuildStatus;
}

/** 构建状态徽章：颜色与圆点语义对齐全应用；作为高权重信息，字号大于普通徽章。 */
export function BuildStatusBadge({ status }: BuildStatusBadgeProps) {
  const tone = BUILD_TONES[status];
  return (
    <span
      className={`inline-flex min-h-7 shrink-0 items-center gap-2 rounded-full border px-3 text-sm font-semibold ${tone.badge}`}
    >
      <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${tone.dot}`} />
      {BUILD_LABELS[status]}
    </span>
  );
}

const BUILD_EDGE: Record<BuildStatus, string> = {
  success: 'border-success',
  failure: 'border-danger',
  pending: 'border-warning',
  neutral: 'border-strong',
  none: 'border-subtle',
};

/** 三层构建信息：状态、workflow、时间与结论。仅显示已有数据，不推断 run title。 */
export function BuildStatusPanel({ build, showLink = false }: { build: BuildInfo; showLink?: boolean }) {
  return (
    <div className={`min-w-0 rounded-r-md border-l-2 bg-surface-raised px-3 py-3 transition-colors duration-150 ease-out ${BUILD_EDGE[build.status]}`}>
      <BuildStatusBadge status={build.status} />

      {build.workflowName ? (
        <p className="mt-2 min-w-0 truncate font-mono text-sm font-medium text-primary" title={build.workflowName}>
          {build.workflowName}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-[160px] flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-secondary">
          {build.finishedAt ? <span>{formatRelativeTime(build.finishedAt)}</span> : null}
          {build.finishedAt && build.conclusion ? <span aria-hidden="true" className="text-muted">·</span> : null}
          {build.conclusion ? <span className="font-mono text-muted">{build.conclusion}</span> : null}
          {build.status === 'none' ? <span>没有可读的 GitHub Actions 构建</span> : null}
        </div>

        {showLink && build.url ? (
          <ExternalLinkButton
            target={{ kind: 'build', url: build.url }}
            label="在 GitHub 打开这次构建"
            className="inline-flex h-9 shrink-0 items-center rounded-md border border-default px-3 text-sm text-primary transition-colors duration-150 ease-out hover:bg-surface-hover active:bg-surface-active"
          >
            在 GitHub 查看 ↗
          </ExternalLinkButton>
        ) : null}
      </div>
    </div>
  );
}
