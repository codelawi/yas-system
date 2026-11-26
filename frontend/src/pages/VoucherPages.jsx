import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Alert, App, AutoComplete, Button, Card, Checkbox, Col, Empty, Input, InputNumber, Modal, Popconfirm, Progress, Result, Row, Segmented, Spin, Table, Tag, Typography } from 'antd'
import { ApartmentOutlined, CheckOutlined, DeleteOutlined, FileDoneOutlined, ImportOutlined, NumberOutlined, PlusOutlined, ScanOutlined, UnlockOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'
import { useAuth } from '../auth'
import { beep } from '../download'
import CodeScanner from '../components/CodeScanner'
import { usePhone } from '../nav'
import { ChipRow, Fab, PhoneActions, PhoneHeader, PhoneList, PhoneRow, PhoneSearch, PhoneSkeleton } from '../components/PhoneUI'
import useRevisionPoll from '../revisionPoll'

/*
 * Issue vouchers (سند صرف عهدة): scan what someone takes from the store, issue the voucher to hand
 * it all over as custody, and take it back by scanning again (in the voucher, or from the return
 * screen, which finds the voucher by itself). A draft is kept on the server, so a phone and the
 * computer can fill the same voucher; each screen follows the other's scans.
 */

const STATUS_COLOR = { draft: 'gold', issued: 'blue', returned: 'green' }
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩'
/** The voucher's numbers are written as on the paper: ١٢٣ */
const arabicDigits = (value) => String(value ?? '').replace(/[0-9]/g, (d) => AR_DIGITS[d])
const formatTime = (value) => (value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '—')

function NeedPin() {
  const { t } = useLang()
  const { requirePin } = useAuth()
  return (
    <div className="page">
      <Result
        icon={<FileDoneOutlined />}
        title={t('vouchers_locked')}
        extra={
          <Button type="primary" size="large" icon={<UnlockOutlined />} onClick={requirePin}>
            {t('unlock')}
          </Button>
        }
      />
    </div>
  )
}

const voucherTitle = (voucher, t) => (voucher.number ? t('voucher_title_n', { n: voucher.number }) : t('voucher_title_draft'))

function StatusTag({ voucher }) {
  const { t } = useLang()
  return <Tag color={STATUS_COLOR[voucher.status]}>{t(`voucher_status_${voucher.status}`)}</Tag>
}

/** "With Ahmad (voucher 12)": who holds a unit now. */
const heldText = (held, t) => (held.voucher_number ? t('voucher_held_in', { name: held.holder, n: held.voucher_number }) : t('voucher_held_by', { name: held.holder }))

/* ---------- The list */

export function VouchersPage() {
  const { t } = useLang()
  const { user } = useAuth()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const phone = usePhone()
  const [data, setData] = useState(null)
  const [status, setStatus] = useState('')
  const [text, setText] = useState('')
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [numbering, setNumbering] = useState(null)

  const load = useCallback(() => api.get('/vouchers', { params: { status: status || undefined, q: search || undefined } }).then(({ data }) => setData(data)), [status, search])
  useEffect(() => {
    if (user) load()
  }, [user, load])

  if (!user) return <NeedPin />

  const create = async () => {
    setCreating(true)
    try {
      const { data } = await api.post('/vouchers')
      navigate(`/vouchers/${data.voucher.id}`)
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
      setCreating(false)
    }
  }

  const saveNumber = async () => {
    try {
      const { data: saved } = await api.put('/vouchers/next-number', { number: numbering })
      setData((d) => ({ ...d, next_number: saved.next_number }))
      setNumbering(null)
      message.success(t('saved'))
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }

  const counts = data?.counts || {}
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const filter = (
    <Segmented
      className="voucher-filter"
      value={status}
      onChange={setStatus}
      options={[
        { value: '', label: `${t('voucher_filter_all')} (${total})` },
        ...['draft', 'issued', 'returned'].map((s) => ({ value: s, label: `${t(`voucher_status_${s}`)} (${counts[s] || 0})` })),
      ]}
    />
  )
  const numberModal = (
    <Modal open={numbering !== null} title={t('voucher_next_number')} okText={t('save')} cancelText={t('cancel')} onOk={saveNumber} onCancel={() => setNumbering(null)} destroyOnHidden>
      <Typography.Paragraph type="secondary">{t('voucher_next_number_hint')}</Typography.Paragraph>
      <InputNumber min={1} max={99999999} precision={0} size="large" value={numbering} onChange={setNumbering} style={{ width: '100%' }} autoFocus onPressEnter={saveNumber} />
    </Modal>
  )
  const progress = (v) => (v.status === 'issued' && v.held_count < v.items_count ? t('voucher_missing_n', { n: v.held_count }) : null)
  const goReturn = () => navigate('/vouchers/return')
  const askNumber = () => setNumbering(data?.next_number ?? 1)

  if (phone)
    return (
      <div className="page">
        <PhoneHeader
          title={t('vouchers')}
          subtitle={data ? t('vouchers_n', { n: total }) : ' '}
          more={[{ key: 'number', icon: <NumberOutlined />, label: `${t('voucher_next_number')}: ${data?.next_number ?? '…'}`, onClick: askNumber }]}
        />
        <PhoneActions actions={[{ key: 'return', icon: <ImportOutlined />, label: t('voucher_return_title'), onClick: goReturn }]} />
        <PhoneSearch value={text} onChange={setText} onSearch={setSearch} placeholder={t('voucher_search')} />
        <ChipRow>{filter}</ChipRow>
        {!data ? (
          <PhoneSkeleton rows={4} />
        ) : data.vouchers.length ? (
          <PhoneList>
            {data.vouchers.map((v) => (
              <PhoneRow
                key={v.id}
                to={`/vouchers/${v.id}`}
                icon={<FileDoneOutlined />}
                tone={v.status === 'draft' ? 'amber' : v.status === 'issued' ? 'blue' : 'green'}
                title={v.recipient || voucherTitle(v, t)}
                subtitle={
                  <>
                    {v.recipient && <span>{voucherTitle(v, t)}</span>}
                    <span>{t('voucher_items_n', { n: v.items_count })}</span>
                  </>
                }
                meta={
                  <>
                    <span>{formatTime(v.issued_at || v.created_at)}</span>
                    {progress(v) && <span>{progress(v)}</span>}
                  </>
                }
                end={<StatusTag voucher={v} />}
              />
            ))}
          </PhoneList>
        ) : (
          <div className="phone-empty">
            <FileDoneOutlined className="phone-empty-icon" />
            <b>{t('no_vouchers')}</b>
          </div>
        )}
        <Fab icon={<PlusOutlined />} label={t('voucher_new')} onClick={create} loading={creating} />
        {numberModal}
      </div>
    )

  return (
    <div className="page">
      <div className="page-head">
        <Typography.Title level={3}>
          <FileDoneOutlined /> {t('vouchers')}
        </Typography.Title>
        <div className="page-actions">
          <Button icon={<NumberOutlined />} onClick={askNumber}>
            {`${t('voucher_next_number')}: ${data?.next_number ?? '…'}`}
          </Button>
          <Button icon={<ImportOutlined />} onClick={goReturn}>
            {t('voucher_return_title')}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={create} loading={creating}>
            {t('voucher_new')}
          </Button>
        </div>
      </div>
      <div className="voucher-toolbar">
        {filter}
        <Input.Search allowClear value={text} onChange={(e) => setText(e.target.value)} onSearch={(v) => setSearch(v.trim())} placeholder={t('voucher_search')} style={{ maxWidth: 320 }} />
      </div>
      <Table
        rowKey="id"
        loading={!data}
        dataSource={data?.vouchers || []}
        pagination={{ pageSize: 50, hideOnSinglePage: true }}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('no_vouchers') }}
        onRow={(v) => ({ onClick: () => navigate(`/vouchers/${v.id}`), style: { cursor: 'pointer' } })}
        columns={[
          { title: t('voucher_number'), key: 'number', render: (_, v) => (v.number ? <Link to={`/vouchers/${v.id}`}><b>{v.number}</b></Link> : <Link to={`/vouchers/${v.id}`}>{t('voucher_status_draft')}</Link>) },
          { title: t('voucher_recipient'), dataIndex: 'recipient', render: (r) => r || '—' },
          { title: t('voucher_units'), dataIndex: 'items_count', align: 'center' },
          {
            title: t('voucher_state'),
            key: 'status',
            render: (_, v) => (
              <span>
                <StatusTag voucher={v} />
                {progress(v) && <Typography.Text type="secondary">{progress(v)}</Typography.Text>}
              </span>
            ),
          },
          { title: t('voucher_date'), key: 'date', render: (_, v) => formatTime(v.issued_at || v.created_at) },
          { title: t('by'), key: 'by', render: (_, v) => v.issuer?.name || v.creator?.name || '—', responsive: ['lg'] },
        ]}
      />
      {numberModal}
    </div>
  )
}

/* ---------- One voucher */

/** The voucher as it will be printed: one line per kind of equipment. */
function VoucherSheet({ voucher, rows }) {
  const { t } = useLang()
  const date = voucher.issued_at ? dayjs(voucher.issued_at) : dayjs()
  return (
    <div className="voucher-sheet" dir="rtl" lang="ar">
      <div className="voucher-sheet-head">
        <div>
          <div className="voucher-sheet-kind">سند صرف فرعي</div>
          <div>
            الى / <b>{voucher.recipient || '…'}</b>
          </div>
          <div className="voucher-sheet-muted">بواسطة الموقعين ادناه</div>
        </div>
        <div className="voucher-sheet-meta">
          <div>
            رقم السند: <b>{voucher.number ? arabicDigits(voucher.number) : '—'}</b>
          </div>
          <div>التاريخ: {arabicDigits(date.format('D / M / YYYY'))} م</div>
        </div>
      </div>
      <table className="voucher-sheet-table">
        <thead>
          <tr>
            <th rowSpan={2}>الحرف والرقم</th>
            <th rowSpan={2}>النوع</th>
            <th colSpan={2}>الكمية</th>
          </tr>
          <tr>
            <th>رقماً</th>
            <th>كتابةً</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((r) => (
              <tr key={r.key}>
                <td className="voucher-sheet-code">
                  {r.code ||
                    (!r.accessory && (
                      <Link to="/groups/codes" className="voucher-no-code" title={t('voucher_no_code_hint')}>
                        {t('voucher_no_code')}
                      </Link>
                    ))}
                </td>
                <td>{r.name}</td>
                <td className="voucher-sheet-qty">{arabicDigits(r.quantity)}</td>
                <td>{r.quantity_words}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={4} className="voucher-sheet-empty">
                {t('voucher_empty_hint')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

/** Choose the accessories of a main equipment to add. */
function AccessoryPicker({ item, inVoucher, onAdd, onClose }) {
  const { t } = useLang()
  const [picked, setPicked] = useState([])
  const [busy, setBusy] = useState(false)
  const free = (item?.accessories || []).filter((a) => !inVoucher.has(a.id))
  const add = async () => {
    setBusy(true)
    try {
      await onAdd(picked)
      onClose()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={!!item}
      title={`${t('accessories')} · ${item?.equipment.display_name || ''}`}
      okText={t('voucher_add_picked', { n: picked.length })}
      okButtonProps={{ disabled: !picked.length, loading: busy }}
      cancelText={t('cancel')}
      onOk={add}
      onCancel={onClose}
      destroyOnHidden
    >
      {free.length > 1 && (
        <Checkbox checked={picked.length === free.length} indeterminate={picked.length > 0 && picked.length < free.length} onChange={(e) => setPicked(e.target.checked ? free.map((a) => a.id) : [])} style={{ marginBottom: 8 }}>
          {t('voucher_select_all')}
        </Checkbox>
      )}
      <div className="voucher-accessories">
        {(item?.accessories || []).map((a) => {
          const already = inVoucher.has(a.id)
          return (
            <Checkbox
              key={a.id}
              disabled={already}
              checked={already || picked.includes(a.id)}
              onChange={(e) => setPicked((p) => (e.target.checked ? [...p, a.id] : p.filter((x) => x !== a.id)))}
            >
              <span>{a.display_name}</span> <span className="serial">{a.serial_number}</span>
              {already && <Tag style={{ marginInlineStart: 6 }}>{t('voucher_already')}</Tag>}
            </Checkbox>
          )
        })}
      </div>
    </Modal>
  )
}

export function VoucherPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { t } = useLang()
  const { user } = useAuth()
  const { message, modal } = App.useApp()
  const phone = usePhone()
  const [report, setReport] = useState(null)
  const [missing, setMissing] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [issuing, setIssuing] = useState(false)
  const [last, setLast] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [mode, setMode] = useState(null)
  const [recipient, setRecipient] = useState('')
  const [recipients, setRecipients] = useState([])
  const [picking, setPicking] = useState(null)
  const revision = useRef(null)
  const typingRecipient = useRef(false)
  const recipientBox = useRef(null)
  const input = useRef(null)
  // Equipment someone else holds, scanned while the camera was open: asked about once it closes
  const pendingMoves = useRef([])

  const show = useCallback((data) => {
    revision.current = data.voucher.revision
    setReport({ voucher: data.voucher, items: data.items, rows: data.rows })
    if (!typingRecipient.current) setRecipient(data.voucher.recipient || '')
  }, [])
  const load = useCallback(
    () =>
      api
        .get(`/vouchers/${id}`)
        .then(({ data }) => show(data))
        .catch((e) => e.response?.status === 404 && setMissing(true)),
    [id, show],
  )
  useEffect(() => {
    if (user) load()
  }, [user, load])
  useEffect(() => {
    if (user)
      api
        .get('/vouchers/recipients')
        .then(({ data }) => setRecipients(data))
        .catch(() => {})
  }, [user])
  useRevisionPoll(user && !missing ? `/vouchers/${id}/revision` : null, revision, load)

  if (!user) return <NeedPin />
  if (missing) return <Result status="404" title={t('voucher_not_found')} extra={<Button onClick={() => navigate('/vouchers')}>{t('vouchers')}</Button>} />
  if (!report) return <Spin size="large" className="page-spin" />

  const { voucher, items, rows } = report
  const isDraft = voucher.status === 'draft'
  const current = isDraft ? 'add' : mode || 'return'
  const inVoucher = new Set(items.map((i) => i.equipment.id))
  const out = items.filter((i) => !i.returned_at).length
  const moved = items.filter((i) => i.moved_to).length
  const own = items.length - moved
  const heldItems = items.filter((i) => i.held_by)

  const unit = (e) => (e ? { serial: e.serial_number, name: e.display_name } : {})

  /** Asks before taking equipment from whoever holds it now; `retry` adds it again with move. */
  const askMove = (held, retry) =>
    modal.confirm({
      title: t('voucher_move_title'),
      content: (
        <div className="voucher-move-list">
          {held.map((h) => (
            <div key={h.id}>
              <b className="serial">{h.serial_number}</b> {h.display_name} — {heldText(h, t)}
            </div>
          ))}
          <p>{t('voucher_move_body')}</p>
        </div>
      ),
      okText: t('voucher_move'),
      cancelText: t('cancel'),
      onOk: retry,
    })

  const addCode = async (value, move) => {
    const { data } = await api.post(`/vouchers/${id}/items`, { code: value, move })
    show(data)
    return data
  }

  /** One scanned or typed code: added to the voucher, or taken back in return mode. Returns what to show. */
  const handle = async (value, fromCamera) => {
    if (current === 'return') {
      const { data } = await api.post(`/vouchers/${id}/return`, { code: value })
      show(data)
      const type = { returned: 'success', already: 'info', not_in_voucher: 'warning' }[data.status]
      const text = data.status === 'not_in_voucher' ? `${t('voucher_not_in')}${data.holder ? ` — ${heldText(data.holder, t)}` : ''}` : t(data.status === 'returned' ? 'voucher_returned' : 'voucher_already_returned')
      return { type, text, ...unit(data.equipment) }
    }

    // A draft takes anything (it is moved only when issued); an issued voucher asks first
    const data = await addCode(value, isDraft)
    const equipment = data.equipment?.[0]
    if (data.status === 'held') {
      const retry = () =>
        addCode(value, true).then(() => {
          beep(true)
          setLast({ type: 'success', text: t('voucher_moved'), ...unit(data.held[0]) })
        })
      if (fromCamera) pendingMoves.current.push({ held: data.held, retry })
      else askMove(data.held, retry)
      return { type: 'warning', text: `${heldText(data.held[0], t)}${fromCamera ? ` — ${t('voucher_ask_after_camera')}` : ''}`, ...unit(data.held[0]) }
    }
    if (data.status === 'already') return { type: 'info', text: t('voucher_already'), ...unit(equipment) }
    const added = data.items.find((i) => i.equipment.id === equipment?.id)
    if (added?.held_by) return { type: 'warning', text: `${t('voucher_added')} — ${heldText(added.held_by, t)}، ${t('voucher_move_later')}`, ...unit(equipment) }
    return { type: 'success', text: t('voucher_added'), ...unit(equipment) }
  }

  const submit = async (text) => {
    const value = (text ?? code).trim()
    if (!value || busy) return
    setBusy(true)
    try {
      const result = await handle(value, false)
      setLast(result)
      beep(result.type === 'success')
      setCode('')
    } catch (e) {
      beep(false)
      setLast({ type: 'error', text: t(errorKey(e) || 'error'), serial: value })
    } finally {
      setBusy(false)
      if (!phone) input.current?.focus()
    }
  }

  const onCameraCode = async (text) => {
    try {
      const result = await handle(text, true)
      setLast(result)
      beep(result.type === 'success')
      return { type: result.type === 'success' ? 'success' : result.type === 'info' ? 'warning' : result.type, text: [result.serial, result.name, result.text].filter(Boolean).join('\n') }
    } catch (e) {
      beep(false)
      return { type: 'error', text: t(errorKey(e) || 'error') }
    }
  }

  const closeCamera = () => {
    setScanning(false)
    const pending = pendingMoves.current
    pendingMoves.current = []
    if (pending.length)
      askMove(
        pending.flatMap((p) => p.held),
        async () => {
          for (const p of pending) await p.retry().catch(() => {})
        },
      )
  }

  const saveRecipient = async (value = recipient) => {
    typingRecipient.current = false
    const name = value.trim()
    if (name === (voucher.recipient || '')) return
    try {
      const { data } = await api.put(`/vouchers/${id}`, { recipient: name })
      show(data)
      if (!isDraft) message.success(t('saved'))
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
      setRecipient(voucher.recipient || '')
    }
  }

  const issue = async (move = false) => {
    setIssuing(true)
    try {
      const { data } = await api.post(`/vouchers/${id}/issue`, { recipient: recipient.trim(), move })
      show(data)
      if (data.status === 'held') {
        askMove(data.held, () => issue(true))
        return
      }
      beep(true)
      setMode('add')
      setLast(null)
      message.success(t('voucher_issued_n', { n: data.voucher.number }))
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setIssuing(false)
    }
  }

  const askIssue = () => {
    const name = recipient.trim()
    if (!name) {
      message.error(t('voucher_no_recipient'))
      recipientBox.current?.focus()
      return
    }
    if (!items.length) {
      message.error(t('voucher_empty'))
      return
    }
    modal.confirm({
      title: t('voucher_issue'),
      content: t('voucher_issue_confirm', { name, n: items.length }),
      okText: t('voucher_issue'),
      cancelText: t('cancel'),
      onOk: () => issue(),
    })
  }

  const addIds = async (ids, move = isDraft) => {
    try {
      const { data } = await api.post(`/vouchers/${id}/items`, { equipment_ids: ids, move })
      show(data)
      if (data.status === 'held') askMove(data.held, () => addIds(ids, true))
      else beep(true)
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }

  const removeItem = async (item) => {
    try {
      const { data } = await api.delete(`/vouchers/${id}/items/${item.id}`)
      show(data)
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }

  const removeDraft = async () => {
    try {
      await api.delete(`/vouchers/${id}`)
      message.success(t('deleted'))
      navigate('/vouchers')
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }

  /** Asks for the PIN again before `run(pin)`; a wrong PIN keeps the dialog open. */
  const askPin = ({ title, body, okText, run }) => {
    let pin = ''
    const dialog = modal.confirm({
      title,
      okText,
      okButtonProps: { danger: true, disabled: true },
      cancelText: t('cancel'),
      content: (
        <div>
          <Typography.Paragraph>{body}</Typography.Paragraph>
          <Input.Password
            autoFocus
            inputMode="numeric"
            maxLength={8}
            placeholder={t('pin')}
            onChange={(e) => {
              pin = e.target.value.replace(/\D/g, '')
              dialog.update({ okButtonProps: { danger: true, disabled: !pin } })
            }}
            style={{ letterSpacing: 4 }}
          />
        </div>
      ),
      onOk: async () => {
        try {
          await run(pin)
        } catch (e) {
          message.error(t(errorKey(e) || 'error'))
          throw e
        }
      },
    })
  }

  const returnAll = () =>
    askPin({
      title: t('voucher_return_all'),
      body: t('voucher_return_all_body', { n: out, name: voucher.recipient }),
      okText: t('voucher_return_all'),
      run: async (pin) => {
        const { data } = await api.post(`/vouchers/${id}/return-all`, { pin })
        show(data)
        setLast(null)
        beep(true)
        message.success(t('voucher_returned_all_n', { n: data.returned }))
      },
    })

  const removeReturned = () =>
    askPin({
      title: t('voucher_delete'),
      body: t('voucher_delete_returned_body'),
      okText: t('delete'),
      run: async (pin) => {
        await api.delete(`/vouchers/${id}`, { data: { pin } })
        message.success(t('deleted'))
        navigate('/vouchers')
      },
    })

  // In return mode, what is still out comes first
  const listed = current === 'return' ? [...items.filter((i) => !i.returned_at), ...items.filter((i) => i.returned_at)] : items

  const itemState = (item) => {
    if (isDraft) return item.held_by ? <Tag color="orange">{heldText(item.held_by, t)}</Tag> : null
    if (item.moved_to) return <Tag color="orange">{t('voucher_moved_to', { n: item.moved_to })}</Tag>
    return item.returned_at ? <Tag color="green">{t('voucher_returned')}</Tag> : <Tag color="blue">{t('voucher_still_out')}</Tag>
  }
  const itemActions = (item) => (
    <>
      {item.accessories.length > 0 && (
        <Button size="small" icon={<ApartmentOutlined />} onClick={() => setPicking(item)}>
          {`${t('accessories')} (${item.accessories.length})`}
        </Button>
      )}
      {(isDraft || !item.returned_at) &&
        (isDraft ? (
          <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={t('voucher_remove')} onClick={() => removeItem(item)} />
        ) : (
          <Popconfirm title={t('voucher_remove_issued')} okText={t('voucher_remove')} okButtonProps={{ danger: true }} cancelText={t('cancel')} onConfirm={() => removeItem(item)}>
            <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={t('voucher_remove')} />
          </Popconfirm>
        ))}
    </>
  )
  const itemName = (item) => (
    <>
      <span>{item.equipment.display_name}</span>
      {item.equipment.parent_serial && <span className="voucher-item-parent">{`${t('accessory_of')} ${item.equipment.parent_serial}`}</span>}
    </>
  )

  const recipientField = (
    <div className="voucher-recipient">
      <label htmlFor="voucher-recipient">{t('voucher_recipient')}</label>
      <AutoComplete
        id="voucher-recipient"
        ref={recipientBox}
        size="large"
        value={recipient}
        options={recipients.filter((r) => r !== recipient && r.includes(recipient.trim())).slice(0, 20).map((r) => ({ value: r }))}
        placeholder={t('voucher_recipient_placeholder')}
        onChange={(value) => {
          typingRecipient.current = true
          setRecipient(value)
        }}
        onSelect={(value) => saveRecipient(value)}
        onBlur={() => saveRecipient()}
        style={{ width: '100%' }}
      />
    </div>
  )

  const modeSwitch = !isDraft && (
    <Segmented
      block
      className="voucher-mode"
      value={current}
      onChange={(value) => {
        setMode(value)
        setLast(null)
      }}
      options={[
        { value: 'return', label: t('voucher_mode_return'), icon: <ImportOutlined /> },
        { value: 'add', label: t('voucher_mode_add'), icon: <PlusOutlined /> },
      ]}
    />
  )

  const scanBar = (
    <div className="scan-bar">
      <Input
        ref={input}
        size="large"
        dir="ltr"
        autoFocus={!phone}
        value={code}
        disabled={busy}
        placeholder={t('scan_placeholder')}
        onChange={(e) => setCode(e.target.value)}
        onPressEnter={() => submit()}
      />
      <Button size="large" type="primary" onClick={() => submit()} loading={busy}>
        {t(current === 'return' ? 'voucher_return_one' : 'add')}
      </Button>
      <Button size="large" icon={<ScanOutlined />} onClick={() => setScanning(true)}>
        {t('stocktake_camera')}
      </Button>
    </div>
  )

  // The other way to return: everything still out, with one press
  const returnAllButton = current === 'return' && out > 0 && (
    <div className="voucher-return-all">
      <span className="voucher-or">{t('voucher_or')}</span>
      <Button size="large" block danger icon={<ImportOutlined />} onClick={returnAll}>
        {t('voucher_return_all_n', { n: out })}
      </Button>
    </div>
  )

  const result = last && (
    <Alert
      className="scan-result"
      type={last.type}
      showIcon
      title={
        <span>
          {last.serial && <b className="serial">{last.serial}</b>}
          {last.serial && ' — '}
          {last.text}
        </span>
      }
      description={last.name}
    />
  )

  // Units another voucher took count neither as returned nor as out
  const returnProgress = !isDraft && items.length > 0 && (
    <div className="voucher-progress">
      <span>
        {own > 0 && (out ? t('voucher_returned_of', { m: own - out, n: own }) : t('voucher_all_back'))}
        {own > 0 && moved > 0 && ' · '}
        {moved > 0 && t('voucher_moved_n', { n: moved })}
      </span>
      {own > 0 && <Progress percent={Math.round(((own - out) / own) * 100)} showInfo={false} strokeColor="#16a34a" />}
    </div>
  )

  const heldWarning = isDraft && heldItems.length > 0 && <Alert type="warning" showIcon title={t('voucher_held_warning', { n: heldItems.length })} className="voucher-held-warning" />

  const tags = (
    <span className="phone-tags">
      <StatusTag voucher={voucher} />
      <Tag>{t('voucher_items_n', { n: items.length })}</Tag>
      {voucher.issued_at && <Tag>{formatTime(voucher.issued_at)}</Tag>}
    </span>
  )

  const camera = <CodeScanner open={scanning} onClose={closeCamera} onCode={onCameraCode} title={voucher.recipient || voucherTitle(voucher, t)} />
  const picker = <AccessoryPicker key={picking?.id} item={picking} inVoucher={inVoucher} onAdd={(ids) => addIds(ids)} onClose={() => setPicking(null)} />

  if (phone)
    return (
      <div className="page voucher-page">
        <PhoneHeader
          icon={<FileDoneOutlined />}
          title={voucherTitle(voucher, t)}
          subtitle={tags}
          more={[
            { key: 'return', icon: <ImportOutlined />, label: t('voucher_return_title'), onClick: () => navigate('/vouchers/return') },
            { key: 'delete', icon: <DeleteOutlined />, label: t('voucher_delete_draft'), danger: true, hidden: !isDraft, onClick: removeDraft, confirm: { title: t('voucher_delete_confirm') } },
            { key: 'delete-returned', icon: <DeleteOutlined />, label: t('voucher_delete'), danger: true, hidden: voucher.status !== 'returned', onClick: removeReturned },
          ]}
        />
        <div className="voucher-panel">
          {recipientField}
          {modeSwitch}
          {scanBar}
          {returnAllButton}
          {result}
          {heldWarning}
          {returnProgress}
        </div>
        <h2 className="voucher-section-title">{t('voucher_preview')}</h2>
        <VoucherSheet voucher={{ ...voucher, recipient: recipient.trim() || voucher.recipient }} rows={rows} />
        {items.length > 0 && (
          <>
            <h2 className="voucher-section-title">{`${t('voucher_scanned')} (${items.length})`}</h2>
            <PhoneList>
              {listed.map((item) => (
                <div key={item.id} className={`phone-row voucher-item-row${item.returned_at ? ' is-back' : ''}`}>
                  <span className={`phone-row-icon tone-${item.equipment.parent_serial ? 'violet' : 'blue'}`}>{item.equipment.parent_serial ? <ApartmentOutlined /> : <FileDoneOutlined />}</span>
                  <span className="phone-row-body">
                    <span className="phone-row-title">{itemName(item)}</span>
                    <span className="phone-row-sub">
                      <span className="serial">{item.equipment.serial_number || '—'}</span>
                    </span>
                    {itemState(item) && <span className="phone-row-meta">{itemState(item)}</span>}
                  </span>
                  <span className="voucher-item-actions">{itemActions(item)}</span>
                </div>
              ))}
            </PhoneList>
          </>
        )}
        {isDraft && <Fab icon={<CheckOutlined />} label={t('voucher_issue')} onClick={askIssue} loading={issuing} />}
        {camera}
        {picker}
      </div>
    )

  return (
    <div className="page voucher-page">
      <div className="page-head">
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            <FileDoneOutlined /> {voucherTitle(voucher, t)}
          </Typography.Title>
          <div style={{ marginTop: 4 }}>{tags}</div>
        </div>
        <div className="page-actions">
          <Button icon={<ImportOutlined />} onClick={() => navigate('/vouchers/return')}>
            {t('voucher_return_title')}
          </Button>
          {isDraft && (
            <Popconfirm title={t('voucher_delete_confirm')} okText={t('delete')} okButtonProps={{ danger: true }} cancelText={t('cancel')} onConfirm={removeDraft}>
              <Button danger icon={<DeleteOutlined />}>
                {t('voucher_delete_draft')}
              </Button>
            </Popconfirm>
          )}
          {voucher.status === 'returned' && (
            <Button danger icon={<DeleteOutlined />} onClick={removeReturned}>
              {t('voucher_delete')}
            </Button>
          )}
          {isDraft && (
            <Button type="primary" icon={<CheckOutlined />} onClick={askIssue} loading={issuing}>
              {t('voucher_issue')}
            </Button>
          )}
        </div>
      </div>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={13}>
          <Card style={{ marginBottom: 16 }}>
            {recipientField}
            {modeSwitch}
            {scanBar}
            {returnAllButton}
            {result}
            {heldWarning}
            {returnProgress}
          </Card>
          <Card title={`${t('voucher_scanned')} (${items.length})`} styles={{ body: { padding: items.length ? 0 : undefined } }}>
            {items.length ? (
              <Table
                rowKey="id"
                size="small"
                dataSource={listed}
                pagination={false}
                scroll={{ x: 'max-content' }}
                rowClassName={(item) => (item.returned_at ? 'voucher-row-back' : '')}
                columns={[
                  {
                    title: t('serial_number'),
                    key: 'serial',
                    render: (_, item) =>
                      item.equipment.deleted ? (
                        <span className="serial">{item.equipment.serial_number || '—'}</span>
                      ) : (
                        <Link to={`/equipment/${item.equipment.id}`} className="serial">
                          {item.equipment.serial_number || '—'}
                        </Link>
                      ),
                  },
                  { title: t('name_field'), key: 'name', render: (_, item) => <span className="voucher-item-name">{itemName(item)}</span> },
                  { title: t('voucher_state'), key: 'state', render: (_, item) => itemState(item) },
                  { key: 'actions', align: 'end', render: (_, item) => <span className="voucher-item-actions">{itemActions(item)}</span> },
                ]}
              />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('voucher_empty_hint')} />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={11}>
          <Card title={t('voucher_preview')}>
            <VoucherSheet voucher={{ ...voucher, recipient: recipient.trim() || voucher.recipient }} rows={rows} />
          </Card>
        </Col>
      </Row>
      {camera}
      {picker}
    </div>
  )
}

/* ---------- Return from anywhere */

/** Scan anything to take it back: its voucher is found by itself. */
export function VoucherReturnPage() {
  const { t } = useLang()
  const { user } = useAuth()
  const phone = usePhone()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [log, setLog] = useState([])
  const input = useRef(null)
  const counter = useRef(0)

  if (!user) return <NeedPin />

  const handle = async (value) => {
    try {
      const { data } = await api.post('/vouchers/return', { code: value })
      const entry = { key: ++counter.current, serial: data.equipment.serial_number, name: data.equipment.display_name, voucher: data.voucher }
      if (data.status === 'not_held') return { ...entry, type: 'warning', text: t('voucher_not_held') }
      const left = data.voucher ? (data.voucher.held_count ? t('voucher_missing_n', { n: data.voucher.held_count }) : t('voucher_all_back')) : null
      return { ...entry, type: 'success', text: [t('voucher_returned_from', { name: data.holder }), left].filter(Boolean).join(' · ') }
    } catch (e) {
      return { key: ++counter.current, serial: value, type: 'error', text: t(errorKey(e) || 'error') }
    }
  }

  const record = (entry) => {
    beep(entry.type === 'success')
    setLog((l) => [entry, ...l].slice(0, 200))
  }

  const submit = async () => {
    const value = code.trim()
    if (!value || busy) return
    setBusy(true)
    const entry = await handle(value)
    record(entry)
    if (entry.type !== 'error') setCode('')
    setBusy(false)
    if (!phone) input.current?.focus()
  }

  const onCameraCode = async (text) => {
    const entry = await handle(text)
    record(entry)
    return { type: entry.type, text: [entry.serial, entry.name, entry.text].filter(Boolean).join('\n') }
  }

  const back = log.filter((e) => e.type === 'success').length

  return (
    <div className="page voucher-page">
      {phone ? (
        <PhoneHeader icon={<ImportOutlined />} title={t('voucher_return_title')} subtitle={t('voucher_return_hint')} />
      ) : (
        <div className="page-head">
          <div>
            <Typography.Title level={3} style={{ margin: 0 }}>
              <ImportOutlined /> {t('voucher_return_title')}
            </Typography.Title>
            <Typography.Text type="secondary">{t('voucher_return_hint')}</Typography.Text>
          </div>
        </div>
      )}
      <Card style={{ marginBottom: 16 }}>
        <div className="scan-bar">
          <Input ref={input} size="large" dir="ltr" autoFocus={!phone} value={code} disabled={busy} placeholder={t('scan_placeholder')} onChange={(e) => setCode(e.target.value)} onPressEnter={submit} />
          <Button size="large" type="primary" onClick={submit} loading={busy}>
            {t('voucher_return_one')}
          </Button>
          <Button size="large" icon={<ScanOutlined />} onClick={() => setScanning(true)}>
            {t('stocktake_camera')}
          </Button>
        </div>
        {log.length > 0 && <div className="voucher-return-count">{t('voucher_returned_now', { n: back })}</div>}
      </Card>
      <CodeScanner open={scanning} onClose={() => setScanning(false)} onCode={onCameraCode} title={t('voucher_return_title')} />
      {log.length ? (
        <div className="voucher-return-log">
          {log.map((entry) => (
            <Alert
              key={entry.key}
              type={entry.type}
              showIcon
              title={
                <span>
                  {entry.serial && <b className="serial">{entry.serial}</b>}
                  {entry.name && ` ${entry.name}`}
                </span>
              }
              description={
                <span>
                  {entry.text}
                  {entry.voucher && (
                    <>
                      {' · '}
                      <Link to={`/vouchers/${entry.voucher.id}`}>{t('voucher_title_n', { n: entry.voucher.number })}</Link>
                    </>
                  )}
                </span>
              }
            />
          ))}
        </div>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('voucher_return_empty')} />
      )}
    </div>
  )
}
