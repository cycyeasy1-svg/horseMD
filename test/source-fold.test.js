// Characterization tests for the source-pane fold helpers (sourceFold.js).
// These lock the behavior as-is (no design spec) — they were written against
// the implementation while it still lived in App.jsx, BEFORE SourceEditorPane
// was restructured to compute fold rows off the urgent render path. If one of
// these fails after an edit, the fold/write-back behavior changed for real.
import { describe, it, expect } from 'vitest'
import {
  countSourceLines,
  buildLineNumberText,
  sourceHeadingForLine,
  findSourceFoldableLines,
  buildSourceView,
  computeFoldRows,
  patchFoldedSourceLines
} from '../src/renderer/src/sourceFold.js'

const DOC = [
  'intro line', //           0
  '# Alpha', //              1  (foldable: has content below)
  'a-body', //               2
  '## Beta', //              3  (foldable)
  'b-body-1', //             4
  'b-body-2', //             5
  '## Gamma', //             6  (foldable)
  'g-body', //               7
  '# Delta', //              8  (foldable)
  'd-body' //                9
]

describe('countSourceLines / buildLineNumberText', () => {
  it('counts 1 for empty string and N for N-1 newlines', () => {
    expect(countSourceLines('')).toBe(1)
    expect(countSourceLines('a')).toBe(1)
    expect(countSourceLines('a\nb')).toBe(2)
    expect(countSourceLines('a\nb\n')).toBe(3)
  })
  it('builds a newline-joined 1..N strip, minimum "1"', () => {
    expect(buildLineNumberText(0)).toBe('1')
    expect(buildLineNumberText(1)).toBe('1')
    expect(buildLineNumberText(4)).toBe('1\n2\n3\n4')
  })
})

describe('sourceHeadingForLine', () => {
  it('parses ATX headings with up to 3 leading spaces and trailing #s', () => {
    expect(sourceHeadingForLine('# Title')).toEqual({ level: 1, text: 'Title', key: '1:Title' })
    expect(sourceHeadingForLine('   ### Deep ##')).toEqual({ level: 3, text: 'Deep', key: '3:Deep' })
  })
  it('rejects non-headings, empty headings, and 4-space-indented lines', () => {
    expect(sourceHeadingForLine('plain')).toBeNull()
    expect(sourceHeadingForLine('#')).toBeNull()
    expect(sourceHeadingForLine('# ')).toBeNull()
    expect(sourceHeadingForLine('    # code block')).toBeNull()
    expect(sourceHeadingForLine('#nospace')).toBeNull()
  })
})

describe('findSourceFoldableLines', () => {
  it('marks headings with any following content as foldable', () => {
    expect([...findSourceFoldableLines(DOC)].sort((a, b) => a - b)).toEqual([1, 3, 6, 8])
  })
  it('a heading with nothing under it is not foldable', () => {
    expect(findSourceFoldableLines(['# lone']).size).toBe(0)
    // Followed only by a same-level heading → still nothing under it.
    const set = findSourceFoldableLines(['# a', '# b'])
    expect(set.has(0)).toBe(false)
  })
})

describe('buildSourceView', () => {
  it('with nothing collapsed: identity map, all rows visible', () => {
    const v = buildSourceView(DOC, new Set())
    expect(v.visibleMap).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(v.hiddenByLine.size).toBe(0)
    expect(v.displayLines).toEqual(DOC)
    expect(v.lineNumbers).toBe('1\n2\n3\n4\n5\n6\n7\n8\n9\n10')
    expect(v.foldRows).toEqual([
      { row: 1, line: 1, key: '1:Alpha', collapsed: false },
      { row: 3, line: 3, key: '2:Beta', collapsed: false },
      { row: 6, line: 6, key: '2:Gamma', collapsed: false },
      { row: 8, line: 8, key: '1:Delta', collapsed: false }
    ])
  })

  it('collapsing a section hides its body up to the next same/higher heading', () => {
    const v = buildSourceView(DOC, new Set(['2:Beta']))
    // b-body-1 / b-body-2 hidden; Gamma (same level) stays visible.
    expect(v.visibleMap).toEqual([0, 1, 2, 3, 6, 7, 8, 9])
    expect(v.hiddenByLine.get(4)).toEqual(['2:Beta'])
    expect(v.hiddenByLine.get(5)).toEqual(['2:Beta'])
    // Skipped original line numbers show the gap (…4 then 7…).
    expect(v.lineNumbers).toBe('1\n2\n3\n4\n7\n8\n9\n10')
    expect(v.foldRows.find((r) => r.key === '2:Beta').collapsed).toBe(true)
  })

  it('collapsing an H1 swallows nested H2 sections; nested keys stack', () => {
    const v = buildSourceView(DOC, new Set(['1:Alpha', '2:Beta']))
    expect(v.visibleMap).toEqual([0, 1, 8, 9])
    // A line inside Beta inside Alpha is hidden by both.
    expect(v.hiddenByLine.get(4)).toEqual(['1:Alpha', '2:Beta'])
    // Gamma's heading line itself is hidden by Alpha.
    expect(v.hiddenByLine.get(6)).toEqual(['1:Alpha'])
    // Hidden headings contribute no fold rows.
    expect(v.foldRows.map((r) => r.key)).toEqual(['1:Alpha', '1:Delta'])
  })

  it('empty doc yields the "1" strip', () => {
    const v = buildSourceView([''], new Set())
    expect(v.lineNumbers).toBe('1')
    expect(v.foldRows).toEqual([])
  })
})

describe('computeFoldRows ≡ buildSourceView(lines, ∅).foldRows', () => {
  const CASES = [
    DOC,
    [''],
    ['plain', 'text', 'only'],
    ['# lone'],
    ['# a', '# b'],
    ['# a', 'body', '## b', '### c', 'deep', '## d', 'tail', '# e', 'x'],
    ['   ## indented', 'body', '###### six', 'body', '####### seven is not a heading', 'x']
  ]
  for (const [i, lines] of CASES.entries()) {
    it(`case ${i} matches`, () => {
      expect(computeFoldRows(lines)).toEqual(buildSourceView(lines, new Set()).foldRows)
    })
  }
})

describe('patchFoldedSourceLines (write-back of an edit made on the folded view)', () => {
  // Folded view of DOC with Beta collapsed: rows = [0,1,2,3,6,7,8,9]
  const view = buildSourceView(DOC, new Set(['2:Beta']))

  it('no visible change → full text unchanged', () => {
    const out = patchFoldedSourceLines(DOC, view.displayLines, [...view.displayLines], view.visibleMap)
    expect(out).toBe(DOC.join('\n'))
  })

  it('editing a visible line keeps hidden lines intact', () => {
    const nextVisible = [...view.displayLines]
    nextVisible[2] = 'a-body EDITED' // original line 2
    const out = patchFoldedSourceLines(DOC, view.displayLines, nextVisible, view.visibleMap)
    const expected = [...DOC]
    expected[2] = 'a-body EDITED'
    expect(out).toBe(expected.join('\n'))
  })

  it('pure insertion between visible lines lands after the previous original line', () => {
    const nextVisible = [...view.displayLines]
    nextVisible.splice(3, 0, 'inserted') // between 'a-body' (orig 2) and '## Beta' (orig 3)
    const out = patchFoldedSourceLines(DOC, view.displayLines, nextVisible, view.visibleMap)
    const expected = [...DOC]
    expected.splice(3, 0, 'inserted') // right after original line 2
    expect(out).toBe(expected.join('\n'))
  })

  it('insertion right below a collapsed heading lands BEFORE its hidden body', () => {
    const nextVisible = [...view.displayLines]
    nextVisible.splice(4, 0, 'inserted') // between '## Beta' (orig 3) and '## Gamma' (orig 6)
    const out = patchFoldedSourceLines(DOC, view.displayLines, nextVisible, view.visibleMap)
    const expected = [...DOC]
    expected.splice(4, 0, 'inserted') // after Beta's heading line, before hidden b-body-1
    expect(out).toBe(expected.join('\n'))
  })

  it('replacing a visible span replaces the matching original span', () => {
    const nextVisible = [...view.displayLines]
    // Replace visible rows 4..5 ('## Gamma','g-body' → originals 6..7) with one line.
    nextVisible.splice(4, 2, 'merged')
    const out = patchFoldedSourceLines(DOC, view.displayLines, nextVisible, view.visibleMap)
    const expected = [...DOC]
    expected.splice(6, 2, 'merged')
    expect(out).toBe(expected.join('\n'))
  })

  it('deleting a visible line removes only that original line', () => {
    const nextVisible = [...view.displayLines]
    nextVisible.splice(7, 1) // drop 'd-body' (original 9)
    const out = patchFoldedSourceLines(DOC, view.displayLines, nextVisible, view.visibleMap)
    const expected = [...DOC]
    expected.splice(9, 1)
    expect(out).toBe(expected.join('\n'))
  })
})
