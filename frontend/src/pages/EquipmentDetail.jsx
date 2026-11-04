import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Result, Spin } from 'antd'
import api from '../api'
import { useLang } from '../i18n'
import EquipmentView from '../components/EquipmentView'
import { useAuth } from '../auth'

export default function EquipmentDetail() {
  const { id } = useParams()
  const { t } = useLang()
  const navigate = useNavigate()
  const [equipment, setEquipment] = useState(null)
  const [missing, setMissing] = useState(false)
  const { user } = useAuth()

  const load = useCallback(
    () =>
      api
        .get(`/equipment/${id}`)
        .then(({ data }) => setEquipment(data))
        .catch(() => setMissing(true)),
    [id],
  )

  useEffect(() => {
    setEquipment(null)
    setMissing(false)
    load()
    // `user`: reload when the PIN is entered or locked again (the history is only sent with a PIN)
  }, [load, user])

  if (missing) return <Result status="404" title={t('not_found')} />
  if (!equipment) return <Spin size="large" className="page-spin" />

  return <EquipmentView
      equipment={equipment}
      onChange={setEquipment}
      onReload={load}
      onDeleted={() => navigate(equipment.parent ? `/equipment/${equipment.parent.id}` : '/equipment')}
    />
}
