import { useEffect, useState } from 'react'
import { Select } from 'antd'
import { FilterOutlined } from '@ant-design/icons'
import api from '../api'
import { useLang } from '../i18n'

export const CATEGORY_KEY = '__category__'
const ANY = '__any__'

/** Readable "field: value" text for an active filter. */
export function filterLabel(filter, t) {
  const key = filter.key === CATEGORY_KEY ? t('category') : filter.key
  const value = filter.value === '' ? t('any_value') : filter.value === '__none__' ? t('no_category') : filter.value
  return `${key}: ${value}`
}

/**
 * Two linked dropdowns: pick a field that exists in the data, then one of its
 * stored values (or "any value"). Calls onAdd({ key, value }) and resets.
 */
export default function FieldFilter({ onAdd }) {
  const { t } = useLang()
  const [keys, setKeys] = useState([])
  const [key, setKey] = useState()
  const [values, setValues] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    api.get('/equipment/keys').then(({ data }) => setKeys(data))
  }, [])

  const chooseKey = (k) => {
    setKey(k)
    setValues([])
    if (!k) return
    setLoading(true)
    api
      .get('/equipment/values', { params: { key: k } })
      .then(({ data }) => setValues(data))
      .finally(() => setLoading(false))
  }

  const chooseValue = (v) => {
    onAdd({ key, value: v === ANY ? '' : v })
    setKey(undefined)
    setValues([])
  }

  const valueOptions = [
    { value: ANY, label: t('any_value') },
    ...(key === CATEGORY_KEY ? [{ value: '__none__', label: t('no_category') }] : []),
    ...values.map((v) => ({ value: v.value, label: `${v.value.split('\n')[0]}  (${v.uses})` })),
  ]

  return (
    <div className="field-filter">
      <Select
        showSearch
        allowClear
        value={key}
        onChange={chooseKey}
        placeholder={
          <span>
            <FilterOutlined /> {t('filter_field')}
          </span>
        }
        optionFilterProp="label"
        options={[{ value: CATEGORY_KEY, label: t('category') }, ...keys.map((k) => ({ value: k, label: k }))]}
        style={{ minWidth: 180 }}
        popupMatchSelectWidth={false}
      />
      <Select
        showSearch
        value={null}
        disabled={!key}
        loading={loading}
        onChange={chooseValue}
        placeholder={t('filter_value')}
        optionFilterProp="label"
        options={valueOptions}
        style={{ minWidth: 200 }}
        popupMatchSelectWidth={false}
      />
    </div>
  )
}
