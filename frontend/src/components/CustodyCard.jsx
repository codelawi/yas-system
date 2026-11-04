import { useCallback, useEffect, useState } from 'react'
import { Alert, App, AutoComplete, Button, Card, Checkbox, DatePicker, Empty, Form, Input, Modal, Tag, Typography } from 'antd'
import { ExportOutlined, ImportOutlined, LockOutlined, UserSwitchOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'
import { useAuth } from '../auth'
import CustodyPrintButton, { loadCustodyForms } from './CustodyPrintButton'
import { printCustodyForm } from '../custodyForm'

/** Who holds this equipment (only with a PIN), hand over / take back. */
export default function CustodyCard({ equipment, mobile, onChanged }) {
  const { t } = useLang()
  const { user, requirePin } = useAuth()
  const { message, modal: confirm } = App.useApp()
  const [list, setList] = useState(null)
  const [holders, setHolders] = useState([])
  const [modal, setModal] = useState(null) // 'out' | 'in'
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  const load = useCallback(() => api.get(`/equipment/${equipment.id}/custody`).then(({ data }) => setList(data)).catch(() => setList(null)), [equipment.id])
  useEffect(() => {
    if (user) load()
    else setList(null)
  }, [user, load])

  const current = list?.find((c) => !c.returned_at)
  const hasAccessories = (equipment.accessories || []).length > 0

  const open = async (kind) => {
    if (!(await requirePin())) return
    form.resetFields()
    form.setFieldsValue({ include_accessories: true })
    if (kind === 'out') api.get('/custody/holders').then(({ data }) => setHolders(data))
    setModal(kind)
  }

  const save = async () => {
    const v = await form.validateFields()
    setSaving(true)
    try {
      if (modal === 'out') {
        const { data } = await api.post(`/equipment/${equipment.id}/custody`, { ...v, due_back_at: v.due_back_at ? v.due_back_at.format('YYYY-MM-DD') : null })
        message.success(t('handed_n', { n: data.handed_over }))
        const forms = await loadCustodyForms()
        const form = forms.find((f) => f.is_default) || forms[0]
        if (form) {
          confirm.confirm({ title: t('cf_handed_print'), okText: t('cf_print'), cancelText: t('cancel'), onOk: () => printCustodyForm(form, data.custody_id) })
        }
      } else {
        const { data } = await api.post(`/equipment/${equipment.id}/custody/return`, v)
        message.success(t('received_n', { n: data.received }))
      }
      setModal(null)
      load()
      onChanged?.()
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setSaving(false)
    }
  }

  const title = (
    <span>
      <UserSwitchOutlined /> {t('custody')}
    </span>
  )

  if (!user) {
    return (
      <Card title={title} style={{ marginTop: 16 }}>
        <div className="history-locked">
          <Typography.Text type="secondary">{t('custody_locked')}</Typography.Text>
          <Button icon={<LockOutlined />} onClick={requirePin}>
            {t('unlock')}
          </Button>
        </div>
      </Card>
    )
  }

  const overdue = current?.due_back_at && dayjs(current.due_back_at).isBefore(dayjs(), 'day')

  return (
    <Card
      title={title}
      style={{ marginTop: 16 }}
      extra={
        current ? (
          <Button type="primary" size={mobile ? 'large' : 'small'} icon={<ImportOutlined />} onClick={() => open('in')}>
            {t('take_back')}
          </Button>
        ) : (
          <Button type="primary" ghost size={mobile ? 'large' : 'small'} icon={<ExportOutlined />} onClick={() => open('out')}>
            {t('hand_over')}
          </Button>
        )
      }
    >
      {current ? (
        <Alert
          type={overdue ? 'error' : 'info'}
          showIcon
          title={<b>{t('in_custody_with', { name: current.holder })}</b>}
          description={
            <span>
              {current.holder_phone && <span dir="ltr">{current.holder_phone} · </span>}
              {t('since')} {dayjs(current.handed_at).format('YYYY-MM-DD')}
              {current.due_back_at && (
                <>
                  {' · '}
                  {t('due_back')}: {dayjs(current.due_back_at).format('YYYY-MM-DD')} {overdue && <Tag color="red">{t('overdue')}</Tag>}
                </>
              )}
              {(current.holder_id_number || current.holder_department) && <div>{[current.holder_id_number, current.holder_department].filter(Boolean).join(' · ')}</div>}
              {current.notes && <div>{current.notes}</div>}
            </span>
          }
          action={<CustodyPrintButton custodyId={current.id} size="small" label={!mobile} />}
        />
      ) : (
        <Tag color="green">{t('available')}</Tag>
      )}

      {list?.filter((c) => c.returned_at).length > 0 && (
        <>
          <Typography.Title level={5} style={{ marginTop: 16 }}>
            {t('custody_history')}
          </Typography.Title>
          <div className="mini-list">
            {list
              .filter((c) => c.returned_at)
              .map((c) => (
                <div key={c.id} className="op-row">
                  <span className="op-main">
                    <b>{c.holder}</b>
                    <span className="mini-sub">
                      {dayjs(c.handed_at).format('YYYY-MM-DD')} → {dayjs(c.returned_at).format('YYYY-MM-DD')}
                      {c.return_notes && ` · ${c.return_notes}`}
                    </span>
                  </span>
                  <CustodyPrintButton custodyId={c.id} size="small" label={false} />
                </div>
              ))}
          </div>
        </>
      )}
      {list && !list.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('no_custody')} style={{ marginTop: 8 }} />}

      <Modal open={!!modal} title={modal === 'out' ? t('hand_over') : t('take_back')} okText={t('save')} cancelText={t('cancel')} onOk={save} onCancel={() => setModal(null)} confirmLoading={saving} forceRender>
        <Form form={form} layout="vertical">
          {modal === 'out' ? (
            <>
              <Form.Item name="holder" label={t('holder')} rules={[{ required: true, whitespace: true, message: t('holder') }]}>
                <AutoComplete options={holders.map((h) => ({ value: h }))} filterOption autoFocus />
              </Form.Item>
              <Form.Item name="holder_phone" label={t('holder_phone')}>
                <Input dir="ltr" inputMode="tel" />
              </Form.Item>
              <Form.Item name="holder_id_number" label={t('holder_id_number')}>
                <Input dir="ltr" />
              </Form.Item>
              <Form.Item name="holder_department" label={t('holder_department')}>
                <Input />
              </Form.Item>
              <Form.Item name="due_back_at" label={t('due_back')}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="notes" label={t('notes')}>
                <Input.TextArea autoSize={{ minRows: 2 }} />
              </Form.Item>
            </>
          ) : (
            <Form.Item name="return_notes" label={t('return_notes')}>
              <Input.TextArea autoSize={{ minRows: 2 }} autoFocus />
            </Form.Item>
          )}
          {hasAccessories && (
            <Form.Item name="include_accessories" valuePropName="checked">
              <Checkbox>{t('with_accessories')}</Checkbox>
            </Form.Item>
          )}
        </Form>
      </Modal>
    </Card>
  )
}
