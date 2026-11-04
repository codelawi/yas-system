import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { App, Button, Card, Checkbox, Empty, Form, Input, Modal, Popconfirm, Result, Spin, Table, Tag, Typography } from 'antd'
import {
  AppstoreAddOutlined,
  ClusterOutlined,
  DeleteOutlined,
  EditOutlined,
  FileWordOutlined,
  MergeCellsOutlined,
  PictureOutlined,
  PlusOutlined,
  PrinterOutlined,
} from '@ant-design/icons'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'
import { useAuth } from '../auth'
import EquipmentForm from '../components/EquipmentForm'
import EquipmentPicker from '../components/EquipmentPicker'

/** Create (no `group`) or rename a group. */
function GroupForm({ open, group, onClose, onSaved }) {
  const { t } = useLang()
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) form.setFieldsValue({ name: group?.name || '' })
  }, [open, group, form])

  const save = async () => {
    const values = await form.validateFields()
    setSaving(true)
    try {
      const { data } = group ? await api.put(`/groups/${group.id}`, values) : await api.post('/groups', values)
      message.success(t('saved'))
      onSaved(data)
    } catch (e) {
      const key = errorKey(e)
      if (key === 'group_name_taken' || key === 'group_name_invalid') form.setFields([{ name: 'name', errors: [t(key)] }])
      else message.error(t(key || 'error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      title={group ? t('rename_group') : t('add_group')}
      okText={t('save')}
      cancelText={t('cancel')}
      onOk={save}
      onCancel={onClose}
      confirmLoading={saving}
      destroyOnHidden
      forceRender
    >
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item name="name" label={t('group_name')} rules={[{ required: true, whitespace: true, message: t('group_name') }]}>
          <Input autoFocus placeholder={t('group_name_example')} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

/** Suggested groups from equipment that share a name; nothing is saved until confirmed. */
function AutoGroupModal({ open, onClose, onDone }) {
  const { t } = useLang()
  const { message } = App.useApp()
  const [suggestions, setSuggestions] = useState(null)
  const [chosen, setChosen] = useState([])
  const [names, setNames] = useState({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setSuggestions(null)
    api.get('/groups/suggest').then(({ data }) => {
      setSuggestions(data)
      setChosen(data.map((s) => s.key))
      setNames(Object.fromEntries(data.map((s) => [s.key, s.name])))
    })
  }, [open])

  const apply = async () => {
    setSaving(true)
    try {
      const groups = suggestions.filter((s) => chosen.includes(s.key)).map((s) => ({ key: s.key, name: (names[s.key] || s.name).trim() }))
      const { data } = await api.post('/groups/apply', { groups })
      message.success(t('auto_group_done', { groups: data.created, n: data.grouped }))
      onDone()
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setSaving(false)
    }
  }

  const columns = [
    {
      title: t('group_name'),
      dataIndex: 'name',
      render: (_, s) => (
        <Input
          value={names[s.key]}
          disabled={!!s.group_id}
          onChange={(e) => setNames({ ...names, [s.key]: e.target.value })}
          variant={s.group_id ? 'borderless' : 'outlined'}
        />
      ),
    },
    {
      title: t('count'),
      dataIndex: 'count',
      width: 110,
      render: (n, s) => (
        <span>
          <b>{n}</b> {s.group_id && <Tag color="blue">{t('existing_group')}</Tag>}
        </span>
      ),
    },
    {
      title: t('serial_number'),
      dataIndex: 'serials',
      responsive: ['md'],
      render: (serials, s) => (
        <Typography.Text type="secondary" className="serial">
          {serials.join('، ')}
          {s.count > serials.length && ' …'}
        </Typography.Text>
      ),
    },
  ]

  return (
    <Modal
      open={open}
      title={t('auto_group')}
      okText={t('auto_group_apply', { n: chosen.length })}
      cancelText={t('cancel')}
      onOk={apply}
      okButtonProps={{ disabled: !chosen.length }}
      onCancel={onClose}
      confirmLoading={saving}
      width={820}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">{t('auto_group_hint')}</Typography.Paragraph>
      {!suggestions ? (
        <Spin />
      ) : suggestions.length ? (
        <Table
          rowKey="key"
          size="small"
          dataSource={suggestions}
          columns={columns}
          pagination={false}
          scroll={{ y: 420 }}
          rowSelection={{ selectedRowKeys: chosen, onChange: setChosen }}
        />
      ) : (
        <Empty description={t('auto_group_none')} />
      )}
    </Modal>
  )
}

/** All groups: add, auto-group. */
export function GroupsPage() {
  const { t } = useLang()
  const { requirePin } = useAuth()
  const navigate = useNavigate()
  const [groups, setGroups] = useState(null)
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const [auto, setAuto] = useState(false)

  const load = () => api.get('/groups').then(({ data }) => setGroups(data))
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once
  }, [])

  const withPin = (open) => async () => {
    if (await requirePin()) open(true)
  }

  const shown = (groups || []).filter((g) => !q || g.name.includes(q.trim()))

  return (
    <div className="page">
      <div className="page-head">
        <Typography.Title level={3}>
          <ClusterOutlined /> {t('groups')}
        </Typography.Title>
        <div className="page-actions">
          <Button icon={<MergeCellsOutlined />} onClick={withPin(setAuto)}>
            {t('auto_group')}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={withPin(setAdding)}>
            {t('add_group')}
          </Button>
        </div>
      </div>
      <Typography.Paragraph type="secondary">{t('groups_intro')}</Typography.Paragraph>
      <Input.Search allowClear placeholder={t('search_groups')} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 420, marginBottom: 16 }} />
      <Table
        rowKey="id"
        loading={!groups}
        dataSource={shown}
        pagination={{ pageSize: 50, hideOnSinglePage: true }}
        locale={{ emptyText: t('no_groups') }}
        onRow={(g) => ({ onDoubleClick: () => navigate(`/groups/${g.id}`) })}
        columns={[
          {
            title: t('group_name'),
            dataIndex: 'name',
            render: (name, g) => (
              <Link to={`/groups/${g.id}`} className="list-big list-title">
                <ClusterOutlined /> {name}
              </Link>
            ),
          },
          { title: t('count'), dataIndex: 'equipment_count', width: 120, render: (n) => t('n_items', { n }) },
        ]}
      />
      <GroupForm open={adding} onClose={() => setAdding(false)} onSaved={(g) => navigate(`/groups/${g.id}`)} />
      <AutoGroupModal
        open={auto}
        onClose={() => setAuto(false)}
        onDone={() => {
          setAuto(false)
          load()
        }}
      />
    </div>
  )
}

/** One group: its units, each with its own serial number and details. */
export function GroupDetail() {
  const { id } = useParams()
  const { t } = useLang()
  const { requirePin } = useAuth()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [group, setGroup] = useState(null)
  const [missing, setMissing] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [picking, setPicking] = useState(false)
  const [creating, setCreating] = useState(false)

  const load = () =>
    api
      .get(`/groups/${id}`)
      .then(({ data }) => setGroup(data))
      .catch(() => setMissing(true))

  useEffect(() => {
    setGroup(null)
    setMissing(false)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the group changes
  }, [id])

  if (missing) return <Result status="404" title={t('group_not_found')} />
  if (!group) return <Spin size="large" className="page-spin" />

  const withPin = (open) => async () => {
    if (await requirePin()) open(true)
  }

  const remove = async () => {
    if (!(await requirePin())) return
    try {
      await api.delete(`/groups/${group.id}`)
      message.success(t('deleted'))
      navigate('/groups')
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }

  const takeOut = async (eq) => {
    if (!(await requirePin())) return
    try {
      await api.post('/groups/assign', { ids: [eq.id], group_id: null })
      load()
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }

  const ids = group.equipment.map((e) => e.id)

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <Typography.Text type="secondary">
            <ClusterOutlined /> {t('group')}
          </Typography.Text>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {group.name}
          </Typography.Title>
          <Tag>{t('n_items', { n: group.equipment.length })}</Tag>
        </div>
        <div className="page-actions">
          <Button icon={<EditOutlined />} onClick={withPin(setRenaming)}>
            {t('rename_group')}
          </Button>
          <Button icon={<PrinterOutlined />} disabled={!ids.length} onClick={() => window.open(`/labels?ids=${ids.join(',')}`, '_blank')}>
            {t('print_labels', { n: ids.length })}
          </Button>
          <Popconfirm title={t('delete_group_confirm')} okText={t('delete')} cancelText={t('cancel')} okButtonProps={{ danger: true }} onConfirm={remove}>
            <Button danger icon={<DeleteOutlined />}>
              {t('delete')}
            </Button>
          </Popconfirm>
        </div>
      </div>

      <Card
        title={`${t('group_units')} (${group.equipment.length})`}
        extra={
          <div className="page-actions">
            <Button type="primary" icon={<PlusOutlined />} onClick={withPin(setCreating)}>
              {t('new_equipment_in_box')}
            </Button>
            <Button icon={<AppstoreAddOutlined />} onClick={withPin(setPicking)}>
              {t('choose_existing')}
            </Button>
            <Button icon={<FileWordOutlined />} onClick={() => navigate(`/import?group=${group.id}`)}>
              {t('import_into_group')}
            </Button>
          </div>
        }
      >
        {group.equipment.length ? (
          <div className="box-items">
            {group.equipment.map((eq) => (
              <div key={eq.id} className="box-item">
                <Link to={`/equipment/${eq.id}`} className="box-item-link">
                  {eq.photo_url ? (
                    <img src={eq.photo_url} alt="" className="box-item-photo" loading="lazy" />
                  ) : (
                    <span className="box-item-photo box-item-nophoto">
                      <PictureOutlined />
                    </span>
                  )}
                  <span className="box-item-text">
                    <span className="serial accessory-name">{eq.serial_number}</span>
                    <Typography.Text type="secondary" className="box-item-extra">
                      {[eq.row_no != null && `${t('row_no')} ${eq.row_no}`, eq.category, eq.accessories_count > 0 && t('accessories_n', { n: eq.accessories_count })]
                        .filter(Boolean)
                        .join(' · ')}
                    </Typography.Text>
                  </span>
                </Link>
                <Popconfirm title={t('take_out_of_group_confirm')} okText={t('take_out_of_group')} cancelText={t('cancel')} onConfirm={() => takeOut(eq)}>
                  <Button type="text" size="small" danger icon={<DeleteOutlined />} title={t('take_out_of_group')} />
                </Popconfirm>
              </div>
            ))}
          </div>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('group_empty')} />
        )}
      </Card>

      <GroupForm
        open={renaming}
        group={group}
        onClose={() => setRenaming(false)}
        onSaved={(data) => {
          setRenaming(false)
          setGroup(data)
        }}
      />
      <EquipmentPicker
        open={picking}
        title={t('choose_existing')}
        hint={t('group_pick_hint')}
        exclude={ids}
        excludedLabel={t('already_in_group')}
        params={{ type: 'main' }}
        onClose={() => setPicking(false)}
        onSubmit={async (picked) => {
          const { data } = await api.post('/groups/assign', { ids: picked, group_id: group.id })
          message.success(t('added_to_group', { n: data.changed }))
          setPicking(false)
          load()
        }}
      />
      <EquipmentForm
        open={creating}
        group={group}
        onClose={() => setCreating(false)}
        onSaved={() => {
          setCreating(false)
          load()
        }}
      />
    </div>
  )
}
