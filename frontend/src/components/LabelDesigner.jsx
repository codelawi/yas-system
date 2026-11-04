import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Divider, Empty, Input, InputNumber, Segmented, Select, Switch, Tag, Tooltip, Typography } from 'antd'
import {
  AlignCenterOutlined,
  AlignLeftOutlined,
  AlignRightOutlined,
  BorderOutlined,
  CopyOutlined,
  DeleteOutlined,
  FontSizeOutlined,
  QrcodeOutlined,
  ReloadOutlined,
  TagOutlined,
  VerticalAlignBottomOutlined,
  VerticalAlignTopOutlined,
} from '@ant-design/icons'
import api from '../api'
import { useLang } from '../i18n'
import { ElementContent } from './TemplateLabel'
import { BUILTIN_SOURCES, defaultTemplate, newElement, newId } from '../labelTemplate'

const MM_PX = 96 / 25.4
const PRESETS = [
  [50, 30],
  [40, 40],
  [60, 40],
  [70, 50],
  [100, 50],
]
const snap = (v) => Math.round(v * 2) / 2
const clamp = (v, min, max) => Math.min(Math.max(v, min), max)
const TYPE_ICON = { qr: <QrcodeOutlined />, field: <TagOutlined />, text: <FontSizeOutlined />, box: <BorderOutlined /> }

/**
 * Canvas editor for the label design: drag to move, drag the corner to resize,
 * arrows to nudge (Shift = 2 mm), Delete to remove.
 */
export default function LabelDesigner({ template, onChange, settings, equipment, url }) {
  const { t } = useLang()
  const [selectedId, setSelectedId] = useState(null)
  const [keys, setKeys] = useState([])
  const stageRef = useRef(null)
  const [stageWidth, setStageWidth] = useState(600)

  useEffect(() => {
    api.get('/equipment/keys').then(({ data }) => setKeys(data))
  }, [])

  // Zoom: fit the label in the canvas area
  useEffect(() => {
    const node = stageRef.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => setStageWidth(entry.contentRect.width))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const zoom = clamp(Math.min((stageWidth - 48) / (template.width * MM_PX), 420 / (template.height * MM_PX)), 1, 12)
  const pxPerMm = MM_PX * zoom

  const selected = template.elements.find((e) => e.id === selectedId)
  const setElements = (elements) => onChange({ ...template, elements })
  const update = (id, patch) => setElements(template.elements.map((e) => (e.id === id ? { ...e, ...patch } : e)))
  const remove = (id) => {
    setElements(template.elements.filter((e) => e.id !== id))
    setSelectedId(null)
  }
  const add = (type) => {
    const el = newElement(type, template)
    setElements([...template.elements, el])
    setSelectedId(el.id)
  }
  const reorder = (id, toFront) => {
    const el = template.elements.find((e) => e.id === id)
    const rest = template.elements.filter((e) => e.id !== id)
    setElements(toFront ? [...rest, el] : [el, ...rest])
  }

  const startDrag = (e, el, mode) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setSelectedId(el.id)
    stageRef.current?.focus()
    const start = { x: e.clientX, y: e.clientY, el: { ...el } }
    const W = template.width
    const H = template.height
    const move = (ev) => {
      const dx = (ev.clientX - start.x) / pxPerMm
      const dy = (ev.clientY - start.y) / pxPerMm
      if (mode === 'move') {
        update(el.id, { x: clamp(snap(start.el.x + dx), 0, W - start.el.w), y: clamp(snap(start.el.y + dy), 0, H - start.el.h) })
      } else if (el.type === 'qr') {
        // QR codes stay square
        const s = clamp(snap(start.el.w + Math.max(dx, dy)), 4, Math.min(W - start.el.x, H - start.el.y))
        update(el.id, { w: s, h: s })
      } else {
        update(el.id, { w: clamp(snap(start.el.w + dx), 2, W - start.el.x), h: clamp(snap(start.el.h + dy), 1.5, H - start.el.y) })
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
      update(selected.id, { x: clamp(selected.x + dx, 0, template.width - selected.w), y: clamp(selected.y + dy, 0, template.height - selected.h) })
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      remove(selected.id)
    } else if (e.key === 'Escape') {
      setSelectedId(null)
    }
  }

  const sourceLabel = useMemo(() => {
    const names = {
      serial_number: t('serial_number'),
      display_name: t('name_field'),
      row_no: t('row_no_long'),
      parent_serial: t('label_show_parent'),
      category: t('category'),
      company: t('label_show_company'),
    }
    return (source) => (source?.startsWith('field:') ? source.slice(6) : names[source] || source)
  }, [t])

  const sourceOptions = [
    { label: t('ld_builtin'), options: BUILTIN_SOURCES.map((s) => ({ value: s, label: sourceLabel(s) })) },
    { label: t('ld_word_fields'), options: keys.map((k) => ({ value: `field:${k}`, label: k })) },
  ]
  const placeholder = (el) => (el.type === 'field' ? `{${sourceLabel(el.source)}}` : '')

  const resize = (width, height) => {
    const w = clamp(Number(width) || template.width, 10, 300)
    const h = clamp(Number(height) || template.height, 10, 300)
    // Keep elements inside the new size
    onChange({
      width: w,
      height: h,
      elements: template.elements.map((el) => {
        const ew = Math.min(el.w, w)
        const eh = Math.min(el.h, h)
        return { ...el, w: ew, h: eh, x: clamp(el.x, 0, w - ew), y: clamp(el.y, 0, h - eh) }
      }),
    })
  }

  return (
    <div className="designer">
      <div className="designer-toolbar">
        <Typography.Text type="secondary">{t('ld_add')}:</Typography.Text>
        <Button icon={<QrcodeOutlined />} onClick={() => add('qr')}>
          {t('ld_qr')}
        </Button>
        <Button icon={<TagOutlined />} onClick={() => add('field')}>
          {t('ld_field')}
        </Button>
        <Button icon={<FontSizeOutlined />} onClick={() => add('text')}>
          {t('ld_text')}
        </Button>
        <Button icon={<BorderOutlined />} onClick={() => add('box')}>
          {t('ld_box')}
        </Button>
        <div style={{ flex: 1 }} />
        <InputNumber size="small" min={10} max={300} value={template.width} onChange={(v) => resize(v, template.height)} prefix={`${t('width')}:`} suffix="mm" style={{ width: 130 }} />
        <InputNumber size="small" min={10} max={300} value={template.height} onChange={(v) => resize(template.width, v)} prefix={`${t('height')}:`} suffix="mm" style={{ width: 140 }} />
        {PRESETS.map(([w, h]) => (
          <Tag.CheckableTag key={`${w}x${h}`} checked={template.width === w && template.height === h} onChange={() => resize(w, h)}>
            <span dir="ltr">
              {w}×{h}
            </span>
          </Tag.CheckableTag>
        ))}
        <Tooltip title={t('ld_reset_help')}>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => onChange(defaultTemplate(settings, template.width, template.height))}>
            {t('ld_reset')}
          </Button>
        </Tooltip>
      </div>

      <div className="designer-body">
        <div ref={stageRef} className="designer-stage" tabIndex={0} onKeyDown={onKeyDown} onPointerDown={() => setSelectedId(null)}>
          <div className="designer-paper" style={{ width: template.width * pxPerMm, height: template.height * pxPerMm }}>
            <div className="tlabel designing" dir="ltr" style={{ width: `${template.width}mm`, height: `${template.height}mm`, transform: `scale(${zoom})` }}>
              {template.elements.map((el) => (
                <div
                  key={el.id}
                  className={`tl-el design-el${el.id === selectedId ? ' selected' : ''}`}
                  style={{ left: `${el.x}mm`, top: `${el.y}mm`, width: `${el.w}mm`, height: `${el.h}mm` }}
                  onPointerDown={(e) => startDrag(e, el, 'move')}
                >
                  <ElementContent el={el} equipment={equipment} url={url} settings={settings} placeholder={placeholder} />
                  {el.id === selectedId && <div className="design-handle" onPointerDown={(e) => startDrag(e, el, 'resize')} style={{ width: `${8 / zoom}px`, height: `${8 / zoom}px` }} />}
                </div>
              ))}
            </div>
          </div>
          <Typography.Text type="secondary" className="designer-hint">
            {t('ld_hint')}
          </Typography.Text>
        </div>

        <div className="designer-panel">
          {!selected ? (
            <>
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('ld_select')} />
              <Divider plain>{t('ld_elements')}</Divider>
              {template.elements.map((el) => (
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
                  <Tooltip title={t('ld_front')}>
                    <Button size="small" icon={<VerticalAlignTopOutlined />} onClick={() => reorder(selected.id, true)} />
                  </Tooltip>
                  <Tooltip title={t('ld_back')}>
                    <Button size="small" icon={<VerticalAlignBottomOutlined />} onClick={() => reorder(selected.id, false)} />
                  </Tooltip>
                  <Tooltip title={t('ld_duplicate')}>
                    <Button
                      size="small"
                      icon={<CopyOutlined />}
                      onClick={() => {
                        const copy = { ...selected, id: newId(), x: clamp(selected.x + 1, 0, template.width - selected.w), y: clamp(selected.y + 1, 0, template.height - selected.h) }
                        setElements([...template.elements, copy])
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
                  <InputNumber min={1} max={40} step={0.2} value={selected.size} onChange={(size) => size && update(selected.id, { size })} suffix="mm" style={{ width: '100%' }} />
                  <Segmented
                    block
                    value={selected.align || 'center'}
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
                      <Switch size="small" checked={selected.mono} onChange={(mono) => update(selected.id, { mono })} /> {t('ld_mono')}
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
                  <label>{t('ld_radius')}</label>
                  <InputNumber min={0} max={20} step={0.5} value={selected.radius} onChange={(radius) => update(selected.id, { radius: radius ?? 0 })} suffix="mm" style={{ width: '100%' }} />
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
