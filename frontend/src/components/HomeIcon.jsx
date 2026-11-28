import { App, Alert, Button, Card, Modal, Typography } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { useLang } from '../i18n'
import { addHomeIcon, isIphone, useHomeIconHere, useHomeIconState } from '../homeIcon'
import { AppLogo, ShareIcon } from './PhoneIcons'

/** A translation with {icon} in it, as text around the icon. */
function WithIcon({ text, icon }) {
  const [before, after = ''] = text.split('{icon}')
  return (
    <>
      {before}
      {icon}
      {after}
    </>
  )
}

/** The steps on the iPhone: Safari's share menu adds the icon, and the data is downloaded inside it. */
function IphoneSteps() {
  const { t } = useLang()
  return (
    <>
      <ol className="offline-steps home-icon-steps">
        <li>
          <WithIcon text={t('home_icon_iphone_share')} icon={<ShareIcon />} />
        </li>
        <li>{t('home_icon_iphone_add')}</li>
        <li>{t('home_icon_iphone_open')}</li>
      </ol>
      <Alert type="warning" showIcon title={t('home_icon_iphone_separate')} style={{ marginTop: 12 }} />
    </>
  )
}

/** Chrome's own dialog when it offers one, otherwise where its menu has it. */
function AndroidWay({ onAdded }) {
  const { t } = useLang()
  const { message } = App.useApp()
  const { canOffer, added } = useHomeIconState()

  const add = async () => {
    if (await addHomeIcon()) {
      message.success(t('home_icon_added'))
      onAdded?.()
    }
  }

  if (canOffer) {
    return (
      <Button type="primary" size="large" block icon={<PlusOutlined />} onClick={add}>
        {t('home_icon_add')}
      </Button>
    )
  }
  return <Typography.Paragraph style={{ marginBottom: 0 }}>{t(added ? 'home_icon_present' : 'home_icon_menu')}</Typography.Paragraph>
}

function HomeIconHow({ onAdded }) {
  return isIphone() ? <IphoneSteps /> : <AndroidWay onAdded={onAdded} />
}

const Title = ({ children }) => (
  <span className="home-icon-title">
    <AppLogo size={22} /> {children}
  </span>
)

/** The fixed place on the "Work offline" page to add the icon (or to say it is there). */
export function HomeIconCard({ style }) {
  const { t } = useLang()
  if (!useHomeIconHere()) return null
  return (
    <Card title={<Title>{t('home_icon_title')}</Title>} style={style}>
      <Typography.Paragraph type="secondary">{t('home_icon_intro')}</Typography.Paragraph>
      <HomeIconHow />
    </Card>
  )
}

/** Offered once the data is saved on the phone. */
export function HomeIconDialog({ open, onClose }) {
  const { t } = useLang()
  return (
    <Modal open={open} centered title={<Title>{t('home_icon_dialog_title')}</Title>} onCancel={onClose} footer={<Button onClick={onClose}>{t('home_icon_later')}</Button>} destroyOnHidden>
      <Typography.Paragraph type="secondary">{t('home_icon_intro')}</Typography.Paragraph>
      <HomeIconHow onAdded={onClose} />
    </Modal>
  )
}
