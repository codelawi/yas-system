import { Button, Card, Typography } from 'antd'
import { HistoryOutlined, LockOutlined } from '@ant-design/icons'
import { useLang } from '../i18n'
import { useAuth } from '../auth'

/** Shown instead of the history until the person enters their PIN. */
export default function HistoryLocked({ title }) {
  const { t } = useLang()
  const { requirePin } = useAuth()

  return (
    <Card
      title={
        <span>
          <HistoryOutlined /> {title || t('history')}
        </span>
      }
    >
      <div className="history-locked">
        <LockOutlined className="history-locked-icon" />
        <Typography.Text type="secondary">{t('history_locked')}</Typography.Text>
        <Button icon={<LockOutlined />} onClick={requirePin}>
          {t('unlock')}
        </Button>
      </div>
    </Card>
  )
}
