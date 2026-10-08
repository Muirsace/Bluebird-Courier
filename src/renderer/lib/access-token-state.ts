import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import type { AccessTokenState } from '../../shared/types';
import { getApi } from './api';

/**
 * 权威“已完成清理”的访问上下文版本，按 QueryClient 隔离（每个应用运行时一份）。
 *
 * 令牌更换一旦提交就推进了访问上下文；清理完成是同一修订号下的终态。此后同版本或更旧的
 * 迟到 pending 回包只可能是过时读取，不能把界面退回待清理状态；只有更大的修订号才代表
 * 一次新的更换。
 */
const resolvedCleanupRevisions = new WeakMap<QueryClient, number>();
/** 已接收的最高上下文事实；查询与操作回包共用，不能让旧完成态覆盖新待清理态。 */
const acceptedStates = new WeakMap<QueryClient, AccessTokenState>();

function newerState(current: AccessTokenState | undefined, incoming: AccessTokenState): AccessTokenState {
  if (!current) return incoming;
  const revision = current.accessContextRevision;
  const next = incoming.accessContextRevision;
  if (revision !== undefined && (next === undefined || next < revision)) return current;
  if (revision === next && current.cleanupPending === false && incoming.cleanupPending === true) return current;
  return incoming;
}

function reconcileState(queryClient: QueryClient, incoming: AccessTokenState): AccessTokenState {
  const cached = queryClient.getQueryData<AccessTokenState>(['accessTokenState']);
  let current = acceptedStates.get(queryClient);
  if (cached) current = newerState(current, cached);
  let next = newerState(current, incoming);
  const resolved = resolvedCleanupRevisions.get(queryClient);
  if (resolved !== undefined && next.accessContextRevision !== undefined && next.accessContextRevision <= resolved) {
    next = { ...next, cleanupPending: false };
  }
  if (next.cleanupPending === false && next.accessContextRevision !== undefined) {
    resolvedCleanupRevisions.set(queryClient, Math.max(resolved ?? -1, next.accessContextRevision));
  }
  acceptedStates.set(queryClient, next);
  return next;
}

/** 发布操作事实并返回是否仍属当前上下文；迟到操作不能清除新上下文的Query或恢复旧状态。 */
export function publishAccessTokenState(queryClient: QueryClient, incoming: AccessTokenState): boolean {
  const next = reconcileState(queryClient, incoming);
  queryClient.setQueryData(['accessTokenState'], next);
  return next.accessContextRevision === incoming.accessContextRevision && next.cleanupPending === incoming.cleanupPending;
}

export interface AccessTokenStateView {
  configured: boolean;
  /** 真的存在未完成的持久清理意图；已被更新的完成事实压过的旧 pending 不算。 */
  cleanupPending: boolean;
  accessContextRevision: number | undefined;
  hasData: boolean;
  isPending: boolean;
  isError: boolean;
  refetch(): void;
  /** 记录一次权威的“清理已完成”事实，供同版本迟到的旧 pending 回包比对。 */
  resolveCleanup(accessContextRevision: number | undefined): void;
}

/**
 * 读取本机访问令牌状态（无网络、无明文的本地读取）。
 *
 * 该状态在应用启动、设置页挂载与令牌更换后都会被消费：这里统一处理两件事——
 * 一是离线也要能读到真实的 pending（networkMode:'always'），
 * 二是按访问上下文修订号保护 pending 状态，避免较旧的迟到回包覆盖已完成清理的事实。
 */
export function useAccessTokenState(): AccessTokenStateView {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['accessTokenState'],
    queryFn: async () => reconcileState(queryClient, await getApi().accessTokenState()),
    networkMode: 'always',
  });
  const data = query.data === undefined ? undefined : reconcileState(queryClient, query.data);
  const revision = data?.accessContextRevision;
  const resolved = resolvedCleanupRevisions.get(queryClient);
  const suppressedPending =
    data?.cleanupPending === true &&
    resolved !== undefined &&
    revision !== undefined &&
    revision <= resolved;
  return {
    configured: data?.configured ?? false,
    cleanupPending: data?.cleanupPending === true && !suppressedPending,
    accessContextRevision: revision,
    hasData: data !== undefined,
    isPending: query.isPending,
    isError: query.isError,
    refetch: () => {
      void query.refetch();
    },
    resolveCleanup(accessContextRevision) {
      if (accessContextRevision !== undefined) {
        const current = resolvedCleanupRevisions.get(queryClient);
        resolvedCleanupRevisions.set(
          queryClient,
          current === undefined ? accessContextRevision : Math.max(current, accessContextRevision),
        );
      }
      const previous = queryClient.getQueryData<AccessTokenState>(['accessTokenState']);
      publishAccessTokenState(queryClient, {
        ...(previous ?? { configured: true }),
        configured: true,
        cleanupPending: false,
        ...(accessContextRevision !== undefined
          ? { accessContextRevision }
          : previous?.accessContextRevision !== undefined
            ? { accessContextRevision: previous.accessContextRevision }
            : {}),
      });
    },
  };
}
