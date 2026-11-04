import { useCallback, useEffect, useState } from 'react'
import { App, Button, Card, Form, Image, Input, Modal, Tag, Typography } from 'antd'
import { CameraOutlined, CheckOutlined, WarningOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'
import { useAuth } from '../auth'

/** Problem reports of one equipment. Anyone can report; closing needs a PIN. */
export default function IssuesCard({ equipment, reportSignal, onChanged }) {
  const { t } = useLang()
  const { requirePin } = useAuth()
  const { message } = App.useApp()
  const [issues, setIssues] = useState([])
  const [closing, setClosing] = useState(null)
  const [resolution, setResolution] = useState('')

  const load = useCallback(() => api.get(`/equipment/${equipment.id}/issues`).then(({ data }) => setIssues(data)), [equipment.id])
  useEffect(() => {
    load()
  }, [load, reportSignal])

  const close = async () => {
    try {
      await api.post(`/issues/${closing.id}/close`, { resolution })
      setClosing(null)
      load()
      onChanged?.()
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }

  const open = issues.filter((i) => i.status === 'open')
  if (!issues.length) return null

  return (
    <Card
      title={
        <span>
          <WarningOutlined /> {t('issues')} {open.length > 0 && <Tag color="volcano">{open.length}</Tag>}
        </span>
      }
      style={{ marginBottom: 16 }}
    >
      <div className="mini-list">
        {issues.map((i) => (
          <div key={i.id} className={`issue-row${i.status === 'open' ? ' open' : ''}`}>
            {i.has_photo && <Image src={`/api/issues/${i.id}/photo`} width={56} height={56} className="issue-photo" />}
            <div className="op-main">
              <span>{i.description}</span>
              <span className="mini-sub">
                {[i.reporter, dayjs(i.created_at).format('YYYY-MM-DD HH:mm')].filter(Boolean).join(' · ')}
              </span>
              {i.status === 'closed' && (
                <span className="mini-sub">
                  <Tag color="green">{t('closed')}</Tag>
                  {[i.resolution, i.closed_by?.name].filter(Boolean).join(' · ')}
                </span>
              )}
            </div>
            {i.status === 'open' && (
              <Button
                size="small"
                icon={<CheckOutlined />}
                onClick={async () => {
                  if (!(await requirePin())) return
                  setResolution('')
                  setClosing(i)
                }}
              >
                {t('close_issue')}
              </Button>
            )}
          </div>
        ))}
      </div>
      <Modal open={!!closing} title={t('close_issue')} okText={t('save')} cancelText={t('cancel')} onOk={close} onCancel={() => setClosing(null)}>
        <Typography.Paragraph type="secondary">{closing?.description}</Typography.Paragraph>
        <Input.TextArea autoSize={{ minRows: 2 }} placeholder={t('resolution')} value={resolution} onChange={(e) => setResolution(e.target.value)} autoFocus />
      </Modal>
    </Card>
  )
}

/** "Report a problem" form - no PIN needed (anyone who scanned the label). */
export function ReportProblemModal({ equipment, open, onClose, onSent }) {
  const { t } = useLang()
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [photo, setPhoto] = useState(null)
  const [sending, setSending] = useState(false)

  const send = async () => {
    const v = await form.validateFields()
    setSending(true)
    try {
      const body = new FormData()
      body.append('description', v.description)
      if (v.reporter) body.append('reporter', v.reporter)
      if (photo) body.append('photo', photo)
      await api.post(`/equipment/${equipment.id}/issues`, body)
      message.success(t('report_sent'))
      form.resetFields()
      setPhoto(null)
      onSent()
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setSending(false)
    }
  }

  return (
    <Modal open={open} title={`${t('report_problem')} · ${equipment.serial_number}`} okText={t('confirm')} cancelText={t('cancel')} onOk={send} onCancel={onClose} confirmLoading={sending} forceRender>
      <Form form={form} layout="vertical">
        <Form.Item name="description" label={t('problem_desc')} rules={[{ required: true, whitespace: true, message: t('problem_desc') }]}>
          <Input.TextArea autoSize={{ minRows: 3 }} />
        </Form.Item>
        <Form.Item name="reporter" label={t('your_name')}>
          <Input />
        </Form.Item>
        <label className="photo-pick">
          <CameraOutlined /> {photo ? photo.name : t('add_photo')}
          <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => setPhoto(e.target.files?.[0] || null)} />
        </label>
      </Form>
    </Modal>
  )
}
