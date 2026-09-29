import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AddRepositoryResult, Glance, NormalizedError } from '../../../shared/types';
import { parseRepoInput } from '../../../shared/repo-input';
import { describeError } from '../../lib/errors';
import { Spinner } from '../Spinner';

interface AddRepositoryFormProps {
  repositories: Glance[];
  adding: boolean;
  onSubmit: (fullName: string) => Promise<AddRepositoryResult>;
  onOpenRepository: (repository: Glance) => void;
}

const DUPLICATE_MESSAGE = '该仓库已在监控清单中';
const ADDED_NOTICE_MS = 1000;
const FALLBACK_ERROR: NormalizedError = {
  kind: 'unknown',
  message: '加入清单失败，请稍后重试',
};

type InlineMessage =
  | { kind: 'invalid' }
  | { kind: 'duplicate'; name: string; repository: Glance | null }
  | { kind: 'error'; error: NormalizedError };
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

/** 添加仓库：默认折叠，复用主进程同一输入解析规则，重复项直接使用已加载清单判断。 */
export function AddRepositoryForm({
  repositories,
  adding,
  onSubmit,
  onOpenRepository,
}: AddRepositoryFormProps) {
  const [expanded, setExpanded] = useState(false);
  const [value, setValue] = useState('');
  const [confirmedName, setConfirmedName] = useState<string | null>(null);
  const [clearReady, setClearReady] = useState(false);
  const [autoClearPending, setAutoClearPending] = useState(false);
  const [lastAction, setLastAction] = useState<Exclude<ActionKind, 'none'>>('join');
  const [error, setError] = useState<NormalizedError | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const wasExpanded = useRef(false);
  const restoreTriggerFocus = useRef(false);
  const submissionId = useRef(0);

  const parsed = parseRepoInput(value);
  const hasInput = value.trim().length > 0;
  const invalid = hasInput && !parsed.ok;
  const localDuplicate = parsed.ok
    ? findRepository(repositories, `${parsed.owner}/${parsed.name}`)
    : null;
  const confirmedRepository = confirmedName ? findRepository(repositories, confirmedName) : null;
  const duplicateRepository = localDuplicate ?? confirmedRepository;
  const duplicateName = duplicateRepository?.fullName ?? confirmedName;
  const isDuplicate = duplicateName !== null;
  const describedBy = invalid
    ? 'add-repository-invalid'
    : isDuplicate
      ? 'add-repository-duplicate'
      : error
        ? 'add-repository-error'
        : undefined;

  const currentMessage = useMemo<InlineMessage | null>(() => {
    if (invalid) return { kind: 'invalid' };
    if (isDuplicate && !autoClearPending) {
      return { kind: 'duplicate', name: duplicateName ?? '', repository: duplicateRepository };
    }
    if (error) return { kind: 'error', error };
    return null;
  }, [invalid, isDuplicate, duplicateName, duplicateRepository, error, autoClearPending]);
  const [retainedMessage, setRetainedMessage] = useState<InlineMessage | null>(null);
  const displayedMessage = currentMessage ?? retainedMessage;
  const messageOpen = expanded && currentMessage !== null;
  const requestedAction: ActionKind = !expanded || !hasInput
    ? 'none'
    : invalid || (isDuplicate && clearReady)
      ? 'clear'
      : isDuplicate
        ? 'added'
        : 'join';
  const actionVisible = requestedAction !== 'none';
  const displayedAction = requestedAction === 'none' ? lastAction : requestedAction;
  const actionLabel = adding
    ? '加入中…'
    : displayedAction === 'clear'
      ? '清除'
      : displayedAction === 'added'
        ? '已添加'
        : '加入';
  const actionAriaLabel = !actionVisible
    ? undefined
    : adding
      ? '正在加入仓库'
      : requestedAction === 'clear'
        ? '清除输入框'
        : requestedAction === 'added'
          ? '仓库已添加，点击清除'
          : '加入仓库';

  const collapse = useCallback((returnFocus = false) => {
    restoreTriggerFocus.current = returnFocus;
    submissionId.current += 1;
    setValue('');
    setConfirmedName(null);
    setClearReady(false);
    setAutoClearPending(false);
    setError(null);
    setExpanded(false);
  }, []);

  useEffect(() => {
    if (expanded) {
      inputRef.current?.focus();
    } else if (wasExpanded.current && restoreTriggerFocus.current) {
      triggerRef.current?.focus();
    }
    restoreTriggerFocus.current = false;
    wasExpanded.current = expanded;
  }, [expanded]);

  useEffect(() => {
    if (currentMessage) {
      setRetainedMessage(currentMessage);
      return;
    }
    if (!retainedMessage) return;
    const timeout = window.setTimeout(() => setRetainedMessage(null), 130);
    return () => window.clearTimeout(timeout);
  }, [currentMessage, retainedMessage]);

  useEffect(() => {
    if (requestedAction !== 'none') setLastAction(requestedAction);
  }, [requestedAction]);

  useEffect(() => {
    if (!expanded || !isDuplicate || adding || clearReady || autoClearPending) return;
    const timeout = window.setTimeout(() => setClearReady(true), ADDED_NOTICE_MS);
    return () => window.clearTimeout(timeout);
  }, [expanded, value, isDuplicate, adding, clearReady, autoClearPending]);

  useEffect(() => {
    if (!expanded || !autoClearPending || adding) return;
    const timeout = window.setTimeout(() => {
      setValue('');
      setConfirmedName(null);
      setClearReady(false);
      setAutoClearPending(false);
      collapse(true);
    }, ADDED_NOTICE_MS);
    return () => window.clearTimeout(timeout);
  }, [expanded, autoClearPending, adding, collapse]);

  useEffect(() => {
    if (!expanded) return;
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      collapse(true);
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [expanded, collapse]);

  useEffect(() => {
    if (!expanded) return;
    function handlePointerDown(event: PointerEvent): void {
      if (containerRef.current?.contains(event.target as Node)) return;
      if (value.trim() !== '' || adding) return;
      collapse();
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [expanded, value, adding, collapse]);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!expanded || adding || !parsed.ok || isDuplicate) return;

    setError(null);
    setConfirmedName(null);
    const currentSubmission = ++submissionId.current;
    const result = await onSubmit(value.trim());
    if (currentSubmission !== submissionId.current) return;
    if (result.ok) {
      setConfirmedName(result.repository?.fullName ?? `${parsed.owner}/${parsed.name}`);
      setClearReady(false);
      setAutoClearPending(true);
      return;
    }

    const resultError = result.error ?? FALLBACK_ERROR;
    if (resultError.message === DUPLICATE_MESSAGE) {
      setConfirmedName(resultError.fullName ?? value.trim());
      setClearReady(false);
      setError(null);
      return;
    }
    setError(resultError);
  }

  return (
    <div ref={containerRef} className="watchlist-add-form" data-expanded={expanded}>
      <button
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
      </button>
      <form
        onSubmit={(event) => void handleSubmit(event)}
        data-action-visible={actionVisible}
        className="watchlist-add-content grid min-w-0"
      >
        <div className="watchlist-add-control-row grid min-w-0 grid-cols-[minmax(0,1fr)_6rem] items-start gap-x-2">
          <div className="watchlist-add-field min-w-0" aria-hidden={!expanded}>
            <input
              ref={inputRef}
              id="add-repository-input"
              type="text"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
                setConfirmedName(null);
                setClearReady(false);
                setAutoClearPending(false);
              }}
              placeholder="owner/repo 或 GitHub 网址"
              aria-label="监控仓库（owner/repo 或 GitHub 网址）"
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              disabled={!expanded || adding}
              tabIndex={expanded ? 0 : -1}
              className={`h-9 w-full min-w-0 rounded-md border bg-surface px-3 font-mono text-sm text-primary placeholder:text-muted transition-colors duration-150 ease-out focus:outline-none focus:ring-2 focus:ring-focus/15 ${
                invalid ? 'border-warning focus:border-warning' : 'border-strong focus:border-focus'
              }`}
            />
          </div>
          <button
            ref={actionRef}
            type={requestedAction === 'join' ? 'submit' : 'button'}
            onClick={() => {
              if (requestedAction === 'clear') {
                setValue('');
                setConfirmedName(null);
                setError(null);
                setClearReady(false);
                setAutoClearPending(false);
                inputRef.current?.focus();
              } else if (requestedAction === 'added') {
                setAutoClearPending(false);
                setClearReady(true);
              }
            }}
            disabled={!actionVisible || adding}
            aria-hidden={!actionVisible}
            tabIndex={actionVisible ? 0 : -1}
            aria-busy={adding}
            aria-label={actionAriaLabel}
            className={`watchlist-add-action relative inline-flex h-9 self-start items-center justify-center rounded-md px-2 text-sm font-medium disabled:cursor-not-allowed ${
              displayedAction !== 'join'
                ? 'border border-default bg-surface-raised text-secondary hover:bg-surface-hover active:bg-surface-active'
                : 'border border-transparent bg-accent-solid text-accent-contrast hover:bg-accent-solid-hover active:bg-accent-solid-pressed'
            }`}
          >
            <span className="watchlist-add-action-label" aria-hidden="true">
              {adding ? <Spinner className="watchlist-add-spinner h-3.5 w-3.5" /> : null}
              <span>{actionLabel}</span>
              {displayedAction === 'added' ? <span className="text-success">✓</span> : null}
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
                  className="add-repository-status min-h-5 text-xs text-warning"
                  aria-live="polite"
                >
                  请输入 owner/repo 或 GitHub 仓库地址
                </p>
              ) : displayedMessage?.kind === 'duplicate' ? (
                <div
                  id="add-repository-duplicate"
                  role="status"
                  className="add-repository-status flex min-h-5 min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-xs text-secondary"
                >
                  <span aria-hidden="true" className="shrink-0 font-medium text-success">
                    ✓
                  </span>
                  <span className="min-w-0 truncate font-mono" title={displayedMessage.name}>
                    {displayedMessage.name}
                  </span>
                  <span className="shrink-0">已在监控清单中 ·</span>
                  <button
                    type="button"
                    disabled={!messageOpen || !displayedMessage.repository}
                    tabIndex={messageOpen && displayedMessage.repository ? 0 : -1}
                    aria-label={`打开 ${displayedMessage.name || '已监控仓库'} 详情`}
                    onClick={() => {
                      if (!displayedMessage.repository) return;
                      collapse();
                      onOpenRepository(displayedMessage.repository);
                    }}
                    className="shrink-0 text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    打开详情
                  </button>
                </div>
              ) : displayedMessage?.kind === 'error' ? (
                <p
                  id="add-repository-error"
                  role="alert"
                  className="add-repository-status min-h-5 break-words text-xs text-danger"
                >
                  {describeError(displayedMessage.error)}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
