// E2E for workspace full-text search: open a folder workspace, search across
// its files from the sidebar panel, and click a hit to open that file. Covers
// the whole pipeline (renderer panel → search IPC → streamed batches → result
// click → openPaths + line jump) that units can't reach. The activity-bar
// button is used instead of Ctrl+Shift+F — native menu accelerators don't fire
// from synthetic (CDP) key events.
import { test, expect } from '@playwright/test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchApp } from './helpers.js'

test('searching a workspace lists hits per file and opens the clicked one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'em-search-'))
  writeFileSync(join(dir, 'one.md'), '# One\n\nfindme alpha\n', 'utf8')
  writeFileSync(join(dir, 'two.md'), '# Two\n\nnothing here\n\nfindme beta\n', 'utf8')

  const res = await launchApp([dir])
  const { page, cleanup } = res
  try {
    // The folder launch arg becomes a workspace root (sidebar pane appears).
    await expect(page.locator('aside.pane-left')).toBeVisible()

    // Switch to the search view and run a query.
    await page.locator('.activity-bar button[title="在工作区中搜索"]').click()
    const panel = page.locator('.hm-search-panel')
    await expect(panel).toBeVisible()
    await panel.locator('.hm-search-box input').fill('findme')

    // Streaming results: one hit in each file, grouped per file.
    await expect(panel.locator('.hm-search-group')).toHaveCount(2)
    await expect(panel.locator('.hm-search-status')).toContainText('2')
    const hit = panel
      .locator('.hm-search-group', { hasText: 'two.md' })
      .locator('.hm-search-item', { hasText: 'findme beta' })
    await expect(hit.locator('.hm-search-hit')).toHaveText('findme')

    // Clicking a hit opens the file in a tab and shows the matched content.
    await hit.click()
    await expect(page.locator('.tab.active', { hasText: 'two.md' })).toBeVisible()
    await expect(page.locator('.km-doc:visible')).toContainText('findme beta')

    // Narrowing the query re-searches (old batches are superseded).
    await panel.locator('.hm-search-box input').fill('alpha')
    await expect(panel.locator('.hm-search-group')).toHaveCount(1)
    await expect(panel.locator('.hm-search-group', { hasText: 'one.md' })).toBeVisible()
  } finally {
    await cleanup()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})
