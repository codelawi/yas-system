import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Alert, App, Button, Card, Input, Popconfirm, Result, Spin, Table, Tag, Typography, Upload } from 'antd'
import { ArrowLeftOutlined, ArrowRightOutlined, CopyOutlined, DeleteOutlined, EditOutlined, FileTextOutlined, SaveOutlined, StarFilled, StarOutlined, UnlockOutlined, UploadOutlined } from '@ant-design/icons'
import api, { equipmentUrl, errorKey } from '../api'
import { useLang } from '../i18n'
import { useAuth } from '../auth'
import { useSettings } from '../settings'
import FormDesigner from '../components/FormDesigner'
import { loadCustodyForms } from '../components/CustodyPrintButton'
import { EQUIPMENT_SOURCES, PERSON_SOURCES, loadFormPages, usesTags } from '../custodyForm'

const KIND_COLOR = { pdf: 'red', image: 'purple', docx: 'blue', xlsx: 'green' }

function BackIcon() {
  const { dir } = useLang()
  return dir === 'rtl' ? <ArrowRightOutlined /> : <ArrowLeftOutlined />
}

function AdminOnly() {
  const { t } = useLang()
  const { user, requirePin } = useAuth()
  return (
    <div className="page">
      <Result
        icon={<FileTextOutlined />}
        title={t('cf_admin_only')}
        extra={
          !user && (
            <Button type="primary" size="large" icon={<UnlockOutlined />} onClick={requirePin}>
              {t('unlock')}
            </Button>
          )
        }
      />
    </div>
  )
}

/** Custody forms: upload templates, pick the default one. Admin only. */
export function CustodyFormsPage() {
  const { t } = useLang()
  const { isAdmin } = useAuth()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [forms, setForms] = useState(null)
  const [uploading, setUploading] = useState(false)

  const load = () => loadCustodyForms(true).then(setForms)
  useEffect(() => {
    if (isAdmin) load()
  }, [isAdmin])

  if (!isAdmin) return <AdminOnly />

  const upload = async ({ file }) => {
    setUploading(true)
    try {
      const body = new FormData()
      body.append('file', file)
      const { data } = await api.post('/custody-forms', body)
      navigate(`/custody/forms/${data.id}`)
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setUploading(false)
    }
  }

  const makeDefault = async (form) => {
    await api.put(`/custody-forms/${form.id}`, { is_default: true })
    load()
  }

  const remove = async (form) => {
    await api.delete(`/custody-forms/${form.id}`)
    message.success(t('deleted'))
    load()
  }

  return (
    <div className="page">
      <div className="page-head">
        <Typography.Title level={3}>
          <FileTextOutlined /> {t('custody_forms')}
        </Typography.Title>
        <div className="page-actions">
          <Link to="/custody">
            <Button icon={<BackIcon />}>{t('custodies')}</Button>
          </Link>
          <Upload accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx,.doc,.xls" showUploadList={false} customRequest={upload}>
            <Button type="primary" icon={<UploadOutlined />} loading={uploading}>
              {t('cf_upload')}
            </Button>
          </Upload>
        </div>
      </div>
      <Alert type="info" showIcon title={t('cf_upload_help')} style={{ marginBottom: 16 }} />
      <Table
        rowKey="id"
        loading={!forms}
        dataSource={forms || []}
        pagination={false}
        locale={{ emptyText: t('cf_none') }}
        scroll={{ x: 'max-content' }}
        columns={[
          {
            title: t('cf_name'),
            dataIndex: 'name',
            render: (v, r) => (
              <div>
                <Link to={`/custody/forms/${r.id}`}>
                  <b>{v}</b>
                </Link>
                <div className="list-name">{r.original_name}</div>
              </div>
            ),
          },
          { title: '', dataIndex: 'kind', render: (k) => <Tag color={KIND_COLOR[k]}>{k === 'image' ? t('cf_kind_image') : k.toUpperCase()}</Tag> },
          {
            title: t('cf_default'),
            key: 'default',
            align: 'center',
            render: (_, r) =>
              r.is_default ? (
                <StarFilled style={{ color: '#f59e0b', fontSize: 18 }} />
              ) : (
                <Button size="small" type="text" icon={<StarOutlined />} onClick={() => makeDefault(r)}>
                  {t('cf_make_default')}
                </Button>
              ),
          },
          {
            key: 'actions',
            align: 'end',
            render: (_, r) => (
              <div className="page-actions" style={{ justifyContent: 'flex-end' }}>
                <Link to={`/custody/forms/${r.id}`}>
                  <Button size="small" icon={<EditOutlined />}>
                    {usesTags(r) ? t('cf_tags') : t('cf_design')}
                  </Button>
                </Link>
                <Popconfirm title={t('cf_delete_confirm')} okText={t('delete')} okButtonProps={{ danger: true }} cancelText={t('cancel')} onConfirm={() => remove(r)}>
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={t('delete')} />
                </Popconfirm>
              </div>
            ),
          },
        ]}
      />
    </div>
  )
}

/** Word/Excel: which {{tags}} exist and which ones the file already uses. */
function TagGuide({ form }) {
  const { t } = useLang()
  const { message } = App.useApp()
  const [tags, setTags] = useState(null)

  useEffect(() => {
    api.get(`/custody-forms/${form.id}/tags`).then(({ data }) => setTags(data))
  }, [form.id])

  if (!tags) return <Spin />

  const copy = (tag) => {
    navigator.clipboard?.writeText(`{{${tag}}}`).then(() => message.success(t('cf_copied')))
  }
  const statusColor = { builtin: 'green', field: 'blue', unknown: 'orange' }

  return (
    <>
      <Card title={t('cf_tags_found')} style={{ marginBottom: 16 }}>
        {tags.found.length ? (
          <div className="cf-tags">
            {tags.found.map((f) => (
              <Tag key={f.tag} color={statusColor[f.known]}>
                <bdi>{`{{${f.tag}}}`}</bdi> · {t(`cf_tag_${f.known}`)}
              </Tag>
            ))}
          </div>
        ) : (
          <Typography.Text type="secondary">{t('cf_no_tags')}</Typography.Text>
        )}
      </Card>
      <Card title={t('cf_tags_title')}>
        <Typography.Paragraph type="secondary">{t('cf_tags_help')}</Typography.Paragraph>
        {[
          ['cf_group_person', PERSON_SOURCES],
          ['cf_group_equipment', EQUIPMENT_SOURCES],
        ].map(([group, ids]) => (
          <div key={group} style={{ marginBottom: 12 }}>
            <Typography.Text strong>{t(group)}</Typography.Text>
            <div className="cf-tags">
              {ids.map((id) => (
                <Button key={id} size="small" icon={<CopyOutlined />} onClick={() => copy(tags.builtin[id])}>
                  <bdi className="serial">{`{{${tags.builtin[id]}}}`}</bdi>
                  <span className="list-name">{t(`cf_src_${id}`)}</span>
                </Button>
              ))}
            </div>
          </div>
        ))}
      </Card>
    </>
  )
}

/** One form: rename, and design (PDF/image) or tag guide (Word/Excel). */
export function CustodyFormPage() {
  const { id } = useParams()
  const { t } = useLang()
  const { isAdmin } = useAuth()
  const { settings } = useSettings()
  const { message } = App.useApp()
  const [form, setForm] = useState(null)
  const [name, setName] = useState('')
  const [pages, setPages] = useState(null)
  const [layout, setLayout] = useState(null)
  const [failed, setFailed] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!isAdmin) return
    api.get('/custody-forms').then(({ data }) => {
      const found = data.find((f) => String(f.id) === id)
      setForm(found || false)
      if (!found) return
      setName(found.name)
      setLayout({ pages: [], elements: [], ...found.layout })
      if (!usesTags(found)) {
        loadFormPages(found)
          .then(setPages)
          .catch(() => setFailed(true))
      }
    })
  }, [id, isAdmin])

  // Free the page images when leaving
  useEffect(() => () => pages?.forEach((p) => URL.revokeObjectURL(p.src)), [pages])

  if (!isAdmin) return <AdminOnly />
  if (form === null) return <Spin size="large" className="page-spin" />
  if (form === false) return <Result status="404" title="404" />

  const save = async () => {
    setSaving(true)
    try {
      const body = { name }
      if (pages) body.layout = { pages: pages.map(({ w, h }) => ({ w, h })), elements: layout.elements.filter((el) => el.page < pages.length) }
      const { data } = await api.put(`/custody-forms/${form.id}`, body)
      setForm(data)
      setDirty(false)
      loadCustodyForms(true)
      message.success(t('saved'))
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Link to="/custody/forms">
            <Button icon={<BackIcon />} aria-label={t('custody_forms')} />
          </Link>
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setDirty(true)
            }}
            style={{ width: 280, fontWeight: 600 }}
          />
          <Tag color={KIND_COLOR[form.kind]}>{form.kind === 'image' ? t('cf_kind_image') : form.kind.toUpperCase()}</Tag>
          {dirty && <Tag color="orange">{t('ld_unsaved')}</Tag>}
        </div>
        <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save} disabled={!name.trim()}>
          {t('save')}
        </Button>
      </div>

      {usesTags(form) ? (
        <TagGuide form={form} />
      ) : failed ? (
        <Result status="warning" title={t('cf_load_failed')} />
      ) : !pages ? (
        <Spin description={t('cf_loading')} size="large">
          <div style={{ height: 300 }} />
        </Spin>
      ) : (
        <FormDesigner
          pages={pages}
          layout={layout}
          qrUrl={equipmentUrl(settings, 'SN-0000')}
          onChange={(l) => {
            setLayout(l)
            setDirty(true)
          }}
        />
      )}
    </div>
  )
}
