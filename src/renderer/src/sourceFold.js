// Pure helpers for the plain-source editor pane (SourceEditorPane in App.jsx):
// line counting / line-number strip, and heading-based folding — which lines
// fold, the folded view (visible-line map + hidden-line index), and the
// write-back that patches an edit made on the folded view into the full text.
// Kept dependency-free so the folding behavior is unit-testable (they moved
// here verbatim from App.jsx; test/source-fold.test.js locks the behavior).

export function countSourceLines(value) {
  let count = 1
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) === 10) count++
  }
  return count
}

export function buildLineNumberText(count) {
  const lines = new Array(Math.max(1, count))
  for (let i = 0; i < lines.length; i++) lines[i] = String(i + 1)
  return lines.join('\n')
}

export function sourceHeadingForLine(line) {
  const m = String(line || '').match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/)
  if (!m) return null
  const text = (m[2] || '').trim()
  if (!text) return null
  return { level: m[1].length, text, key: `${m[1].length}:${text}` }
}

export function findSourceFoldableLines(lines) {
  const foldable = new Set()
  const stack = []

  for (let i = 0; i < lines.length; i++) {
    const heading = sourceHeadingForLine(lines[i])
    if (heading) {
      while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop()
      stack.forEach((h) => foldable.add(h.line))
      stack.push({ level: heading.level, line: i })
    } else {
      stack.forEach((h) => foldable.add(h.line))
    }
  }

  return foldable
}

export function buildSourceView(lines, collapsedKeys) {
  const visibleMap = []
  const hiddenByLine = new Map()
  const foldRows = []
  const collapsedStack = []
  const foldableLines = findSourceFoldableLines(lines)

  for (let i = 0; i < lines.length; i++) {
    const heading = sourceHeadingForLine(lines[i])
    const foldable = heading && foldableLines.has(i)
    if (heading) {
      while (collapsedStack.length && collapsedStack[collapsedStack.length - 1].level >= heading.level) {
        collapsedStack.pop()
      }
    }

    const hiddenBy = collapsedStack.map((h) => h.key)
    if (hiddenBy.length) {
      hiddenByLine.set(i, hiddenBy)
    } else {
      const row = visibleMap.length
      visibleMap.push(i)
      if (foldable) {
        foldRows.push({
          row,
          line: i,
          key: heading.key,
          collapsed: collapsedKeys.has(heading.key)
        })
      }
    }

    if (foldable && collapsedKeys.has(heading.key)) collapsedStack.push(heading)
  }

  return {
    visibleMap,
    hiddenByLine,
    foldRows,
    displayLines: visibleMap.map((i) => lines[i]),
    lineNumbers: visibleMap.map((i) => String(i + 1)).join('\n') || '1'
  }
}

// Fold buttons only, for the no-fold fast path: equivalent to
// buildSourceView(lines, new Set()).foldRows (nothing collapsed → row === line)
// without materializing the visible view. Runs off the urgent render (deferred),
// so typing never pays the whole-document heading walk.
export function computeFoldRows(lines) {
  const foldable = findSourceFoldableLines(lines)
  const rows = []
  for (const i of foldable) {
    const h = sourceHeadingForLine(lines[i])
    if (h) rows.push({ row: i, line: i, key: h.key, collapsed: false })
  }
  return rows.sort((a, b) => a.row - b.row)
}

export function patchFoldedSourceLines(lines, oldVisibleLines, newVisibleLines, visibleMap) {
  let prefix = 0
  const maxPrefix = Math.min(oldVisibleLines.length, newVisibleLines.length)
  while (prefix < maxPrefix && oldVisibleLines[prefix] === newVisibleLines[prefix]) prefix++

  let oldSuffix = oldVisibleLines.length
  let newSuffix = newVisibleLines.length
  while (
    oldSuffix > prefix &&
    newSuffix > prefix &&
    oldVisibleLines[oldSuffix - 1] === newVisibleLines[newSuffix - 1]
  ) {
    oldSuffix--
    newSuffix--
  }

  if (prefix === oldVisibleLines.length && prefix === newVisibleLines.length) return lines.join('\n')

  const next = lines.slice()
  const inserted = newVisibleLines.slice(prefix, newSuffix)
  const oldChanged = oldSuffix - prefix

  if (oldChanged === 0) {
    const prevOrig = prefix > 0 ? visibleMap[prefix - 1] : -1
    next.splice(prevOrig + 1, 0, ...inserted)
    return next.join('\n')
  }

  const startOrig = visibleMap[prefix] ?? lines.length
  const endOrig = visibleMap[oldSuffix - 1] ?? startOrig
  next.splice(startOrig, Math.max(1, endOrig - startOrig + 1), ...inserted)
  return next.join('\n')
}
