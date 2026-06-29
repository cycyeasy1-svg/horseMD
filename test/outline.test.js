// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { parseHeadings } from '../src/renderer/src/components/Outline.jsx'

describe('parseHeadings', () => {
  it('reads ATX headings with their level', () => {
    expect(parseHeadings('# A\n## B\n###### F')).toEqual([
      { level: 1, text: 'A' },
      { level: 2, text: 'B' },
      { level: 6, text: 'F' }
    ])
  })

  it('reads Setext headings (=== → h1, --- → h2)', () => {
    expect(parseHeadings('Title\n=====\n\nSub\n---')).toEqual([
      { level: 1, text: 'Title' },
      { level: 2, text: 'Sub' }
    ])
  })

  it('reads single-line HTML headings and strips inner tags', () => {
    expect(parseHeadings('<h3>Hello <em>World</em></h3>')).toEqual([
      { level: 3, text: 'Hello World' }
    ])
  })

  it('skips a leading YAML front-matter block (no false Setext on its closing ---)', () => {
    const md = '---\ntitle: T\ndate: 2026\n---\n\n# Real'
    expect(parseHeadings(md)).toEqual([{ level: 1, text: 'Real' }])
  })

  it('does not treat a table separator row as a Setext heading', () => {
    const md = '| col | b |\n| --- | --- |\n| 1 | 2 |'
    expect(parseHeadings(md)).toEqual([])
  })

  it('ignores # inside fenced code', () => {
    const md = '# Kept\n\n```\n# not a heading\n```\n\n## Also kept'
    expect(parseHeadings(md)).toEqual([
      { level: 1, text: 'Kept' },
      { level: 2, text: 'Also kept' }
    ])
  })
})
