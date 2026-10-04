import { useCallback, useState } from 'react';

/** Portal 容器归页面 owner 持有；换布局槽位不更换容器，也就不重挂页面。 */
export function usePageHost(): HTMLDivElement {
  const [host] = useState(() => {
    const element = document.createElement('div');
    element.className = 'responsive-page-host';
    return element;
  });
  return host;
}

/** 只迁移不含 React 自己管理 children 的宿主；未显示的页面留在 document 外。 */
export function PageSlot({ host }: { host: HTMLElement }) {
  const attach = useCallback((slot: HTMLDivElement | null): void => {
    if (slot) slot.appendChild(host);
    else host.remove();
  }, [host]);
  return <div ref={attach} className="responsive-page-slot" />;
}
