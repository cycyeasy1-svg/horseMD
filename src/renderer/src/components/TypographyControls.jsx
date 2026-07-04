import { useRef, useState } from 'react'
import { useI18n } from '../i18n.jsx'
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
  LINE_HEIGHT_PRESETS,
  LINE_HEIGHT_MIN,
  LINE_HEIGHT_MAX,
  PARA_SPACING_PRESETS,
  PARA_SPACING_MIN,
  PARA_SPACING_MAX
} from '../settings.js'

const zoomPct = (z) => Math.round(z * 100) + '%'
const round1 = (n) => Math.round(n * 10) / 10

// One small reusable "presets + fine-tune slider" block. Shared by the
// status-bar Layout popover and the Settings modal's typography section.
export function AdjustGroup({ title, valueLabel, presets, activeIndex, onPick, pct, fromX, onSet }) {
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

// The five typography adjusters (font size · width · zoom · line height ·
// paragraph spacing) with separators, wired to the shared settings setters.
export function TypographyGroups({
  fontSize,
  onSetFontSize,
  pageWidth,
  onSetPageWidth,
  zoom,
  onSetZoom,
  lineHeight,
  onSetLineHeight,
  paragraphSpacing,
  onSetParagraphSpacing
}) {
  const { t } = useI18n()

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

  const lhPct = (lineHeight - LINE_HEIGHT_MIN) / (LINE_HEIGHT_MAX - LINE_HEIGHT_MIN)
  const lhIdx = LINE_HEIGHT_PRESETS.findIndex((p) => p.value === lineHeight)
  const lhFromX = (track, clientX) => {
    const r = track.getBoundingClientRect()
    const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    return round1(LINE_HEIGHT_MIN + p * (LINE_HEIGHT_MAX - LINE_HEIGHT_MIN))
  }

  const psPct = (paragraphSpacing - PARA_SPACING_MIN) / (PARA_SPACING_MAX - PARA_SPACING_MIN)
  const psIdx = PARA_SPACING_PRESETS.findIndex((p) => p.value === paragraphSpacing)
  const psFromX = (track, clientX) => {
    const r = track.getBoundingClientRect()
    const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    return round1(PARA_SPACING_MIN + p * (PARA_SPACING_MAX - PARA_SPACING_MIN))
  }

  return (
    <>
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
      <div className="hm-pop-sep" />
      <AdjustGroup
        title={t('settings.lineHeight')}
        valueLabel={lineHeight.toFixed(2)}
        presets={LINE_HEIGHT_PRESETS.map((p) => ({
          ...p,
          label: t('settings.lineHeightPreset.' + p.id)
        }))}
        activeIndex={lhIdx}
        onPick={(p) => onSetLineHeight(p.value)}
        pct={lhPct}
        fromX={lhFromX}
        onSet={onSetLineHeight}
      />
      <div className="hm-pop-sep" />
      <AdjustGroup
        title={t('settings.paragraphSpacing')}
        valueLabel={paragraphSpacing.toFixed(1) + ' em'}
        presets={PARA_SPACING_PRESETS.map((p) => ({
          ...p,
          label: t('settings.paraSpacingPreset.' + p.id)
        }))}
        activeIndex={psIdx}
        onPick={(p) => onSetParagraphSpacing(p.value)}
        pct={psPct}
        fromX={psFromX}
        onSet={onSetParagraphSpacing}
      />
    </>
  )
}
