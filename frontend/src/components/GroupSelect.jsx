import { useEffect, useState } from 'react'
import { Select } from 'antd'
import api from '../api'
import { useLang } from '../i18n'

/** Choose a group (clear it for "no group"). */
export default function GroupSelect({ value, onChange, ...props }) {
  const { t } = useLang()
  const [groups, setGroups] = useState([])

  useEffect(() => {
    api
      .get('/groups')
      .then(({ data }) => setGroups(data))
      .catch(() => {}) // no list without a connection: the form cannot save then anyway
  }, [])

  return (
    <Select
      value={value ?? undefined}
      onChange={(v) => onChange?.(v ?? null)}
      allowClear
      showSearch
      optionFilterProp="label"
      placeholder={t('no_group')}
      options={groups.map((g) => ({ value: g.id, label: g.name }))}
      {...props}
    />
  )
}
