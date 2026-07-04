import { memo, useEffect, useRef, useState } from 'react'
import { Icon } from './icons.jsx'
import { useI18n } from '../i18n.jsx'
import { baseName, dirName } from '../paths.js'

// Workspace full-text search (sidebar view). The heavy lifting is in the main
// process (search:start walks the roots and streams per-file batches); this
// panel only renders the stream. Options mirror the in-document find bar so
// both searches behave identically.
function SearchPanel({ workspaces, onOpenResult, onAddFolder, focusNonce }) {
  const { t } = useI18n()
  const inputRef = useRef(null)
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState({ caseSensitive: false, wholeWord: false, regex: false })
  // groups: [{ path, items: [{line, col, len, text, textCol}] }] in arrival order.
  const [groups, setGroups] = useState([])
  const [status, setStatus] = useState({ running: false, done: false, total: 0, truncated: false, error: '' })
  const searchIdRef = useRef(0)
  const debounceRef = useRef(0)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusNonce])

  // Subscribe to the result stream; batches for a superseded search id are
  // dropped (main also stops walking, but in-flight events can still land).
  useEffect(() => {
    const offBatch = window.api.onSearchBatch?.(({ id, path, items }) => {
      if (id !== searchIdRef.current) return
      setGroups((prev) => [...prev, { path, items }])
      setStatus((s) => ({ ...s, total: s.total + items.length }))
    })
    const offDone = window.api.onSearchDone?.(({ id, total, truncated }) => {
      if (id !== searchIdRef.current) return
      setStatus((s) => ({ ...s, running: false, done: true, total, truncated }))
    })
    return () => {
      offBatch?.()
      offDone?.()
      window.api.searchCancel?.()
    }
  }, [])

  const roots = (workspaces || []).map((w) => w.rootPath)

  const runSearch = async (q, opts = options) => {
    clearTimeout(debounceRef.current)
    setGroups([])
    if (!q.trim() || !roots.length) {
      searchIdRef.current = 0
      window.api.searchCancel?.()
      setStatus({ running: false, done: false, total: 0, truncated: false, error: '' })
      return
    }
    setStatus({ running: true, done: false, total: 0, truncated: false, error: '' })
    const res = await window.api.searchStart?.({ roots, query: q, options: opts })
    searchIdRef.current = res?.id ?? 0
    if (res?.error) {
      setStatus({ running: false, done: true, total: 0, truncated: false, error: res.error })
    }
  }

  const onQueryChange = (q) => {
    setQuery(q)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(q), 300)
  }

  const toggleOption = (key) => {
    const next = { ...options, [key]: !options[key] }
    setOptions(next)
    if (query.trim()) runSearch(query, next)
  }

  const opt = (key, label, tip) => (
    <button
      key={key}
      className={`findbar-option${options[key] ? ' active' : ''}`}
      title={tip}
      aria-pressed={options[key]}
      onClick={() => toggleOption(key)}
    >
      {label}
    </button>
  )

  // Render an excerpt with the matched span highlighted.
  const excerpt = (item) => {
    const pre = item.text.slice(0, item.textCol)
    const hit = item.text.slice(item.textCol, item.textCol + item.len)
    const post = item.text.slice(item.textCol + item.len)
    return (
      <>
        <span>{pre.trimStart()}</span>
        <mark className="hm-search-hit">{hit}</mark>
        <span>{post}</span>
      </>
    )
  }

  return (
    <div className="hm-search-panel">
      <div className="hm-search-head">{t('search.title')}</div>
      <div className="hm-search-box">
        <input
          ref={inputRef}
          value={query}
          placeholder={t('search.placeholder')}
          spellCheck={false}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              runSearch(query)
            }
          }}
        />
        <div className="hm-search-opts">
          {opt('caseSensitive', 'Aa', t('find.caseSensitive'))}
          {opt('wholeWord', 'W', t('find.wholeWord'))}
          {opt('regex', '.*', t('find.regex'))}
        </div>
      </div>

      <div className="hm-search-status">
        {status.error === 'regex'
          ? t('find.invalidRegex')
          : status.running
            ? t('search.searching', { n: status.total })
            : status.done
              ? (status.truncated
                  ? t('search.truncated', { n: status.total })
                  : t('search.results', { n: status.total, m: groups.length }))
              : ''}
      </div>

      <div className="hm-search-results">
        {!roots.length && (
          <div className="hm-search-empty">
            <p>{t('search.noWorkspace')}</p>
            <button className="hm-search-addfolder" onClick={onAddFolder}>
              <Icon name="folder-open" size={14} /> {t('welcome.openFolder')}
            </button>
          </div>
        )}
        {groups.map((g) => (
          <div className="hm-search-group" key={g.path}>
            <div className="hm-search-file" title={g.path}>
              <Icon name="file" size={13} className="hm-search-fileicon" />
              <span className="hm-search-filename">{baseName(g.path)}</span>
              <span className="hm-search-filedir">{dirName(g.path)}</span>
              <span className="hm-search-count">{g.items.length}</span>
            </div>
            {g.items.map((item, i) => (
              <button
                className="hm-search-item"
                key={`${item.line}:${item.col}:${i}`}
                title={t('search.gotoLine', { n: item.line })}
                onClick={() => onOpenResult(g.path, item.line)}
              >
                <span className="hm-search-line">{item.line}</span>
                <span className="hm-search-text">{excerpt(item)}</span>
              </button>
            ))}
          </div>
        ))}
        {status.done && !status.error && !groups.length && roots.length > 0 && (
          <div className="hm-search-empty">{t('search.noResults')}</div>
        )}
      </div>
    </div>
  )
}

export default memo(SearchPanel)
