import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Divider, Empty, Input, InputNumber, Segmented, Select, Switch, Tooltip, Typography } from 'antd'
import { AlignCenterOutlined, AlignLeftOutlined, AlignRightOutlined, BorderOutlined, CopyOutlined, DeleteOutlined, FontSizeOutlined, QrcodeOutlined, TagOutlined } from '@ant-design/icons'
import api from '../api'
import { useLang } from '../i18n'
import { ElementContent } from './TemplateLabel'
import { newId } from '../labelTemplate'
import { EQUIPMENT_SOURCES, PERSON_SOURCES, newFormElement } from '../custodyForm'

const MM_PX = 96 / 25.4
const snap = (v) => Math.round(v * 2) / 2
const clamp = (v, min, max) => Math.min(Math.max(v, min), max)
const TYPE_ICON = { qr: <QrcodeOutlined />, field: <TagOutlined />, text: <FontSizeOutlined />, box: <BorderOutlined /> }

/**
 * Places custody values on an uploaded form (PDF pages / image shown as background).
 * Same handling as the label designer: drag to move, corner to resize, arrows to nudge, Delete to remove.
 */
export default function FormDesigner({ pages, layout, onChange, qrUrl }) {
  const { t } = useLang()
  const [page, setPage] = useState(0)
  const [selectedId, setSelectedId] = useState(null)
  const [keys, setKeys] = useState([])
  const stageRef = useRef(null)
  const [stageWidth, setStageWidth] = useState(800)

  useEffect(() => {
    api.get('/equipment/keys').then(({ data }) => setKeys(data))
  }, [])

  useEffect(() => {
    const node = stageRef.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => setStageWidth(entry.contentRect.width))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const size = pages[page]
  const zoom = clamp((stageWidth - 48) / (size.w * MM_PX), 0.3, 3)
  const pxPerMm = MM_PX * zoom

  const elements = layout.elements
  const selected = elements.find((e) => e.id === selectedId)
  const setElements = (list) => onChange({ ...layout, elements: list })
  const update = (id, patch) => setElements(elements.map((e) => (e.id === id ? { ...e, ...patch } : e)))
  const remove = (id) => {
    setElements(elements.filter((e) => e.id !== id))
    setSelectedId(null)
  }
  const add = (type) => {
    const el = newFormElement(type, page, size)
    setElements([...elements, el])
    setSelectedId(el.id)
  }

  const startDrag = (e, el, mode) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setSelectedId(el.id)
    stageRef.current?.focus()
    const start = { x: e.clientX, y: e.clientY, el: { ...el } }
    const move = (ev) => {
      const dx = (ev.clientX - start.x) / pxPerMm
      const dy = (ev.clientY - start.y) / pxPerMm
      if (mode === 'move') {
        update(el.id, { x: clamp(snap(start.el.x + dx), 0, size.w - start.el.w), y: clamp(snap(start.el.y + dy), 0, size.h - start.el.h) })
      } else if (el.type === 'qr') {
        const s = clamp(snap(start.el.w + Math.max(dx, dy)), 8, Math.min(size.w - start.el.x, size.h - start.el.y))
        update(el.id, { w: s, h: s })
      } else {
        update(el.id, { w: clamp(snap(start.el.w + dx), 3, size.w - start.el.x), h: clamp(snap(start.el.h + dy), 2, size.h - start.el.y) })
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onKeyDown = (e) => {
    if (!selected || e.target !== stageRef.current) return
    const step = e.shiftKey ? 2 : 0.5
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    if (moves[e.key]) {
      e.preventDefault()
      const [dx, dy] = moves[e.key]
      update(selected.id, { x: clamp(selected.x + dx, 0, size.w - selected.w), y: clamp(selected.y + dy, 0, size.h - selected.h) })
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      remove(selected.id)
    } else if (e.key === 'Escape') {
      setSelectedId(null)
    }
  }

  const sourceLabel = useMemo(() => (source) => (source?.startsWith('field:') ? source.slice(6) : t(`cf_src_${source}`)), [t])
  const sourceOptions = [
    { label: t('cf_group_person'), options: PERSON_SOURCES.map((s) => ({ value: s, label: sourceLabel(s) })) },
    { label: t('cf_group_equipment'), options: EQUIPMENT_SOURCES.map((s) => ({ value: s, label: sourceLabel(s) })) },
    { label: t('ld_word_fields'), options: keys.map((k) => ({ value: `field:${k}`, label: k })) },
  ]
  const placeholder = (el) => (el.type === 'field' ? `{${sourceLabel(el.source)}}` : '')
  const onPage = elements.filter((el) => el.page === page)

  return (
    <div className="designer">
      <div className="designer-toolbar">
        <Typography.Text type="secondary">{t('ld_add')}:</Typography.Text>
        <Button type="primary" icon={<TagOutlined />} onClick={() => add('field')}>
          {t('ld_field')}
        </Button>
        <Button icon={<FontSizeOutlined />} onClick={() => add('text')}>
          {t('ld_text')}
        </Button>
        <Button icon={<QrcodeOutlined />} onClick={() => add('qr')}>
          {t('ld_qr')}
        </Button>
        <Button icon={<BorderOutlined />} onClick={() => add('box')}>
          {t('ld_box')}
        </Button>
        <div style={{ flex: 1 }} />
        {pages.length > 1 && (
          <Segmented
            value={page}
            onChange={(p) => {
              setPage(p)
              setSelectedId(null)
            }}
            options={pages.map((_, i) => ({ value: i, label: `${t('cf_page')} ${i + 1}` }))}
          />
        )}
      </div>

      <div className="designer-body">
        <div ref={stageRef} className="designer-stage form-stage" tabIndex={0} onKeyDown={onKeyDown} onPointerDown={() => setSelectedId(null)}>
          <div className="designer-paper" style={{ width: size.w * pxPerMm, height: size.h * pxPerMm }}>
            <div className="tlabel designing" dir="ltr" style={{ width: `${size.w}mm`, height: `${size.h}mm`, transform: `scale(${zoom})` }}>
              <img className="cf-bg" src={size.src} alt="" draggable={false} />
              {onPage.map((el) => (
                <div
                  key={el.id}
                  className={`tl-el design-el${el.id === selectedId ? ' selected' : ''}`}
                  style={{ left: `${el.x}mm`, top: `${el.y}mm`, width: `${el.w}mm`, height: `${el.h}mm` }}
                  onPointerDown={(e) => startDrag(e, el, 'move')}
                >
                  <ElementContent el={el} url={qrUrl} value={el.type === 'text' ? el.text || '' : ''} placeholder={placeholder} />
                  {el.id === selectedId && <div className="design-handle" onPointerDown={(e) => startDrag(e, el, 'resize')} style={{ width: `${10 / zoom}px`, height: `${10 / zoom}px` }} />}
                </div>
              ))}
            </div>
          </div>
          <Typography.Text type="secondary" className="designer-hint">
            {t('cf_hint')}
          </Typography.Text>
        </div>

        <div className="designer-panel">
          {!selected ? (
            <>
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('cf_select')} />
              {onPage.length > 0 && <Divider plain>{t('ld_elements')}</Divider>}
              {onPage.map((el) => (
                <button key={el.id} type="button" className="designer-layer" onClick={() => setSelectedId(el.id)}>
                  {TYPE_ICON[el.type]} <span>{el.type === 'field' ? sourceLabel(el.source) : el.type === 'text' ? el.text : t(`ld_${el.type}`)}</span>
                </button>
              ))}
            </>
          ) : (
            <div className="designer-props">
              <div className="designer-props-head">
                <b>
                  {TYPE_ICON[selected.type]} {t(`ld_${selected.type}`)}
                </b>
                <div className="page-actions" style={{ flexWrap: 'nowrap' }}>
                  <Tooltip title={t('ld_duplicate')}>
                    <Button
                      size="small"
                      icon={<CopyOutlined />}
                      onClick={() => {
                        const copy = { ...selected, id: newId(), y: clamp(selected.y + selected.h + 1, 0, size.h - selected.h) }
                        setElements([...elements, copy])
                        setSelectedId(copy.id)
                      }}
                    />
                  </Tooltip>
                  <Tooltip title={t('delete')}>
                    <Button size="small" danger icon={<DeleteOutlined />} onClick={() => remove(selected.id)} />
                  </Tooltip>
                </div>
              </div>

              {selected.type === 'field' && (
                <>
                  <label>{t('ld_source')}</label>
                  <Select showSearch optionFilterProp="label" value={selected.source} options={sourceOptions} onChange={(source) => update(selected.id, { source })} style={{ width: '100%' }} />
                  <label>{t('ld_prefix')}</label>
                  <Input value={selected.prefix} placeholder={t('ld_prefix_ph')} onChange={(e) => update(selected.id, { prefix: e.target.value })} />
                </>
              )}
              {selected.type === 'text' && (
                <>
                  <label>{t('ld_text')}</label>
                  <Input.TextArea autoSize value={selected.text} onChange={(e) => update(selected.id, { text: e.target.value })} />
                </>
              )}

              {(selected.type === 'field' || selected.type === 'text') && (
                <>
                  <label>{t('ld_font_size')}</label>
                  <InputNumber min={1} max={30} step={0.2} value={selected.size} onChange={(v) => v && update(selected.id, { size: v })} suffix="mm" style={{ width: '100%' }} />
                  <Segmented
                    block
                    value={selected.align || 'start'}
                    onChange={(align) => update(selected.id, { align })}
                    options={[
                      { value: 'start', icon: <AlignLeftOutlined /> },
                      { value: 'center', icon: <AlignCenterOutlined /> },
                      { value: 'end', icon: <AlignRightOutlined /> },
                    ]}
                    style={{ marginTop: 8 }}
                  />
                  <div className="designer-switches">
                    <span>
                      <Switch size="small" checked={selected.bold} onChange={(bold) => update(selected.id, { bold })} /> {t('ld_bold')}
                    </span>
                    <span>
                      <Switch size="small" checked={selected.fit} onChange={(fit) => update(selected.id, { fit })} /> {t('ld_fit')}
                    </span>
                    <span>
                      <Switch size="small" checked={selected.wrap} onChange={(wrap) => update(selected.id, { wrap })} /> {t('ld_wrap')}
                    </span>
                  </div>
                </>
              )}

              {selected.type === 'box' && (
                <>
                  <label>{t('ld_border')}</label>
                  <InputNumber min={0.1} max={3} step={0.1} value={selected.border} onChange={(border) => border && update(selected.id, { border })} suffix="mm" style={{ width: '100%' }} />
                </>
              )}

              <label>{t('ld_position')}</label>
              <div className="designer-xywh" dir="ltr">
                {['x', 'y', 'w', 'h'].map((k) => (
                  <InputNumber
                    key={k}
                    size="small"
                    step={0.5}
                    min={k === 'w' || k === 'h' ? 1 : 0}
                    value={selected[k]}
                    prefix={k.toUpperCase()}
                    onChange={(v) => {
                      if (v == null) return
                      const patch = { [k]: v }
                      if (selected.type === 'qr' && (k === 'w' || k === 'h')) Object.assign(patch, { w: v, h: v })
                      update(selected.id, patch)
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
