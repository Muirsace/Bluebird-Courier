import { useCallback, useEffect, useRef, useState } from 'react';
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
const FALLBACK_ERROR: NormalizedError = {
  kind: 'unknown',
  message: '加入清单失败，请稍后重试',
};

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
  const [serverDuplicateName, setServerDuplicateName] = useState<string | null>(null);
  const [error, setError] = useState<NormalizedError | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasExpanded = useRef(false);
  const submissionId = useRef(0);

  const parsed = parseRepoInput(value);
  const hasInput = value.trim().length > 0;
  const invalid = hasInput && !parsed.ok;
  const localDuplicate = parsed.ok
    ? findRepository(repositories, `${parsed.owner}/${parsed.name}`)
    : null;
  const serverDuplicate = serverDuplicateName ? findRepository(repositories, serverDuplicateName) : null;
  const duplicateRepository = localDuplicate ?? serverDuplicate;
  const duplicateName = duplicateRepository?.fullName ?? serverDuplicateName;
  const isDuplicate = duplicateName !== null;
  const describedBy = invalid
    ? 'add-repository-invalid'
    : isDuplicate
      ? 'add-repository-duplicate'
      : error
        ? 'add-repository-error'
        : undefined;

  const collapse = useCallback(() => {
    submissionId.current += 1;
    setValue('');
    setServerDuplicateName(null);
    setError(null);
    setExpanded(false);
  }, []);

  useEffect(() => {
    if (expanded) {
      inputRef.current?.focus();
    } else if (wasExpanded.current) {
      triggerRef.current?.focus();
    }
    wasExpanded.current = expanded;
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      collapse();
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
    if (adding || !parsed.ok || isDuplicate) return;

    setError(null);
    setServerDuplicateName(null);
    const currentSubmission = ++submissionId.current;
    const result = await onSubmit(value.trim());
    if (currentSubmission !== submissionId.current) return;
    if (result.ok) {
      collapse();
      return;
    }

    const resultError = result.error ?? FALLBACK_ERROR;
    if (resultError.message === DUPLICATE_MESSAGE) {
      setServerDuplicateName(resultError.fullName ?? value.trim());
      setError(null);
      return;
    }
    setError(resultError);
  }

  return (
    <div
      ref={containerRef}
      className={`watchlist-add-form ${expanded ? 'min-w-0 max-w-lg flex-[1_1_24rem]' : 'shrink-0'}`}
    >
      {expanded ? (
        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2"
        >
          <div className="min-w-0">
            <input
              ref={inputRef}
              id="add-repository-input"
              type="text"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
                setServerDuplicateName(null);
              }}
              placeholder="owner/repo 或 GitHub 网址"
              aria-label="监控仓库（owner/repo 或 GitHub 网址）"
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              disabled={adding}
              className={`h-[38px] w-full min-w-0 rounded-md border bg-surface px-3 font-mono text-sm text-primary placeholder:text-muted transition-colors duration-150 ease-out focus:outline-none focus:ring-2 focus:ring-focus/15 ${
                invalid ? 'border-warning focus:border-warning' : 'border-strong focus:border-focus'
              }`}
            />

            {invalid ? (
              <p
                id="add-repository-invalid"
                className="add-repository-status mt-1 min-h-5 text-xs text-warning"
                aria-live="polite"
              >
                请输入 owner/repo 或 GitHub 仓库地址
              </p>
            ) : isDuplicate ? (
              <div
                id="add-repository-duplicate"
                role="status"
                className="add-repository-status mt-1.5 flex h-5 min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-xs text-secondary"
              >
                <span aria-hidden="true" className="shrink-0 font-medium text-success">
                  ✓
                </span>
                <span className="min-w-0 truncate font-mono" title={duplicateName ?? undefined}>
                  {duplicateName}
                </span>
                <span className="shrink-0">已在监控清单中 ·</span>
                <button
                  type="button"
                  disabled={!duplicateRepository}
                  aria-label={`查看 ${duplicateName ?? '已监控仓库'}`}
                  onClick={() => {
                    if (!duplicateRepository) return;
                    collapse();
                    onOpenRepository(duplicateRepository);
                  }}
                  className="shrink-0 text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                >
                  查看
                </button>
              </div>
            ) : error ? (
              <p
                id="add-repository-error"
                role="alert"
                className="add-repository-status mt-1 min-h-5 break-words text-xs text-danger"
              >
                {describeError(error)}
              </p>
            ) : null}
          </div>
          <button
            type="submit"
            disabled={adding || !parsed.ok || isDuplicate}
            aria-busy={adding}
            aria-label={adding ? '正在加入仓库' : isDuplicate ? '仓库已添加' : '加入仓库'}
            className={`inline-flex h-[38px] w-24 self-start items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors duration-150 ease-out disabled:cursor-not-allowed ${
              isDuplicate
                ? 'border border-default bg-surface-raised text-secondary'
                : 'bg-accent-solid text-accent-contrast hover:bg-accent-solid-hover active:bg-accent-solid-pressed disabled:opacity-60'
            }`}
          >
            {adding ? <Spinner className="h-3.5 w-3.5" /> : null}
            <span>{adding ? '加入中…' : isDuplicate ? '已添加' : '加入'}</span>
            {isDuplicate ? <span aria-hidden="true" className="text-success">✓</span> : null}
          </button>
        </form>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setExpanded(true)}
          disabled={adding}
          aria-expanded={false}
          aria-label="新增仓库"
          className="inline-flex h-[38px] items-center justify-center rounded-md bg-accent-solid px-4 text-sm font-medium text-accent-contrast transition-colors duration-150 ease-out hover:bg-accent-solid-hover active:bg-accent-solid-pressed"
        >
          ＋ 新增仓库
        </button>
      )}
    </div>
  );
}
