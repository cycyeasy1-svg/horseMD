// Keep-mode table column filters: the Excel-style dropdown (display-only row
// hiding), the cross-column rule (a later dropdown lists only values from rows
// that survive the other columns' filters), the right-click "clear this table's
// filters" entry, and the status-bar badge (aggregate label + per-table tooltip
// + click-to-clear). All DOM interactions the vitest unit suite can't see.
import { test, expect } from '@playwright/test'
import { launchApp, fixture } from './helpers.js'

// Open the two-table filter fixture and make its keep editor the active pane.
async function openFilterDoc() {
  const res = await launchApp([fixture('filter.md')])
  await res.page.locator('.tab', { hasText: 'filter.md' }).click()
  await expect(res.page.locator('.km-doc')).toBeVisible()
  return res
}

// Open table ti / column ci's filter dropdown, uncheck one value, confirm.
// Selectors stay host-scoped (.km-doc) so the floating-header ▼ clones that live
// on document.body never match.
async function excludeValue(page, ti, ci, value) {
  await page
    .locator(`.km-doc table.km-table[data-ti="${ti}"] .km-filter-btn[data-ci="${ci}"]`)
    .first()
    .click()
  const pop = page.locator('.km-filter-pop')
  await expect(pop).toBeVisible()
  await pop.locator(`input[data-v="${value}"]`).setChecked(false)
  await pop.locator('.km-fp-actions .ok').click()
  await expect(pop).toHaveCount(0)
}

test('column filter hides rows; a second column dropdown lists only surviving values', async () => {
  const { page, cleanup } = await openFilterDoc()
  try {
    const bananaRow = page.locator('.km-doc table[data-ti="0"] tbody tr', { hasText: 'banana' })
    await expect(bananaRow).toBeVisible()
    await excludeValue(page, 0, 0, 'banana')
    await expect(bananaRow).toBeHidden()
    // Single filtered table → plain badge with that table's counts.
    await expect(page.locator('.status-filter')).toContainText('筛选 3/4 条')

    // The color column's dropdown is built from the fruit filter's survivors:
    // "yellow" lives only on the hidden banana row, so it must not be listed.
    await page
      .locator('.km-doc table.km-table[data-ti="0"] .km-filter-btn[data-ci="1"]')
      .first()
      .click()
    const list = page.locator('.km-filter-pop .km-fp-list')
    await expect(list.locator('label', { hasText: 'red' })).toHaveCount(1)
    await expect(list.locator('label', { hasText: 'purple' })).toHaveCount(1)
    await expect(list.locator('label', { hasText: 'yellow' })).toHaveCount(0)
  } finally {
    await cleanup()
  }
})

test('right-click "clear this table\'s filters" restores the rows and the badge', async () => {
  const { page, cleanup } = await openFilterDoc()
  try {
    const bananaRow = page.locator('.km-doc table[data-ti="0"] tbody tr', { hasText: 'banana' })
    await excludeValue(page, 0, 0, 'banana')
    await expect(bananaRow).toBeHidden()

    await page
      .locator('.km-doc table[data-ti="0"] td', { hasText: 'apple' })
      .click({ button: 'right' })
    await page.locator('.km-table-menu .km-tm-item', { hasText: '清除本表格的全部筛选' }).click()
    await expect(bananaRow).toBeVisible()
    await expect(page.locator('.status-filter')).toHaveCount(0)
  } finally {
    await cleanup()
  }
})

test('multi-table badge aggregates counts, breaks them down in the tooltip, and clears on click', async () => {
  const { page, cleanup } = await openFilterDoc()
  try {
    await excludeValue(page, 0, 0, 'banana') // table 1: 3/4 shown
    await excludeValue(page, 1, 0, 'osaka') // table 2: 1/2 shown
    const badge = page.locator('.status-filter')
    await expect(badge).toContainText('2 个表格 · 筛选 4/6 条')
    const title = await badge.getAttribute('title')
    expect(title).toContain('表格 1: 3/4')
    expect(title).toContain('表格 2: 1/2')
    expect(title).toContain('点击清除全部筛选')

    await badge.click()
    await expect(page.locator('.km-doc tr.km-filtered')).toHaveCount(0)
    await expect(badge).toHaveCount(0)
  } finally {
    await cleanup()
  }
})
