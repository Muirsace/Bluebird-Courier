import type { RepositoryHeaderSlots } from './RepositoryHeaderParts';

interface NarrowRepositoryHeaderProps extends RepositoryHeaderSlots {
  onBack: () => void;
}

/** Single-column header and its existing Back affordance beneath the global header. */
export function NarrowRepositoryHeader({ identity, actions, metrics, onBack }: NarrowRepositoryHeaderProps) {
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex h-9 items-center rounded-md border border-default px-3 text-sm text-primary transition-colors duration-150 ease-out hover:bg-surface-hover active:bg-surface-active"
      >
        ← 返回监控清单
      </button>
      <header className="narrow-repository-header repository-header rounded-lg border border-subtle bg-surface p-4">
        <div className="repository-header-top flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          {identity}
          {actions}
        </div>
        {metrics}
      </header>
    </div>
  );
}
