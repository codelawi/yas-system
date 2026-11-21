import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { App, Button, Input, Modal, Result, Select, Table, Tag, Typography } from 'antd'
import { FileTextOutlined, ImportOutlined, UnlockOutlined, UserSwitchOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'
import { useAuth } from '../auth'
import CustodyPrintButton from '../components/CustodyPrintButton'
import { usePhone } from '../nav'
import { Chevron, PhoneHeader, PhoneList, PhoneSkeleton } from '../components/PhoneUI'

/** Who holds what right now (custody). Only with a PIN. */
export default function CustodyPage() {
  const { t } = useLang()
  const { user, isAdmin, requirePin } = useAuth()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [holder, setHolder] = useState()
  const [data, setData] = useState({ open: [], holders: [] })
  const [loading, setLoading] = useState(false)
  const [receiving, setReceiving] = useState(null)
  const [notes, setNotes] = useState('')
  const phone = usePhone()

  const load = useCallback(() => {
    setLoading(true)
    return api
      .get('/custody', { params: { holder } })
      .then(({ data }) => setData(data))
      .finally(() => setLoading(false))
  }, [holder])

  useEffect(() => {
    if (user) load()
  }, [user, load])

  if (!user) {
    return (
      <div className="page">
        <Result
          icon={<UserSwitchOutlined />}
          title={t('custody_locked')}
          extra={
            <Button type="primary" size="large" icon={<UnlockOutlined />} onClick={requirePin}>
              {t('unlock')}
            </Button>
          }
        />
      </div>
    )
  }

  const receive = async () => {
    try {
      const { data } = await api.post(`/equipment/${receiving.equipment.id}/custody/return`, { return_notes: notes, include_accessories: false })
      message.success(t('received_n', { n: data.received }))
      setReceiving(null)
      load()
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }

  const startReceive = (r) => {
    setNotes('')
    setReceiving(r)
  }
  const overdue = (r) => r.due_back_at && dayjs(r.due_back_at).isBefore(dayjs(), 'day')
  const receiveModal = (
    <Modal open={!!receiving} title={`${t('take_back')} · ${receiving?.equipment.serial_number || receiving?.equipment.display_name || ''}`} okText={t('save')} cancelText={t('cancel')} onOk={receive} onCancel={() => setReceiving(null)}>
      <Typography.Paragraph>{receiving && t('in_custody_with', { name: receiving.holder })}</Typography.Paragraph>
      <Input.TextArea autoSize={{ minRows: 2 }} placeholder={t('return_notes')} value={notes} onChange={(e) => setNotes(e.target.value)} />
    </Modal>
  )

  // Phones: one card per custody, the equipment opens from it, "take back" under it
  if (phone)
    return (
      <div className="page">
        <PhoneHeader
          title={t('custodies')}
          subtitle={t('custody_n', { n: data.open.length })}
          more={isAdmin ? [{ key: 'forms', icon: <FileTextOutlined />, label: t('custody_forms'), onClick: () => navigate('/custody/forms') }] : undefined}
        />
        {data.holders.length > 0 && (
          <Select allowClear className="phone-select" value={holder} onChange={setHolder} placeholder={t('all_holders')} options={data.holders.map((h) => ({ value: h, label: h }))} />
        )}
        {loading && !data.open.length ? (
          <PhoneSkeleton rows={3} />
        ) : data.open.length ? (
          <PhoneList className={loading ? 'is-busy' : ''}>
            {data.open.map((r) => (
              <div key={r.id} className="phone-custody">
                <Link to={`/equipment/${r.equipment.id}`} className="phone-row">
                  <span className={`phone-row-icon tone-${overdue(r) ? 'red' : 'violet'}`}>
                    <UserSwitchOutlined />
                  </span>
                  <span className="phone-row-body">
                    <span className="phone-row-title">{r.holder}</span>
                    <span className="phone-row-sub">
                      <span className="serial">{r.equipment.serial_number || '—'}</span>
                      {r.equipment.display_name && <span>{r.equipment.display_name}</span>}
                    </span>
                    <span className="phone-row-meta">
                      <span>{`${t('since')} ${dayjs(r.handed_at).format('YYYY-MM-DD')}`}</span>
                      {r.due_back_at && <Tag color={overdue(r) ? 'red' : 'default'}>{`${t('due_back')} ${dayjs(r.due_back_at).format('YYYY-MM-DD')}`}</Tag>}
                    </span>
                  </span>
                  <Chevron />
                </Link>
                <div className="phone-custody-actions">
                  {r.holder_phone && (
                    <a className="ant-btn ant-btn-default ant-btn-sm phone-call" href={`tel:${r.holder_phone}`} dir="ltr">
                      {r.holder_phone}
                    </a>
                  )}
                  <CustodyPrintButton custodyId={r.id} size="small" label={false} />
                  <Button size="small" type="primary" ghost icon={<ImportOutlined />} onClick={() => startReceive(r)}>
                    {t('take_back')}
                  </Button>
                </div>
              </div>
            ))}
          </PhoneList>
        ) : (
          <div className="phone-empty">
            <UserSwitchOutlined className="phone-empty-icon" />
            <b>{t('no_custody')}</b>
          </div>
        )}
        {receiveModal}
      </div>
    )

  return (
    <div className="page">
      <div className="page-head">
        <Typography.Title level={3}>
          <UserSwitchOutlined /> {t('custodies')} ({data.open.length})
        </Typography.Title>
        <div className="page-actions">
          <Select allowClear value={holder} onChange={setHolder} placeholder={t('all_holders')} options={data.holders.map((h) => ({ value: h, label: h }))} style={{ minWidth: 200 }} />
          {isAdmin && (
            <Link to="/custody/forms">
              <Button icon={<FileTextOutlined />}>{t('custody_forms')}</Button>
            </Link>
          )}
        </div>
      </div>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={data.open}
        scroll={{ x: 'max-content' }}
        pagination={{ pageSize: 50, hideOnSinglePage: true }}
        locale={{ emptyText: t('no_custody') }}
        rowClassName={(r) => (overdue(r) ? 'row-overdue' : '')}
        columns={[
          {
            title: t('serial_number'),
            key: 'eq',
            render: (_, r) => (
              <div>
                <Link to={`/equipment/${r.equipment.id}`} className="serial">
                  {r.equipment.serial_number || '—'}
                </Link>
                {r.equipment.display_name && <div className="list-name">{r.equipment.display_name}</div>}
                {r.equipment.parent && <div className="list-name">↳ {r.equipment.parent.serial_number}</div>}
              </div>
            ),
          },
          {
            title: t('holder'),
            key: 'holder',
            render: (_, r) => (
              <div>
                <b>{r.holder}</b>
                {r.holder_phone && (
                  <div className="list-name" dir="ltr">
                    {r.holder_phone}
                  </div>
                )}
              </div>
            ),
          },
          { title: t('since'), dataIndex: 'handed_at', render: (v) => dayjs(v).format('YYYY-MM-DD') },
          {
            title: t('due_back'),
            dataIndex: 'due_back_at',
            render: (v) =>
              v ? (
                <span>
                  {dayjs(v).format('YYYY-MM-DD')} {dayjs(v).isBefore(dayjs(), 'day') && <Tag color="red">{t('overdue')}</Tag>}
                </span>
              ) : (
                '—'
              ),
          },
          { title: t('by'), dataIndex: ['handed_by', 'name'], render: (v) => v || '—', responsive: ['lg'] },
          {
            key: 'actions',
            align: 'end',
            render: (_, r) => (
              <div className="page-actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                <CustodyPrintButton custodyId={r.id} size="small" label={false} />
                <Button size="small" icon={<ImportOutlined />} onClick={() => startReceive(r)}>
                  {t('take_back')}
                </Button>
              </div>
            ),
          },
        ]}
      />
      {receiveModal}
    </div>
  )
}
