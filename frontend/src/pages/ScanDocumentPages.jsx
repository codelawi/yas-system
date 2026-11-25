import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { App, Breadcrumb, Button, Empty, Form, Input, Modal, Popconfirm, Result, Segmented, Spin, Table, Tag, Typography } from 'antd'
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  FileTextOutlined,
  FileWordOutlined,
  FolderAddOutlined,
  FolderOutlined,
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
import { usePhone } from '../nav'
import { Fab, PhoneActions, PhoneHeader, PhoneList, PhoneRow, PhoneSkeleton } from '../components/PhoneUI'

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

const folderPath = (folderId) => `/scan-documents/folders/${folderId}`
const formatTime = (value) => (value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '—')
/** Phones: the time only for today, otherwise the date */
const shortTime = (value) => (!value ? '' : dayjs(value).isSame(dayjs(), 'day') ? dayjs(value).format('HH:mm') : dayjs(value).format('YYYY-MM-DD'))

/** "Scan documents › <folder>": links back to the pages above this one. */
function ScanBreadcrumb({ folder }) {
  const { t } = useLang()
  const items = [
    {
      title: (
        <Link to="/scan-documents">
          <ScanOutlined /> {t('scan_docs')}
        </Link>
      ),
    },
  ]
  if (folder) {
    items.push({
      title: (
        <Link to={folderPath(folder.id)}>
          <FolderOutlined /> {folder.name}
        </Link>
      ),
    })
  }
  return <Breadcrumb className="scan-breadcrumb" items={items} />
}

/** "Within this document" / "Within the whole folder": where a scanned code must not repeat. */
function DuplicateScopeChoice({ value, onChange, folderName, block }) {
  const { t } = useLang()
  return (
    <div className="scan-dup-scope">
      <Segmented
        block={block}
        value={value}
        onChange={onChange}
        options={[
          { value: 'document', label: t('scan_dup_document'), icon: <FileTextOutlined /> },
          { value: 'folder', label: t('scan_dup_folder'), icon: <FolderOutlined /> },
        ]}
      />
      <Typography.Text type="secondary" className="scan-dup-help">
        {value === 'folder' ? t('scan_dup_folder_help', { folder: folderName }) : t('scan_dup_document_help')}
      </Typography.Text>
    </div>
  )
}

/** The folders of scan documents + "new folder". A folder is made first, then documents inside it. */
export function ScanFoldersPage() {
  const { t } = useLang()
  const { requirePin } = useAuth()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const phone = usePhone()
  const [list, setList] = useState(null)
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()

  const listRevision = useRef(null)
  const loadList = useCallback(() => api.get('/scan-folders').then(({ data }) => setList(data)), [])
  useEffect(() => {
    loadList()
  }, [loadList])
  // A folder or document added, deleted or scanned into on another device shows up here by itself
  useRevisionPoll('/scan-folders/revision', listRevision, loadList)

  const startNew = async () => {
    if (!(await requirePin())) return
    form.setFieldsValue({ name: `${t('scan_docs')} ${dayjs().format('YYYY-MM-DD')}` })
    setOpen(true)
  }

  const create = async () => {
    const v = await form.validateFields()
    try {
      const { data } = await api.post('/scan-folders', v)
      navigate(folderPath(data.id))
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }

  const newFolder = (
    <Modal open={open} title={t('new_scan_folder')} okText={t('confirm')} cancelText={t('cancel')} onOk={create} onCancel={() => setOpen(false)} forceRender>
      <Form form={form} layout="vertical" onFinish={create}>
        <Form.Item name="name" label={t('scan_folder_name')} rules={[{ required: true, whitespace: true }]}>
          <Input autoFocus maxLength={191} />
        </Form.Item>
      </Form>
    </Modal>
  )

  if (phone)
    return (
      <div className="page">
        <PhoneHeader title={t('scan_docs')} subtitle={list ? t('folders_n', { n: list.length }) : '\u00a0'} />
        {!list ? (
          <PhoneSkeleton rows={3} />
        ) : list.length ? (
          <PhoneList>
            {list.map((f) => (
              <PhoneRow
                key={f.id}
                to={folderPath(f.id)}
                icon={<FolderOutlined />}
                tone="amber"
                title={f.name}
                subtitle={
                  <>
                    <span>{t('docs_n', { n: f.documents_count })}</span>
                    <span>{t('rows_n', { n: f.rows_count })}</span>
                  </>
                }
                end={<span className="phone-row-time">{shortTime(f.last_change_at)}</span>}
              />
            ))}
          </PhoneList>
        ) : (
          <div className="phone-empty">
            <ScanOutlined className="phone-empty-icon" />
            <b>{t('scan_folders_empty')}</b>
            <span>{t('scan_docs_intro')}</span>
          </div>
        )}
        <Fab icon={<FolderAddOutlined />} label={t('new_scan_folder')} onClick={startNew} />
        {newFolder}
      </div>
    )

  return (
    <div className="page">
      <div className="page-head">
        <Typography.Title level={3}>
          <ScanOutlined /> {t('scan_docs')}
        </Typography.Title>
        <Button type="primary" size="large" icon={<FolderAddOutlined />} onClick={startNew}>
          {t('new_scan_folder')}
        </Button>
      </div>
      <Typography.Paragraph type="secondary">{t('scan_docs_intro')}</Typography.Paragraph>
      <Table
        rowKey="id"
        loading={!list}
        dataSource={list || []}
        onRow={(r) => ({ onClick: () => navigate(folderPath(r.id)), style: { cursor: 'pointer' } })}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: <Empty description={t('scan_folders_empty')} /> }}
        columns={[
          {
            title: t('scan_folder_name'),
            dataIndex: 'name',
            render: (v, r) => (
              <Link to={folderPath(r.id)}>
                <FolderOutlined /> {v}
              </Link>
            ),
          },
          { title: t('scan_folder_docs'), dataIndex: 'documents_count', align: 'center' },
          { title: t('scan_doc_rows'), dataIndex: 'rows_count', align: 'center' },
          { title: t('updated_at'), dataIndex: 'last_change_at', render: formatTime },
          { title: t('by'), dataIndex: ['created_by', 'name'], render: (v) => v || '—' },
        ]}
      />
      {newFolder}
    </div>
  )
}

/** One folder: its documents + "new document". */
export function ScanFolderPage() {
  const { folderId } = useParams()
  const { t } = useLang()
  const { user, requirePin } = useAuth()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [folder, setFolder] = useState(null)
  const [documents, setDocuments] = useState([])
  const [missing, setMissing] = useState(false)
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()
  const phone = usePhone()

  const revision = useRef(null)
  const load = useCallback(
    async ({ live = false } = {}) => {
      try {
        const { data } = await api.get(`/scan-folders/${folderId}`)
        setFolder(data.folder)
        setDocuments(data.documents)
      } catch (e) {
        if (!live || e?.response?.status === 404) setMissing(true)
      }
    },
    [folderId],
  )
  useEffect(() => {
    load()
  }, [load])
  // Documents added, renamed or scanned into on another device show up here by themselves
  const liveLoad = useCallback(() => load({ live: true }), [load])
  useRevisionPoll(`/scan-folders/${folderId}/revision`, revision, liveLoad)

  if (missing) return <Result status="404" title={t('not_found')} extra={<Link to="/scan-documents">{t('scan_docs')}</Link>} />
  if (!folder) return <Spin size="large" className="page-spin" />

  const fail = (e) => message.error(t(errorKey(e) || 'error'))
  const canEdit = !!user

  const rename = async (name) => {
    if (!name.trim() || name === folder.name || !(await requirePin())) return
    try {
      const { data } = await api.put(`/scan-folders/${folderId}`, { name })
      setFolder(data)
    } catch (e) {
      fail(e)
    }
  }

  const removeFolder = async () => {
    if (!(await requirePin())) return
    try {
      await api.delete(`/scan-folders/${folderId}`)
      message.success(t('deleted'))
      navigate('/scan-documents')
    } catch (e) {
      fail(e)
    }
  }

  const startNew = async () => {
    if (!(await requirePin())) return
    form.setFieldsValue({ title: `${folder.name} ${documents.length + 1}`, duplicate_scope: 'document' })
    setOpen(true)
  }

  const create = async () => {
    const v = await form.validateFields()
    try {
      const { data } = await api.post('/scan-documents', { ...v, scan_folder_id: folder.id })
      navigate(`/scan-documents/${data.id}`)
    } catch (e) {
      fail(e)
    }
  }

  const newDocument = (
    <Modal open={open} title={t('new_scan_doc')} okText={t('confirm')} cancelText={t('cancel')} onOk={create} onCancel={() => setOpen(false)} forceRender>
      <Form form={form} layout="vertical" onFinish={create}>
        <Form.Item name="title" label={t('scan_doc_title')} rules={[{ required: true, whitespace: true }]}>
          <Input autoFocus maxLength={191} />
        </Form.Item>
        <Form.Item name="duplicate_scope" label={t('scan_dup_scope')} initialValue="document">
          <DuplicateScopeChoice block folderName={folder.name} />
        </Form.Item>
      </Form>
    </Modal>
  )

  if (phone)
    return (
      <div className="page">
        <PhoneHeader
          kicker={
            <span>
              <FolderOutlined /> {t('scan_docs')}
            </span>
          }
          title={
            <Typography.Text className="phone-editable" editable={canEdit ? { onChange: rename, triggerType: ['icon', 'text'], maxLength: 191 } : false}>
              {folder.name}
            </Typography.Text>
          }
          subtitle={t('docs_n', { n: documents.length })}
          more={[
            canEdit
              ? {
                  key: 'delete',
                  icon: <DeleteOutlined />,
                  label: t('delete'),
                  danger: true,
                  onClick: removeFolder,
                  confirm: { title: t('delete_scan_folder_confirm', { n: documents.length }) },
                }
              : { key: 'unlock', icon: <UnlockOutlined />, label: t('unlock_to_edit'), onClick: requirePin },
          ]}
        />
        {documents.length ? (
          <PhoneList>
            {documents.map((d) => (
              <PhoneRow
                key={d.id}
                to={`/scan-documents/${d.id}`}
                icon={<FileTextOutlined />}
                title={d.title}
                subtitle={
                  <>
                    <span>{t('rows_n', { n: d.rows_count })}</span>
                    <span>{t(d.duplicate_scope === 'folder' ? 'scan_dup_folder' : 'scan_dup_document')}</span>
                  </>
                }
                end={<span className="phone-row-time">{shortTime(d.updated_at)}</span>}
              />
            ))}
          </PhoneList>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('scan_folder_empty')} />
        )}
        <Fab icon={<PlusOutlined />} label={t('new_scan_doc')} onClick={startNew} />
        {newDocument}
      </div>
    )

  return (
    <div className="page">
      <ScanBreadcrumb />
      <div className="page-head">
        <Typography.Title level={3} style={{ margin: 0 }} editable={canEdit ? { onChange: rename, triggerType: ['icon'], maxLength: 191 } : false}>
          {folder.name}
        </Typography.Title>
        <div className="page-actions">
          <Button type="primary" size="large" icon={<PlusOutlined />} onClick={startNew}>
            {t('new_scan_doc')}
          </Button>
          {canEdit ? (
            <Popconfirm title={t('delete_scan_folder_confirm', { n: documents.length })} okText={t('delete')} okButtonProps={{ danger: true }} cancelText={t('cancel')} onConfirm={removeFolder}>
              <Button danger icon={<DeleteOutlined />}>
                {t('delete')}
              </Button>
            </Popconfirm>
          ) : (
            <Button icon={<UnlockOutlined />} onClick={requirePin}>
              {t('unlock_to_edit')}
            </Button>
          )}
        </div>
      </div>
      <Table
        rowKey="id"
        dataSource={documents}
        onRow={(r) => ({ onClick: () => navigate(`/scan-documents/${r.id}`), style: { cursor: 'pointer' } })}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: <Empty description={t('scan_folder_empty')} /> }}
        columns={[
          {
            title: t('scan_doc_title'),
            dataIndex: 'title',
            render: (v, r) => (
              <Link to={`/scan-documents/${r.id}`}>
                <FileTextOutlined /> {v}
              </Link>
            ),
          },
          { title: t('scan_doc_rows'), dataIndex: 'rows_count', align: 'center' },
          {
            title: t('scan_dup_scope'),
            dataIndex: 'duplicate_scope',
            render: (v) => (v === 'folder' ? <Tag color="blue">{t('scan_dup_folder')}</Tag> : <Tag>{t('scan_dup_document')}</Tag>),
          },
          { title: t('updated_at'), dataIndex: 'updated_at', render: formatTime },
          { title: t('by'), dataIndex: ['created_by', 'name'], render: (v) => v || '—' },
        ]}
      />
      {newDocument}
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
  const phone = usePhone()

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
  const onCode = async (code, { photo } = {}) => {
    try {
      // Text read by the camera comes with a photo of the line, kept with the new row
      let body = { code }
      if (photo) {
        body = new FormData()
        body.append('code', code)
        body.append('photo', photo, 'line.jpg')
      }
      const { data } = await api.post(`/scan-documents/${id}/scan`, body)
      if (data.status === 'added') {
        beep(true)
        setRows((rs) => (rs.some((r) => r.id === data.row.id) ? rs : [...rs, data.row]))
        return { type: 'success', text: t('scan_added_row', { n: data.row_number, code: data.row.code }) }
      }
      beep(false)
      // With "within the whole folder" the code may be in another document of the folder
      const elsewhere = data.document && data.document.id !== doc.id
      return {
        type: 'warning',
        text: elsewhere
          ? t('scan_duplicate_in_doc', { title: data.document.title, n: data.row_number, code: data.row.code })
          : t('scan_duplicate_row', { n: data.row_number, code: data.row.code }),
      }
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
      navigate(doc.folder ? folderPath(doc.folder.id) : '/scan-documents')
    } catch (e) {
      fail(e)
    }
  }

  const saveScope = async (duplicate_scope) => {
    if (duplicate_scope === doc.duplicate_scope || !(await requirePin())) return
    try {
      const { data } = await api.put(`/scan-documents/${id}`, { duplicate_scope })
      setDoc(data.document)
    } catch (e) {
      fail(e)
    }
  }
  const scopeLabel = t(doc.duplicate_scope === 'folder' ? 'scan_dup_folder' : 'scan_dup_document')

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
        // The photo of the line read (camera's text mode) is kept on the server, not shown here
        if (c.key === 'code') {
          return canEdit ? (
            <CellInput className="scan-doc-code" dir="ltr" value={row.code} onSave={(code) => saveRow(row, { code })} />
          ) : (
            <span className="serial">{cellText(c, row, index)}</span>
          )
        }
        if (!canEdit) return <span>{cellText(c, row, index)}</span>
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

  // Phones: scanning is the floating button, the rest are tiles
  const phoneHead = phone && (
    <>
      <PhoneHeader
        kicker={
          doc.folder ? (
            <Link to={folderPath(doc.folder.id)}>
              <FolderOutlined /> {doc.folder.name}
            </Link>
          ) : (
            t('scan_docs')
          )
        }
        title={
          <Typography.Text className="phone-editable" editable={canEdit ? { onChange: saveTitle, triggerType: ['icon', 'text'] } : false}>
            {doc.title}
          </Typography.Text>
        }
        subtitle={t('rows_n', { n: rows.length })}
      />
      <PhoneActions
        actions={[
          { key: 'word', icon: <FileWordOutlined />, label: t('download_word'), onClick: exportWord, loading: exporting, disabled: !rows.length },
          { key: 'row', icon: <InsertRowBelowOutlined />, label: t('add_row'), onClick: addRow, hidden: !canEdit },
          { key: 'columns', icon: <TableOutlined />, label: t('edit_columns'), onClick: () => setColumnsOpen(true), hidden: !canEdit },
          {
            key: 'delete',
            icon: <DeleteOutlined />,
            label: t('delete'),
            danger: true,
            onClick: removeDoc,
            hidden: !canEdit,
            confirm: { title: t('delete_scan_doc_confirm') },
          },
          { key: 'unlock', icon: <UnlockOutlined />, label: t('unlock_to_edit'), onClick: requirePin, hidden: canEdit },
        ]}
      />
    </>
  )

  return (
    <div className="page">
      {phone ? (
        phoneHead
      ) : (
        <>
          <ScanBreadcrumb folder={doc.folder} />
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
        </>
      )}

      <div className="scan-doc-options">
        <Typography.Text strong>{t('scan_dup_scope')}:</Typography.Text>
        <DuplicateScopeChoice value={doc.duplicate_scope} onChange={saveScope} folderName={doc.folder?.name} />
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

      {phone && <Fab icon={<ScanOutlined />} label={t('scan_start')} onClick={startScan} />}
      <ColumnsModal open={columnsOpen} columns={doc.columns} onCancel={() => setColumnsOpen(false)} onSave={saveColumns} />
      <CodeScanner open={scanning} onClose={closeScanner} onCode={onCode} title={`${t('scan_doc_scanner_title', { title: doc.title })} · ${t('scan_dup_scope')}: ${scopeLabel}`} />
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
