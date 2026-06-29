// Boot + fixture-render smoke tests. These prove the harness end-to-end:
// Playwright launches the built Electron app, opens committed fixtures as tabs,
// and asserts real rendered DOM — the foundation the ported etv.mjs cases build on.
import { test, expect } from '@playwright/test'
import { launchApp, fixture } from './helpers.js'

test('app boots: shell, preload bridge and status bar are present', async () => {
  const { page, cleanup } = await launchApp()
  try {
    // Shell mounted (waited on in launchApp) and the platform class is applied.
    await expect(page.locator('#root .app')).toBeVisible()
    // The whitelisted preload bridge is exposed to the renderer.
    expect(await page.evaluate(() => typeof window.api)).toBe('object')
    // A theme base class is on <body> (light|dark).
    const bodyClass = await page.evaluate(() => document.body.className)
    expect(bodyClass).toMatch(/\b(light|dark)\b/)
    await expect(page.locator('.statusbar')).toBeVisible()
  } finally {
    await cleanup()
  }
})

test('opening a markdown fixture renders its heading in the editor', async () => {
  const { page, cleanup } = await launchApp([fixture('welcome.md')])
  try {
    // The fixture opened as a tab. (First run also opens the onboarding doc, so
    // activate the fixture's tab to make its lazily-mounted editor the visible one.)
    const tab = page.locator('.tab', { hasText: 'welcome.md' })
    await expect(tab).toBeVisible()
    await tab.click()
    // Editor-agnostic: opened .md renders in the keep editor (.km-*) here, the
    // onboarding doc in Milkdown (.ProseMirror) — so assert by role, not class.
    await expect(page.getByRole('heading', { name: 'E2E Welcome Fixture' })).toBeVisible()
  } finally {
    await cleanup()
  }
})

test('rendered document shows list and table block content', async () => {
  const { page, cleanup } = await launchApp([fixture('welcome.md')])
  try {
    await page.locator('.tab', { hasText: 'welcome.md' }).click()
    await expect(page.getByText('list item one')).toBeVisible()
    // Scope to the live document: a wide table also mounts a hidden floating-header
    // clone (outside .km-doc) carrying the same header text — see editor-tablescroll.js.
    await expect(page.locator('.km-doc').getByText('col a')).toBeVisible()
  } finally {
    await cleanup()
  }
})

test('keep mode resolves a relative image to a file:// URL', async () => {
  const { page, cleanup } = await launchApp([fixture('images.md')])
  try {
    await page.locator('.tab', { hasText: 'images.md' }).click()
    // The fixture's ![sample](./assets/sample.png) renders as an <img> whose src
    // is resolved against the doc folder (keep-parser inline() + resolveToFileUrl).
    const img = page.locator('.km-doc img').first()
    await expect(img).toHaveAttribute('src', /^file:\/\/.*sample\.png$/)
  } finally {
    await cleanup()
  }
})
