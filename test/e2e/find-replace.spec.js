// E2E for find & replace: replace operates on the markdown SOURCE (keep-mode
// round-trip guarantee), remounts the visible editor with the new content,
// dirties the tab, and the rewritten source is what lands on disk. This is the
// full pipeline a unit test can't see (replaceMatchesInText itself is unit-
// tested in test/find.test.js).
import { test, expect } from '@playwright/test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchApp } from './helpers.js'

test('replace-all rewrites the source, dirties the tab, and saves to disk', async () => {
  // Replace ends in a save, so operate on a throwaway copy.
  const dir = mkdtempSync(join(tmpdir(), 'em-replace-'))
  const file = join(dir, 'replace-test.md')
  writeFileSync(file, '# Title\n\nfoo one\n\nfoo two\n', 'utf8')

  const res = await launchApp([file])
  const { page, cleanup } = res
  try {
    await page.locator('.tab', { hasText: 'replace-test.md' }).click()
    await expect(page.locator('.km-doc')).toBeVisible()

    // Ctrl+H opens the find bar with the replace row shown.
    await page.keyboard.press('Control+h')
    const findbar = page.locator('.findbar')
    await expect(findbar).toBeVisible()
    const replaceInput = findbar.locator('.findbar-replace-input')
    await expect(replaceInput).toBeVisible()

    // Type the query (debounced live search enables the replace buttons once
    // matches are counted) and the replacement.
    await findbar.locator('input').first().fill('foo')
    await replaceInput.fill('bar')
    const buttons = findbar.locator('.findbar-replace-btn')
    const allBtn = buttons.nth(1) // [replace one, replace all]
    await expect(allBtn).toBeEnabled()
    await allBtn.click()

    // The visible keep editor re-renders the rewritten source.
    await expect(page.locator('.km-doc')).toContainText('bar one')
    await expect(page.locator('.km-doc')).toContainText('bar two')
    await expect(page.locator('.km-doc')).not.toContainText('foo')

    // Replace dirties the tab; saving writes the rewritten markdown verbatim.
    const fab = page.locator('.hm-save-fab')
    await expect(fab).toBeVisible()
    await fab.click()
    await expect(fab).toHaveCount(0)
    await expect.poll(() => readFileSync(file, 'utf8')).toBe('# Title\n\nbar one\n\nbar two\n')
  } finally {
    await cleanup()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})
