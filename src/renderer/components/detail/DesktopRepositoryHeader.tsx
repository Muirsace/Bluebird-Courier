import type { RepositoryHeaderSlots } from './RepositoryHeaderParts';

/** Workspace header. The existing Shell strip reserves native caption geometry. */
export function DesktopRepositoryHeader({ identity, actions, metrics }: RepositoryHeaderSlots) {
  return (
    <div>
      <header className="desktop-repository-header repository-header">
        <div className="repository-header-top">
          {identity}
          {actions}
        </div>
        {metrics}
      </header>
    </div>
  );
}
