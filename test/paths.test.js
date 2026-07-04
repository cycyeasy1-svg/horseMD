// Characterization tests for the shared path / filename / doc-classification
// helpers. These guard cross-platform behavior (Windows vs POSIX) and the
// workspace-sanitization that keeps the file watcher from targeting "/".
import { describe, it, expect } from 'vitest'
import {
  isNewerVersion,
  isAbsolutePath,
  sanitizeWorkspace,
  sanitizeWorkspaces,
  baseName,
  dirName,
  joinPath,
  isMarkdownName,
  isPlainTextDoc,
  isValidName,
  isExistsError,
  isHeavyDoc,
  buildSessionTabs,
  sessionSnapshotEqual,
  RECENTS_MAX,
  rememberRecent,
  removeRecentPath,
  clearUnpinnedRecents,
  toggleRecentPinned,
  reorderTabsList,
  toggleTabPinnedInList
} from '../src/renderer/src/paths.js'

describe('isNewerVersion', () => {
  it('compares dotted versions component-wise', () => {
    expect(isNewerVersion('0.1.5', '0.1.4')).toBe(true)
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true)
    expect(isNewerVersion('0.1.4', '0.1.5')).toBe(false)
  })
  it('treats equal versions as not newer', () => {
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false)
  })
  it('handles differing segment counts', () => {
    expect(isNewerVersion('1.2', '1.2.0')).toBe(false)
    expect(isNewerVersion('1.2.1', '1.2')).toBe(true)
  })
})

describe('isAbsolutePath', () => {
  it('accepts POSIX, Windows drive and UNC paths', () => {
    expect(isAbsolutePath('/home/x')).toBe(true)
    expect(isAbsolutePath('C:\\Users\\x')).toBe(true)
    expect(isAbsolutePath('C:/Users/x')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share')).toBe(true)
  })
  it('rejects relative paths and non-strings', () => {
    expect(isAbsolutePath('.')).toBe(false)
    expect(isAbsolutePath('foo/bar')).toBe(false)
    expect(isAbsolutePath(null)).toBe(false)
    expect(isAbsolutePath(undefined)).toBe(false)
  })
})

describe('sanitizeWorkspace / sanitizeWorkspaces', () => {
  it('keeps a workspace only when its rootPath is absolute', () => {
    const abs = { rootPath: '/work', rootName: 'work' }
    expect(sanitizeWorkspace(abs)).toBe(abs)
    expect(sanitizeWorkspace({ rootPath: 'rel' })).toBe(null)
    expect(sanitizeWorkspace(null)).toBe(null)
  })
  it('de-duplicates by rootPath and fills rootName from the path', () => {
    const out = sanitizeWorkspaces([
      { rootPath: '/a' },
      { rootPath: '/a', rootName: 'dup' },
      { rootPath: 'rel' }
    ])
    expect(out).toEqual([{ rootPath: '/a', rootName: 'a' }])
  })
  it('falls back to the legacy single workspace when no array is given', () => {
    expect(sanitizeWorkspaces(undefined, { rootPath: '/old', rootName: 'old' })).toEqual([
      { rootPath: '/old', rootName: 'old' }
    ])
  })
})

describe('baseName / dirName / joinPath', () => {
  it('baseName takes the last segment across separators', () => {
    expect(baseName('/a/b/c.md')).toBe('c.md')
    expect(baseName('C:\\a\\b.md')).toBe('b.md')
    expect(baseName('')).toBe('Untitled')
  })
  it('dirName drops the last segment', () => {
    expect(dirName('/a/b/c.md')).toBe('/a/b')
    expect(dirName('C:\\a\\b.md')).toBe('C:\\a')
    expect(dirName('')).toBe('')
  })
  it('joinPath normalizes trailing separators and joins with /', () => {
    expect(joinPath('/a/b', 'c.md')).toBe('/a/b/c.md')
    expect(joinPath('/a/b/', 'c.md')).toBe('/a/b/c.md')
    expect(joinPath('C:\\a\\', 'c.md')).toBe('C:\\a/c.md')
  })
})

describe('markdown / plain-text classification', () => {
  it('isMarkdownName matches .md/.markdown/.mdx case-insensitively', () => {
    expect(isMarkdownName('a.md')).toBe(true)
    expect(isMarkdownName('a.MARKDOWN')).toBe(true)
    expect(isMarkdownName('a.mdx')).toBe(true)
    expect(isMarkdownName('a.txt')).toBe(false)
    expect(isMarkdownName('')).toBe(false)
  })
  it('isPlainTextDoc is true only for a pathed non-markdown tab', () => {
    expect(isPlainTextDoc({ path: '/a.txt' })).toBe(true)
    expect(isPlainTextDoc({ path: '/a.md' })).toBe(false)
    expect(isPlainTextDoc({ path: null })).toBe(false) // untitled
    expect(isPlainTextDoc(null)).toBe(false)
  })
})

describe('isValidName', () => {
  it('rejects separators, reserved chars and dot names', () => {
    expect(isValidName('notes.md')).toBe(true)
    expect(isValidName('a/b')).toBe(false)
    expect(isValidName('a:b')).toBe(false)
    expect(isValidName('a*?')).toBe(false)
    expect(isValidName('.')).toBe(false)
    expect(isValidName('..')).toBe(false)
    expect(isValidName('')).toBe(false)
  })
})

describe('isExistsError', () => {
  it('detects EEXIST-style fs errors', () => {
    expect(isExistsError({ message: 'EEXIST: file already exists' })).toBe(true)
    expect(isExistsError({ message: 'ENOENT' })).toBe(false)
    expect(isExistsError(null)).toBe(false)
  })
})

describe('isHeavyDoc', () => {
  it('is false for empty or small docs', () => {
    expect(isHeavyDoc('')).toBe(false)
    expect(isHeavyDoc('# hi\n\nsome text')).toBe(false)
  })
  it('is true for a long run of non-blank lines (>1000)', () => {
    expect(isHeavyDoc(Array(1100).fill('x').join('\n'))).toBe(true)
    // 150–1000 line runs are no longer heavy (measured ≈0.5 s at 900 lines)
    expect(isHeavyDoc(Array(900).fill('x').join('\n'))).toBe(false)
  })
  it('a blank line resets the run', () => {
    const chunk = (Array(800).fill('x').join('\n') + '\n\n')
    expect(isHeavyDoc(chunk.repeat(3))).toBe(false)
  })
  it('fenced code lines do not count toward the run', () => {
    // a single huge code block is one CodeMirror node — cheap in rich mode
    expect(isHeavyDoc('```js\n' + Array(2000).fill('code();').join('\n') + '\n```')).toBe(false)
    expect(isHeavyDoc('~~~\n' + Array(2000).fill('x').join('\n') + '\n~~~')).toBe(false)
    // an unclosed fence swallows the rest of the doc (still one code node)
    expect(isHeavyDoc('```\n' + Array(2000).fill('x').join('\n'))).toBe(false)
    // but a >1000 prose run AFTER a closed fence is still heavy
    expect(isHeavyDoc('```\ncode\n```\n' + Array(1100).fill('x').join('\n'))).toBe(true)
  })
  it('is true past the total-size cap', () => {
    expect(isHeavyDoc('a'.repeat(400001))).toBe(true)
  })
})

describe('buildSessionTabs (what survives a restart)', () => {
  const saved = { path: '/docs/a.md', title: 'a.md', content: 'x', savedContent: 'x' }
  const dirtyScratch = { path: null, title: 'Untitled', content: 'draft', savedContent: '' }

  it('openPaths lists every saved tab path, in order, dropping pathless tabs', () => {
    const tabs = [saved, dirtyScratch, { path: '/docs/b.md', title: 'b.md', content: '', savedContent: '' }]
    expect(buildSessionTabs(tabs).openPaths).toEqual(['/docs/a.md', '/docs/b.md'])
  })
  it('keeps a dirty, non-blank scratch tab as {title, content} only', () => {
    expect(buildSessionTabs([dirtyScratch]).untitled).toEqual([{ title: 'Untitled', content: 'draft' }])
  })
  it('drops a scratch tab whose content equals its saved baseline (not dirty)', () => {
    const clean = { path: null, title: 'Untitled', content: 'same', savedContent: 'same' }
    expect(buildSessionTabs([clean]).untitled).toEqual([])
  })
  it('drops a whitespace-only scratch tab (no real work to keep)', () => {
    const blank = { path: null, title: 'Untitled', content: '   \n\t', savedContent: '' }
    expect(buildSessionTabs([blank]).untitled).toEqual([])
  })
  it('never persists a saved file as an untitled scratch (it reopens from disk)', () => {
    const editedSaved = { path: '/docs/a.md', title: 'a.md', content: 'new', savedContent: 'old' }
    const { openPaths, untitled } = buildSessionTabs([editedSaved])
    expect(openPaths).toEqual(['/docs/a.md'])
    expect(untitled).toEqual([])
  })
  it('tolerates missing/empty input', () => {
    expect(buildSessionTabs(undefined)).toEqual({ openPaths: [], pinnedPaths: [], untitled: [] })
    expect(buildSessionTabs([])).toEqual({ openPaths: [], pinnedPaths: [], untitled: [] })
  })
  it('records pinned tab paths (pathless pins are dropped)', () => {
    const tabs = [
      { path: '/a.md', pinned: true, content: '', savedContent: '' },
      { path: '/b.md', content: '', savedContent: '' },
      { path: null, pinned: true, content: 'x', savedContent: '' }
    ]
    expect(buildSessionTabs(tabs).pinnedPaths).toEqual(['/a.md'])
  })
})

describe('reorderTabsList / toggleTabPinnedInList', () => {
  const tab = (id, pinned = false) => ({ id, pinned })

  it('moves a tab to the drop target position', () => {
    const out = reorderTabsList([tab('a'), tab('b'), tab('c')], 'a', 'c')
    expect(out.map((t) => t.id)).toEqual(['b', 'c', 'a'])
  })
  it('keeps the pinned group in front — an unpinned tab cannot enter it', () => {
    const out = reorderTabsList([tab('p', true), tab('a'), tab('b')], 'b', 'p')
    expect(out.map((t) => t.id)).toEqual(['p', 'b', 'a'])
  })
  it('a pinned tab dragged into the unpinned zone snaps back to the pinned tail', () => {
    const out = reorderTabsList([tab('p1', true), tab('p2', true), tab('a')], 'p1', 'a')
    expect(out.map((t) => t.id)).toEqual(['p2', 'p1', 'a'])
  })
  it('returns the input unchanged for unknown ids', () => {
    const list = [tab('a'), tab('b')]
    expect(reorderTabsList(list, 'a', 'zzz')).toBe(list)
  })
  it('pinning moves the tab into the front group; unpinning leaves it at the group boundary', () => {
    const pinned = toggleTabPinnedInList([tab('a'), tab('b')], 'b')
    expect(pinned.map((t) => [t.id, !!t.pinned])).toEqual([['b', true], ['a', false]])
    const unpinned = toggleTabPinnedInList(pinned, 'b')
    expect(unpinned.map((t) => [t.id, !!t.pinned])).toEqual([['b', false], ['a', false]])
  })
})

describe('sessionSnapshotEqual', () => {
  const ws = ['C:/w']
  const recents = [{ path: 'C:/w/a.md' }]
  const base = () => ({
    workspaces: ws,
    workspace: ws[0],
    theme: 'light',
    customTheme: null,
    lang: 'zh',
    recents,
    sidebarOpen: true,
    sidebarMode: 'files',
    sidebarWidth: 240,
    openPaths: ['C:/w/a.md', 'C:/w/b.md'],
    untitled: [{ title: 'Untitled', content: 'draft' }],
    activePath: 'C:/w/a.md'
  })

  it('is true for value-equal snapshots with fresh openPaths/untitled arrays', () => {
    expect(sessionSnapshotEqual(base(), base())).toBe(true)
  })
  it('is false when either side is missing', () => {
    expect(sessionSnapshotEqual(null, base())).toBe(false)
    expect(sessionSnapshotEqual(base(), null)).toBe(false)
  })
  it('detects each scalar field change', () => {
    for (const [k, v] of [
      ['theme', 'dark'],
      ['customTheme', 'x.css'],
      ['lang', 'en'],
      ['sidebarOpen', false],
      ['sidebarMode', 'outline'],
      ['sidebarWidth', 300],
      ['activePath', 'C:/w/b.md']
    ]) {
      const b = base()
      b[k] = v
      expect(sessionSnapshotEqual(base(), b), k).toBe(false)
    }
  })
  it('compares workspaces/recents by reference (state identity)', () => {
    const b = base()
    b.workspaces = ['C:/w'] // same value, new identity → treated as changed
    expect(sessionSnapshotEqual(base(), b)).toBe(false)
    const c = base()
    c.recents = [{ path: 'C:/w/a.md' }]
    expect(sessionSnapshotEqual(base(), c)).toBe(false)
  })
  it('detects open-tab list changes', () => {
    const b = base()
    b.openPaths = ['C:/w/a.md']
    expect(sessionSnapshotEqual(base(), b)).toBe(false)
    const c = base()
    c.openPaths = ['C:/w/a.md', 'C:/w/c.md']
    expect(sessionSnapshotEqual(base(), c)).toBe(false)
  })
  it('detects untitled draft edits and count changes', () => {
    const b = base()
    b.untitled = [{ title: 'Untitled', content: 'draft EDITED' }]
    expect(sessionSnapshotEqual(base(), b)).toBe(false)
    const c = base()
    c.untitled = []
    expect(sessionSnapshotEqual(base(), c)).toBe(false)
  })
})

describe('recents helpers', () => {
  const entry = (path, extra = {}) => ({ path, name: path.split('/').pop(), dir: 'C:/w', openedAt: 1, ...extra })

  describe('rememberRecent', () => {
    it('inserts at the top and dedupes by normalized path', () => {
      const prev = [entry('C:/w/a.md')]
      const next = rememberRecent(prev, entry('C:\\w\\a.md', { openedAt: 2 }))
      expect(next).toHaveLength(1)
      expect(next[0].openedAt).toBe(2)
    })
    it('preserves the pinned flag when re-remembering', () => {
      const prev = [entry('C:/w/a.md', { pinned: true })]
      const next = rememberRecent(prev, entry('C:/w/a.md', { openedAt: 2 }))
      expect(next[0].pinned).toBe(true)
    })
    it('caps only the unpinned tail at RECENTS_MAX, pinned always survive', () => {
      let list = [entry('C:/w/pin.md', { pinned: true })]
      for (let i = 0; i < RECENTS_MAX + 3; i++) {
        list = rememberRecent(list, entry(`C:/w/f${i}.md`))
      }
      expect(list.filter((r) => r.pinned)).toHaveLength(1)
      expect(list.filter((r) => !r.pinned)).toHaveLength(RECENTS_MAX)
      expect(list[0].path).toBe('C:/w/pin.md') // pinned sorts first
    })
  })

  describe('removeRecentPath', () => {
    it('removes by path with normalization', () => {
      const prev = [entry('C:/w/a.md'), entry('C:/w/b.md')]
      expect(removeRecentPath(prev, 'C:\\w\\a.md').map((r) => r.path)).toEqual(['C:/w/b.md'])
    })
  })

  describe('clearUnpinnedRecents', () => {
    it('keeps only pinned entries', () => {
      const prev = [entry('C:/w/a.md', { pinned: true }), entry('C:/w/b.md')]
      expect(clearUnpinnedRecents(prev).map((r) => r.path)).toEqual(['C:/w/a.md'])
    })
  })

  describe('toggleRecentPinned', () => {
    it('pins an entry and moves it to the front group', () => {
      const prev = [entry('C:/w/a.md'), entry('C:/w/b.md')]
      const next = toggleRecentPinned(prev, 'C:/w/b.md')
      expect(next[0]).toMatchObject({ path: 'C:/w/b.md', pinned: true })
    })
    it('unpins back into the unpinned group', () => {
      const prev = [entry('C:/w/a.md', { pinned: true }), entry('C:/w/b.md')]
      const next = toggleRecentPinned(prev, 'C:/w/a.md')
      expect(next.every((r) => !r.pinned)).toBe(true)
    })
  })
})
