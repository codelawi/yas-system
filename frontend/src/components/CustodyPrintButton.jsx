import { useEffect, useState } from 'react'
import { App, Button, Dropdown, Space, Tooltip } from 'antd'
import { DownOutlined, PrinterOutlined } from '@ant-design/icons'
import api, { errorKey } from '../api'
import { useLang } from '../i18n'
import { printCustodyForm } from '../custodyForm'

// One request for every button on the page
let formsRequest = null
export const loadCustodyForms = (fresh = false) => {
  if (fresh || !formsRequest) {
    formsRequest = api
      .get('/custody-forms')
      .then(({ data }) => data)
      .catch(() => {
        formsRequest = null
        return []
      })
  }
  return formsRequest
}

/** "Print custody form" for one hand-over; a menu when there are several forms. */
export default function CustodyPrintButton({ custodyId, size, label = true }) {
  const { t } = useLang()
  const { message } = App.useApp()
  const [forms, setForms] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    loadCustodyForms().then(setForms)
  }, [])

  if (!forms) return null
  if (!forms.length) {
    return (
      <Tooltip title={`${t('cf_none')} — ${t('cf_none_hint')}`}>
        <Button size={size} icon={<PrinterOutlined />} disabled>
          {label && t('cf_print')}
        </Button>
      </Tooltip>
    )
  }

  const print = async (form) => {
    setBusy(true)
    try {
      await printCustodyForm(form, custodyId)
    } catch (e) {
      message.error(t(errorKey(e) || 'error'))
    } finally {
      setBusy(false)
    }
  }

  const main = forms.find((f) => f.is_default) || forms[0]
  const button = (
    <Button size={size} icon={<PrinterOutlined />} loading={busy} onClick={() => print(main)} title={t('cf_print')}>
      {label && t('cf_print')}
    </Button>
  )
  if (forms.length === 1) return button

  return (
    <Space.Compact>
      {button}
      <Dropdown menu={{ items: forms.map((f) => ({ key: String(f.id), label: f.name })), onClick: ({ key }) => print(forms.find((f) => String(f.id) === key)) }}>
        <Button size={size} icon={<DownOutlined />} />
      </Dropdown>
    </Space.Compact>
  )
}
