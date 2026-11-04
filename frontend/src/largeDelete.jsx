import { App, Input, Typography } from 'antd'
import { errorKey } from './api'
import { useLang } from './i18n'

/**
 * Runs a delete request. When it would delete more than 5 equipment the server
 * answers "pin_required:N": we then ask for the PIN (again, even if unlocked)
 * and send the request once more with it.
 * Returns the response, or null when the user cancelled.
 */
export function useLargeDelete() {
  const { t } = useLang()
  const { modal } = App.useApp()

  const askPin = (count, error) =>
    new Promise((resolve) => {
      let pin = ''
      modal.confirm({
        title: t('big_delete_title', { n: count }),
        okText: t('delete'),
        okButtonProps: { danger: true },
        cancelText: t('cancel'),
        content: (
          <div>
            <Typography.Paragraph>{t('big_delete_body', { n: count })}</Typography.Paragraph>
            {error && <Typography.Paragraph type="danger">{error}</Typography.Paragraph>}
            <Input.Password autoFocus inputMode="numeric" maxLength={8} placeholder={t('pin')} onChange={(e) => (pin = e.target.value.replace(/\D/g, ''))} style={{ letterSpacing: 4 }} />
          </div>
        ),
        onOk: () => resolve(pin || null),
        onCancel: () => resolve(null),
      })
    })

  return async (send) => {
    let pin
    let count = ''
    for (;;) {
      try {
        return await send(pin)
      } catch (e) {
        const key = errorKey(e) || ''
        if (key.startsWith('pin_required:')) {
          count = key.split(':')[1]
          pin = await askPin(count)
        } else if (pin && key === 'wrong_pin') {
          pin = await askPin(count, t('wrong_pin'))
        } else {
          throw e
        }
        if (!pin) return null
      }
    }
  }
}
