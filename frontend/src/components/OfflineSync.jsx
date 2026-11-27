import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Input, List, Modal, Progress, Radio, Result, Space, Typography } from 'antd'
import { CloudSyncOutlined, LockOutlined } from '@ant-design/icons'
import { useLang } from '../i18n'
import { saveSession } from '../auth'
import { downloadOffline, readOfflineMeta } from '../offline'
import { SyncStopped, serverReachable, signInToSync, syncChanges } from '../offlineSync'
import { SYNC_EVENT, changeText } from './OfflineChanges'

/** The answers each kind of question offers (offlineSync.js). */
const CHOICES = {
  field: ['phone', 'server'],
  photo: ['phone', 'server'],
  changed_deleted: ['delete', 'keep'],
  serial_taken: ['merge', 'rename', 'drop'],
  box_taken: ['merge', 'rename', 'drop'],
  group_taken: ['merge', 'rename', 'drop'],
  equipment_deleted: ['restore', 'keep'],
  box_deleted: ['restore', 'keep'],
  group_deleted: ['restore', 'keep'],
  scan_folder_deleted: ['restore', 'keep'],
  scan_document_deleted: ['restore', 'keep'],
  scan_row_deleted: ['restore', 'keep'],
}

/** A field's name as the pages show it. */
function attrName(t, q) {
  // A scan document's column, as its table names it
  if (q.attrName) return q.attrName
  if (q.type === 'scan_folder') return t('scan_folder_name')
  if (q.type === 'scan_document') return t({ title: 'scan_doc_title', duplicate_scope: 'scan_dup_scope' }[q.attr] || q.attr)
  if (q.attr.startsWith('field:')) return q.attr.slice(6)
  if (q.type === 'box') return t({ number: 'box_number', name: 'box_name' }[q.attr] || q.attr)
  if (q.type === 'group') return t({ name: 'group_name' }[q.attr] || q.attr)
  return t(q.attr === 'group_id' ? 'group' : q.attr)
}

function choiceLabel(t, q, choice) {
  if (q.kind === 'field') {
    const removed = choice === 'phone' ? q.removedOnPhone : q.removedOnServer
    let value = removed ? t('cf_removed') : (choice === 'phone' ? q.phone : q.server) || '—'
    if (q.type === 'scan_document' && q.attr === 'duplicate_scope' && !removed) value = t(value === 'folder' ? 'scan_dup_folder' : 'scan_dup_document')
    return (
      <span>
        {t(choice === 'phone' ? 'cf_from_phone' : 'cf_from_server')}: <bdi className="cf-value">{String(value)}</bdi>
        {choice === 'phone' && q.user && <Typography.Text type="secondary"> ({q.user})</Typography.Text>}
      </span>
    )
  }
  if (q.kind === 'photo') return t(choice === 'phone' ? (q.removed ? 'cf_photo_phone_removed' : 'cf_photo_phone') : 'cf_photo_server')
  if (choice === 'rename') return t({ serial_taken: 'cf_rename_serial', box_taken: 'cf_rename_box', group_taken: 'cf_rename_group' }[q.kind])
  if (choice === 'merge') return t(q.kind === 'serial_taken' ? 'cf_merge_equipment' : q.kind === 'box_taken' ? 'cf_merge_box' : 'cf_merge_group')
  if (choice === 'keep') return t(q.kind === 'changed_deleted' ? 'cf_keep' : 'cf_keep_deleted')
  return t(`cf_${choice}`)
}

function questionTitle(t, q) {
  if (q.kind === 'field') return t('cf_field', { label: q.label, field: attrName(t, q) })
  if (q.kind === 'serial_taken') return t('cf_serial_taken', { value: q.value, other: q.other || '' })
  if (q.kind === 'box_taken' || q.kind === 'group_taken') return t(`cf_${q.kind}`, { value: q.value })
  if (q.kind === 'changed_deleted' && q.type && q.type !== 'equipment') return t(`cf_changed_deleted_${q.type}`, { label: q.label })
  return t(`cf_${q.kind}`, { label: q.label })
}

const answered = (q, answer) => !!answer?.choice && (answer.choice !== 'rename' || !!String(answer.value ?? '').trim())

function Questions({ questions, onDone }) {
  const { t } = useLang()
  const [answers, setAnswers] = useState({})
  const set = (id, patch) => setAnswers((all) => ({ ...all, [id]: { ...all[id], ...patch } }))
  const ready = questions.every((q) => answered(q, answers[q.id]))

  return (
    <div>
      <Alert type="info" showIcon title={t('sync_questions_hint', { n: questions.length })} style={{ marginBottom: 12 }} />
      <div className="sync-questions">
        {questions.map((q) => (
          <div key={q.id} className="sync-question">
            <Typography.Text strong>{questionTitle(t, q)}</Typography.Text>
            <Radio.Group value={answers[q.id]?.choice} onChange={(e) => set(q.id, { choice: e.target.value })}>
              <Space direction="vertical">
                {CHOICES[q.kind].map((choice) => (
                  <Radio key={choice} value={choice}>
                    {choiceLabel(t, q, choice)}
                  </Radio>
                ))}
              </Space>
            </Radio.Group>
            {answers[q.id]?.choice === 'rename' && (
              <Input autoFocus value={answers[q.id]?.value ?? ''} placeholder={q.value} onChange={(e) => set(q.id, { value: e.target.value })} dir="auto" />
            )}
          </div>
        ))}
      </div>
      <Button type="primary" size="large" block disabled={!ready} onClick={() => onDone(answers)} style={{ marginTop: 12 }}>
        {t('sync_continue')}
      </Button>
    </div>
  )
}

function Summary({ report }) {
  const { t } = useLang()
  const problems = [...report.failed.map((f) => ({ ...f, text: t(f.error) })), ...report.dropped.map((d) => ({ ...d, text: t(d.reason) }))]
  return (
    <Result
      status={report.failed.length ? 'warning' : 'success'}
      title={t('sync_done')}
      subTitle={[t('sync_sent', { n: report.sent }), report.merged > 0 && t('sync_merged', { n: report.merged }), report.skipped > 0 && t('sync_skipped', { n: report.skipped })].filter(Boolean).join(' · ')}
      extra={
        problems.length > 0 && (
          <List
            size="small"
            header={t('sync_not_sent', { n: problems.length })}
            dataSource={problems}
            rowKey={(p) => `${p.id}-${p.text}`}
            renderItem={(p) => (
              <List.Item>
                <div style={{ textAlign: 'start' }}>
                  <div>{p.effect ? changeText(t, p.effect) : `#${p.id}`}</div>
                  <Typography.Text type="secondary">{p.text}</Typography.Text>
                </div>
              </List.Item>
            )}
          />
        )
      }
    />
  )
}

/**
 * Sending the phone's changes to the server (offlineSync.js): the PIN of whoever syncs, then
 * the changes, the questions at the end, and a fresh copy of the data on the phone.
 */
export default function SyncDialog() {
  const { t } = useLang()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState('pin')
  const [pin, setPin] = useState('')
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState(null)
  const [questions, setQuestions] = useState(null)
  const [report, setReport] = useState(null)
  const answer = useRef(null)

  useEffect(() => {
    const start = () => {
      setOpen(true)
      setStep('pin')
      setPin('')
      setError(null)
      setReport(null)
    }
    window.addEventListener(SYNC_EVENT, start)
    return () => window.removeEventListener(SYNC_EVENT, start)
  }, [])

  const run = async () => {
    if (!pin) return
    setStep('running')
    setError(null)
    setProgress({ step: 'check' })
    if (!(await serverReachable())) {
      setError(t('sync_unreachable'))
      setStep('pin')
      return
    }
    let session
    try {
      session = await signInToSync(pin)
    } catch (e) {
      setError(t(e.reason || 'error'))
      setPin('')
      setStep('pin')
      return
    }
    try {
      const result = await syncChanges({
        token: session.token,
        onProgress: setProgress,
        ask: (list) =>
          new Promise((resolve) => {
            answer.current = resolve
            setQuestions(list)
            setStep('questions')
          }),
      })
      setStep('running')
      setProgress({ step: 'download' })
      const meta = await readOfflineMeta()
      await downloadOffline({ token: session.token, user: session.user, withPhotos: meta?.with_photos ?? true, clearChanges: true })
      // Unlocked on the server now, as whoever synced
      saveSession(session.token, session.user)
      setReport(result)
      setStep('done')
    } catch (e) {
      setError(e instanceof SyncStopped ? [t(e.reason), e.detail].filter(Boolean).join(' · ') : t('sync_download_failed'))
      setStep('error')
    }
  }

  const answerQuestions = (answers) => {
    setStep('running')
    answer.current?.(answers)
  }

  const close = () => {
    setOpen(false)
    // What was synced, and the fresh copy, show on every page
    if (step === 'done' || step === 'error') window.location.reload()
  }

  const progressText =
    progress &&
    (progress.step === 'send' ? t('sync_step_send', { done: progress.done, total: progress.total }) : t(`sync_step_${progress.step}`))

  return (
    <Modal
      open={open}
      title={
        <span>
          <CloudSyncOutlined /> {t('sync_title')}
        </span>
      }
      footer={null}
      closable={step !== 'running' && step !== 'questions'}
      maskClosable={false}
      keyboard={step === 'pin'}
      onCancel={close}
      width={step === 'questions' ? 560 : 400}
      centered
      destroyOnHidden
    >
      {step === 'pin' && (
        <div>
          <Typography.Paragraph type="secondary">{t('sync_pin')}</Typography.Paragraph>
          <Input.Password
            autoFocus
            size="large"
            inputMode="numeric"
            maxLength={8}
            prefix={<LockOutlined />}
            value={pin}
            status={error ? 'error' : undefined}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            onPressEnter={run}
            style={{ textAlign: 'center', letterSpacing: 6 }}
          />
          {error && <Typography.Paragraph type="danger" style={{ marginTop: 8 }}>{error}</Typography.Paragraph>}
          <Button type="primary" size="large" block disabled={!pin} onClick={run} style={{ marginTop: 12 }}>
            {t('sync')}
          </Button>
        </div>
      )}
      {step === 'running' && (
        <div className="sync-progress">
          {progress?.step === 'send' && progress.total > 0 && <Progress percent={Math.round((progress.done / progress.total) * 100)} />}
          <Typography.Text type="secondary">{progressText}</Typography.Text>
          <Typography.Paragraph type="secondary" className="sync-keep-open">
            {t('sync_keep_open')}
          </Typography.Paragraph>
        </div>
      )}
      {step === 'questions' && questions && <Questions questions={questions} onDone={answerQuestions} />}
      {step === 'done' && report && <Summary report={report} />}
      {step === 'error' && <Result status="error" title={t('sync_stopped')} subTitle={error} extra={<Button onClick={close}>{t('close')}</Button>} />}
      {step === 'done' && (
        <Button type="primary" block onClick={close}>
          {t('close')}
        </Button>
      )}
    </Modal>
  )
}
