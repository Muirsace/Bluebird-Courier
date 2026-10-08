// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { makeRepoData } from '../helpers/fake-github';
import { click, createStub, renderApp, repoOpenButton, settle, type RenderResult } from './helpers';
import type { DetailViewSnapshot } from '../../src/renderer/lib/detail-view';

vi.mock('react-chartjs-2', () => import('./chart-stub'));
let harness: Harness | undefined;
let view: RenderResult | undefined;
afterEach(async () => { await view?.unmount(); harness?.destroy(); });

it('真实SQLite和facade打开结果直接进入renderer，首屏展示两日趋势', async () => {
  harness = createHarness();
  await harness.facade.saveAccessToken('ghp_valid_token');
  harness.github.addRepo(makeRepoData());
  const added = await harness.facade.addRepository('octo-demo/hello-world');
  const id = added.repository!.id;
  await harness.facade.fetchDetail(id);
  harness.clock.advanceMs(86400000);
  await harness.facade.refreshGlance();
  const repositories = await harness.facade.listRepositories();
  const stub = createStub({ repositories });
  // 直接使用真实用例返回，不用统一valid状态的renderer桩覆盖主进程契约。
  Object.assign(stub.api, harness.facade);
  view = await renderApp(stub);
  await settle();
  await click(repoOpenButton('octo-demo/hello-world'));
  await settle();
  expect(view.queryClient.getQueryData<DetailViewSnapshot>(['detail', id])?.detail?.trend).toHaveLength(2);
});
