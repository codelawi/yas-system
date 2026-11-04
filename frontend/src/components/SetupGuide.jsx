import { useState } from 'react'
import { Alert, Button, Card, Input, Space, Steps, Tag, Typography } from 'antd'
import { CheckCircleOutlined, CloseCircleOutlined, PrinterOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import api from '../api'
import { useLang } from '../i18n'
import QrCode from './QrCode'

const Code = ({ children }) => (
  <Typography.Text code copyable className="guide-code">
    {children}
  </Typography.Text>
)

/** Step-by-step plan (to do with IT) so the QR address never changes after printing. */
export default function SetupGuide({ info, onUseAddress }) {
  const { t } = useLang()
  const lan = info.addresses.filter((a) => a.kind === 'lan')
  const main = lan[0]
  const port = window.location.port
  const portPart = port ? `:${port}` : ''
  const localUrl = `http://${(info.hostname || 'repo').toLowerCase().replace(/\.local$/, '')}.local${portPart}`
  const [name, setName] = useState('')
  const [check, setCheck] = useState(null)
  const nameUrl = name.trim() ? (/^https?:\/\//i.test(name.trim()) ? name.trim() : `http://${name.trim()}`).replace(/\/+$/, '') : ''

  const testName = async () => {
    setCheck('testing')
    try {
      const { data } = await api.get('/network/check-address', { params: { url: nameUrl } })
      setCheck(data.status)
    } catch {
      setCheck('mismatch')
    }
  }

  const print = () => {
    document.body.classList.add('print-guide')
    const done = () => {
      document.body.classList.remove('print-guide')
      window.removeEventListener('afterprint', done)
    }
    window.addEventListener('afterprint', done)
    window.print()
  }

  return (
    <Card
      className="setup-guide"
      style={{ marginBottom: 16 }}
      title={
        <span>
          <SafetyCertificateOutlined /> {t('guide_title')}
        </span>
      }
      extra={
        <Button icon={<PrinterOutlined />} onClick={print} className="no-print">
          {t('guide_print')}
        </Button>
      }
    >
      <Alert type="warning" showIcon title={t('guide_why')} style={{ marginBottom: 16 }} />

      {/* No router: the laptop joins phone hotspots and its IP changes every time */}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        title={t('guide_hotspot_title')}
        description={
          <div>
            <p style={{ margin: '4px 0 8px' }}>{t('guide_hotspot_body')}</p>
            <div className="page-actions" style={{ alignItems: 'center' }}>
              <Code>{localUrl}</Code>
              <Button size="small" type="primary" onClick={() => onUseAddress(localUrl)} className="no-print">
                {t('net_use_for_qr')}
              </Button>
            </div>
            <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
              {t('guide_hotspot_test')}
            </Typography.Text>
          </div>
        }
      />

      <div className="guide-facts">
        <div>
          <span>{t('net_hostname')}</span>
          <b className="serial">{info.hostname || '—'}</b>
        </div>
        <div>
          <span>{t('guide_current_ip')}</span>
          <b className="serial">{main?.ip || '—'}</b>
        </div>
        <div>
          <span>{t('guide_mac')}</span>
          <b className="serial">{main?.mac || '—'}</b>
        </div>
        <div>
          <span>{t('guide_port')}</span>
          <b className="serial">{port || '80'}</b>
        </div>
      </div>

      <Steps
        orientation="vertical"
        size="small"
        current={-1}
        items={[
          {
            title: t('guide_s1_title'),
            content: (
              <div className="guide-step">
                <p>{t('guide_s1_body')}</p>
                <p dir="ltr" style={{ textAlign: 'start' }}>
                  MAC: <Code>{main?.mac || '—'}</Code> → IP: <Code>{main?.ip || '—'}</Code>
                </p>
                <Typography.Text type="secondary">{t('guide_s1_alt')}</Typography.Text>
              </div>
            ),
          },
          {
            title: (
              <span>
                {t('guide_s2_title')} <Tag color="green">{t('guide_recommended')}</Tag>
              </span>
            ),
            content: (
              <div className="guide-step">
                <p>{t('guide_s2_body', { ip: main?.ip || '…' })}</p>
                <p>
                  {t('guide_example')}: <bdi dir="ltr"><Code>repo</Code> → <Code>{main?.ip || '…'}</Code> = <Code>{`http://repo${portPart}`}</Code></bdi>
                </p>
                <Space.Compact style={{ width: '100%', maxWidth: 560 }} className="no-print">
                  <Input
                    dir="ltr"
                    placeholder={`http://repo.company.local${portPart}`}
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value)
                      setCheck(null)
                    }}
                  />
                  <Button disabled={!nameUrl} loading={check === 'testing'} onClick={testName}>
                    {t('net_test')}
                  </Button>
                  <Button type="primary" disabled={check !== 'ok'} onClick={() => onUseAddress(nameUrl)}>
                    {t('net_use_for_qr')}
                  </Button>
                </Space.Compact>
                {check && check !== 'testing' && (
                  <div style={{ marginTop: 6 }}>
                    {check === 'ok' ? (
                      <Typography.Text type="success">
                        <CheckCircleOutlined /> {t('guide_name_ok')}
                      </Typography.Text>
                    ) : (
                      <Typography.Text type="danger">
                        <CloseCircleOutlined /> {t('guide_name_bad')}
                      </Typography.Text>
                    )}
                  </div>
                )}
              </div>
            ),
          },
          {
            title: t('guide_s3_title'),
            content: (
              <div className="guide-step">
                <p>{t('guide_s3_body')}</p>
                <Code>{`netsh advfirewall firewall add rule name="Equipment Repository" dir=in action=allow protocol=TCP localport=${port || 80}`}</Code>
              </div>
            ),
          },
          {
            title: t('guide_s4_title'),
            content: (
              <div className="guide-step guide-test">
                <div>
                  <p>{t('guide_s4_body')}</p>
                  <p>
                    {t('net_qr_address')}: <Code>{info.base_url || '—'}</Code>
                  </p>
                </div>
                {info.base_url && <QrCode value={info.base_url} size={110} />}
              </div>
            ),
          },
          {
            title: t('guide_s5_title'),
            content: (
              <div className="guide-step">
                <p>{t('guide_s5_body')}</p>
                <p>{t('guide_later')}</p>
              </div>
            ),
          },
        ]}
      />
    </Card>
  )
}
