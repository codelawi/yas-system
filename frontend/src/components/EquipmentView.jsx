import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, App, Button, Card, Col, Empty, Popconfirm, Row, Tag, Typography } from 'antd'
import { ApartmentOutlined, ClusterOutlined, DeleteOutlined, InboxOutlined, DownOutlined, EditOutlined, FilePdfOutlined, FileWordOutlined, PlusOutlined, PrinterOutlined, UpOutlined, WarningOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api, { equipmentUrl, errorKey } from '../api'
import { useLang } from '../i18n'
import { useAuth } from '../auth'
import { qrPointsToLocalhost, useSettings } from '../settings'
import QrCode from './QrCode'
import FieldList from './FieldList'
import HistoryTimeline from './HistoryTimeline'
import HistoryLocked from './HistoryLocked'
import EquipmentForm from './EquipmentForm'
import { useLargeDelete } from '../largeDelete'
import MaintenanceCard from './MaintenanceCard'
import CustodyCard from './CustodyCard'
import IssuesCard, { ReportProblemModal } from './IssuesCard'
import EquipmentPhoto from './EquipmentPhoto'
import { usePhone } from '../nav'
import { PhoneActions } from './PhoneUI'

/** Full equipment page, shared by the dashboard and the phone scan page. */
const HISTORY_OPEN_KEY = 'history_open'

/** Change history, collapsed by default (it gets long); the choice is remembered on this device. */
function HistoryCard({ logs }) {
  const { t } = useLang()
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(HISTORY_OPEN_KEY) === '1'
    } catch {
      return false
    }
  })
  const toggle = () => {
    setOpen(!open)
    try {
      localStorage.setItem(HISTORY_OPEN_KEY, open ? '0' : '1')
    } catch {
      /* not remembered */
    }
  }

  return (
    <Card
      title={`${t('history')} (${logs.length})`}
      extra={
        <Button size="small" type="text" icon={open ? <UpOutlined /> : <DownOutlined />} onClick={toggle}>
          {t(open ? 'collapse' : 'expand')}
        </Button>
      }
      styles={open ? undefined : { body: { display: 'none' } }}
    >
      <HistoryTimeline logs={logs} />
    </Card>
  )
}

export default function EquipmentView({ equipment, onChange, onDeleted, onReload, mobile: scanPage }) {
  const { t } = useLang()
  // Phones lay the page out the same way whether it was opened from a label or from the list
  const phone = usePhone()
  const mobile = scanPage || phone
  const { requirePin } = useAuth()
  const { settings } = useSettings()
  const { message } = App.useApp()
  const [editing, setEditing] = useState(false)
  const [addingAccessory, setAddingAccessory] = useState(false)
  const [reporting, setReporting] = useState(false)
  const [reportSignal, setReportSignal] = useState(0)
  const url = equipmentUrl(settings, equipment.serial_number)
  const accessories = equipment.accessories || []
  const isAccessory = !!equipment.parent
  // Phones stay on the scan pages, the dashboard uses its own pages
  const linkTo = (eq) => (scanPage ? `/eq/${encodeURIComponent(eq.serial_number)}` : `/equipment/${eq.id}`)

  const edit = async () => {
    if (await requirePin()) setEditing(true)
  }

  const addAccessory = async () => {
    if (await requirePin()) setAddingAccessory(true)
  }

  const deleteWithPin = useLargeDelete()
  const remove = async () => {
    if (!(await requirePin())) return
    try {
      // A main equipment with more than 4 accessories asks for the PIN again
      const res = await deleteWithPin((pin) => api.delete(`/equipment/${equipment.id}`, { data: pin ? { pin } : undefined }))
      if (!res) return
      message.success(t('deleted'))
      onDeleted()
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }

  const printLabels = (ids) => window.open(`/labels?ids=${ids.join(',')}`, '_blank')

  const actions = (
    <div className="page-actions">
      <Button type="primary" icon={<EditOutlined />} onClick={edit} size={mobile ? 'large' : 'middle'}>
        {t('edit')}
      </Button>
      {!mobile && equipment.serial_number && (
        <Button icon={<PrinterOutlined />} onClick={() => printLabels([equipment.id])}>
          {t('print_label')}
        </Button>
      )}
      {!mobile && (
        <Button icon={<FilePdfOutlined />} onClick={() => window.open(`/print/equipment/${equipment.id}`, '_blank')}>
          {t('equipment_sheet')}
        </Button>
      )}
      <Button icon={<WarningOutlined />} onClick={() => setReporting(true)} size={mobile ? 'large' : 'middle'}>
        {t('report_problem')}
      </Button>
      <Popconfirm
        title={accessories.length ? t('delete_confirm_accessories', { n: accessories.length }) : t('delete_confirm')}
        okText={t('delete')}
        cancelText={t('cancel')}
        okButtonProps={{ danger: true }}
        onConfirm={remove}
      >
        <Button danger icon={<DeleteOutlined />} size={mobile ? 'large' : 'middle'}>
          {t('delete')}
        </Button>
      </Popconfirm>
    </div>
  )

  // Phones: the main actions as tiles under the title, the rest behind "more"
  const accessoryLabels = accessories.filter((a) => a.serial_number).map((a) => a.id)
  const phoneActions = [
    { key: 'edit', icon: <EditOutlined />, label: t('edit'), primary: true, onClick: edit },
    { key: 'label', icon: <PrinterOutlined />, label: t('act_label'), onClick: () => printLabels([equipment.id]), hidden: !equipment.serial_number },
    { key: 'report', icon: <WarningOutlined />, label: t('act_report'), onClick: () => setReporting(true) },
    { key: 'sheet', icon: <FilePdfOutlined />, label: t('equipment_sheet'), onClick: () => window.open(`/print/equipment/${equipment.id}`, '_blank') },
    { key: 'labels', icon: <PrinterOutlined />, label: t('print_accessory_labels'), onClick: () => printLabels(accessoryLabels), hidden: !accessoryLabels.length },
    {
      key: 'delete',
      icon: <DeleteOutlined />,
      label: t('delete'),
      danger: true,
      onClick: remove,
      confirm: { title: accessories.length ? t('delete_confirm_accessories', { n: accessories.length }) : t('delete_confirm') },
    },
  ]

  // On phones the photo comes first, above the details
  const photo = <EquipmentPhoto equipment={equipment} onChanged={(photo_url) => onChange({ ...equipment, photo_url })} />

  const accessoriesCard = !isAccessory && (
    <Card
      title={
        <span>
          <ApartmentOutlined /> {t('accessories')} ({accessories.length})
        </span>
      }
      extra={
        <div className="page-actions">
          {!mobile && accessoryLabels.length > 0 && (
            <Button size="small" icon={<PrinterOutlined />} onClick={() => printLabels(accessoryLabels)}>
              {t('print_accessory_labels')}
            </Button>
          )}
          <Button size="small" type="primary" ghost icon={<PlusOutlined />} onClick={addAccessory}>
            {t('add_accessory')}
          </Button>
        </div>
      }
      style={{ marginTop: 16 }}
    >
      {accessories.length ? (
        <div className="accessory-list">
          {accessories.map((a) => {
            const quantity = a.fields.find((f) => f.key === 'عدد')?.value
            const details = a.fields.filter((f) => f.key !== 'عدد').slice(0, 2)
            return (
              <Link key={a.id} to={scanPage ? `/item/${a.id}` : `/equipment/${a.id}`} className="accessory-item">
                <span className="accessory-name">{a.name || t('accessory')}</span>
                {quantity && <span className="accessory-quantity">{`${t('accessory_quantity')} ${quantity}`}</span>}
                <span className="serial">{a.serial_number || '—'}</span>
                {details.length > 0 && (
                  <Typography.Text type="secondary" className="accessory-extra">
                    {details.map((f) => `${f.key}: ${f.value.split('\n')[0]}`).join(' · ')}
                  </Typography.Text>
                )}
              </Link>
            )
          })}
        </div>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('no_accessories')} />
      )}
    </Card>
  )

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <Typography.Text type="secondary">
            {isAccessory ? t('accessory') : t('serial_number')}
            {equipment.display_name && ` · ${equipment.display_name}`}
          </Typography.Text>
          <Typography.Title level={mobile ? 2 : 3} className="serial eq-title" style={{ margin: 0 }} copyable={!!equipment.serial_number}>
            {equipment.serial_number || equipment.display_name || t('accessory')}
          </Typography.Title>
          {equipment.row_no != null && <Tag title={t('row_no_long')}>{t('row_no')} {equipment.row_no}</Tag>}
          {equipment.category && <Tag color="blue">{equipment.category}</Tag>}
          {equipment.group &&
            (scanPage ? (
              <Tag color="cyan" icon={<ClusterOutlined />}>
                {equipment.group.name}
              </Tag>
            ) : (
              <Link to={`/groups/${equipment.group.id}`}>
                <Tag color="cyan" icon={<ClusterOutlined />} style={{ cursor: 'pointer' }}>
                  {equipment.group.name}
                </Tag>
              </Link>
            ))}
          {(equipment.boxes || []).map((b) => (
            <Link key={b.id} to={scanPage ? `/box/${encodeURIComponent(b.number)}` : `/boxes/${b.id}`}>
              <Tag color="purple" icon={<InboxOutlined />} style={{ cursor: 'pointer' }}>
                {t('box')} {b.number}
                {b.name && ` · ${b.name}`}
              </Tag>
            </Link>
          ))}
        </div>
        {!mobile && actions}
      </div>
      {phone && <PhoneActions actions={phoneActions} />}

      {isAccessory && (
        <Alert
          type="info"
          showIcon
          icon={<ApartmentOutlined />}
          style={{ marginBottom: 16 }}
          title={
            <span>
              {t('accessory_of')}:{' '}
              <Link to={linkTo(equipment.parent)}>
                {equipment.parent.display_name && `${equipment.parent.display_name} · `}
                <span className="serial">{equipment.parent.serial_number}</span>
              </Link>
            </span>
          }
        />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}>
          {mobile && photo}
          <Card title={t('details')}>
            <FieldList fields={equipment.fields} />
            <div className="meta">
              {t('created_at')}: {dayjs(equipment.created_at).format('YYYY-MM-DD HH:mm')}
              {equipment.created_by && ` · ${equipment.created_by}`}
              <br />
              {t('updated_at')}: {dayjs(equipment.updated_at).format('YYYY-MM-DD HH:mm')}
              {equipment.updated_by && ` · ${equipment.updated_by}`}
              {equipment.import && (
                <>
                  <br />
                  {t('source_file')}:{' '}
                  <a href={`/api/imports/${equipment.import.id}/download`}>
                    <FileWordOutlined /> {equipment.import.original_name}
                  </a>
                </>
              )}
            </div>
          </Card>
          {accessoriesCard}
          <CustodyCard equipment={equipment} mobile={mobile} onChanged={onReload} />
          <MaintenanceCard equipment={equipment} onChanged={onReload} />
          {mobile && !phone && <div style={{ marginTop: 16 }}>{actions}</div>}
        </Col>
        <Col xs={24} lg={8}>
          {!mobile && photo}
          {!mobile && equipment.serial_number && (
            <Card title={t('qr_code')} style={{ marginBottom: 16 }}>
              {qrPointsToLocalhost(settings) && <Alert type="warning" showIcon title={t('localhost_warning')} style={{ marginBottom: 12 }} />}
              <div className="qr-box">
                <QrCode value={url} size={180} />
                <Typography.Text type="secondary" copyable className="qr-url">
                  {url}
                </Typography.Text>
              </div>
            </Card>
          )}
          <IssuesCard equipment={equipment} reportSignal={reportSignal} onChanged={onReload} />
          {equipment.logs ? (
            <HistoryCard logs={equipment.logs} />
          ) : (
            <HistoryLocked />
          )}
        </Col>
      </Row>

      <ReportProblemModal
        equipment={equipment}
        open={reporting}
        onClose={() => setReporting(false)}
        onSent={() => {
          setReporting(false)
          setReportSignal((n) => n + 1)
          onReload()
        }}
      />
      <EquipmentForm
        open={editing}
        equipment={equipment}
        onClose={() => setEditing(false)}
        onSaved={(eq) => {
          setEditing(false)
          onChange(eq)
        }}
      />
      <EquipmentForm
        open={addingAccessory}
        parent={equipment}
        onClose={() => setAddingAccessory(false)}
        onSaved={() => {
          setAddingAccessory(false)
          onReload()
        }}
      />
    </div>
  )
}
