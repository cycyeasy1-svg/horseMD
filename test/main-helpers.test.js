// Characterization tests for the pure main-process helpers. isRestrictedRoot /
// isAbsolutePath are the safety gate that stops chokidar from recursively
// watching "/" (which floods EACCES and aborts the whole main process on
// launch), so their behavior must not drift unnoticed.
import { describe, it, expect } from 'vitest'
import { MD_EXTS, MD_RE, isAbsolutePath, isRestrictedRoot, imageNameParts, searchContentLines } from '../src/main/helpers.js'

describe('MD_EXTS / MD_RE', () => {
  it('lists the supported extensions', () => {
    expect(MD_EXTS).toEqual(['md', 'markdown', 'mdx', 'txt'])
  })
  it('matches supported extensions case-insensitively at end of path', () => {
    expect(MD_RE.test('/a/b.md')).toBe(true)
    expect(MD_RE.test('C:\\a\\b.MARKDOWN')).toBe(true)
    expect(MD_RE.test('notes.txt')).toBe(true)
    expect(MD_RE.test('image.png')).toBe(false)
    expect(MD_RE.test('README')).toBe(false)
  })
})

describe('isAbsolutePath', () => {
  it('accepts POSIX / Windows-drive / UNC, rejects relative', () => {
    expect(isAbsolutePath('/x')).toBe(true)
    expect(isAbsolutePath('D:\\x')).toBe(true)
    expect(isAbsolutePath('D:/x')).toBe(true)
    expect(isAbsolutePath('\\\\srv\\share')).toBe(true)
    expect(isAbsolutePath('rel/path')).toBe(false)
    expect(isAbsolutePath('.')).toBe(false)
  })
})

describe('isRestrictedRoot', () => {
  it('restricts empty / dot / relative / root paths', () => {
    expect(isRestrictedRoot('')).toBe(true)
    expect(isRestrictedRoot('/')).toBe(true)
    expect(isRestrictedRoot('.')).toBe(true)
    expect(isRestrictedRoot('..')).toBe(true)
    expect(isRestrictedRoot('some/relative')).toBe(true)
  })
  it('restricts macOS system/device trees', () => {
    expect(isRestrictedRoot('/dev')).toBe(true)
    expect(isRestrictedRoot('/System/Volumes/Data')).toBe(true)
    expect(isRestrictedRoot('/private/var/db')).toBe(true)
  })
  it('allows a normal absolute workspace folder', () => {
    expect(isRestrictedRoot('/Users/me/notes')).toBe(false)
    expect(isRestrictedRoot('C:\\Users\\me\\notes')).toBe(false)
  })
  it('ignores a trailing separator', () => {
    expect(isRestrictedRoot('/Users/me/notes/')).toBe(false)
    expect(isRestrictedRoot('/')).toBe(true)
  })
})

describe('imageNameParts', () => {
  it('splits stem and extension', () => {
    expect(imageNameParts('photo.png')).toEqual({ stem: 'photo', ext: '.png' })
    expect(imageNameParts('a.b.c')).toEqual({ stem: 'a.b', ext: '.c' })
  })
  it('defaults a missing name/extension to image.png', () => {
    expect(imageNameParts(null)).toEqual({ stem: 'image', ext: '.png' })
    expect(imageNameParts('noext')).toEqual({ stem: 'noext', ext: '.png' })
  })
  it('sanitizes path/reserved characters', () => {
    expect(imageNameParts('a/b:c.png')).toEqual({ stem: 'a_b_c', ext: '.png' })
  })
  it('keeps a dotfile name intact with a default extension', () => {
    expect(imageNameParts('.gitignore')).toEqual({ stem: '.gitignore', ext: '.png' })
  })
})

describe('searchContentLines (workspace full-text search)', () => {
  const content = 'Alpha beta\ngamma ALPHA\n\nalphabet soup\n'

  it('finds case-insensitive hits with 1-based line numbers and columns', () => {
    const { matches } = searchContentLines(content, 'alpha')
    expect(matches.map((m) => [m.line, m.col])).toEqual([[1, 0], [2, 6], [4, 0]])
    expect(matches[0]).toMatchObject({ len: 5, text: 'Alpha beta', textCol: 0 })
  })
  it('honors caseSensitive and wholeWord', () => {
    expect(searchContentLines(content, 'alpha', { caseSensitive: true }).matches.map((m) => m.line)).toEqual([4])
    expect(searchContentLines(content, 'alpha', { wholeWord: true }).matches.map((m) => m.line)).toEqual([1, 2])
  })
  it('supports regex and reports invalid patterns without throwing', () => {
    const { matches } = searchContentLines('a1 b22\nc333', '[a-z](\\d+)', { regex: true })
    expect(matches.map((m) => [m.line, m.col, m.len])).toEqual([[1, 0, 2], [1, 3, 3], [2, 0, 4]])
    expect(searchContentLines('x', '[', { regex: true })).toMatchObject({ matches: [], error: 'regex' })
  })
  it('caps the number of hits per file', () => {
    const many = Array(30).fill('hit hit hit').join('\n')
    expect(searchContentLines(many, 'hit', {}, 10).matches).toHaveLength(10)
  })
  it('excerpts very long lines around the match and adjusts textCol', () => {
    const long = 'x'.repeat(500) + 'NEEDLE' + 'y'.repeat(500)
    const { matches } = searchContentLines(long, 'NEEDLE')
    const m = matches[0]
    expect(m.col).toBe(500)
    expect(m.text.length).toBeLessThanOrEqual(241) // 240 + leading ellipsis
    expect(m.text.slice(m.textCol, m.textCol + m.len)).toBe('NEEDLE')
  })
  it('returns nothing for an empty query or content', () => {
    expect(searchContentLines('', 'x').matches).toEqual([])
    expect(searchContentLines('abc', '').matches).toEqual([])
  })
})
