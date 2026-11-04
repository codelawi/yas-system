import { useCallback, useEffect, useState } from 'react'
import { App, Button, Form, Input, Modal, Popconfirm, Select, Switch, Table, Tag, Typography } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'
import { useAuth } from '../auth'

export default function UsersPage() {
  const { t } = useLang()
  const { user: me } = useAuth()
  const { message } = App.useApp()
  const [users, setUsers] = useState([])
  const [editing, setEditing] = useState(null) // null | {} (new) | user
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  const load = useCallback(() => api.get('/users').then(({ data }) => setUsers(data)), [])
  useEffect(() => {
    load()
  }, [load])

  const open = (user) => {
    setEditing(user)
    form.setFieldsValue({ name: user.name || '', pin: '', role: user.role || 'editor', is_active: user.is_active ?? true })
  }

  const save = async () => {
    const values = await form.validateFields()
    setSaving(true)
    try {
      if (editing.id) await api.put(`/users/${editing.id}`, values)
      else await api.post('/users', values)
      message.success(t('saved'))
      setEditing(null)
      load()
    } catch (e) {
      const key = errorKey(e)
      if (key === 'pin_taken') form.setFields([{ name: 'pin', errors: [t(key)] }])
      else message.error(t(key || 'error'))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (user) => {
    try {
      await api.delete(`/users/${user.id}`)
      load()
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <Typography.Title level={3}>{t('users')}</Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => open({})}>
          {t('add_user')}
        </Button>
      </div>
      <Table
        rowKey="id"
        dataSource={users}
        pagination={false}
        columns={[
          { title: t('name'), dataIndex: 'name' },
          { title: t('role'), dataIndex: 'role', render: (r) => <Tag color={r === 'admin' ? 'gold' : 'blue'}>{t(`role_${r}`)}</Tag> },
          { title: '', dataIndex: 'is_active', render: (a) => <Tag color={a ? 'green' : 'default'}>{t(a ? 'active' : 'inactive')}</Tag> },
          {
            key: 'actions',
            align: 'end',
            render: (_, u) => (
              <>
                <Button type="text" icon={<EditOutlined />} onClick={() => open(u)} />
                {u.id !== me?.id && (
                  <Popconfirm title={t('delete_user_confirm')} okText={t('delete')} cancelText={t('cancel')} okButtonProps={{ danger: true }} onConfirm={() => remove(u)}>
                    <Button type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                )}
              </>
            ),
          },
        ]}
      />
      <Modal open={!!editing} title={editing?.id ? t('edit_user') : t('add_user')} okText={t('save')} cancelText={t('cancel')} onOk={save} onCancel={() => setEditing(null)} confirmLoading={saving} destroyOnHidden forceRender>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('name')} rules={[{ required: true, whitespace: true, message: t('name') }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="pin"
            label={t('pin')}
            extra={editing?.id ? t('pin_keep') : t('pin_rule')}
            rules={[{ required: !editing?.id, message: t('pin_rule') }, { pattern: /^\d{4,8}$/, message: t('pin_rule') }]}
          >
            <Input.Password inputMode="numeric" maxLength={8} autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="role" label={t('role')}>
            <Select options={['editor', 'admin'].map((r) => ({ value: r, label: t(`role_${r}`) }))} />
          </Form.Item>
          <Form.Item name="is_active" label={t('active')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
