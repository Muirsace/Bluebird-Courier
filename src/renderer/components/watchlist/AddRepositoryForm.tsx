import { useState } from 'react';
import type { FormEvent } from 'react';
import { Spinner } from '../Spinner';

interface AddRepositoryFormProps {
  adding: boolean;
  /** 返回 true 表示加入成功（此时清空输入框）。 */
  onSubmit: (fullName: string) => Promise<boolean>;
}

/** 添加监控仓库：输入框与「加入」按钮作为一个操作组，加入中禁止重复提交。 */
export function AddRepositoryForm({ adding, onSubmit }: AddRepositoryFormProps) {
  const [value, setValue] = useState('');

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (adding) return;
    const fullName = value.trim();
    if (!fullName) return;
    if (await onSubmit(fullName)) setValue('');
  }

  return (
    <form onSubmit={handleSubmit} className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <input
        type="text"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="owner/repo 或 GitHub 网址"
        aria-label="监控仓库（owner/repo 或 GitHub 网址）"
        className="h-[38px] w-full min-w-0 flex-1 rounded-md border border-strong bg-surface px-3 font-mono text-sm text-primary placeholder:text-muted transition-colors duration-150 ease-out focus:border-focus sm:max-w-md"
      />
      <button
        type="submit"
        disabled={adding}
        aria-busy={adding}
        className="flex h-9 min-w-28 shrink-0 items-center justify-center gap-2 rounded-md bg-accent-solid px-4 text-sm font-medium text-accent-contrast transition-colors duration-150 ease-out hover:bg-accent-solid-hover active:bg-accent-solid-pressed disabled:cursor-not-allowed disabled:opacity-60"
      >
        {adding ? <Spinner className="h-3.5 w-3.5" /> : null}
        {adding ? '加入中…' : '＋ 加入'}
      </button>
    </form>
  );
}
