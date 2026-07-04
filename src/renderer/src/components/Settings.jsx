import { useEffect } from 'react'
import { Icon } from './icons.jsx'
import { useI18n, LANGS } from '../i18n.jsx'
import { THEMES } from '../themes.js'
import { TypographyGroups } from './TypographyControls.jsx'

// One labeled row with a toggle switch on the right.
function SwitchRow({ label, desc, checked, onChange }) {
  return (
    <div className="hm-set-row">
      <div className="hm-set-text">
        <div className="hm-set-label">{label}</div>
        {desc && <div className="hm-set-desc">{desc}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`hm-switch${checked ? ' on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className="hm-switch-knob" />
      </button>
    </div>
  )
}

// Unified settings modal — the discoverable home for every preference. The
// status-bar Layout popover stays as a quick entry for the typography subset;
// both write through the same settings state in App.
export default function Settings({
  open,
  onClose,
  settings,
  updateSettings,
  theme,
  setTheme,
  customThemes = [],
  customTheme,
  onPickCustom,
  onRefreshThemes,
  onOpenThemesFolder,
  onGetMoreThemes,
  typographyProps
}) {
  const { lang, t, setLang } = useI18n()
  const caps = window.api.capabilities || {}

  // Esc closes; re-scan the themes folder on open so new CSS files show up.
  useEffect(() => {
    if (!open) return
    onRefreshThemes?.()
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // Refresh only on the open transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  return (
    <div className="hm-settings-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="hm-settings" role="dialog" aria-label={t('settings.title')}>
        <div className="hm-settings-head">
          <span className="hm-settings-title">
            <Icon name="settings" size={16} /> {t('settings.title')}
          </span>
          <button className="hm-settings-close" onClick={onClose} title={t('find.close')}>
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="hm-settings-body">
          {/* ── Editing ── */}
          <div className="hm-set-section">
            <div className="hm-set-section-title">{t('settings.sectionEditing')}</div>
            <div className="hm-set-row">
              <div className="hm-set-text">
                <div className="hm-set-label">{t('settings.defaultMode')}</div>
                <div className="hm-set-desc">{t('settings.defaultModeDesc')}</div>
              </div>
              <div className="hm-set-seg">
                {['keep', 'rich'].map((m) => (
                  <button
                    key={m}
                    className={`hm-set-seg-item${settings.defaultEditorMode === m ? ' active' : ''}`}
                    onClick={() => updateSettings({ defaultEditorMode: m })}
                  >
                    {t(m === 'keep' ? 'mode.keep' : 'mode.rich')}
                  </button>
                ))}
              </div>
            </div>
            <SwitchRow
              label={t('settings.autosave')}
              desc={t('settings.autosaveDesc')}
              checked={settings.autosave}
              onChange={(v) => updateSettings({ autosave: v })}
            />
            {caps.spellcheck && (
              <SwitchRow
                label={t('settings.spellcheck')}
                desc={t('settings.spellcheckDesc')}
                checked={settings.spellcheck}
                onChange={(v) => updateSettings({ spellcheck: v })}
              />
            )}
          </div>

          {/* ── Typography (same controls as the status-bar Layout popover) ── */}
          <div className="hm-set-section">
            <div className="hm-set-section-title">{t('settings.sectionTypography')}</div>
            <TypographyGroups {...typographyProps} />
          </div>

          {/* ── Appearance ── */}
          <div className="hm-set-section">
            <div className="hm-set-section-title">{t('settings.sectionAppearance')}</div>
            <div className="hm-set-themes">
              {THEMES.map((th) => (
                <button
                  key={th.id}
                  className={`hm-set-theme${!customTheme && th.id === theme ? ' active' : ''}`}
                  onClick={() => setTheme(th.id)}
                >
                  <span className="theme-swatch" style={{ background: th.swatch }} />
                  {lang === 'zh' ? th.zh : th.en}
                </button>
              ))}
              {customThemes.map((c) => (
                <button
                  key={c.file}
                  className={`hm-set-theme${customTheme === c.file ? ' active' : ''}`}
                  title={c.file}
                  onClick={() => onPickCustom?.(c.file)}
                >
                  <span className="theme-swatch theme-swatch-custom" />
                  {c.name}
                </button>
              ))}
            </div>
            <div className="hm-set-theme-actions">
              <button onClick={() => onOpenThemesFolder?.()}>
                <Icon name="folder" size={13} /> {t('theme.openFolder')}
              </button>
              <button onClick={() => onGetMoreThemes?.()}>
                <Icon name="globe" size={13} /> {t('theme.getMore')}
              </button>
            </div>
          </div>

          {/* ── Language ── */}
          <div className="hm-set-section">
            <div className="hm-set-section-title">{t('settings.sectionLanguage')}</div>
            <div className="hm-set-seg hm-set-langs">
              {LANGS.map((l) => (
                <button
                  key={l.id}
                  className={`hm-set-seg-item${l.id === lang ? ' active' : ''}`}
                  onClick={() => setLang(l.id)}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
