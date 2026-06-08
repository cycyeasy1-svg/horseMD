import { useEffect, useRef } from 'react'
import { Icon } from './icons.jsx'
import { useI18n } from '../i18n.jsx'

export default function Tabs({ tabs, activeId, onActivate, onClose, onNew }) {
  const { t } = useI18n()
  const activeRef = useRef(null)

  // When the active tab changes (opened a new file, switched, or restored a
  // session), the tab strip may have scrolled it out of view once the tabs
  // overflow the window width. Pull it back into the visible range so the user
  // never has to hunt/scroll for the file they just opened. `inline: 'nearest'`
  // only scrolls when it's actually off-screen and never jumps vertically.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [activeId, tabs.length])

  return (
    <div className="tabs">
      <div className="tabs-scroll">
        {tabs.map((tab) => {
          const dirty = tab.content !== tab.savedContent
          const isActive = tab.id === activeId
          return (
            <div
              key={tab.id}
              ref={isActive ? activeRef : null}
              className={`tab${isActive ? ' active' : ''}`}
              onClick={() => onActivate(tab.id)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  onClose(tab.id)
                }
              }}
              title={tab.path || tab.title}
            >
              <span className="tab-title">{tab.title}</span>
              <span
                className={`tab-close${dirty ? ' dirty' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(tab.id)
                }}
              >
                {dirty ? <span className="dot" /> : <Icon name="close" size={13} />}
              </span>
            </div>
          )
        })}
      </div>
      <button className="tab-new" title={t('tab.new')} onClick={onNew}>
        <Icon name="plus" size={16} />
      </button>
    </div>
  )
}
