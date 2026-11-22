import { useMemo, useState } from 'react'
import { Alert, Button, Input, Modal, Tag } from 'antd'
import { CheckCircleFilled } from '@ant-design/icons'
import { useLang } from '../i18n'
import { lineParts, matchSerial } from '../ocr/text'

/**
 * Confirms a line read by the camera before it is used: the photo of the line, the text (to
 * correct a misread character), the serial number the system knows when it looks like one, and
 * the line's words to use just one of them.
 *
 * pick: { id, text, photoUrl } or null; give the modal key={pick?.id}. onAdd(text) adds it; onCancel goes back to the frozen picture.
 */
export default function TextPickModal({ pick, index, onAdd, onCancel }) {
  const { t } = useLang()
  // Each pick mounts a new modal (key), starting from its text
  const [value, setValue] = useState(pick?.text || '')

  const match = useMemo(() => matchSerial(value, index), [value, index])
  const parts = useMemo(() => (pick ? lineParts(pick.text) : []), [pick])
  const text = value.trim()

  return (
    <Modal
      open={!!pick}
      zIndex={2100}
      centered
      destroyOnHidden
      title={t('ocr_confirm_title')}
      onCancel={onCancel}
      footer={[
        <Button key="back" size="large" onClick={onCancel}>
          {t('ocr_back')}
        </Button>,
        <Button key="add" type="primary" size="large" disabled={!text} onClick={() => onAdd(text)}>
          {t('add')}
        </Button>,
      ]}
    >
      {pick?.photoUrl && <img className="ocr-pick-photo" src={pick.photoUrl} alt="" />}
      <Input
        className="ocr-pick-input"
        size="large"
        dir="ltr"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onPressEnter={() => text && onAdd(text)}
        aria-label={t('ocr_text')}
      />
      {match?.how === 'exact' && (
        <Tag className="ocr-pick-known" color="success" icon={<CheckCircleFilled />}>
          {t('ocr_known')}
        </Tag>
      )}
      {match && match.how !== 'exact' && (
        <Alert
          className="ocr-pick-suggest"
          type="info"
          showIcon
          title={
            <span>
              {t('ocr_did_you_mean')} <b className="serial" dir="ltr">{match.serial}</b>
            </span>
          }
          action={
            <Button size="small" type="primary" onClick={() => setValue(match.serial)}>
              {t('ocr_use_it')}
            </Button>
          }
        />
      )}
      {parts.length > 0 && (
        <div className="ocr-pick-parts">
          <span>{t('ocr_parts')}</span>
          <span className="ocr-pick-part-list" dir="ltr">
          {parts.map((part, i) => (
            <Tag.CheckableTag key={i} checked={value === part} onChange={() => setValue(part)} dir="ltr">
              {part}
            </Tag.CheckableTag>
          ))}
          </span>
          {value !== pick.text && (
            <Tag.CheckableTag checked={false} onChange={() => setValue(pick.text)}>
              {t('ocr_whole_line')}
            </Tag.CheckableTag>
          )}
        </div>
      )}
    </Modal>
  )
}
