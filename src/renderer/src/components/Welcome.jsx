import { Icon } from './icons.jsx'
import logoUrl from '../assets/logo.png'

// App version, injected at build time from package.json (see electron.vite.config).
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''

function relTime(ts, lang, t) {
  if (!ts) return ''
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return t('time.justNow')
  if (min < 60) return t('time.minutesAgo', { n: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('time.hoursAgo', { n: hr })
  const days = Math.floor(hr / 24)
  if (days === 1) return t('time.yesterday')
  try {
    const locale = lang === 'zh' ? 'zh-CN' : lang === 'ja' ? 'ja-JP' : 'en-US'
    return new Date(ts).toLocaleDateString(locale, {
      month: 'short',
      day: 'numeric'
    })
  } catch {
    return ''
  }
}

// Welcome / empty-state screen: logo, version, quick actions, recent files.
export default function Welcome({
  t,
  lang,
  recents,
  onNew,
  onOpen,
  onOpenFolder,
  onOpenRecent,
  onRemoveRecent,
  onClearRecents,
  onTogglePinRecent
}) {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <img className="welcome-logo" src={logoUrl} alt="EasyMarkdown" />
        <h1>
          <span className="brand-easy">Easy</span>
          <span className="brand-md">Markdown</span>
          {APP_VERSION && <span className="welcome-version">v{APP_VERSION}</span>}
        </h1>
        <p className="welcome-tagline">{t('welcome.tagline')}</p>
        <div className="welcome-actions">
          <button className="btn-primary" onClick={onNew}>
            <Icon name="file-plus" size={16} /> {t('welcome.newFile')}
          </button>
          <button onClick={onOpen}>
            <Icon name="file" size={16} /> {t('welcome.openFile')}
          </button>
          <button onClick={onOpenFolder}>
            <Icon name="folder" size={16} /> {t('welcome.openFolder')}
          </button>
        </div>

        {recents && recents.length > 0 && (
          <div className="welcome-recents">
            <div className="welcome-recents-head">
              <span>{t('welcome.recent')}</span>
              {recents.some((r) => !r.pinned) && (
                <button className="recents-clear" onClick={onClearRecents}>
                  {t('welcome.clearRecents')}
                </button>
              )}
            </div>
            <div className="welcome-recents-list">
              {recents.map((r) => (
                <div
                  key={r.path}
                  className={'recent-item' + (r.pinned ? ' pinned' : '')}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenRecent(r.path)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onOpenRecent(r.path)
                    }
                  }}
                  title={r.path}
                >
                  <Icon name="file" size={16} className="recent-icon" />
                  <span className="recent-main">
                    <span className="recent-name">{r.name}</span>
                    <span className="recent-path">{r.dir}</span>
                  </span>
                  <span className="recent-time">{relTime(r.openedAt, lang, t)}</span>
                  <span className="recent-actions">
                    <button
                      className={'recent-act' + (r.pinned ? ' active' : '')}
                      title={t(r.pinned ? 'welcome.unpinRecent' : 'welcome.pinRecent')}
                      onClick={(e) => {
                        e.stopPropagation()
                        onTogglePinRecent(r.path)
                      }}
                    >
                      <Icon name="pin" size={13} />
                    </button>
                    <button
                      className="recent-act"
                      title={t('welcome.removeRecent')}
                      onClick={(e) => {
                        e.stopPropagation()
                        onRemoveRecent(r.path)
                      }}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="welcome-hints">
          <span><kbd>Ctrl</kbd><kbd>P</kbd> {t('hint.palette')}</span>
          <span><kbd>Ctrl</kbd><kbd>B</kbd> {t('hint.sidebar')}</span>
          <span><kbd>Ctrl</kbd><kbd>N</kbd> {t('hint.new')}</span>
          <span><kbd>Ctrl</kbd><kbd>S</kbd> {t('hint.save')}</span>
        </div>
      </div>
    </div>
  )
}
