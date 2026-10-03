import type { ReactNode, RefObject } from 'react';
import { AppShell } from './AppShell';
import { DesktopSidebarHeader } from './DesktopSidebarHeader';

interface DesktopAppShellProps {
  sidebar: ReactNode;
  workspace: ReactNode;
  workspaceRef: RefObject<HTMLElement>;
  settingsActive: boolean;
  onGoSettings: () => void;
}

/** Desktop presentation only; App owns the pages, portal hosts and navigation. */
export function DesktopAppShell({ sidebar, workspace, workspaceRef, settingsActive, onGoSettings }: DesktopAppShellProps) {
  return (
    <div className="desktop-app-shell app-frame mx-auto flex min-h-full w-full max-w-6xl flex-col" data-desktop={true}>
      <main className="flex-1 px-4 py-5">
        <AppShell
          rail={null}
          sidebarChrome={<DesktopSidebarHeader settingsActive={settingsActive} onGoSettings={onGoSettings} />}
          workspaceRef={workspaceRef}
          sidebar={sidebar}
          workspace={workspace}
        />
      </main>
    </div>
  );
}
