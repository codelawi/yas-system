import { useRef, useState } from 'react'
import { App, Button, Card, Empty, Image, Popconfirm } from 'antd'
import { CameraOutlined, DeleteOutlined, PictureOutlined } from '@ant-design/icons'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'
import { useAuth } from '../auth'

/** Longest side of an uploaded photo: phone photos are shrunk before upload, so they are quick on a hotspot. */
const MAX_SIDE = 1600

/** Makes a smaller JPEG of a photo; returns the original file if the browser can't read it (e.g. HEIC). */
async function shrink(file) {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
    if (scale === 1 && file.size < 1024 * 1024) return file
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    return blob ? new File([blob], 'photo.jpg', { type: 'image/jpeg' }) : file
  } catch {
    return file
  }
}

/** The equipment's photo: anyone can see it, adding / changing / removing it needs the PIN. */
export default function EquipmentPhoto({ equipment, onChanged }) {
  const { t } = useLang()
  const { requirePin } = useAuth()
  const { message } = App.useApp()
  const [busy, setBusy] = useState(false)
  const input = useRef(null)

  const upload = async (file) => {
    if (!file || !(await requirePin())) return
    setBusy(true)
    try {
      const body = new FormData()
      body.append('photo', await shrink(file))
      const { data } = await api.post(`/equipment/${equipment.id}/photo`, body)
      message.success(t('saved'))
      onChanged(data.photo_url)
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!(await requirePin())) return
    try {
      await api.delete(`/equipment/${equipment.id}/photo`)
      onChanged(null)
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    }
  }

  const picker = (
    <>
      <Button size="small" type="primary" ghost icon={<CameraOutlined />} loading={busy} onClick={() => input.current?.click()}>
        {t(equipment.photo_url ? 'change_photo' : 'add_photo')}
      </Button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          upload(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </>
  )

  return (
    <Card
      title={
        <span>
          <PictureOutlined /> {t('photo')}
        </span>
      }
      extra={
        <div className="page-actions">
          {picker}
          {equipment.photo_url && (
            <Popconfirm title={t('remove_photo_confirm')} okText={t('delete')} cancelText={t('cancel')} okButtonProps={{ danger: true }} onConfirm={remove}>
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </div>
      }
      style={{ marginBottom: 16 }}
    >
      {equipment.photo_url ? (
        <Image src={equipment.photo_url} className="equipment-photo" alt={equipment.serial_number} />
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('no_photo')} />
      )}
    </Card>
  )
}
