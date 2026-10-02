import type { ReactNode, RefObject } from 'react';

interface AppShellProps {
  rail: ReactNode;
  sidebar: ReactNode;
  sidebarChrome: ReactNode;
  workspace: ReactNode;
  workspaceRef?: RefObject<HTMLElement>;
}

/** 只提供槽位与滚动容器；导航、数据和仓库状态全部归 App。 */
export function AppShell({ rail, sidebar, sidebarChrome, workspace, workspaceRef }: AppShellProps) {
  return (
    <div className="app-shell">
      <div className="app-shell-rail" hidden={rail == null}>{rail}</div>
      <aside className="app-shell-sidebar" aria-label="仓库侧栏">
        {sidebarChrome}
        <div className="app-shell-sidebar-body">{sidebar}</div>
      </aside>
      <section ref={workspaceRef} className="app-shell-workspace" aria-label="工作区" data-app-scroll-root="workspace">
        <div className="app-shell-window-drag-strip window-drag-region" aria-hidden="true" />
        <div className="app-shell-slot-content">{workspace}</div>
      </section>
    </div>
  );
}
