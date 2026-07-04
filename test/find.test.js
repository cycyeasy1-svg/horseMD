// Pure find-helper logic: case-insensitive match offsets and source-line →
// block-index mapping. The DOM-highlighting helpers (CSS Custom Highlight API)
// are intentionally not covered here — they belong to the future E2E layer.
import { describe, it, expect } from 'vitest'
import { matchIndices, findMatchesInText, replaceMatchesInText, docBlocks, blockIndexForLine } from '../src/renderer/src/find.js'

describe('matchIndices', () => {
  it('returns all case-insensitive match offsets', () => {
    expect(matchIndices('aXaXa', 'x')).toEqual([1, 3])
    expect(matchIndices('Hello hello', 'hello')).toEqual([0, 6])
  })
  it('does not overlap matches (advances by query length)', () => {
    expect(matchIndices('aaaa', 'aa')).toEqual([0, 2])
  })
  it('returns empty for empty text or query', () => {
    expect(matchIndices('', 'x')).toEqual([])
    expect(matchIndices('abc', '')).toEqual([])
  })
})

describe('findMatchesInText', () => {
  const offsets = (result) => result.matches.map((m) => [m.index, m.length])

  it('honors case-sensitive search', () => {
    expect(offsets(findMatchesInText('Foo foo', 'foo'))).toEqual([[0, 3], [4, 3]])
    expect(offsets(findMatchesInText('Foo foo', 'foo', { caseSensitive: true }))).toEqual([[4, 3]])
  })

  it('filters whole-word matches', () => {
    expect(offsets(findMatchesInText('cat scatter cat_ cat', 'cat', { wholeWord: true }))).toEqual([[0, 3], [17, 3]])
  })

  it('supports regular expressions and reports invalid patterns', () => {
    expect(offsets(findMatchesInText('A-1 B-22', '[A-Z]-\\d+', { regex: true }))).toEqual([[0, 3], [4, 4]])
    expect(findMatchesInText('abc', '[', { regex: true })).toMatchObject({ matches: [], error: 'regex' })
  })
})

describe('replaceMatchesInText', () => {
  it('replaces all literal matches (case-insensitive by default)', () => {
    expect(replaceMatchesInText('Foo foo FOO', 'foo', 'bar')).toEqual({
      text: 'bar bar bar',
      count: 3,
      error: ''
    })
  })
  it('honors caseSensitive and wholeWord options', () => {
    expect(replaceMatchesInText('Foo foo', 'foo', 'x', { caseSensitive: true }).text).toBe('Foo x')
    expect(replaceMatchesInText('cat scatter cat', 'cat', 'dog', { wholeWord: true }).text).toBe(
      'dog scatter dog'
    )
  })
  it('replaces only the Nth match when onlyIndex is given (clamped)', () => {
    expect(replaceMatchesInText('a a a', 'a', 'b', {}, 1).text).toBe('a b a')
    expect(replaceMatchesInText('a a a', 'a', 'b', {}, 99).text).toBe('a a b')
    expect(replaceMatchesInText('a a a', 'a', 'b', {}, 0)).toMatchObject({ count: 1 })
  })
  it('restricts replacement to options.range (in-selection scope)', () => {
    const r = replaceMatchesInText('x x x x', 'x', 'y', { range: { start: 2, end: 5 } })
    expect(r.text).toBe('x y y x')
    expect(r.count).toBe(2)
  })
  it('expands $1/$&/$$ in regex replacements and reports bad patterns', () => {
    expect(
      replaceMatchesInText('A-1 B-22', '([A-Z])-(\\d+)', '$2:$1', { regex: true }).text
    ).toBe('1:A 22:B')
    expect(replaceMatchesInText('ab', 'a', '[$&]$$', { regex: true }).text).toBe('[a]$b')
    expect(replaceMatchesInText('abc', '[', 'x', { regex: true })).toMatchObject({
      count: 0,
      error: 'regex'
    })
  })
  it('returns the input untouched for empty text or query', () => {
    expect(replaceMatchesInText('', 'a', 'b')).toEqual({ text: '', count: 0, error: '' })
    expect(replaceMatchesInText('abc', '', 'b').text).toBe('abc')
  })
})

describe('docBlocks', () => {
  it('segments a document the same way keep mode renders it', () => {
    const blocks = docBlocks('# Title\n\npara line\n')
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph'])
  })
})

describe('blockIndexForLine', () => {
  const content = '# Title\n\npara one\npara two\n\n## End'
  it('maps a line inside a block to that block index', () => {
    expect(blockIndexForLine(content, 1)).toEqual({ bi: 0, total: 6 }) // heading
    expect(blockIndexForLine(content, 3)).toMatchObject({ bi: 1 }) // paragraph
    expect(blockIndexForLine(content, 6)).toMatchObject({ bi: 2 }) // ## End
  })
  it('maps a blank-gap line to the next block', () => {
    expect(blockIndexForLine(content, 2)).toMatchObject({ bi: 1 })
  })
  it('clamps an out-of-range line to the last block', () => {
    expect(blockIndexForLine(content, 999)).toMatchObject({ bi: 2 })
  })
  it('returns bi -1 when there are no blocks', () => {
    expect(blockIndexForLine('', 1)).toEqual({ bi: -1, total: 1 })
  })
})
