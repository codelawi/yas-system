import { App, Input, Typography } from 'antd'
import api, { errorKey } from './api'
import { useLang } from './i18n'

/**
 * Saves the QR address. When labels were already printed with the current
 * address the server refuses; we then show how many labels would break and ask
 * for the new address to be typed again.
 * Returns the saved settings, or null when the user cancelled or it failed.
 */
export function useQrAddressSaver() {
  const { t } = useLang()
  const { modal, message } = App.useApp()

  return async (endpoint, payload, newUrl, current) => {
    try {
      return (await api.put(endpoint, payload)).data
    } catch (e) {
      const key = errorKey(e) || ''
      if (!key.startsWith('qr_address_locked')) {
        message.error(t(key || 'error'))
        return null
      }
      const count = key.split(':')[1]
      let typed = ''
      const ok = await modal.confirm({
        title: t('qr_lock_title'),
        width: 520,
        okText: t('qr_lock_change'),
        okButtonProps: { danger: true },
        cancelText: t('cancel'),
        content: (
          <div>
            <Typography.Paragraph>{t('qr_lock_body', { n: count, url: current })}</Typography.Paragraph>
            <Typography.Paragraph type="secondary">{t('qr_lock_type', { url: newUrl })}</Typography.Paragraph>
            <Input dir="ltr" placeholder={newUrl} onChange={(ev) => (typed = ev.target.value)} />
          </div>
        ),
      })
      if (!ok) return null
      if (typed.trim().replace(/\/+$/, '') !== newUrl.replace(/\/+$/, '')) {
        message.error(t('qr_lock_mismatch'))
        return null
      }
      try {
        return (await api.put(endpoint, { ...payload, confirm_base_url: newUrl })).data
      } catch (e2) {
        message.error(t(errorKey(e2) || 'error'))
        return null
      }
    }
  }
}
