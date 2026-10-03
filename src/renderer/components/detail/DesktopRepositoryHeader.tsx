import type { RepositoryHeaderSlots } from './RepositoryHeaderParts';

/** Workspace header. The existing Shell strip reserves native caption geometry. */
export function DesktopRepositoryHeader({ identity, actions, metrics }: RepositoryHeaderSlots) {
  return (
    <div>
      <header className="desktop-repository-header repository-header rounded-lg border border-subtle bg-surface p-4">
        <div className="repository-header-top flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          {identity}
          {actions}
        </div>
        {metrics}
      </header>
    </div>
  );
}
