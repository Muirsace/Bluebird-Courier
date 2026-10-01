import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AddRepositoryResult, Glance, NormalizedError } from '../../../shared/types';
import { parseRepoInput } from '../../lib/repo-input';
import { describeError } from '../../lib/errors';
import { Spinner } from '../Spinner';

export type AddRepositoryPosition = 'visible' | 'offscreen';

export interface AddRepositoryOutcome {
  result: AddRepositoryResult;
  newCardPosition: AddRepositoryPosition;
}

interface RepositoryOmniboxProps {
  /** Desktop 常驻输入外壳；Narrow 继续沿用同一实例的折叠入口。 */
  sidebar?: boolean;
  active?: boolean;
  repositories: Glance[];
  adding: boolean;
  onSubmit: (fullName: string) => Promise<AddRepositoryOutcome>;
  onOpenRepository: (repository: Glance) => void;
  /**
   * 定位刚加入的卡片：实现方必须在调用栈内立即发起滚动（同步），
   * 并在"滚动到位、高亮开始"时调用 onRevealSettled —— 提示要等它之后再停留一会儿。
   */
  onViewPosition: (repositoryId: number, onRevealSettled: () => void) => void;
}

const DUPLICATE_MESSAGE = '该仓库已在监控清单中';
const VISIBLE_SUCCESS_MS = 1400;
/** 「查看位置」到位后提示停留多久：够看完高亮，然后提示与输入框一起收回。 */
const REVEAL_SUCCESS_MS = 700;
const DUPLICATE_ACTION_MS = 1200;
const MESSAGE_EXIT_MS = 130;
const FALLBACK_ERROR: NormalizedError = {
  kind: 'unknown',
  message: '加入清单失败，请稍后重试',
};

type SuccessRepository = {
  repositoryId: number | null;
  fullName: string;
  position: AddRepositoryPosition;
};

type FeedbackState =
  | { kind: 'none' }
  | { kind: 'duplicate'; name: string; repository: Glance | null; phase: 'confirming' | 'manual-clear' }
  | { kind: 'remote-error'; input: string; error: NormalizedError }
  | { kind: 'success'; repository: SuccessRepository; phase: 'confirming' | 'manual-clear' | 'revealing' };

type InlineMessage =
  | { kind: 'invalid' }
  | { kind: 'duplicate'; name: string; repository: Glance | null }
  | { kind: 'remote-error'; input: string; error: NormalizedError }
  | { kind: 'success'; repository: SuccessRepository };
type ActionKind = 'none' | 'clear' | 'join' | 'added';

function findRepository(repositories: Glance[], fullName: string): Glance | null {
  const parsed = parseRepoInput(fullName);
  if (!parsed.ok) return null;
  return (
    repositories.find(
      (repository) =>
        repository.owner.toLowerCase() === parsed.owner.toLowerCase() &&
        repository.name.toLowerCase() === parsed.name.toLowerCase(),
    ) ?? null
  );
}

/** Repository Omnibox 外壳，目前只提供原添加能力，不搜索或过滤仓库。 */
export function RepositoryOmnibox({
  sidebar = false,
  active = true,
  repositories,
  adding,
  onSubmit,
  onOpenRepository,
  onViewPosition,
}: RepositoryOmniboxProps) {
  const [expanded, setExpanded] = useState(false);
  const formOpen = sidebar || expanded;
  const [value, setValue] = useState('');
  const [feedback, setFeedback] = useState<FeedbackState>({ kind: 'none' });
  const [retainedMessage, setRetainedMessage] = useState<InlineMessage | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasExpanded = useRef(false);
  const restoreTriggerFocus = useRef(false);
  const submissionId = useRef(0);
  const valueRef = useRef('');
  const feedbackRef = useRef<FeedbackState>({ kind: 'none' });
  const successTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    submissionId.current += 1;
    if (successTimerRef.current !== null) window.clearTimeout(successTimerRef.current);
  }, []);

  const updateFeedback = (next: FeedbackState): void => {
    feedbackRef.current = next;
    setFeedback(next);
  };
  const cancelSuccessTimer = (): void => {
    if (successTimerRef.current !== null) window.clearTimeout(successTimerRef.current);
    successTimerRef.current = null;
  };

  const parsed = parseRepoInput(value);
  const hasInput = value.trim().length > 0;
  const invalid = hasInput && !parsed.ok;
  const localDuplicate = parsed.ok
    ? findRepository(repositories, `${parsed.owner}/${parsed.name}`)
    : null;
  const duplicateFeedback = feedback.kind === 'duplicate' ? feedback : null;
  const duplicateRepository = duplicateFeedback?.repository ?? localDuplicate;
  const duplicateName = duplicateFeedback?.name ?? duplicateRepository?.fullName ?? null;
  const isDuplicate = duplicateName !== null && hasInput;
  const hasRemoteError = feedback.kind === 'remote-error' && feedback.input === value;
  const successRepository = feedback.kind === 'success' ? feedback.repository : null;

  const currentMessage = useMemo<InlineMessage | null>(() => {
    if (successRepository) return { kind: 'success', repository: successRepository };
    if (isDuplicate) {
      return { kind: 'duplicate', name: duplicateName ?? '', repository: duplicateRepository };
    }
    if (hasRemoteError && feedback.kind === 'remote-error') {
      return { kind: 'remote-error', input: feedback.input, error: feedback.error };
    }
    if (invalid) return { kind: 'invalid' };
    return null;
  }, [
    invalid,
    isDuplicate,
    duplicateName,
    duplicateRepository,
    hasRemoteError,
    feedback,
    successRepository,
  ]);

  const messageId =
    currentMessage?.kind === 'invalid'
      ? 'add-repository-invalid'
      : currentMessage?.kind === 'duplicate'
        ? 'add-repository-duplicate'
        : currentMessage?.kind === 'remote-error'
          ? 'add-repository-error'
          : currentMessage?.kind === 'success'
            ? 'add-repository-success'
            : undefined;
  const messageOpen = formOpen && currentMessage !== null;
  const displayedMessage = currentMessage ?? retainedMessage;
  const requestedAction: ActionKind = !formOpen
    ? 'none'
    : adding
      ? 'join'
      : successRepository
        ? feedback.kind === 'success' && feedback.phase !== 'confirming' ? 'clear' : 'added'
        : isDuplicate
          ? duplicateFeedback?.phase === 'manual-clear' ? 'clear' : 'added'
          : invalid || hasRemoteError
          ? 'clear'
          : 'join';
  const actionVisible = formOpen && hasInput;
  // 定位进行中只锁「查看位置」自己：卡在 revealing（例如目标卡片一直没提交）时，
  // 用户仍然能靠这个按钮清掉成功提示，不留下关不掉的反馈。
  const actionDisabled =
    !actionVisible ||
    adding ||
    (requestedAction === 'join' && !parsed.ok);
  const actionLabel = adding
    ? '加入中…'
    : requestedAction === 'clear'
      ? '清除'
      : requestedAction === 'added'
        ? '已添加'
        : '加入';
  const actionAriaLabel = !actionVisible
    ? undefined
    : adding
      ? '正在加入仓库'
      : requestedAction === 'clear'
        ? '清除输入框'
        : requestedAction === 'added'
          ? '仓库已添加，切换到清除'
          : '加入仓库';

  const collapse = useCallback((returnFocus = false) => {
    if (successTimerRef.current !== null) window.clearTimeout(successTimerRef.current);
    successTimerRef.current = null;
    restoreTriggerFocus.current =
      returnFocus && containerRef.current?.contains(document.activeElement) === true;
    submissionId.current += 1;
    valueRef.current = '';
    setValue('');
    feedbackRef.current = { kind: 'none' };
    setFeedback({ kind: 'none' });
    setExpanded(false);
  }, []);

  function resetToEditing(): void {
    cancelSuccessTimer();
    submissionId.current += 1;
    valueRef.current = '';
    setValue('');
    updateFeedback({ kind: 'none' });
    inputRef.current?.focus();
  }

  useEffect(() => {
    if (!sidebar && active && expanded && !wasExpanded.current) {
      inputRef.current?.focus();
    } else if (!sidebar && active && !expanded && wasExpanded.current && restoreTriggerFocus.current) {
      triggerRef.current?.focus();
    }
    restoreTriggerFocus.current = false;
    wasExpanded.current = expanded;
  }, [expanded, active, sidebar]);

  useEffect(() => {
    if (currentMessage) {
      setRetainedMessage(currentMessage);
      return;
    }
    if (!retainedMessage) return;
    const timeout = window.setTimeout(() => setRetainedMessage(null), MESSAGE_EXIT_MS);
    return () => window.clearTimeout(timeout);
  }, [currentMessage, retainedMessage]);

  useEffect(() => {
    if (!expanded || feedback.kind !== 'success' || feedback.phase !== 'confirming' ||
      feedback.repository.position !== 'visible') return;
    cancelSuccessTimer();
    successTimerRef.current = window.setTimeout(() => {
      if (feedbackRef.current === feedback) collapse();
    }, VISIBLE_SUCCESS_MS);
    return cancelSuccessTimer;
  }, [expanded, feedback, collapse]);

  useEffect(() => {
    if (!expanded || !isDuplicate || duplicateFeedback?.phase === 'manual-clear') return;
    const name = duplicateName;
    const input = value;
    const timeout = window.setTimeout(() => {
      if (valueRef.current !== input || feedbackRef.current.kind === 'success') return;
      const next: FeedbackState = {
        kind: 'duplicate',
        name: name ?? input,
        repository: duplicateRepository,
        phase: 'manual-clear',
      };
      feedbackRef.current = next;
      setFeedback(next);
    }, DUPLICATE_ACTION_MS);
    return () => window.clearTimeout(timeout);
  }, [expanded, isDuplicate, duplicateFeedback?.phase, duplicateName, duplicateRepository, value]);

  useEffect(() => {
    if (!formOpen || !active) return;
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      collapse(true);
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [formOpen, active, collapse]);

  useEffect(() => {
    if (sidebar || !expanded || !active) return;
    function handlePointerDown(event: PointerEvent): void {
      if (containerRef.current?.contains(event.target as Node) || adding) return;
      if (feedbackRef.current.kind !== 'none' || hasInput || isDuplicate) return;
      collapse();
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [expanded, active, hasInput, adding, isDuplicate, collapse, sidebar]);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (
      !formOpen ||
      adding ||
      !parsed.ok ||
      isDuplicate ||
      hasRemoteError ||
      successRepository
    ) {
      return;
    }

    const inputAtSubmit = value;
    const submittedValue = inputAtSubmit.trim();
    const submittedName = `${parsed.owner}/${parsed.name}`;
    cancelSuccessTimer();
    updateFeedback({ kind: 'none' });
    const currentSubmission = ++submissionId.current;
    const outcome = await onSubmit(submittedValue);
    if (currentSubmission !== submissionId.current) return;

    const result = outcome.result;
    if (result.ok) {
      updateFeedback({
        kind: 'success',
        repository: {
          repositoryId: result.repository?.id ?? null,
          fullName: result.repository?.fullName ?? submittedName,
          position: outcome.newCardPosition,
        },
        phase: 'confirming',
      });
      return;
    }

    const resultError = result.error ?? FALLBACK_ERROR;
    if (resultError.message === DUPLICATE_MESSAGE) {
      const name = resultError.fullName ?? submittedValue;
      updateFeedback({
        kind: 'duplicate',
        name,
        repository: findRepository(repositories, name),
        phase: 'confirming',
      });
      return;
    }
    updateFeedback({ kind: 'remote-error', input: inputAtSubmit, error: resultError });
  }

  return (
    <div ref={containerRef} className="watchlist-add-form" data-expanded={formOpen} data-omnibox={sidebar || undefined}>
      {!sidebar ? <button
        ref={triggerRef}
        type="button"
        onClick={() => setExpanded(true)}
        disabled={adding}
        aria-expanded={expanded}
        aria-controls="add-repository-input"
        aria-hidden={expanded}
        tabIndex={expanded ? -1 : 0}
        aria-label="新增仓库"
        className="watchlist-add-trigger inline-flex h-9 items-center justify-center rounded-md bg-accent-solid px-4 text-sm font-medium text-accent-contrast hover:bg-accent-solid-hover active:bg-accent-solid-pressed"
      >
        ＋ 新增仓库
      </button> : null}
      <form
        onSubmit={(event) => void handleSubmit(event)}
        className="watchlist-add-content grid min-w-0"
        data-action-visible={actionVisible}
      >
        <div className="watchlist-add-control-row grid min-w-0 items-start">
          <div className="watchlist-add-field min-w-0" aria-hidden={!formOpen}>
            {sidebar ? <span className="repository-omnibox-icon" aria-hidden="true" /> : null}
            <input
              ref={inputRef}
              id="add-repository-input"
              type="text"
              value={value}
              onChange={(event) => {
                const nextValue = event.target.value;
                // 输入意图随同一实例迁移到 Narrow；空的 Desktop 首屏仍对应折叠 Legacy。
                if (sidebar && nextValue.length > 0) setExpanded(true);
                cancelSuccessTimer();
                valueRef.current = nextValue;
                setValue(nextValue);
                const duplicate = findRepository(repositories, nextValue);
                updateFeedback(duplicate
                  ? { kind: 'duplicate', name: duplicate.fullName, repository: duplicate, phase: 'confirming' }
                  : { kind: 'none' });
              }}
              placeholder={sidebar ? '输入 owner/repo 添加仓库…' : 'owner/repo 或 GitHub 网址'}
              aria-label="监控仓库（owner/repo 或 GitHub 网址）"
              aria-invalid={invalid || hasRemoteError || undefined}
              aria-describedby={messageOpen ? messageId : undefined}
              disabled={!formOpen || adding}
              tabIndex={formOpen ? 0 : -1}
              className={`h-9 w-full min-w-0 rounded-md border bg-surface px-3 font-mono text-sm text-primary placeholder:text-muted transition-colors duration-150 ease-out focus:outline-none focus:ring-2 focus:ring-focus/15 ${
                invalid || hasRemoteError
                  ? 'border-warning focus:border-warning'
                  : 'border-strong focus:border-focus'
              }`}
            />
          </div>
          <button
            type={requestedAction === 'join' ? 'submit' : 'button'}
            onClick={() => {
              if (requestedAction === 'clear') {
                resetToEditing();
              } else if (requestedAction === 'added') {
                cancelSuccessTimer();
                if (feedbackRef.current.kind === 'success') {
                  updateFeedback({ ...feedbackRef.current, phase: 'manual-clear' });
                } else if (duplicateName) {
                  updateFeedback({
                    kind: 'duplicate',
                    name: duplicateName,
                    repository: duplicateRepository,
                    phase: 'manual-clear',
                  });
                }
              }
            }}
            disabled={actionDisabled}
            aria-hidden={!actionVisible}
            tabIndex={actionVisible ? 0 : -1}
            aria-busy={adding}
            aria-label={actionAriaLabel}
            className={`watchlist-add-action relative inline-flex h-9 self-start items-center justify-center rounded-md px-2 text-sm font-medium disabled:cursor-not-allowed ${
              requestedAction === 'added'
                ? 'border border-default bg-surface-raised text-secondary'
                : requestedAction === 'clear'
                  ? 'border border-default bg-surface-raised text-secondary hover:bg-surface-hover active:bg-surface-active'
                  : adding
                    ? 'border border-transparent bg-accent-solid text-accent-contrast'
                    : actionDisabled
                      ? 'border border-default bg-surface-raised text-muted'
                      : 'border border-transparent bg-accent-solid text-accent-contrast hover:bg-accent-solid-hover active:bg-accent-solid-pressed'
            }`}
          >
            <span className="watchlist-add-action-label" aria-hidden="true">
              {adding ? <Spinner className="watchlist-add-spinner h-3.5 w-3.5" /> : null}
              <span>{actionLabel}</span>
              {requestedAction === 'added' ? <span className="text-success">{' '}✓</span> : null}
            </span>
          </button>
        </div>
        <div
          className="watchlist-inline-message"
          data-open={messageOpen}
          aria-hidden={!messageOpen}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="pt-1.5">
              {displayedMessage?.kind === 'invalid' ? (
                <p
                  id="add-repository-invalid"
                  aria-live="polite"
                  className="add-repository-status min-h-5 text-xs text-warning"
                >
                  请输入 owner/repo 或 GitHub 仓库地址
                </p>
              ) : displayedMessage?.kind === 'duplicate' ? (
                <div
                  id="add-repository-duplicate"
                  role="status"
                  className={`add-repository-status flex min-h-5 min-w-0 items-center gap-1 text-xs text-secondary ${sidebar ? 'flex-wrap' : 'overflow-hidden whitespace-nowrap'}`}
                >
                  <span aria-hidden="true" className="shrink-0 font-medium text-success">
                    ✓
                  </span>
                  {!sidebar ? <span className="min-w-0 truncate font-mono" title={displayedMessage.name}>
                    {displayedMessage.name}
                  </span> : null}
                  <span className="shrink-0">已在监控清单中 ·</span>
                  <button
                    type="button"
                    disabled={!messageOpen || !displayedMessage.repository}
                    tabIndex={messageOpen && displayedMessage.repository ? 0 : -1}
                    aria-label={`打开 ${displayedMessage.name || '已监控仓库'} 详情`}
                    onClick={() => {
                      if (!displayedMessage.repository) return;
                      onOpenRepository(displayedMessage.repository);
                    }}
                    className="shrink-0 text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    打开详情
                  </button>
                </div>
              ) : displayedMessage?.kind === 'remote-error' ? (
                <p
                  id="add-repository-error"
                  role="alert"
                  className="add-repository-status min-h-5 break-words text-xs text-danger"
                >
                  {describeError(displayedMessage.error)}
                </p>
              ) : displayedMessage?.kind === 'success' ? (
                <div
                  id="add-repository-success"
                  role="status"
                  className="add-repository-status flex min-h-5 min-w-0 flex-wrap items-center gap-x-1 text-xs text-success"
                >
                  <span aria-hidden="true" className="shrink-0 font-medium">✓</span>
                  {' '}
                  <span className="min-w-0 [overflow-wrap:anywhere] font-mono">
                    {displayedMessage.repository.fullName}
                  </span>
                  {' '}
                  <span>已加入监控清单</span>
                  {displayedMessage.repository.position === 'offscreen' &&
                  displayedMessage.repository.repositoryId !== null ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <button
                        type="button"
                        disabled={!messageOpen || feedback.kind === 'success' && feedback.phase === 'revealing'}
                        tabIndex={messageOpen && feedback.kind === 'success' && feedback.phase !== 'revealing' ? 0 : -1}
                        onClick={() => {
                          const repositoryId = displayedMessage.repository.repositoryId;
                          if (repositoryId === null || feedbackRef.current.kind !== 'success' ||
                            feedbackRef.current.phase === 'revealing') return;
                          const revealing: FeedbackState = {
                            ...feedbackRef.current,
                            phase: 'revealing',
                          };
                          feedbackRef.current = revealing;
                          // 顺序固定：先让页面开始定位（同步），再安排收尾。
                          // 收尾不在到位那一刻发生——到位后提示还要停留一段，用户才看得见高亮；
                          // 停留结束连同输入框一起收回，不留一个空表单占着版面。
                          onViewPosition(repositoryId, () => {
                            if (feedbackRef.current !== revealing) return;
                            cancelSuccessTimer();
                            successTimerRef.current = window.setTimeout(() => {
                              if (feedbackRef.current === revealing) collapse();
                            }, REVEAL_SUCCESS_MS);
                          });
                          cancelSuccessTimer();
                          setFeedback(revealing);
                        }}
                        className="shrink-0 font-medium text-accent hover:underline disabled:cursor-not-allowed"
                      >
                        查看位置
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
