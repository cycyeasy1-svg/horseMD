import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './icons.jsx'
import logoUrl from '../assets/logo.png'
import { useI18n } from '../i18n.jsx'
import { THEMES, themeById } from '../themes.js'
import { LANGS } from '../i18n.jsx'
import {
  PAGE_WIDTH_PRESETS,
  PAGE_WIDTH_MIN,
  PAGE_WIDTH_MAX,
  FONT_SIZE_PRESETS,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  ZOOM_PRESETS,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_STEP
} from '../settings.js'

const zoomPct = (z) => Math.round(z * 100) + '%'

// Render a short string with **bold** spans (used by the one-time mode hint).
function boldMd(s) {
  return String(s)
    .split(/(\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map((seg, i) =>
      seg.startsWith('**') && seg.endsWith('**') ? (
        <strong key={i}>{seg.slice(2, -2)}</strong>
      ) : (
        <span key={i}>{seg}</span>
      )
    )
}

// App version, injected at build time from package.json (see electron.vite.config).
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''
const ORIGINAL_AUTHOR = 'Evan Yang'
const FORK_AUTHOR = 'Easy Chen'

// Render an i18n template like "Built by {author}…" with the {token} slots
// swapped for emphasized names, so the names stay bold across both languages.
function richLine(tpl, map) {
  return tpl.split(/(\{\w+\})/g).map((part, i) => {
    const m = part.match(/^\{(\w+)\}$/)
    return m ? (
      <strong className="hm-about-name" key={i}>
        {map[m[1]]}
      </strong>
    ) : (
      part
    )
  })
}

function stats(md) {
  const text = (md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/[#>*_~\-\[\]()!]/g, ' ')
  const words = (text.match(/[\p{L}\p{N}]+/gu) || []).length
  const chars = (md || '').length
  const charsNoSpace = (md || '').replace(/\s/g, '').length
  const readMin = Math.max(1, Math.round(words / 220))
  return { words, chars, charsNoSpace, readMin }
}

// Small popover that closes on outside click.
function usePopover() {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  return { open, setOpen, ref }
}

// One small reusable "presets + fine-tune slider" block, used for both font size
// and editor width inside the combined Layout popover.
function AdjustGroup({ title, valueLabel, presets, activeIndex, onPick, pct, fromX, onSet }) {
  const { t } = useI18n()
  const trackRef = useRef(null)
  const [dragging, setDragging] = useState(false)
  const startDrag = (e) => {
    e.preventDefault()
    setDragging(true)
    onSet(fromX(trackRef.current, e.clientX))
    const onMove = (ev) => onSet(fromX(trackRef.current, ev.clientX))
    const onUp = () => {
      setDragging(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  return (
    <div className="hm-adjust-group">
      <div className="hm-pop-head">
        <span className="hm-pop-title">{title}</span>
        <span className="hm-pop-value">{valueLabel}</span>
      </div>
      <div className="hm-seg" style={{ '--seg-count': presets.length, '--seg-index': activeIndex }}>
        {activeIndex >= 0 && <span className="hm-seg-pill" aria-hidden="true" />}
        {presets.map((p, i) => (
          <button
            key={p.id}
            className={`hm-seg-item${i === activeIndex ? ' active' : ''}`}
            onClick={() => onPick(p)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className={`hm-fine${dragging ? ' dragging' : ''}`}>
        <span className="hm-fine-label">{t('settings.fineTune')}</span>
        <div className="hm-ftrack" ref={trackRef} onPointerDown={startDrag}>
          <div className="hm-ffill" style={{ width: pct * 100 + '%' }} />
          <div className="hm-fthumb" style={{ left: pct * 100 + '%' }} />
        </div>
      </div>
    </div>
  )
}

// Combined "layout" control: ONE secondary status-bar button → a popover that
// holds both the font-size and editor-width adjusters. Replaces the two separate
// status-bar buttons so the bar stays uncluttered. `hm-pagewidth` lets mobile
// hide it via CSS (mobile sets size in the "more" sheet and forces full width).
function LayoutControl({ fontSize, onSetFontSize, pageWidth, onSetPageWidth, zoom, onSetZoom }) {
  const { t } = useI18n()
  const { open, setOpen, ref } = usePopover()

  const zoomPctVal = (zoom - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN)
  const zoomIdx = ZOOM_PRESETS.findIndex((p) => p.zoom === zoom)
  const zoomFromX = (track, clientX) => {
    const r = track.getBoundingClientRect()
    const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    return ZOOM_MIN + p * (ZOOM_MAX - ZOOM_MIN)
  }

  const fontPct = (fontSize - FONT_SIZE_MIN) / (FONT_SIZE_MAX - FONT_SIZE_MIN)
  const fontIdx = FONT_SIZE_PRESETS.findIndex((p) => p.size === fontSize)
  const fontFromX = (track, clientX) => {
    const r = track.getBoundingClientRect()
    const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    return Math.round(FONT_SIZE_MIN + p * (FONT_SIZE_MAX - FONT_SIZE_MIN))
  }

  const isFull = pageWidth === 'full'
  const widthPct = isFull ? 1 : (pageWidth - PAGE_WIDTH_MIN) / (PAGE_WIDTH_MAX - PAGE_WIDTH_MIN)
  const widthIdx = PAGE_WIDTH_PRESETS.findIndex((p) =>
    p.width === 'full' ? isFull : !isFull && pageWidth === p.width
  )
  const widthFromX = (track, clientX) => {
    const r = track.getBoundingClientRect()
    const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    return Math.round((PAGE_WIDTH_MIN + p * (PAGE_WIDTH_MAX - PAGE_WIDTH_MIN)) / 10) * 10
  }

  return (
    <div className="block-switch hm-pagewidth hm-layout" ref={ref}>
      <button className="status-btn" onClick={() => setOpen((v) => !v)} title={t('settings.layout')}>
        <Icon name="settings" size={14} /> {t('settings.layoutLabel')}
      </button>
      {open && (
        <div className="hm-pop hm-width-pop hm-layout-pop">
          <AdjustGroup
            title={t('settings.fontSize')}
            valueLabel={fontSize + ' px'}
            presets={FONT_SIZE_PRESETS.map((p) => ({ ...p, label: t('settings.font.' + p.id) }))}
            activeIndex={fontIdx}
            onPick={(p) => onSetFontSize(p.size)}
            pct={fontPct}
            fromX={fontFromX}
            onSet={onSetFontSize}
          />
          <div className="hm-pop-sep" />
          <AdjustGroup
            title={t('settings.pageWidth')}
            valueLabel={isFull ? t('settings.width.full') : pageWidth + ' px'}
            presets={PAGE_WIDTH_PRESETS.map((p) => ({ ...p, label: t('settings.width.' + p.id) }))}
            activeIndex={widthIdx}
            onPick={(p) => onSetPageWidth(p.width)}
            pct={widthPct}
            fromX={widthFromX}
            onSet={onSetPageWidth}
          />
          <div className="hm-pop-sep" />
          <AdjustGroup
            title={t('settings.zoom')}
            valueLabel={zoomPct(zoom)}
            presets={ZOOM_PRESETS.map((p) => ({ ...p, label: zoomPct(p.zoom) }))}
            activeIndex={zoomIdx}
            onPick={(p) => onSetZoom(p.zoom)}
            pct={zoomPctVal}
            fromX={zoomFromX}
            onSet={onSetZoom}
          />
        </div>
      )}
    </div>
  )
}

// Document stats: one status-bar button showing the character count → popover
// with the full breakdown (words, characters, characters w/o spaces, read time).
function StatsControl({ stats }) {
  const { t } = useI18n()
  const { open, setOpen, ref } = usePopover()
  const n = (x) => x.toLocaleString()
  const rows = [
    [t('status.statWords'), n(stats.words)],
    [t('status.statChars'), n(stats.chars)],
    [t('status.statCharsNoSpace'), n(stats.charsNoSpace)],
    [t('status.statRead'), t('status.readValue', { n: stats.readMin })]
  ]
  return (
    <div className="block-switch hm-stats" ref={ref}>
      <button className="status-btn" onClick={() => setOpen((v) => !v)} title={t('status.stats')}>
        <Icon name="stats" size={14} /> {t('status.chars', { n: n(stats.chars) })}
      </button>
      {open && (
        <div className="hm-pop hm-stats-pop">
          {rows.map(([label, value]) => (
            <div className="hm-stat-row" key={label}>
              <span className="hm-stat-label">{label}</span>
              <span className="hm-stat-value">{value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ThemePicker({
  theme,
  setTheme,
  customThemes = [],
  customTheme,
  onPickCustom,
  onRefreshThemes,
  onOpenThemesFolder,
  onGetMoreThemes
}) {
  const { lang, t } = useI18n()
  const { open, setOpen, ref } = usePopover()
  const cur = themeById(theme)
  // Re-scan the themes folder each time the menu opens so freshly-dropped CSS
  // files show up without a restart.
  const toggle = () => {
    if (!open) onRefreshThemes?.()
    setOpen((v) => !v)
  }
  const activeCustom = customThemes.find((c) => c.file === customTheme)
  const triggerLabel = activeCustom ? activeCustom.name : lang === 'zh' ? cur.zh : cur.en
  return (
    <div className="block-switch" ref={ref}>
      <button className="status-btn" onClick={toggle} title={t('tip.toggleTheme')}>
        <span className="theme-swatch" style={{ background: activeCustom ? 'var(--accent)' : cur.swatch }} />
        {triggerLabel}
        <span className="block-switch-caret">▾</span>
      </button>
      {open && (
        <div className="block-switch-menu theme-menu">
          {THEMES.map((th) => (
            <button
              key={th.id}
              className={`block-menu-item${!customTheme && th.id === theme ? ' active' : ''}`}
              onClick={() => {
                setTheme(th.id)
                setOpen(false)
              }}
            >
              <span className="theme-swatch" style={{ background: th.swatch }} />
              <span className="block-menu-name">{lang === 'zh' ? th.zh : th.en}</span>
            </button>
          ))}

          {customThemes.length > 0 && (
            <>
              <div className="theme-menu-label">{t('theme.custom')}</div>
              {customThemes.map((c) => (
                <button
                  key={c.file}
                  className={`block-menu-item${customTheme === c.file ? ' active' : ''}`}
                  onClick={() => {
                    onPickCustom?.(c.file)
                    setOpen(false)
                  }}
                  title={c.file}
                >
                  <span className="theme-swatch theme-swatch-custom" />
                  <span className="block-menu-name">
                    {c.name}
                    {c.dir ? <span className="theme-custom-dir"> · {c.dir}</span> : null}
                  </span>
                </button>
              ))}
            </>
          )}

          <div className="theme-menu-sep" />
          <button
            className="block-menu-item theme-menu-action"
            onClick={() => {
              onOpenThemesFolder?.()
              setOpen(false)
            }}
          >
            <Icon name="folder" size={13} />
            <span className="block-menu-name">{t('theme.openFolder')}</span>
          </button>
          <button
            className="block-menu-item theme-menu-action"
            onClick={() => {
              onGetMoreThemes?.()
              setOpen(false)
            }}
          >
            <Icon name="globe" size={13} />
            <span className="block-menu-name">{t('theme.getMore')}</span>
          </button>
        </div>
      )}
    </div>
  )
}

function LangSwitch({ lang, setLang }) {
  const { t } = useI18n()
  const { open, setOpen, ref } = usePopover()
  return (
    <div className="block-switch" ref={ref}>
      <button className="status-btn" onClick={() => setOpen((v) => !v)} title={t('tip.language')}>
        <Icon name="globe" size={14} /> {LANGS.find((l) => l.id === lang)?.label ?? 'EN'}
      </button>
      {open && (
        <div className="block-switch-menu">
          {LANGS.map((l) => (
            <button
              key={l.id}
              className={`block-menu-item${l.id === lang ? ' active' : ''}`}
              onClick={() => {
                setLang(l.id)
                setOpen(false)
              }}
            >
              <span className="block-menu-name">{l.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// About: replaces the bare GitHub link with a small credits popover. It keeps
// the original author's attribution and a link to the upstream project, which
// the MIT license requires us to preserve, alongside this fork's repo.
function AboutControl() {
  const { t } = useI18n()
  const { open, setOpen, ref } = usePopover()
  return (
    <div className="block-switch hm-about" ref={ref}>
      <button className="status-btn" onClick={() => setOpen((v) => !v)} title={t('about.title')}>
        <Icon name="info" size={14} />
      </button>
      {open && (
        <div className="hm-pop hm-about-pop">
          <div className="hm-about-head">
            <img className="hm-about-logo" src={logoUrl} alt="EasyMarkdown" />
            <div className="hm-about-name-ver">
              <span className="hm-about-brand">
                <span className="brand-easy">Easy</span>
                <span className="brand-md">Markdown</span>
              </span>
              {APP_VERSION && <span className="hm-about-ver">v{APP_VERSION}</span>}
            </div>
          </div>
          <p className="hm-about-text">
            {richLine(t('about.intro'), { author: FORK_AUTHOR, project: 'horseMD' })}
          </p>
          <p className="hm-about-text">
            {richLine(t('about.thanks'), { author: ORIGINAL_AUTHOR })}
          </p>
          <div className="hm-about-license">{t('about.license')}</div>
        </div>
      )}
    </div>
  )
}

// Mobile: a single "•••" popover that folds together the controls that crowd
// the bottom bar on a phone — word counts, source toggle, theme, language,
// GitHub — so the bar itself stays to just the block type + this one button.
function MobileMore({
  dirty,
  onSave,
  sourceMode,
  onToggleSource,
  theme,
  setTheme,
  lang,
  setLang,
  customThemes = [],
  customTheme,
  onPickCustom,
  onRefreshThemes,
  fontSize,
  onSetFontSize,
  zoom,
  onSetZoom
}) {
  const { t } = useI18n()
  const { open, setOpen, ref } = usePopover()
  const stepFont = (delta) =>
    onSetFontSize(Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, fontSize + delta)))
  const stepZoom = (delta) =>
    onSetZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom + delta)))
  const toggle = () => {
    if (!open) onRefreshThemes?.()
    setOpen((v) => !v)
  }
  return (
    <div className="block-switch" ref={ref}>
      <button className="status-btn hm-more-btn" onClick={toggle} title={t('status.more')}>
        <Icon name="more" size={16} />
        <span>{t('status.more')}</span>
      </button>
      {open && (
        <div className="block-switch-menu hm-status-sheet">
          <button
            className={`block-menu-item hm-sheet-save${dirty ? ' dirty' : ''}`}
            onClick={() => {
              onSave?.()
              setOpen(false)
            }}
          >
            <Icon name="save" size={15} />
            <span className="block-menu-name">{t('status.save')}</span>
            {dirty && <span className="hm-sheet-save-dot" />}
          </button>
          <div className="theme-menu-sep" />
          <button
            className="block-menu-item"
            onClick={() => {
              onToggleSource()
              setOpen(false)
            }}
          >
            <Icon name="code" size={14} />
            <span className="block-menu-name">
              {sourceMode ? t('status.source') : t('status.rich')}
            </span>
          </button>

          <div className="theme-menu-label">{t('settings.fontSize')}</div>
          <div className="hm-sheet-fontsize">
            <button
              className="hm-fontstep"
              onClick={() => stepFont(-1)}
              disabled={fontSize <= FONT_SIZE_MIN}
              aria-label="−"
            >
              −
            </button>
            <span className="hm-fontstep-value">{fontSize}px</span>
            <button
              className="hm-fontstep"
              onClick={() => stepFont(1)}
              disabled={fontSize >= FONT_SIZE_MAX}
              aria-label="+"
            >
              +
            </button>
          </div>

          <div className="theme-menu-label">{t('settings.zoom')}</div>
          <div className="hm-sheet-fontsize">
            <button
              className="hm-fontstep"
              onClick={() => stepZoom(-ZOOM_STEP)}
              disabled={zoom <= ZOOM_MIN}
              aria-label="−"
            >
              −
            </button>
            <span className="hm-fontstep-value">{zoomPct(zoom)}</span>
            <button
              className="hm-fontstep"
              onClick={() => stepZoom(ZOOM_STEP)}
              disabled={zoom >= ZOOM_MAX}
              aria-label="+"
            >
              +
            </button>
          </div>

          <div className="theme-menu-label">{t('tip.toggleTheme')}</div>
          <div className="hm-sheet-themes">
            {THEMES.map((th) => (
              <button
                key={th.id}
                className={`hm-sheet-swatch${!customTheme && th.id === theme ? ' active' : ''}`}
                style={{ background: th.swatch }}
                title={lang === 'zh' ? th.zh : th.en}
                onClick={() => setTheme(th.id)}
              />
            ))}
            {customThemes.map((c) => (
              <button
                key={c.file}
                className={`hm-sheet-swatch hm-sheet-swatch-custom${customTheme === c.file ? ' active' : ''}`}
                title={c.name}
                onClick={() => onPickCustom?.(c.file)}
              />
            ))}
          </div>

          <div className="theme-menu-label">{t('tip.language')}</div>
          <div className="hm-sheet-langs">
            {LANGS.map((l) => (
              <button
                key={l.id}
                className={`block-menu-item${l.id === lang ? ' active' : ''}`}
                onClick={() => setLang(l.id)}
              >
                <span className="block-menu-name">{l.label}</span>
              </button>
            ))}
          </div>

          <div className="theme-menu-sep" />
          <div className="theme-menu-label">{t('about.title')}</div>
          <div className="hm-about-sheet">
            <p className="hm-about-text">
              {richLine(t('about.intro'), { author: FORK_AUTHOR, project: 'horseMD' })}
            </p>
            <p className="hm-about-text">
              {richLine(t('about.thanks'), { author: ORIGINAL_AUTHOR })}
            </p>
            <div className="hm-about-license">{t('about.license')}</div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function StatusBar({
  tab,
  isMobile,
  onSave,
  onShare,
  theme,
  setTheme,
  lang,
  setLang,
  sourceMode,
  onToggleSource,
  keepEligible,
  keepMode,
  onToggleKeep,
  showModeHint,
  onDismissModeHint,
  pageWidth,
  onSetPageWidth,
  fontSize,
  onSetFontSize,
  zoom,
  onSetZoom,
  customThemes,
  customTheme,
  onPickCustom,
  onRefreshThemes,
  onOpenThemesFolder,
  onGetMoreThemes,
  filterInfo
}) {
  const { t } = useI18n()
  const s = useMemo(() => stats(tab?.content), [tab?.content])
  const dirty = tab && tab.content !== tab.savedContent
  return (
    <div className="statusbar">
      <div className="status-left">
        {tab ? (
          isMobile ? (
            <>
              <span className={`status-dot ${dirty ? 'mod' : 'ok'}`}>{dirty ? '●' : '✓'}</span>
              <span className="status-counts">
                {t('status.words', { n: s.words })} · {t('status.chars', { n: s.chars })} ·{' '}
                {t('status.read', { n: s.readMin })}
              </span>
            </>
          ) : (
            <>
              <span className="status-path" title={tab.path || t('status.unsaved')}>
                {tab.path || t('status.unsaved')}
              </span>
              <span className={`status-dot ${dirty ? 'mod' : 'ok'}`}>
                {dirty ? '● ' + t('status.modified') : '✓ ' + t('status.saved')}
              </span>
              {filterInfo && (
                <span className="status-filter" title={t('status.filtered', filterInfo)}>
                  <Icon name="filter" size={12} />{' '}
                  {t('status.filtered', filterInfo)}
                </span>
              )}
            </>
          )
        ) : (
          <span className="status-path">{t('status.ready')}</span>
        )}
      </div>
      <div className="status-right">
        {isMobile ? (
          tab && (
            <>
              {window.api.capabilities?.canShare && (
                <button className="status-btn hm-share-btn" onClick={onShare} title={t('status.share')}>
                  <Icon name="share" size={17} />
                  <span>{t('status.shareShort')}</span>
                </button>
              )}
              <MobileMore
                dirty={dirty}
                onSave={onSave}
                sourceMode={sourceMode}
                onToggleSource={onToggleSource}
                theme={theme}
                setTheme={setTheme}
                lang={lang}
                setLang={setLang}
                customThemes={customThemes}
                customTheme={customTheme}
                onPickCustom={onPickCustom}
                onRefreshThemes={onRefreshThemes}
                fontSize={fontSize}
                onSetFontSize={onSetFontSize}
                zoom={zoom}
                onSetZoom={onSetZoom}
              />
            </>
          )
        ) : (
          <>
            {tab && <StatsControl stats={s} />}
            {keepEligible && (
              <span className="mode-switch-wrap">
                <button
                  className={`status-btn${keepMode ? ' active' : ''}`}
                  onClick={onToggleKeep}
                  title={t('tip.toggleKeep')}
                >
                  <Icon name="shield" size={14} /> {keepMode ? t('mode.keep') : t('mode.rich')}
                </button>
                {showModeHint && (
                  <div className="mode-hint" role="dialog">
                    <button
                      className="mode-hint-close"
                      onClick={onDismissModeHint}
                      aria-label={t('hint.gotIt')}
                    >
                      ✕
                    </button>
                    <div className="mode-hint-title">{t('hint.modeTitle')}</div>
                    <p className="mode-hint-line">{boldMd(t('hint.modeKeep'))}</p>
                    <p className="mode-hint-line">{boldMd(t('hint.modeRich'))}</p>
                    <div className="mode-hint-actions">
                      <button className="mode-hint-ok" onClick={onDismissModeHint}>
                        {t('hint.gotIt')}
                      </button>
                    </div>
                    <span className="mode-hint-arrow" />
                  </div>
                )}
              </span>
            )}
            <button className="status-btn" onClick={onToggleSource} title={t('tip.toggleSource')}>
              <Icon name="code" size={14} /> {sourceMode ? t('status.source') : t('status.rich')}
            </button>
            <LayoutControl
              fontSize={fontSize}
              onSetFontSize={onSetFontSize}
              pageWidth={pageWidth}
              onSetPageWidth={onSetPageWidth}
              zoom={zoom}
              onSetZoom={onSetZoom}
            />
            <ThemePicker
              theme={theme}
              setTheme={setTheme}
              customThemes={customThemes}
              customTheme={customTheme}
              onPickCustom={onPickCustom}
              onRefreshThemes={onRefreshThemes}
              onOpenThemesFolder={onOpenThemesFolder}
              onGetMoreThemes={onGetMoreThemes}
            />
            <LangSwitch lang={lang} setLang={setLang} />
            <AboutControl />
          </>
        )}
      </div>
    </div>
  )
}
