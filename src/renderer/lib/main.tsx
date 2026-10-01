import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { App } from '../pages/App';
import { ThemeProvider } from './theme';
import '../styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      // 窗口重新获焦或页面来回切换不该触发重抓：详情页一次全量 = 4 次 GitHub 调用 + 写当日快照。
      // 需要新数据时由用户显式触发（重新抓取），或在增删后 invalidateQueries。
      refetchOnWindowFocus: false,
      staleTime: 60_000,
    },
  },
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('未找到根节点 #root');
}

createRoot(container).render(
  <QueryClientProvider client={queryClient}>
    <ThemeProvider>
      <MotionConfig reducedMotion="user">
        <App />
      </MotionConfig>
    </ThemeProvider>
  </QueryClientProvider>,
);
