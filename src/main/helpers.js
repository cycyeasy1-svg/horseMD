// Pure main-process helpers — no Electron, no Node-runtime state — so they can be
// imported by both src/main/index.js AND the unit tests (which run without an
// Electron runtime). Keep this module dependency-free: anything needing `app`,
// `fs`, or chokidar stays in index.js.

// Supported Markdown file types — single source for the open-dialog filter and
// the extension test used while scanning folders / launch args.
export const MD_EXTS = ['md', 'markdown', 'mdx', 'txt']
export const MD_RE = new RegExp(`\\.(${MD_EXTS.join('|')})$`, 'i')

// An absolute path: POSIX "/…", Windows "C:\…"/"C:/…", or a UNC "\\…".
export const isAbsolutePath = (p) => /^\//.test(p) || /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p)

// Paths we must never watch recursively: a non-absolute path (resolves against
// the process CWD — "/" under Finder/launchd, so it would recurse the whole
// filesystem and crash the watcher), plus macOS system/device trees that throw
// EACCES/EPERM when watched.
export const isRestrictedRoot = (p) => {
  const norm = (p || '').replace(/[\\/]+$/, '')
  if (norm === '' || norm === '/' || norm === '.' || norm === '..') return true
  if (!isAbsolutePath(norm)) return true
  return /^\/(dev|proc|System\/Volumes|private\/var\/(db|folders)|\.vol)(\/|$)/.test(norm)
}

// ── Workspace full-text search: per-file matching ──
// Line-oriented so results carry a 1-based line number the renderer can jump
// to. Options mirror the in-document find bar (caseSensitive / wholeWord /
// regex) so both searches behave identically. Pure — the fs walk lives in
// index.js; this only sees one file's content.
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u
const isWordChar = (ch) => !!ch && WORD_CHAR_RE.test(ch)
const isWholeWordMatch = (text, start, len) =>
  !isWordChar(text[start - 1]) && !isWordChar(text[start + len])

// Long lines are excerpted around the first match so a minified/one-line file
// can't flood the results UI. `textCol` is the match position INSIDE `text`.
const EXCERPT_MAX = 240
function makeHit(lineIdx, col, len, line) {
  let text = line
  let textCol = col
  if (line.length > EXCERPT_MAX) {
    const start = Math.max(0, col - 60)
    const prefix = start > 0 ? '…' : ''
    text = prefix + line.slice(start, start + EXCERPT_MAX)
    textCol = col - start + prefix.length
  }
  return { line: lineIdx + 1, col, len, text, textCol }
}

export function searchContentLines(content, query, options = {}, cap = 50) {
  const q = String(query ?? '')
  if (!q) return { matches: [], error: '' }
  let re = null
  if (options.regex) {
    try {
      re = new RegExp(q, options.caseSensitive ? 'g' : 'gi')
    } catch {
      return { matches: [], error: 'regex' }
    }
  }
  const out = []
  const lines = String(content ?? '').split('\n')
  for (let i = 0; i < lines.length && out.length < cap; i++) {
    const line = lines[i]
    if (re) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(line)) && out.length < cap) {
        if (!m[0]) {
          re.lastIndex += 1
          continue
        }
        if (options.wholeWord && !isWholeWordMatch(line, m.index, m[0].length)) continue
        out.push(makeHit(i, m.index, m[0].length, line))
      }
    } else {
      const hay = options.caseSensitive ? line : line.toLowerCase()
      const needle = options.caseSensitive ? q : q.toLowerCase()
      let idx = hay.indexOf(needle)
      while (idx !== -1 && out.length < cap) {
        if (!options.wholeWord || isWholeWordMatch(line, idx, q.length)) {
          out.push(makeHit(i, idx, q.length, line))
        }
        idx = hay.indexOf(needle, idx + Math.max(1, needle.length))
      }
    }
  }
  return { matches: out, error: '' }
}

// Split a desired image filename into a filesystem-safe { stem, ext }, stripping
// path/reserved chars. The fs collision check (appending -1, -2…) lives in
// uniqueImageFile in index.js — this is just the pure naming part.
export const imageNameParts = (name) => {
  const safe = (name || 'image.png').replace(/[\\/:*?"<>|]/g, '_') || 'image.png'
  const dot = safe.lastIndexOf('.')
  const ext = dot > 0 ? safe.slice(dot) : '.png'
  const stem = (dot > 0 ? safe.slice(0, dot) : safe) || 'image'
  return { stem, ext }
}
