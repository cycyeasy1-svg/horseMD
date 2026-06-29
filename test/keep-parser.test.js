// Characterization tests for the keep-mode parser/renderer (pure functions).
// These lock the *current* behavior of the Markdown source map + inline render
// so refactors (e.g. swapping in a remark-based parser) can't silently change
// output. See keep-parser.js's header for the \r / "zero diff" contract.
import { describe, it, expect } from 'vitest'
import {
  escapeHtml,
  escapeAttr,
  inline,
  splitRow,
  toViewLines,
  parseDoc,
  replaceCellInLine,
  insertColumnInLine,
  removeColumnInLine,
  buildTableRow,
  extractHeadings
} from '../src/renderer/src/keep-parser.js'

describe('escapeHtml / escapeAttr', () => {
  it('escapes &, <, > for HTML', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
  })
  it('escapeAttr also escapes double quotes', () => {
    expect(escapeAttr('say "hi" & <b>')).toBe('say &quot;hi&quot; &amp; &lt;b&gt;')
  })
  it('coerces non-strings', () => {
    expect(escapeHtml(42)).toBe('42')
  })
})

describe('inline', () => {
  it('renders bold, italic and inline code', () => {
    expect(inline('**b** and *i* and `c`')).toBe(
      '<strong>b</strong> and <em>i</em> and <code>c</code>'
    )
  })
  it('does not mistake a space-wrapped number in prose for a code placeholder', () => {
    // Regression: the code-span placeholder was once ` N `, so literal prose like
    // "以下 2 区域" got restored as <code>undefined</code>.
    expect(inline('人間は以下 2 区域')).toBe('人間は以下 2 区域')
    expect(inline('`a` then 0 and `b`')).toBe('<code>a</code> then 0 and <code>b</code>')
  })
  it('keeps inline code contents literal — escaped, with no entity decode or bold', () => {
    // escapeHtml runs on the whole segment before code spans are pulled out, so a
    // code span's `&` is already `&amp;` and stays that way (never decoded back).
    expect(inline('`&nbsp; **x**`')).toBe('<code>&amp;nbsp; **x**</code>')
  })
  it('renders links and neutralizes javascript: schemes', () => {
    expect(inline('[ok](https://a.com)')).toBe(
      '<a href="https://a.com" target="_blank" rel="noopener">ok</a>'
    )
    expect(inline('[x](javascript:void)')).toBe(
      '<a href="" target="_blank" rel="noopener">x</a>'
    )
  })
  it('renders an image with an absolute URL src', () => {
    expect(inline('![logo](https://x.com/a.png)')).toBe('<img src="https://x.com/a.png" alt="logo">')
  })
  it('resolves a relative image path against baseDir to a file:// URL', () => {
    expect(inline('![a](./assets/p.png)', '/home/u/notes')).toBe(
      '<img src="file:///home/u/notes/assets/p.png" alt="a">'
    )
  })
  it('leaves a relative image path as-is when no baseDir is given', () => {
    expect(inline('![a](./p.png)')).toBe('<img src="./p.png" alt="a">')
  })
  it('blanks a javascript: image src but allows data: URLs', () => {
    expect(inline('![x](javascript:alert)')).toBe('<img src="" alt="x">')
    expect(inline('![x](data:image/png;base64,AAAA)')).toBe('<img src="data:image/png;base64,AAAA" alt="x">')
  })
  it('does not leave a stray ! before an image (regression)', () => {
    expect(inline('![a](b.png)')).not.toContain('!<')
  })
  it('splits <br> into real line breaks', () => {
    expect(inline('a<br>b')).toBe('a<br>b')
    expect(inline('a<br/>b')).toBe('a<br>b')
  })
  it('decodes well-formed entities but keeps a bare & literal', () => {
    expect(inline('a&nbsp;b')).toBe('a&nbsp;b')
    expect(inline('Tom & Jerry')).toBe('Tom &amp; Jerry')
  })
})

describe('splitRow', () => {
  it('splits a leading/trailing-pipe row and trims cells', () => {
    expect(splitRow('| a | b | c |')).toEqual(['a', 'b', 'c'])
  })
  it('splits a borderless row', () => {
    expect(splitRow('a | b')).toEqual(['a', 'b'])
  })
  it('keeps escaped pipes inside a cell', () => {
    expect(splitRow('| a \\| b | c |')).toEqual(['a \\| b', 'c'])
  })
})

describe('toViewLines', () => {
  it('strips a trailing \\r but leaves \\r-free lines intact', () => {
    expect(toViewLines(['a\r', 'b', 'c\r'])).toEqual(['a', 'b', 'c'])
  })
})

describe('parseDoc', () => {
  it('parses a heading with level and text', () => {
    expect(parseDoc(['## Hello'])).toEqual([
      { type: 'heading', start: 0, end: 0, level: 2, text: 'Hello' }
    ])
  })
  it('groups consecutive non-blank lines into one paragraph', () => {
    const blocks = parseDoc(['line one', 'line two', '', 'next'])
    expect(blocks).toEqual([
      { type: 'paragraph', start: 0, end: 1 },
      { type: 'paragraph', start: 3, end: 3 }
    ])
  })
  it('parses a fenced code block and captures the language', () => {
    const blocks = parseDoc(['```mermaid', 'graph TD', '```'])
    expect(blocks).toEqual([{ type: 'code', start: 0, end: 2, lang: 'mermaid' }])
  })
  it('parses a GFM table with header/separator/data rows', () => {
    const blocks = parseDoc(['| a | b |', '| - | - |', '| 1 | 2 |'])
    expect(blocks).toHaveLength(1)
    const t = blocks[0]
    expect(t.type).toBe('table')
    expect(t.headers).toEqual(['a', 'b'])
    expect(t.dataRows).toEqual([{ lineIdx: 2, cells: ['1', '2'] }])
  })
  it('parses blockquotes, hr and lists', () => {
    expect(parseDoc(['> quote'])[0].type).toBe('quote')
    expect(parseDoc(['---'])[0].type).toBe('hr')
    expect(parseDoc(['- a', '- b'])[0]).toMatchObject({ type: 'list', start: 0, end: 1 })
  })
  it('never hangs on a lone non-block line (always advances)', () => {
    expect(parseDoc(['just text'])).toEqual([{ type: 'paragraph', start: 0, end: 0 }])
  })
  it('returns an empty array for empty input', () => {
    expect(parseDoc([])).toEqual([])
  })
})

describe('table cell/column edits (raw-line, byte-preserving)', () => {
  it('replaceCellInLine swaps one cell, keeps the rest and the trailing \\r', () => {
    expect(replaceCellInLine('| a | b | c |\r', 1, 'X')).toBe('| a | X | c |\r')
  })
  it('insertColumnInLine inserts a new segment at the column index', () => {
    expect(insertColumnInLine('| a | b |', 1, '')).toBe('| a |  | b |')
  })
  it('removeColumnInLine deletes the segment at the column index', () => {
    expect(removeColumnInLine('| a | b | c |', 1)).toBe('| a | c |')
  })
  it('removeColumnInLine is a no-op for an out-of-range index', () => {
    expect(removeColumnInLine('| a | b |', 9)).toBe('| a | b |')
  })
  it('buildTableRow matches the reference row pipe style and column count', () => {
    expect(buildTableRow(2, '| x | y |')).toBe('|  |  |')
    expect(buildTableRow(2, 'x | y')).toBe('  |  ')
  })
})

describe('extractHeadings', () => {
  it('returns headings in document order with their block index', () => {
    // Blank lines don't emit blocks, so block indices are: A=0, "text"=1, B=2.
    const blocks = parseDoc(['# A', '', 'text', '', '## B'])
    expect(extractHeadings(blocks)).toEqual([
      { level: 1, text: 'A', bi: 0 },
      { level: 2, text: 'B', bi: 2 }
    ])
  })
})
