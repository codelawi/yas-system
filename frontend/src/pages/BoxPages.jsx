import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Button, Empty, Input, Layout, Result, Spin, Table, Typography } from 'antd'
import { AppstoreOutlined, CameraOutlined, CheckSquareOutlined, GlobalOutlined, InboxOutlined, LockOutlined, PlusOutlined, PrinterOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../api'
import { useLang } from '../i18n'
import { useAuth } from '../auth'
import BoxView, { BoxForm, formatWeight } from '../components/BoxView'
import { OfflineNoCopy, noOfflineCopy } from '../components/OfflineBanner'
import { usePhone } from '../nav'
import { Fab, PhoneHeader, PhoneList, PhoneRow, PhoneSearch, PhoneSkeleton, SelectionBar } from '../components/PhoneUI'

/** All boxes: search, add, print labels. */
export function BoxesPage() {
  const { t } = useLang()
  const { requirePin } = useAuth()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [boxes, setBoxes] = useState(null)
  const [selected, setSelected] = useState([])
  const [adding, setAdding] = useState(false)
  const phone = usePhone()
  const [selecting, setSelecting] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => api.get('/boxes', { params: { q } }).then(({ data }) => setBoxes(data)), 250)
    return () => clearTimeout(timer)
  }, [q])

  const add = async () => {
    if (await requirePin()) setAdding(true)
  }

  const printLabels = (ids) => window.open(`/boxes/labels?ids=${ids.join(',')}`, '_blank')

  const columns = [
    {
      title: t('box_number'),
      dataIndex: 'number',
      render: (number, box) => (
        <Link to={`/boxes/${box.id}`}>
          <InboxOutlined /> <strong>{number}</strong>
        </Link>
      ),
    },
    { title: t('box_name'), dataIndex: 'name' },
    { title: t('box_contents'), dataIndex: 'equipment_count', render: (n) => t('n_items', { n }) },
    { title: t('weight'), dataIndex: 'weight', render: (w) => formatWeight(w, t) },
    { title: t('updated_at'), dataIndex: 'updated_at', responsive: ['md'], render: (d) => dayjs(d).format('YYYY-MM-DD') },
  ]

  const form = <BoxForm open={adding} onClose={() => setAdding(false)} onSaved={(box) => navigate(`/boxes/${box.id}`)} />

  if (phone) {
    const toggle = (id) => setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
    return (
      <div className="page">
        <PhoneHeader
          title={t('boxes')}
          subtitle={boxes ? t('boxes_n', { n: boxes.length }) : '\u00a0'}
          more={[{ key: 'select', icon: <CheckSquareOutlined />, label: t('select_items'), onClick: () => setSelecting(true), hidden: selecting }]}
        />
        <PhoneSearch value={q} placeholder={t('search_boxes')} onChange={setQ} />
        {!boxes ? (
          <PhoneSkeleton rows={4} />
        ) : boxes.length ? (
          <PhoneList>
            {boxes.map((box) => (
              <PhoneRow
                key={box.id}
                to={`/boxes/${box.id}`}
                icon={<span className="phone-box-number">{box.number}</span>}
                tone="amber"
                title={box.name || `${t('box')} ${box.number}`}
                subtitle={
                  <>
                    <span>{t('n_items', { n: box.equipment_count })}</span>
                    {box.weight != null && <span>{formatWeight(box.weight, t)}</span>}
                  </>
                }
                selecting={selecting}
                selected={selected.includes(box.id)}
                onSelect={() => toggle(box.id)}
              />
            ))}
          </PhoneList>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('no_boxes')} />
        )}
        {selecting ? (
          <SelectionBar
            count={selected.length}
            onClose={() => {
              setSelecting(false)
              setSelected([])
            }}
            actions={[{ key: 'labels', icon: <PrinterOutlined />, label: t('print_label'), onClick: () => printLabels(selected) }]}
          />
        ) : (
          <Fab icon={<PlusOutlined />} label={t('add_box')} onClick={add} />
        )}
        {form}
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page-head">
        <Typography.Title level={3}>
          <InboxOutlined /> {t('boxes')}
        </Typography.Title>
        <div className="page-actions">
          {selected.length > 0 && (
            <Button icon={<PrinterOutlined />} onClick={() => printLabels(selected)}>
              {t('print_labels', { n: selected.length })}
            </Button>
          )}
          <Button type="primary" icon={<PlusOutlined />} onClick={add}>
            {t('add_box')}
          </Button>
        </div>
      </div>
      <Input.Search allowClear placeholder={t('search_boxes')} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 420, marginBottom: 16 }} />
      <Table
        rowKey="id"
        loading={!boxes}
        dataSource={boxes || []}
        columns={columns}
        pagination={{ pageSize: 50, hideOnSinglePage: true }}
        rowSelection={{ selectedRowKeys: selected, onChange: setSelected }}
        onRow={(box) => ({ onDoubleClick: () => navigate(`/boxes/${box.id}`) })}
        locale={{ emptyText: t('no_boxes') }}
        scroll={{ x: true }}
      />
      {form}
    </div>
  )
}

/** One box inside the dashboard. */
export function BoxDetail() {
  const { id } = useParams()
  const { t } = useLang()
  const navigate = useNavigate()
  const [box, setBox] = useState(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    setBox(null)
    setMissing(false)
    api
      .get(`/boxes/${id}`)
      .then(({ data }) => setBox(data))
      .catch(() => setMissing(true))
  }, [id])

  if (missing) return <Result status="404" title={t('box_not_found')} />
  if (!box) return <Spin size="large" className="page-spin" />

  return <BoxView box={box} onChange={setBox} onDeleted={() => navigate('/boxes')} />
}

/** Page opened by a phone after scanning the QR code on a box. */
export function ScanBoxPage() {
  const { number } = useParams()
  const { t, toggle } = useLang()
  const { user, logout } = useAuth()
  const [box, setBox] = useState(null)
  const [state, setState] = useState('loading')

  const load = useCallback(
    () =>
      api
        .get(`/boxes/number/${encodeURIComponent(number)}`)
        .then(({ data }) => {
          setBox(data)
          setState('ok')
        })
        .catch((e) => setState(noOfflineCopy(e) ? 'no_copy' : 'missing')),
    [number],
  )

  useEffect(() => {
    setState('loading')
    load()
  }, [load])

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header className="app-header scan-header">
        <Link to="/" className="brand-inline">
          <AppstoreOutlined /> {t('app_name')}
        </Link>
        <div style={{ flex: 1 }} />
        <Link to="/scan">
          <Button icon={<CameraOutlined />} />
        </Link>
        <Button type="text" icon={<GlobalOutlined />} onClick={toggle}>
          {t('language')}
        </Button>
        {user && <Button icon={<LockOutlined />} onClick={logout} />}
      </Layout.Header>
      <Layout.Content className="app-content">
        {state === 'loading' && <Spin size="large" className="page-spin" />}
        {state === 'no_copy' && <OfflineNoCopy />}
        {state === 'missing' && (
          <Result
            status="404"
            title={t('box_not_found')}
            subTitle={number}
            extra={
              <Link to="/">
                <Button>{t('open_dashboard')}</Button>
              </Link>
            }
          />
        )}
        {state === 'ok' && <BoxView box={box} onChange={setBox} onDeleted={() => setState('missing')} mobile />}
      </Layout.Content>
    </Layout>
  )
}
