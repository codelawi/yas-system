import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { App, Button, Empty, Form, Input, Modal, Popconfirm, Result, Spin, Table, Typography } from 'antd'
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  FileWordOutlined,
  InsertRowBelowOutlined,
  PlusOutlined,
  ScanOutlined,
  TableOutlined,
  UnlockOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'
import { useAuth } from '../auth'
import { beep } from '../download'
import CodeScanner from '../components/CodeScanner'
import { cellText, downloadScanDocDocx } from '../scanDocExport'

/** How often open screens ask the server whether something changed (ms). */
const POLL_MS = 1500
/** How long a row added from another device stays highlighted (ms). */
const FRESH_MS = 4000

/**
 * Live updates without any extra server: every POLL_MS asks `url` for the current revision and calls
 * `onChange` when it differs from `known.current` (the caller sets it after each load).
 * Pauses while the tab is hidden and checks at once when it is shown again.
 */
function useRevisionPoll(url, known, onChange) {
  const callback = useRef(onChange)
  callback.current = onChange

  useEffect(() => {
    let stopped = false
    let busy = false
    const check = async () => {
      if (stopped || busy || document.visibilityState !== 'visible') return
      busy = true
      try {
        const { data } = await api.get(url)
        if (!stopped && data.revision !== known.current) {
          known.current = data.revision
          await callback.current()
        }
      } catch {
        /* the server is busy or out of reach: try again next time */
      } finally {
        busy = false
      }
    }
    const timer = setInterval(check, POLL_MS)
    document.addEventListener('visibilitychange', check)
    return () => {
      stopped = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [url, known])
}

/** List of scan documents + "new document". */
export function ScanDocumentsPage() {
  const { t } = useLang()
  const { requirePin } = useAuth()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [list, setList] = useState(null)
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()

  const listRevision = useRef(null)
  const loadList = useCallback(() => api.get('/scan-documents').then(({ data }) => setList(data)), [])
  useEffect(() => {
    loadList()
  }, [loadList])
  // A document added, deleted or scanned into on another device shows up here by itself
  useRevisionPoll('/scan-documents/revision', listRevision, loadList)

  const startNew = async () => {
    if (!(await requirePin())) return
    form.setFieldsValue({ title: `${t('scan_docs')} ${dayjs().format('YYYY-MM-DD HH:mm')}` })
    setOpen(true)
  }

  const create = async () => {
    const v = await form.validateFields()
    try {
      const { data } = await api.post('/scan-documents', v)
      navigate(`/scan-documents/${data.id}`)
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <Typography.Title level={3}>
          <ScanOutlined /> {t('scan_docs')}
        </Typography.Title>
        <Button type="primary" size="large" icon={<PlusOutlined />} onClick={startNew}>
          {t('new_scan_doc')}
        </Button>
      </div>
      <Typography.Paragraph type="secondary">{t('scan_docs_intro')}</Typography.Paragraph>
      <Table
        rowKey="id"
        loading={!list}
        dataSource={list || []}
        onRow={(r) => ({ onClick: () => navigate(`/scan-documents/${r.id}`), style: { cursor: 'pointer' } })}
        pagination={false}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: t('scan_doc_title'), dataIndex: 'title', render: (v, r) => <Link to={`/scan-documents/${r.id}`}>{v}</Link> },
          { title: t('scan_doc_rows'), dataIndex: 'rows_count', align: 'center' },
          { title: t('updated_at'), dataIndex: 'updated_at', render: (v) => dayjs(v).format('YYYY-MM-DD HH:mm') },
          { title: t('by'), dataIndex: ['created_by', 'name'], render: (v) => v || '—' },
        ]}
      />
      <Modal open={open} title={t('new_scan_doc')} okText={t('confirm')} cancelText={t('cancel')} onOk={create} onCancel={() => setOpen(false)} forceRender>
        <Form form={form} layout="vertical" onFinish={create}>
          <Form.Item name="title" label={t('scan_doc_title')} rules={[{ required: true, whitespace: true }]}>
            <Input autoFocus />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

/** A text box that saves when it loses focus (only if the text changed). */
function CellInput({ value, onSave, multiline, className, dir }) {
  const [text, setText] = useState(value ?? '')
  // While typing, a change from another device does not replace the text; the last save wins
  const focused = useRef(false)
  const dirty = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(value ?? '')
  }, [value])

  const commit = async () => {
    focused.current = false
    if (!dirty.current || text === (value ?? '')) {
      dirty.current = false
      setText(value ?? '')
      return
    }
    dirty.current = false
    const ok = await onSave(text)
    if (!ok) setText(value ?? '')
  }

  const props = {
    value: text,
    onChange: (e) => {
      dirty.current = true
      setText(e.target.value)
    },
    onFocus: () => {
      focused.current = true
    },
    onBlur: commit,
    className,
    dir,
    variant: 'borderless',
  }
  return multiline ? <Input.TextArea autoSize={{ minRows: 1, maxRows: 6 }} {...props} /> : <Input {...props} onPressEnter={(e) => e.target.blur()} />
}

/** One scan document: the scanner, the editable table and the Word download. */
export function ScanDocumentPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { t } = useLang()
  const { user, requirePin } = useAuth()
  const { message } = App.useApp()
  const [doc, setDoc] = useState(null)
  const [rows, setRows] = useState([])
  const [missing, setMissing] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [exporting, setExporting] = useState(false)

  const [fresh, setFresh] = useState([]) // ids of rows just added from another device
  const revision = useRef(null)
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  const load = useCallback(
    async ({ live = false } = {}) => {
      try {
        const { data } = await api.get(`/scan-documents/${id}`)
        revision.current = data.document.revision
        if (live) {
          const known = new Set(rowsRef.current.map((r) => r.id))
          const added = data.rows.filter((r) => !known.has(r.id)).map((r) => r.id)
          if (added.length) {
            beep(true)
            setFresh((f) => [...f, ...added])
            setTimeout(() => setFresh((f) => f.filter((x) => !added.includes(x))), FRESH_MS)
          }
        }
        setDoc(data.document)
        setRows(data.rows)
      } catch (e) {
        if (!live || e?.response?.status === 404) setMissing(true)
      }
    },
    [id],
  )
  useEffect(() => {
    load()
  }, [load])
  // Rows scanned on a phone appear here within a second or two
  const liveLoad = useCallback(() => load({ live: true }), [load])
  useRevisionPoll(`/scan-documents/${id}/revision`, revision, liveLoad)

  // Bring the newest row into view
  const lastFresh = fresh[fresh.length - 1]
  useEffect(() => {
    if (lastFresh) document.querySelector(`.scan-doc-table [data-row-key="${lastFresh}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [lastFresh])

  if (missing) return <Result status="404" title={t('not_found')} extra={<Link to="/scan-documents">{t('scan_docs')}</Link>} />
  if (!doc) return <Spin size="large" className="page-spin" />

  const fail = (e) => message.error(t(errorKey(e) || 'error'))

  const startScan = async () => {
    if (await requirePin()) setScanning(true)
  }

  /** Called by the scanner for each code read; the answer is shown on the camera screen. */
  const onCode = async (code) => {
    try {
      const { data } = await api.post(`/scan-documents/${id}/scan`, { code })
      if (data.status === 'added') {
        beep(true)
        setRows((rs) => (rs.some((r) => r.id === data.row.id) ? rs : [...rs, data.row]))
        return { type: 'success', text: t('scan_added_row', { n: data.row_number, code: data.row.code }) }
      }
      beep(false)
      return { type: 'warning', text: t('scan_duplicate_row', { n: data.row_number, code: data.row.code }) }
    } catch (e) {
      beep(false)
      return { type: 'error', text: t(errorKey(e) || 'error') }
    }
  }

  const closeScanner = () => {
    setScanning(false)
    load() // rows another phone may have added meanwhile
  }

  const saveTitle = async (title) => {
    if (!title.trim() || title === doc.title || !(await requirePin())) return
    try {
      const { data } = await api.put(`/scan-documents/${id}`, { title })
      setDoc(data.document)
    } catch (e) {
      fail(e)
    }
  }

  const saveRow = async (row, change) => {
    try {
      const { data } = await api.put(`/scan-documents/${id}/rows/${row.id}`, change)
      setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, ...data } : r)))
      return true
    } catch (e) {
      fail(e)
      return false
    }
  }

  const addRow = async () => {
    if (!(await requirePin())) return
    try {
      const { data } = await api.post(`/scan-documents/${id}/rows`)
      setRows((rs) => (rs.some((r) => r.id === data.id) ? rs : [...rs, data]))
    } catch (e) {
      fail(e)
    }
  }

  const removeRow = async (row) => {
    try {
      await api.delete(`/scan-documents/${id}/rows/${row.id}`)
      setRows((rs) => rs.filter((r) => r.id !== row.id))
    } catch (e) {
      fail(e)
    }
  }

  const removeDoc = async () => {
    if (!(await requirePin())) return
    try {
      await api.delete(`/scan-documents/${id}`)
      message.success(t('deleted'))
      navigate('/scan-documents')
    } catch (e) {
      fail(e)
    }
  }

  const saveColumns = async (columns) => {
    try {
      const { data } = await api.put(`/scan-documents/${id}`, { columns })
      setDoc(data.document)
      setRows(data.rows)
      setColumnsOpen(false)
      message.success(t('saved'))
    } catch (e) {
      fail(e)
    }
  }

  const exportWord = async () => {
    setExporting(true)
    try {
      await downloadScanDocDocx(doc, rows, { t })
    } catch {
      message.error(t('error'))
    } finally {
      setExporting(false)
    }
  }

  const canEdit = !!user
  const tableColumns = [
    ...doc.columns.map((c) => ({
      key: c.key,
      title: c.label,
      width: c.key === 'no' ? 56 : undefined,
      align: c.key === 'no' ? 'center' : undefined,
      render: (_, row, index) => {
        if (c.key === 'no' || c.key === 'scanned_at') return <span style={{ whiteSpace: 'nowrap' }}>{cellText(c, row, index)}</span>
        if (!canEdit) return <span className={c.key === 'code' ? 'serial' : undefined}>{cellText(c, row, index)}</span>
        if (c.key === 'code') return <CellInput className="scan-doc-code" dir="ltr" value={row.code} onSave={(code) => saveRow(row, { code })} />
        return <CellInput multiline value={row.cells?.[c.key]} onSave={(value) => saveRow(row, { cells: { [c.key]: value } })} />
      },
    })),
    ...(canEdit
      ? [
          {
            key: 'delete',
            width: 48,
            render: (_, row) => (
              <Popconfirm title={t('delete_row_confirm')} okText={t('delete')} okButtonProps={{ danger: true }} cancelText={t('cancel')} onConfirm={() => removeRow(row)}>
                <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={t('delete')} />
              </Popconfirm>
            ),
          },
        ]
      : []),
  ]

  return (
    <div className="page">
      <div className="page-head">
        <Typography.Title level={3} style={{ margin: 0 }} editable={canEdit ? { onChange: saveTitle, triggerType: ['icon'] } : false}>
          {doc.title}
        </Typography.Title>
        <div className="page-actions">
          <Button type="primary" size="large" icon={<ScanOutlined />} onClick={startScan}>
            {t('scan_start')}
          </Button>
          <Button icon={<FileWordOutlined />} loading={exporting} onClick={exportWord} disabled={!rows.length}>
            {t('download_word')}
          </Button>
          {canEdit ? (
            <>
              <Button icon={<InsertRowBelowOutlined />} onClick={addRow}>
                {t('add_row')}
              </Button>
              <Button icon={<TableOutlined />} onClick={() => setColumnsOpen(true)}>
                {t('edit_columns')}
              </Button>
              <Popconfirm title={t('delete_scan_doc_confirm')} okText={t('delete')} okButtonProps={{ danger: true }} cancelText={t('cancel')} onConfirm={removeDoc}>
                <Button danger icon={<DeleteOutlined />}>
                  {t('delete')}
                </Button>
              </Popconfirm>
            </>
          ) : (
            <Button icon={<UnlockOutlined />} onClick={requirePin}>
              {t('unlock_to_edit')}
            </Button>
          )}
        </div>
      </div>

      <Table
        className="scan-doc-table"
        rowKey="id"
        rowClassName={(r) => (fresh.includes(r.id) ? 'scan-doc-row-new' : '')}
        size="small"
        bordered
        dataSource={rows}
        columns={tableColumns}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: <Empty description={t('scan_doc_empty')} /> }}
      />

      <ColumnsModal open={columnsOpen} columns={doc.columns} onCancel={() => setColumnsOpen(false)} onSave={saveColumns} />
      <CodeScanner open={scanning} onClose={closeScanner} onCode={onCode} title={t('scan_doc_scanner_title', { title: doc.title })} />
    </div>
  )
}

const newColumnKey = () => `c_${Math.random().toString(36).slice(2, 10)}`

/** Rename, reorder, add and remove the table's columns. The scanned text column cannot be removed. */
function ColumnsModal({ open, columns, onCancel, onSave }) {
  const { t } = useLang()
  const [draft, setDraft] = useState(columns)
  // Start from the current columns each time the window opens (not while it is open)
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) setDraft(columns)
    wasOpen.current = open
  }, [open, columns])

  const set = (index, label) => setDraft((d) => d.map((c, i) => (i === index ? { ...c, label } : c)))
  const move = (index, step) =>
    setDraft((d) => {
      const next = [...d]
      const [item] = next.splice(index, 1)
      next.splice(index + step, 0, item)
      return next
    })
  const remove = (index) => setDraft((d) => d.filter((_, i) => i !== index))
  const valid = draft.every((c) => c.label.trim())

  return (
    <Modal open={open} title={t('edit_columns')} okText={t('save')} cancelText={t('cancel')} onCancel={onCancel} onOk={() => onSave(draft.map((c) => ({ ...c, label: c.label.trim() })))} okButtonProps={{ disabled: !valid }}>
      {draft.map((c, i) => (
        <div key={c.key} style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <Input value={c.label} placeholder={t('column_name')} onChange={(e) => set(i, e.target.value)} status={c.label.trim() ? undefined : 'error'} maxLength={100} />
          <Button icon={<ArrowUpOutlined />} disabled={i === 0} onClick={() => move(i, -1)} aria-label="up" />
          <Button icon={<ArrowDownOutlined />} disabled={i === draft.length - 1} onClick={() => move(i, 1)} aria-label="down" />
          <Button danger icon={<DeleteOutlined />} disabled={c.key === 'code'} onClick={() => remove(i)} aria-label={t('delete')} />
        </div>
      ))}
      <Button type="dashed" block icon={<PlusOutlined />} onClick={() => setDraft((d) => [...d, { key: newColumnKey(), label: '' }])} disabled={draft.length >= 30}>
        {t('add_column')}
      </Button>
    </Modal>
  )
}
