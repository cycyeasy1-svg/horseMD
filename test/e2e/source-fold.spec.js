// E2E for source-mode heading folding — the fold gutter, the folded textarea
// view, and (most critically) the write-back that patches an edit made on the
// folded view into the full document. This is the DOM path the pure-function
// suite (test/source-fold.test.js) can't see: textarea value ↔ handleChange ↔
// patchFoldedSourceLines ↔ App state, across fold/unfold transitions.
import { test, expect } from '@playwright/test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchApp } from './helpers.js'

const FOLD_DOC = ['# Alpha', 'alpha body 1', 'alpha body 2', '# Beta', 'beta body'].join('\n')

test('fold hides the section, an edit while folded survives unfold and save', async () => {
  // Saving writes to disk, so operate on a throwaway copy.
  const dir = mkdtempSync(join(tmpdir(), 'em-fold-'))
  const file = join(dir, 'fold-test.md')
  writeFileSync(file, FOLD_DOC, 'utf8')

  const { page, cleanup } = await launchApp([file])
  try {
    await page.locator('.tab', { hasText: 'fold-test.md' }).click()
    await expect(page.locator('.km-doc')).toBeVisible()

    // Enter global source mode via the status-bar toggle.
    await page.locator('button[title*="切换源码模式"]').click()
    const ta = page.locator('textarea.source-editor')
    await expect(ta).toBeVisible()
    await expect(ta).toHaveValue(FOLD_DOC)

    // Both headings have bodies → two fold buttons in the gutter.
    const toggles = page.locator('.source-fold-toggle')
    await expect(toggles).toHaveCount(2)

    // Collapse "# Alpha": its body vanishes from the textarea, and the line
    // numbers keep ORIGINAL numbering with a gap (1, then 4 5).
    await toggles.first().click()
    await expect(ta).toHaveValue('# Alpha\n# Beta\nbeta body')
    await expect
      .poll(() => page.locator('.source-line-numbers').evaluate((el) => el.textContent))
      .toBe('1\n4\n5')

    // Edit a visible line while folded (fill = full visible-view replacement,
    // the same event shape a keystroke produces).
    await ta.fill('# Alpha\n# Beta\nbeta body EDITED')

    // Unfold: the hidden body is intact and the edit landed on the right line.
    await toggles.first().click()
    const expected = ['# Alpha', 'alpha body 1', 'alpha body 2', '# Beta', 'beta body EDITED'].join('\n')
    await expect(ta).toHaveValue(expected)

    // Save (via the FAB, shown because the doc is dirty) and verify the exact
    // bytes on disk — the fold write-back must be lossless.
    await page.locator('.hm-save-fab').click()
    await expect.poll(() => readFileSync(file, 'utf8')).toBe(expected)
  } finally {
    await cleanup()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

test('line jump into a collapsed section auto-expands it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'em-fold-'))
  const file = join(dir, 'jump-test.md')
  writeFileSync(file, FOLD_DOC, 'utf8')

  const { page, cleanup } = await launchApp([file])
  try {
    await page.locator('.tab', { hasText: 'jump-test.md' }).click()
    await expect(page.locator('.km-doc')).toBeVisible()
    await page.locator('button[title*="切换源码模式"]').click()
    const ta = page.locator('textarea.source-editor')
    await expect(ta).toBeVisible()

    // Collapse Alpha, then jump to line 3 (hidden inside it) via the find bar's
    // line mode (Ctrl+F → the "line" mode toggle → "3" → Enter).
    await page.locator('.source-fold-toggle').first().click()
    await expect(ta).toHaveValue('# Alpha\n# Beta\nbeta body')
    await page.keyboard.press('Control+f')
    const findbar = page.locator('.findbar')
    await expect(findbar).toBeVisible()
    await findbar.locator('.findbar-mode').click()
    const findInput = findbar.locator('input')
    await findInput.fill('3')
    await findInput.press('Enter')

    // The section auto-expands so the target line is visible again.
    await expect(ta).toHaveValue(FOLD_DOC)
  } finally {
    await cleanup()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})
