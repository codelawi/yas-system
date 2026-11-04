import { Empty } from 'antd'
import { useLang } from '../i18n'

/** Read-only key/value list. Multi-line values (lists of items) keep their lines. */
export default function FieldList({ fields, compact }) {
  const { t } = useLang()
  if (!fields?.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('no_fields')} />

  return (
    <dl className={compact ? 'field-list compact' : 'field-list'}>
      {fields.map((f, i) => (
        <div className="field-list-row" key={i}>
          <dt>{f.key}</dt>
          <dd>{f.value || '—'}</dd>
        </div>
      ))}
    </dl>
  )
}
