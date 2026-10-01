import type { ReactNode, RefObject } from 'react';
import { motion } from 'motion/react';

interface AppShellProps {
  rail: ReactNode;
  sidebar: ReactNode;
  workspace: ReactNode;
  workspaceRef?: RefObject<HTMLElement>;
}

/** 只提供槽位与滚动容器；导航、数据和仓库状态全部归 App。 */
export function AppShell({ rail, sidebar, workspace, workspaceRef }: AppShellProps) {
  return (
    <div className="app-shell">
      <div className="app-shell-rail" hidden={rail == null}>{rail}</div>
      {/* 只记录卡片的滚动坐标，不给侧栏添加布局动画或进退场。 */}
      <motion.aside layoutScroll className="app-shell-sidebar" aria-label="仓库侧栏" data-app-scroll-root="sidebar">
        <div className="app-shell-slot-content">{sidebar}</div>
      </motion.aside>
      <section ref={workspaceRef} className="app-shell-workspace" aria-label="工作区" data-app-scroll-root="workspace">
        <div className="app-shell-slot-content">{workspace}</div>
      </section>
    </div>
  );
}
