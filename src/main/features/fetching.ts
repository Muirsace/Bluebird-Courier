import type Database from 'better-sqlite3';
import type { Clock } from '../core/clock';
import type { BuildRun, GitHubPort, IssueOrPullRequest } from '../core/github/port';
import type {
  BuildInfo,
  BuildStatus,
  CommitItem,
  Detail,
  Glance,
  IssueItem,
  PullRequestItem,
  ReleaseItem,
} from '../../shared/types';
import { listSnapshots, recordSnapshot } from './snapshots';
import {
  mustFindRepositoryRow,
  updateRepositoryGlance,
  updateRepositoryLatestRelease,
  rowToGlance,
  type GlanceValues,
} from './watchlist';

/**
 * 抓取编排。
 *
 * 轻量抓取（每仓库两次调用）：仓库元数据（star / fork / open issues / 最近推送时间）+ 最新发版。
 * 全量抓取（每次四类调用）：发版列表、提交列表、议题与合并请求列表（同一端点按 pull_request 标记拆分）、
 * 构建状态（最近一次构建结论）。趋势不调接口、只读快照。
 *
 * 仅成功抓取后记历史快照（每天一档，手动刷新同样记档）。
 */
/** 轻量抓取结果：展示字段值 + GitHub 返回的规范 full_name（落库以它为准）。 */
export interface FetchedGlance extends GlanceValues {
  fullName: string;
}

export async function fetchGlanceValues(
  github: GitHubPort,
  accessToken: string,
  fullName: string,
): Promise<FetchedGlance> {
  const meta = await github.getRepositoryMeta(accessToken, fullName);
  const latestRelease = await github.getLatestRelease(accessToken, fullName);
  return {
    fullName: meta.fullName,
    stars: meta.stars,
    forks: meta.forks,
    openIssues: meta.openIssues,
    pushedAt: meta.pushedAt,
    latestReleaseTag: latestRelease?.tagName ?? null,
  };
}

/** 成功抓取的落库动作：更新展示字段 + 记历史快照，返回最新轻量信息。 */
export function applyGlanceValues(
  db: Database.Database,
  clock: Clock,
  repositoryId: number,
  values: GlanceValues,
): Glance {
  const capturedAt = clock.now();
  // 展示字段与当日快照必须同进同退，否则会留下"已标记抓取成功、当日却缺一档"的中间态
  db.transaction(() => {
    updateRepositoryGlance(db, repositoryId, values, capturedAt.toISOString());
    recordSnapshot(db, repositoryId, values, capturedAt);
  })();
  return rowToGlance(mustFindRepositoryRow(db, repositoryId));
}

// ---------- 全量抓取 ----------

export interface DetailValues {
  releases: ReleaseItem[];
  commits: CommitItem[];
  issues: IssueItem[];
  pullRequests: PullRequestItem[];
  build: BuildInfo;
}

/**
 * 全量抓取（四类调用）：发版列表、提交列表、议题与合并请求列表（同一端点按 pull_request
 * 标记拆分）、构建状态（最近一次构建结论）。趋势不调接口、只读快照。
 */
export async function fetchDetailValues(
  github: GitHubPort,
  accessToken: string,
  fullName: string,
): Promise<DetailValues> {
  const releases = await github.listReleases(accessToken, fullName);
  const commits = await github.listCommits(accessToken, fullName);
  const issuesAndPullRequests = await github.listIssues(accessToken, fullName);
  const latestBuild = await github.getLatestBuild(accessToken, fullName);

  const issues: IssueItem[] = [];
  const pullRequests: PullRequestItem[] = [];
  for (const item of issuesAndPullRequests) {
    const { hasPullRequest, ...rest } = item;
    if (hasPullRequest) pullRequests.push(rest);
    else issues.push(rest);
  }

  return {
    releases,
    commits,
    issues,
    pullRequests,
    build: toBuildInfo(latestBuild),
  };
}

/** 构建结论归一为构建状态徽章；没有构建 = "无构建"空态。 */
export function toBuildInfo(run: BuildRun | null): BuildInfo {
  if (run === null) {
    return { status: 'none', conclusion: null, workflowName: null, url: null, finishedAt: null };
  }
  return {
    status: buildStatusOf(run),
    conclusion: run.conclusion,
    workflowName: run.workflowName,
    url: run.url,
    finishedAt: run.finishedAt,
  };
}

function buildStatusOf(run: BuildRun): Exclude<BuildStatus, 'none'> {
  const conclusion = run.conclusion;
  if (conclusion === null) return 'pending';
  if (conclusion === 'success') return 'success';
  if (
    conclusion === 'failure' ||
    conclusion === 'timed_out' ||
    conclusion === 'action_required' ||
    conclusion === 'startup_failure'
  ) {
    return 'failure';
  }
  return 'neutral';
}

/**
 * 全量抓取成功的落库动作。
 * 全量不含元数据调用：指标沿用最近一次轻量抓取的值，最新发版标签以本次发版列表为准；
 * 快照记"抓取时刻已知的最新指标值"（手动刷新同样记档）。
 */
export function applyDetailValues(
  db: Database.Database,
  clock: Clock,
  repositoryId: number,
  values: DetailValues,
): Detail {
  const row = mustFindRepositoryRow(db, repositoryId);

  const capturedAt = clock.now();
  const latestReleaseTag = values.releases[0]?.tagName ?? null;
  // 同 applyGlanceValues：标签与快照同进同退
  db.transaction(() => {
    updateRepositoryLatestRelease(db, repositoryId, latestReleaseTag, capturedAt.toISOString());
    recordSnapshot(
      db,
      repositoryId,
      {
        stars: row.stars,
        forks: row.forks,
        openIssues: row.open_issues,
        latestReleaseTag,
        pushedAt: row.pushed_at,
      },
      capturedAt,
    );
  })();

  return {
    repository: rowToGlance(mustFindRepositoryRow(db, repositoryId)),
    releases: values.releases,
    commits: values.commits,
    issues: values.issues,
    pullRequests: values.pullRequests,
    build: values.build,
    trend: listSnapshots(db, repositoryId),
  };
}
