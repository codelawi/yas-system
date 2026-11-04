import { useCallback, useEffect, useState } from 'react'
import { App, AutoComplete, Button, Card, DatePicker, Empty, Form, Input, InputNumber, Modal, Popconfirm, Tag, Typography } from 'antd'
import { CheckOutlined, DeleteOutlined, PlusOutlined, ToolOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'
import { useAuth } from '../auth'

const PRESETS = ['preset_inspection', 'preset_maintenance', 'preset_warranty', 'preset_expiry']

/** How close a date is: overdue / soon (7 days) / ok */
export function dueState(date) {
  const days = dayjs(date).startOf('day').diff(dayjs().startOf('day'), 'day')
  return days < 0 ? 'overdue' : days <= 7 ? 'soon' : 'ok'
}
export const DUE_COLOR = { overdue: 'red', soon: 'orange', ok: 'green' }

export default function MaintenanceCard({ equipment, onChanged }) {
  const { t } = useLang()
  const { requirePin } = useAuth()
  const { message } = App.useApp()
  const [data, setData] = useState({ schedules: [], records: [] })
  const [modal, setModal] = useState(null) // { kind: 'date' | 'done' | 'work', schedule? }
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  const load = useCallback(() => api.get(`/equipment/${equipment.id}/maintenance`).then(({ data }) => setData(data)), [equipment.id])
  useEffect(() => {
    load()
  }, [load])

  const open = async (kind, schedule) => {
    if (!(await requirePin())) return
    form.resetFields()
    form.setFieldsValue(kind === 'date' ? { due_date: dayjs().add(1, 'month') } : { done_at: dayjs() })
    setModal({ kind, schedule })
  }

  const save = async () => {
    const v = await form.validateFields()
    const date = (d) => (d ? d.format('YYYY-MM-DD') : null)
    setSaving(true)
    try {
      if (modal.kind === 'date') await api.post(`/equipment/${equipment.id}/maintenance`, { ...v, due_date: date(v.due_date) })
      if (modal.kind === 'done') await api.post(`/maintenance/${modal.schedule.id}/complete`, { ...v, done_at: date(v.done_at) })
      if (modal.kind === 'work') await api.post(`/equipment/${equipment.id}/maintenance-records`, { ...v, done_at: date(v.done_at) })
      message.success(t('saved'))
      setModal(null)
      load()
      onChanged?.()
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (schedule) => {
    if (!(await requirePin())) return
    await api.delete(`/maintenance/${schedule.id}`)
    load()
    onChanged?.()
  }

  return (
    <Card
      title={
        <span>
          <ToolOutlined /> {t('maintenance')}
        </span>
      }
      extra={
        <div className="page-actions">
          <Button size="small" onClick={() => open('work')}>
            {t('log_work')}
          </Button>
          <Button size="small" type="primary" ghost icon={<PlusOutlined />} onClick={() => open('date')}>
            {t('add_date')}
          </Button>
        </div>
      }
      style={{ marginTop: 16 }}
    >
      {!data.schedules.length ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('no_dates')} />
      ) : (
        <div className="mini-list">
          {data.schedules.map((s) => {
            const state = dueState(s.due_date)
            return (
              <div key={s.id} className="op-row">
                <Tag color={DUE_COLOR[state]}>{t(state === 'ok' ? 'on_time' : state === 'soon' ? 'due_soon' : 'overdue')}</Tag>
                <span className="op-main">
                  <b>{s.title}</b>
                  <span className="mini-sub">
                    {dayjs(s.due_date).format('YYYY-MM-DD')} · {dayjs(s.due_date).fromNow()}
                    {s.interval_months ? ` · ${t('every_n_months', { n: s.interval_months })}` : ''}
                  </span>
                </span>
                <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => open('done', s)}>
                  {t('mark_done')}
                </Button>
                <Popconfirm title={`${t('delete')}?`} okText={t('delete')} cancelText={t('cancel')} onConfirm={() => remove(s)}>
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </div>
            )
          })}
        </div>
      )}

      {data.records.length > 0 && (
        <>
          <Typography.Title level={5} style={{ marginTop: 16 }}>
            {t('work_log')}
          </Typography.Title>
          <div className="mini-list">
            {data.records.map((r) => (
              <div key={r.id} className="op-row">
                <span className="mini-date">{dayjs(r.done_at).format('YYYY-MM-DD')}</span>
                <span className="op-main">
                  <b>{r.title}</b>
                  {(r.notes || r.cost || r.user) && (
                    <span className="mini-sub">
                      {[r.notes, r.cost && `${t('cost')}: ${Number(r.cost)}`, r.user?.name].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <Modal
        open={!!modal}
        title={modal?.kind === 'date' ? t('add_date') : modal?.kind === 'done' ? `${t('mark_done')}: ${modal.schedule.title}` : t('log_work')}
        okText={t('save')}
        cancelText={t('cancel')}
        onOk={save}
        onCancel={() => setModal(null)}
        confirmLoading={saving}
        forceRender
      >
        <Form form={form} layout="vertical">
          {modal?.kind !== 'done' && (
            <Form.Item name="title" label={t('title')} rules={[{ required: true, whitespace: true, message: t('title') }]}>
              <AutoComplete options={PRESETS.map((p) => ({ value: t(p) }))} filterOption />
            </Form.Item>
          )}
          {modal?.kind === 'date' ? (
            <>
              <Form.Item name="due_date" label={t('due_date')} rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="interval_months" label={t('repeat_months')} extra={t('no_repeat')}>
                <InputNumber min={1} max={240} style={{ width: '100%' }} placeholder="12" />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item name="done_at" label={t('done_at')} rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="cost" label={t('cost')}>
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </>
          )}
          <Form.Item name="notes" label={t('notes')}>
            <Input.TextArea autoSize={{ minRows: 2 }} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
