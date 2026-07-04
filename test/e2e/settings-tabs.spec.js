// E2E for the unified Settings modal (open → toggle → persist) and tab
// pinning (context menu → pin icon → survives "Close Others"). Drag-reorder
// itself is pure HTML5 DnD (unreliable under automation); its ordering logic
// is unit-tested in paths.test.js, so here we cover the pin path end-to-end.
import { test, expect } from '@playwright/test'
import { launchApp, fixture } from './helpers.js'

test('settings modal opens, autosave toggle flips and persists in settings storage', async () => {
  const { page, cleanup } = await launchApp([fixture('welcome.md')])
  try {
    await page.locator('.tab', { hasText: 'welcome.md' }).click()

    // Open via the status-bar gear.
    await page.locator('.statusbar button[title="设置"]').click()
    const modal = page.locator('.hm-settings')
    await expect(modal).toBeVisible()

    // The typography section reuses the shared adjuster groups.
    await expect(modal.locator('.hm-adjust-group').first()).toBeVisible()

    // Flip autosave on.
    const autosaveSwitch = modal
      .locator('.hm-set-row', { hasText: '自动保存' })
      .locator('.hm-switch')
    await expect(autosaveSwitch).toHaveAttribute('aria-checked', 'false')
    await autosaveSwitch.click()
    await expect(autosaveSwitch).toHaveAttribute('aria-checked', 'true')

    // Persisted to the settings key (same storage the next launch reads).
    await expect
      .poll(() =>
        page.evaluate(() => JSON.parse(localStorage.getItem('easymarkdown.settings.v1') || '{}').autosave)
      )
      .toBe(true)

    // Esc closes the modal.
    await page.keyboard.press('Escape')
    await expect(modal).toHaveCount(0)
  } finally {
    await cleanup()
  }
})

test('pinning a tab shows the pin icon and it survives Close Others', async () => {
  const { page, cleanup } = await launchApp([fixture('welcome.md')])
  try {
    // A fresh profile boots with the onboarding doc plus the fixture tab —
    // exactly the two tabs this scenario needs.
    const fixtureTab = page.locator('.tab', { hasText: 'welcome.md' })
    await fixtureTab.click()
    const other = page.locator('.tab', { hasNotText: 'welcome.md' }).first()
    await expect(other).toBeVisible()

    // Pin the fixture tab via its context menu.
    await fixtureTab.click({ button: 'right' })
    await page.locator('.tab-ctxmenu button', { hasText: '固定标签' }).click()
    await expect(fixtureTab).toHaveClass(/pinned/)
    await expect(fixtureTab.locator('.tab-pin')).toBeVisible()

    // "Close Others" from the OTHER tab must keep the pinned one.
    await other.click({ button: 'right' })
    await page.locator('.tab-ctxmenu button', { hasText: '关闭其他' }).click()
    await expect(page.locator('.tab.pinned', { hasText: 'welcome.md' })).toBeVisible()
    await expect(other).toBeVisible()
  } finally {
    await cleanup()
  }
})
