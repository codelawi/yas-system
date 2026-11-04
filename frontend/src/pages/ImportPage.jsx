import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { App, AutoComplete, Button, Card, Col, Input, Modal, Result, Row, Select, Spin, Steps, Table, Tag, Typography, Upload } from 'antd'
import { ApartmentOutlined, EditOutlined, EyeOutlined, FileWordOutlined, InboxOutlined, UnlockOutlined } from '@ant-design/icons'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'
import { useAuth } from '../auth'
import FieldList from '../components/FieldList'
import FieldEditor, { cleanFields } from '../components/FieldEditor'
import TableMapper from '../components/TableMapper'
import { accessoryCandidates, activeAccessoryKeys, applyAccessoryKeys, buildItems, initialMapping } from '../importMapping'

const ACC_KEYS_STORE = 'repo_accessory_keys'
const STATUS_COLOR = { new: 'green', exists: 'orange', missing_serial: 'red', duplicate_in_upload: 'purple' }
const DEFAULT_ACTION = { new: 'create', exists: 'skip', missing_serial: 'skip', duplicate_in_upload: 'skip' }

function storedAccessoryKeys() {
  try {
    return JSON.parse(localStorage.getItem(ACC_KEYS_STORE)) || []
  } catch {
    return []
  }
}

export default function ImportPage() {
  const { t } = useLang()
  const { user, requirePin } = useAuth()
  const { message } = App.useApp()
  const [step, setStep] = useState(0)
  const [fileList, setFileList] = useState([])
  const [reading, setReading] = useState(false)
  const [files, setFiles] = useState([])
  // import_id → one mapping per table (what each column / key means)
  const [mappings, setMappings] = useState({})
  // uid → manual changes made in the review list (serial, fields, action)
  const [overrides, setOverrides] = useState({})
  // serial → equipment already in the system
  const [existing, setExisting] = useState({})
  const [checking, setChecking] = useState(false)
  const checked = useRef(new Set())
  const [category, setCategory] = useState('')
  const [categories, setCategories] = useState([])
  const [mapperFor, setMapperFor] = useState(null)
  const [editRow, setEditRow] = useState(null)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState(null)

  useEffect(() => {
    api.get('/equipment/categories').then(({ data }) => setCategories(data))
  }, [])

  const read = async () => {
    setReading(true)
    try {
      const body = new FormData()
      fileList.forEach((f) => body.append('files[]', f.originFileObj || f))
      const { data } = await api.post('/imports/preview', body)
      const remembered = storedAccessoryKeys()
      setFiles(data.files)
      setMappings(Object.fromEntries(data.files.map((f) => [f.import_id, f.tables.map((tb) => initialMapping(tb, remembered))])))
      setOverrides({})
      setExisting({})
      checked.current = new Set()
      setStep(1)
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setReading(false)
    }
  }

  // Items from the tables + mappings, then the user's manual changes on top
  const baseItems = useMemo(
    () => files.flatMap((f) => f.tables.flatMap((tb, ti) => buildItems(tb, mappings[f.import_id]?.[ti], f))),
    [files, mappings],
  )

  const rows = useMemo(() => {
    const seen = new Set()
    return baseItems.map((item) => {
      const o = overrides[item.uid] || {}
      const serial = (o.serial ?? item.serial ?? '').trim() || null
      const status = !serial ? 'missing_serial' : seen.has(serial) ? 'duplicate_in_upload' : existing[serial] ? 'exists' : 'new'
      if (serial) seen.add(serial)
      return {
        ...item,
        serial,
        fields: o.fields ?? item.fields,
        status,
        existing: existing[serial],
        action: o.action && (status === 'exists' ? ['overwrite', 'skip'] : ['create', 'skip']).includes(o.action) ? o.action : DEFAULT_ACTION[status],
      }
    })
  }, [baseItems, overrides, existing])

  // Ask the server which serials already exist (only the ones not asked yet)
  const serialsKey = rows.map((r) => r.serial).filter(Boolean).join('\n')
  useEffect(() => {
    const todo = [...new Set(serialsKey.split('\n').filter((s) => s && !checked.current.has(s)))]
    if (!todo.length) return
    setChecking(true)
    const timer = setTimeout(() => {
      api
        .post('/imports/check', { serials: todo })
        .then(({ data }) => {
          todo.forEach((s) => checked.current.add(s))
          setExisting((e) => ({ ...e, ...data }))
        })
        .finally(() => setChecking(false))
    }, 300)
    return () => clearTimeout(timer)
  }, [serialsKey])

  const override = (uid, patch) => setOverrides((o) => ({ ...o, [uid]: { ...o[uid], ...patch } }))
  const setExistingAction = (action) => setOverrides((o) => ({ ...o, ...Object.fromEntries(rows.filter((r) => r.status === 'exists').map((r) => [r.uid, { ...o[r.uid], action }])) }))

  /** Mapping changed: field edits made for those tables no longer match, keep serial / action only. */
  const resetFieldOverrides = (importIds) =>
    setOverrides((o) => Object.fromEntries(Object.entries(o).map(([uid, v]) => [uid, importIds.some((id) => uid.startsWith(`${id}:`)) ? { serial: v.serial, action: v.action } : v])))

  const accessoryKeys = useMemo(() => activeAccessoryKeys(files, mappings), [files, mappings])
  const accessoryOptions = useMemo(() => accessoryCandidates(files, mappings), [files, mappings])

  const changeAccessoryKeys = (keys) => {
    setMappings((m) => applyAccessoryKeys(m, keys))
    resetFieldOverrides(files.map((f) => f.import_id))
  }

  const toSave = rows.filter((r) => r.action !== 'skip')
  const counts = useMemo(() => rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {}), [rows])
  const accessoryTotal = toSave.reduce((n, r) => n + r.accessories.length, 0)

  const commit = async () => {
    setSaving(true)
    try {
      try {
        // Remember accessory columns for the next import (with columns not in this upload)
        const notHere = storedAccessoryKeys().filter((k) => !accessoryOptions.includes(k))
        localStorage.setItem(ACC_KEYS_STORE, JSON.stringify([...new Set([...notHere, ...accessoryKeys])]))
      } catch {
        /* ignore */
      }
      const { data } = await api.post('/imports/commit', {
        category: category || null,
        items: rows.map((r) => ({
          import_id: r.import_id,
          action: r.action,
          serial: r.serial,
          row_no: r.row_no ?? null,
          fields: cleanFields(r.fields),
          accessories: r.accessories,
        })),
      })
      setResult(data)
      setStep(2)
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setSaving(false)
    }
  }

  const reset = () => {
    setStep(0)
    setFileList([])
    setFiles([])
    setMappings({})
    setOverrides({})
    setResult(null)
  }

  if (!user) {
    return (
      <div className="page">
        <Result
          icon={<UnlockOutlined />}
          title={t('import_need_pin')}
          extra={
            <Button type="primary" size="large" onClick={requirePin}>
              {t('unlock')}
            </Button>
          }
        />
      </div>
    )
  }

  const mapperFile = files.find((f) => f.import_id === mapperFor)

  const columns = [
    {
      title: t('file'),
      key: 'source',
      render: (_, r) => (
        <div className="source-cell">
          <div>{r.file}</div>
          <Typography.Text type="secondary">
            {t('table')} {r.table}
            {r.row ? ` · ${t('row')} ${r.row}` : ''}
          </Typography.Text>
        </div>
      ),
      responsive: ['md'],
    },
    { title: t('row_no'), dataIndex: 'row_no', width: 56, align: 'center', render: (v) => v ?? '—' },
    {
      title: t('serial_number'),
      dataIndex: 'serial',
      render: (v, r) => (
        <Input
          value={overrides[r.uid]?.serial ?? v ?? ''}
          status={!v && r.action !== 'skip' ? 'error' : undefined}
          onChange={(e) => {
            const serial = e.target.value
            // Typing a serial for a row that had none: add it by default
            override(r.uid, r.status === 'missing_serial' && serial.trim() ? { serial, action: 'create' } : { serial })
          }}
          style={{ minWidth: 140 }}
        />
      ),
    },
    {
      title: '',
      dataIndex: 'status',
      filters: Object.keys(STATUS_COLOR).map((s) => ({ text: t(`st_${s}`), value: s })),
      onFilter: (v, r) => r.status === v,
      render: (s) => <Tag color={STATUS_COLOR[s]}>{t(`st_${s}`)}</Tag>,
    },
    {
      title: t('fields'),
      key: 'fields',
      render: (_, r) => (
        <div className="field-preview">
          {r.accessories.length > 0 && (
            <Tag color="purple" icon={<ApartmentOutlined />}>
              {t('accessories_n', { n: r.accessories.length })}
            </Tag>
          )}
          {r.fields.slice(0, 3).map((f, i) => (
            <span key={i}>
              <b>
                <bdi>{f.key}</bdi>:
              </b>{' '}
              <bdi>{String(f.value).split('\n')[0]}</bdi>
            </span>
          ))}
          {r.fields.length > 3 && <Typography.Text type="secondary">+{r.fields.length - 3}</Typography.Text>}
        </div>
      ),
    },
    {
      title: t('action'),
      dataIndex: 'action',
      render: (v, r) => (
        <Select
          value={v}
          onChange={(action) => override(r.uid, { action })}
          style={{ width: 120 }}
          status={r.status === 'exists' && v === 'skip' ? 'warning' : undefined}
          options={(r.status === 'exists' ? ['overwrite', 'skip'] : ['create', 'skip']).map((a) => ({ value: a, label: t(`ac_${a}`) }))}
        />
      ),
    },
    { key: 'edit', render: (_, r) => <Button type="text" icon={<EditOutlined />} onClick={() => setEditRow({ uid: r.uid, serial: r.serial ?? '', fields: r.fields, status: r.status })} /> },
  ]

  return (
    <div className="page">
      <Typography.Title level={3}>{t('import')}</Typography.Title>
      <Steps current={step} items={[{ title: t('import_step_upload') }, { title: t('import_step_review') }, { title: t('import_step_done') }]} style={{ marginBottom: 24 }} />

      {step === 0 && (
        <Card>
          <Upload.Dragger multiple accept=".docx" fileList={fileList} beforeUpload={() => false} onChange={({ fileList }) => setFileList(fileList.filter((f) => f.name.toLowerCase().endsWith('.docx')))}>
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">{t('import_drop')}</p>
            <p className="ant-upload-hint">{t('import_drop_hint')}</p>
          </Upload.Dragger>
          <Button type="primary" size="large" block disabled={!fileList.length} loading={reading} onClick={read} style={{ marginTop: 16 }}>
            {t('read_files')} ({fileList.length})
          </Button>
        </Card>
      )}

      {step === 1 && (
        <>
          {/* One line per file, with the button that opens its tables */}
          <Card size="small" style={{ marginBottom: 16 }}>
            {files.map((f) => (
              <div key={f.import_id} className="file-line">
                <FileWordOutlined className="file-line-icon" />
                <b>{f.file}</b>
                {f.error ? (
                  <Tag color="red">{t(f.error)}</Tag>
                ) : (
                  <>
                    <Typography.Text type="secondary">
                      {t('map_tables_n', { n: f.tables.length })} · {t('map_items_n', { n: rows.filter((r) => r.import_id === f.import_id).length })}
                    </Typography.Text>
                    {f.warnings.map((w) => (
                      <Tag key={w} color="orange">
                        {t(`warn_${w}`)}
                      </Tag>
                    ))}
                    <div style={{ flex: 1 }} />
                    {f.tables.length > 0 && (
                      <Button type="primary" ghost icon={<EyeOutlined />} onClick={() => setMapperFor(f.import_id)}>
                        {t('map_open')}
                      </Button>
                    )}
                  </>
                )}
              </div>
            ))}
          </Card>

          <Card style={{ marginBottom: 16 }}>
            <div className="toolbar" style={{ marginBottom: 0 }}>
              {Object.entries(counts).map(([s, n]) => (
                <Tag key={s} color={STATUS_COLOR[s]}>
                  {t(`st_${s}`)}: {n}
                </Tag>
              ))}
              {checking && <Spin size="small" />}
              <div style={{ flex: 1 }} />
              <AutoComplete value={category} onChange={setCategory} options={categories.map((c) => ({ value: c }))} placeholder={t('import_category')} filterOption allowClear style={{ minWidth: 260 }} />
              {counts.exists > 0 && (
                <>
                  <Button onClick={() => setExistingAction('overwrite')}>{t('overwrite_all')}</Button>
                  <Button onClick={() => setExistingAction('skip')}>{t('skip_all')}</Button>
                </>
              )}
            </div>
          </Card>

          {accessoryOptions.length > 0 && (
            <Card style={{ marginBottom: 16 }} size="small">
              <Typography.Text strong>
                <ApartmentOutlined /> {t('accessory_columns')}
              </Typography.Text>
              <Typography.Paragraph type="secondary" style={{ margin: '4px 0 8px' }}>
                {t('accessory_columns_help')} {t('map_accessory_hint')}
              </Typography.Paragraph>
              <Select mode="multiple" allowClear value={accessoryKeys} onChange={changeAccessoryKeys} options={accessoryOptions.map((k) => ({ value: k, label: k }))} placeholder={t('accessory_columns')} style={{ width: '100%' }} />
            </Card>
          )}

          <Table
            rowKey="uid"
            columns={columns}
            dataSource={rows}
            pagination={{ pageSize: 50, hideOnSinglePage: true }}
            scroll={{ x: 'max-content' }}
            rowClassName={(r) => (r.action === 'skip' ? 'row-skipped' : '')}
            expandable={{
              expandedRowRender: (r) => {
                const accessoryBlock = r.accessories.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <Typography.Text strong>
                      <ApartmentOutlined /> {t('accessories')}
                    </Typography.Text>
                    <FieldList fields={r.accessories.map((a) => ({ key: a.name, value: a.serial }))} compact />
                  </div>
                )
                return r.status === 'exists' ? (
                  <Row gutter={16}>
                    <Col xs={24} md={12}>
                      <Typography.Text strong>{t('current_data')}</Typography.Text>
                      <FieldList fields={r.existing.fields} compact />
                    </Col>
                    <Col xs={24} md={12}>
                      <Typography.Text strong>{t('new_data')}</Typography.Text>
                      <FieldList fields={r.fields} compact />
                      {accessoryBlock}
                    </Col>
                  </Row>
                ) : (
                  <>
                    <FieldList fields={r.fields} compact />
                    {accessoryBlock}
                  </>
                )
              },
            }}
          />

          <div className="page-actions" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
            <Button onClick={reset}>{t('cancel')}</Button>
            <Button type="primary" size="large" disabled={!toSave.length || checking} loading={saving} onClick={commit}>
              {t('save_import', { n: toSave.length })}
              {accessoryTotal > 0 && ` + ${t('accessories_n', { n: accessoryTotal })}`}
            </Button>
          </div>
        </>
      )}

      {step === 2 && result && (
        <Result
          status={result.errors.length ? 'warning' : 'success'}
          title={`${t('import_result', result)}${result.accessories ? ` ${t('import_result_accessories', { n: result.accessories })}` : ''}`}
          subTitle={
            result.errors.length > 0 && (
              <div>
                {t('errors')}:{' '}
                {result.errors.map((e, i) => (
                  <Tag key={i} color="red">
                    {e.serial || '—'}: {t(`err_${e.error}`)}
                  </Tag>
                ))}
              </div>
            )
          }
          extra={[
            <Link key="view" to={files.length === 1 ? `/equipment?import_id=${files[0].import_id}` : '/equipment'}>
              <Button type="primary">{t('view_imported')}</Button>
            </Link>,
            <Button key="more" onClick={reset}>
              {t('import_more')}
            </Button>,
          ]}
        />
      )}

      <TableMapper
        key={mapperFor ?? 'closed'}
        open={!!mapperFile}
        file={mapperFile}
        mappings={mapperFile ? mappings[mapperFile.import_id] : []}
        accessoryKeys={accessoryKeys}
        onClose={() => setMapperFor(null)}
        onApply={(draft) => {
          setMappings((m) => ({ ...m, [mapperFile.import_id]: draft }))
          resetFieldOverrides([mapperFile.import_id])
          setMapperFor(null)
        }}
      />

      <Modal
        open={!!editRow}
        title={t('edit_equipment')}
        okText={t('save')}
        cancelText={t('cancel')}
        width={760}
        onCancel={() => setEditRow(null)}
        onOk={() => {
          const patch = { serial: editRow.serial, fields: editRow.fields }
          if (editRow.status === 'missing_serial' && editRow.serial.trim()) patch.action = 'create'
          override(editRow.uid, patch)
          setEditRow(null)
        }}
        destroyOnHidden
      >
        {editRow && (
          <>
            <Typography.Text strong>{t('serial_number')}</Typography.Text>
            <Input value={editRow.serial} onChange={(e) => setEditRow({ ...editRow, serial: e.target.value })} style={{ marginBottom: 16 }} />
            <FieldEditor value={editRow.fields} onChange={(fields) => setEditRow({ ...editRow, fields })} />
          </>
        )}
      </Modal>
    </div>
  )
}
