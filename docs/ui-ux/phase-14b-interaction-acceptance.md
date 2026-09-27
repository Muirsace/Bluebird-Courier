# Phase 14B · Interaction Acceptance Record

**Date:** 2026-09-27

**Result:** Renderer interaction and visual checks passed; pause for user review before Full Manual Acceptance / RC.

## Test setup

- Tested the built Renderer bundle `index-WDRSsg7L.js` with `index-B09VzUR7.css` in the local browser preview.
- The preview uses a local fixture bridge for repositories, settings, refresh, and token validation. It made no GitHub API requests and did not use the Electron IPC / database path.
- Viewports: **480 × 800**, **768 × 900**, and **1152 × 1000**. The browser's document/body widths stayed within the viewport at each size.
- Loading screenshots use a fixture-held promise; the test controls are hidden in the captured UI.

## Interaction checks

- Detail tabs: ArrowRight moved from Releases to Commits in the preview. Automated coverage also checks ArrowLeft, ArrowRight, Home, End, selection, and retained focus in `tests/renderer/detail-data.test.tsx`.
- Repository menu: ArrowDown moved focus to the remove action; Escape closed the menu and restored focus to its trigger. Automated coverage checks ArrowUp, ArrowDown, Home, End, Escape, Tab exit, and focus leaving the menu in `tests/renderer/repository-actions.test.tsx`.
- Focus-visible outlines remain visible on tabs and actions; menu actions expose their accessible names and the danger action stays text labeled.
- A held refresh showed a disabled **刷新中…** button while existing repository data remained visible. No external request was made.
- Light and Dark use the same component states. The final CSS includes themed native Chromium scrollbars and a `prefers-reduced-motion` rule that removes overlay motion and shortens transitions. The Windows / Electron OS preference was not changed or simulated; smoke-check that setting during Full Manual Acceptance.

## Responsive checks

| Viewport | Evidence |
|---|---|
| 480 × 800 | Watchlist, detail overview, build, settings, menu, and remove popover fit without horizontal overflow. Menu right edge: 447px; remove popover: 159–447px. |
| 768 × 900 | Watchlist fits the viewport without horizontal overflow. |
| 1152 × 1000 | Watchlist, detail tabs, settings, menus, and loading state fit without horizontal overflow. Settings input measured 748px wide; at 480px it measured 356px. |

## Screenshot evidence

All images below were captured from the final built Renderer with fixture controls hidden, except the refresh state which shows only product UI.

### Watchlist and overlays

- Light 480px: [watchlist](screenshots/phase-14b/watchlist-light-480-final.png), [menu](screenshots/phase-14b/watchlist-menu-480-light-final.png), [remove popover](screenshots/phase-14b/watchlist-remove-popover-480-light-final.png)
- Light 768px: [watchlist](screenshots/phase-14b/watchlist-light-768-final.png)
- Light 1152px: [watchlist](screenshots/phase-14b/watchlist-light-1152-final.png), [refresh loading](screenshots/phase-14b/watchlist-loading-light-1152-final.png)
- Dark 1152px: [watchlist](screenshots/phase-14b/watchlist-dark-1152-final.png), [menu](screenshots/phase-14b/watchlist-menu-dark-1152-final.png), [focused danger action](screenshots/phase-14b/watchlist-menu-danger-focus-dark-1152-final.png)

### Detail

- Light 480px: [overview](screenshots/phase-14b/detail-overview-light-480-final.png), [build](screenshots/phase-14b/detail-build-light-480-final.png)
- Light 1152px: [overview](screenshots/phase-14b/detail-overview-light-1152-final.png), [release](screenshots/phase-14b/detail-release-light-1152-final.png), [commits with tab focus](screenshots/phase-14b/detail-commits-focus-light-1152-final.png), [Issue & PR empty state](screenshots/phase-14b/detail-issues-empty-light-1152-final.png), [build action focus](screenshots/phase-14b/detail-build-focus-light-1152-final.png), [30D trend focus](screenshots/phase-14b/detail-trend-range-focus-light-1152-final.png)
- Dark 1152px: [overview](screenshots/phase-14b/detail-overview-dark-1152-final.png), [build](screenshots/phase-14b/detail-build-dark-1152-final.png), [30D trend](screenshots/phase-14b/detail-trend-range-focus-dark-1152-final.png)

### Settings

- Light: [480px](screenshots/phase-14b/settings-light-480-final.png), [1152px](screenshots/phase-14b/settings-light-1152-final.png)
- Dark 1152px: [settings](screenshots/phase-14b/settings-dark-1152-final.png)

## Limits

- This is a visual / interaction record, not the Full Manual Acceptance run. Existing TC-01–TC-78 remain the acceptance suite; no new manual test-case inventory was added.
- Electron itself was not started by the agent. Per the repository's Windows Electron instruction, the user runs `npm start`; the reduced-motion OS preference should be included in that manual smoke.
- Search / sort remain in Backlog; no new feature or additional phase was started.
