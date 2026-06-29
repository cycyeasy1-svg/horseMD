import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../i18n.jsx'
import { Icon } from './icons.jsx'

// Pull every heading the document renders — not just ATX `#` headings, but also
// Setext (text underlined with === / ---) and inline HTML <h1>…<h6> — so the
// outline matches what's actually shown. Fenced code is skipped, and a leading
// `---` YAML front-matter block is stepped over so its closing fence isn't
// mistaken for a Setext underline.
export function parseHeadings(md) {
  const lines = (md || '').split('\n')
  const out = []
  let inFence = false
  let fence = ''
  let i = 0
  // Skip a YAML front-matter block at the very top (--- … ---).
  if (lines[0] !== undefined && /^---\s*$/.test(lines[0])) {
    let j = 1
    while (j < lines.length && !/^---\s*$/.test(lines[j])) j++
    if (j < lines.length) i = j + 1 // found the closing fence
  }
  for (; i < lines.length; i++) {
    const line = lines[i]
    const fm = line.match(/^(\s*)(```+|~~~+)/)
    if (fm) {
      const marker = fm[2][0]
      if (!inFence) {
        inFence = true
        fence = marker
      } else if (marker === fence) {
        inFence = false
      }
      continue
    }
    if (inFence) continue
    // ATX: # … ######
    const hm = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (hm) {
      out.push({ level: hm[1].length, text: hm[2].trim() })
      continue
    }
    // Inline HTML heading: <h2 …>text</h2> (single line).
    const htm = line.match(/<h([1-6])\b[^>]*>(.*?)<\/h\1>/i)
    if (htm) {
      out.push({ level: Number(htm[1]), text: htm[2].replace(/<[^>]+>/g, '').trim() })
      continue
    }
    // Setext: a paragraph line underlined by === (h1) or --- (h2). The text line
    // must carry real content and not itself be a heading / list / quote / table.
    const next = lines[i + 1]
    if (
      next !== undefined &&
      /^(=+|-+)\s*$/.test(next) &&
      /\S/.test(line) &&
      !/^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\||\s*$)/.test(line)
    ) {
      out.push({ level: next.trim()[0] === '=' ? 1 : 2, text: line.trim() })
      i++ // consume the underline
      continue
    }
  }
  return out
}

export default function Outline({ content, activeIndex = -1, onJump }) {
  // Re-parsing the whole document on every keystroke is wasted work — the outline
  // can lag a beat behind the cursor. Deferring the content keeps typing smooth on
  // large docs (React renders the heavy parse at low priority).
  const deferredContent = useDeferredValue(content)
  const headings = useMemo(() => parseHeadings(deferredContent), [deferredContent])

  // Section fold state. A heading is collapsible when a deeper heading follows
  // it; collapsing hides every descendant (deeper heading) until a sibling/uncle
  // at the same-or-shallower level. Default is fully expanded (empty set), so the
  // outline reads like a flat list until the user folds something.
  const [collapsed, setCollapsed] = useState(() => new Set())
  const toggle = (i) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  // One pass over the flat list derives, per heading: whether it has children,
  // whether it's currently visible, and (when hidden) which collapsed ancestor
  // hides it — so the scrollspy can fall back to that ancestor when the active
  // heading is folded away.
  const view = useMemo(() => {
    const hasChildren = headings.map(
      (h, i) => i + 1 < headings.length && headings[i + 1].level > h.level
    )
    const visible = new Array(headings.length).fill(true)
    const hiddenBy = new Array(headings.length).fill(-1)
    let hideBelow = Infinity // hide headings deeper than this level
    let hideOwner = -1
    headings.forEach((h, i) => {
      if (h.level > hideBelow) {
        visible[i] = false
        hiddenBy[i] = hideOwner
        return
      }
      // exited any collapsed region at this level or shallower
      hideBelow = Infinity
      hideOwner = -1
      if (hasChildren[i] && collapsed.has(i)) {
        hideBelow = h.level
        hideOwner = i
      }
    })
    return { hasChildren, visible, hiddenBy }
  }, [headings, collapsed])

  // When the viewed heading is folded away, highlight the collapsed ancestor that
  // hides it instead, so the outline still shows roughly where you are.
  const effectiveActive =
    activeIndex >= 0 && !view.visible[activeIndex] ? view.hiddenBy[activeIndex] : activeIndex

  // Keep the active row scrolled into view (like the file tree reveals the open
  // file). Guarded so we only scroll on a real change.
  const activeRef = useRef(null)
  const lastScrolledRef = useRef(-1)
  useEffect(() => {
    if (effectiveActive >= 0 && activeRef.current && lastScrolledRef.current !== effectiveActive) {
      activeRef.current.scrollIntoView({ block: 'nearest' })
      lastScrolledRef.current = effectiveActive
    }
  }, [effectiveActive])

  return (
    <div className="outline">
      <div className="panel-head">{t('outline.title')}</div>
      <div className="outline-list">
        {headings.length === 0 ? (
          <div className="outline-empty">{t('outline.empty')}</div>
        ) : (
          headings.map((h, i) =>
            view.visible[i] ? (
              <div
                key={i}
                ref={i === effectiveActive ? activeRef : undefined}
                className={`outline-item lvl-${h.level}${i === effectiveActive ? ' active' : ''}`}
                style={{ paddingLeft: 8 + (h.level - 1) * 12 }}
                onClick={() => onJump(i)}
                title={h.text}
              >
                {view.hasChildren[i] ? (
                  <span
                    className={`outline-chevron${collapsed.has(i) ? '' : ' chevron-expanded'}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggle(i)
                    }}
                    title={t(collapsed.has(i) ? 'outline.expand' : 'outline.collapse')}
                  >
                    <Icon name="chevron-right" size={13} />
                  </span>
                ) : (
                  <span className="outline-chevron outline-chevron-spacer" />
                )}
                <span className="outline-label">{h.text}</span>
              </div>
            ) : null
          )
        )}
      </div>
    </div>
  )
}
