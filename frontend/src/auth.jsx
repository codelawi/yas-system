import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Input, Modal, Typography } from 'antd'
import { LockOutlined } from '@ant-design/icons'
import api, { errorKey, tokenStore } from './api'
import { useLang } from './i18n'

const AuthContext = createContext(null)
const USER_KEY = 'repo_user'

function readUser() {
  try {
    return tokenStore.get() ? JSON.parse(localStorage.getItem(USER_KEY)) : null
  } catch {
    return null
  }
}

/**
 * Viewing is open to everyone; any change asks for a personal PIN.
 * Call `await requirePin()` before a change: it resolves to the user, or null if cancelled.
 */
export function AuthProvider({ children }) {
  const { t } = useLang()
  const [user, setUser] = useState(readUser)
  const [open, setOpen] = useState(false)
  const [pin, setPin] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const waiters = useRef([])

  const clear = useCallback(() => {
    tokenStore.clear()
    localStorage.removeItem(USER_KEY)
    setUser(null)
  }, [])

  useEffect(() => {
    window.addEventListener('auth:expired', clear)
    // Make sure a stored token is still valid
    if (tokenStore.get()) api.get('/auth/me').catch(() => {})
    return () => window.removeEventListener('auth:expired', clear)
  }, [clear])

  const settle = (ok) => {
    waiters.current.forEach((resolve) => resolve(ok))
    waiters.current = []
  }

  const requirePin = useCallback(() => {
    if (tokenStore.get() && user) return Promise.resolve(user)
    setPin('')
    setError(null)
    setOpen(true)
    return new Promise((resolve) => waiters.current.push(resolve))
  }, [user])

  const submit = async () => {
    if (!pin) return
    setLoading(true)
    setError(null)
    try {
      const { data } = await api.post('/auth/login', { pin })
      tokenStore.set(data.token)
      localStorage.setItem(USER_KEY, JSON.stringify(data.user))
      setUser(data.user)
      setOpen(false)
      settle(data.user)
    } catch (e) {
      setError(t(errorKey(e) || 'error'))
      setPin('')
    } finally {
      setLoading(false)
    }
  }

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout')
    } catch {
      /* token may already be gone */
    }
    clear()
  }, [clear])

  const value = useMemo(() => ({ user, isAdmin: user?.role === 'admin', requirePin, logout }), [user, requirePin, logout])

  return (
    <AuthContext.Provider value={value}>
      {children}
      <Modal
        open={open}
        title={
          <span>
            <LockOutlined /> {t('enter_pin')}
          </span>
        }
        okText={t('confirm')}
        cancelText={t('cancel')}
        confirmLoading={loading}
        onOk={submit}
        onCancel={() => {
          setOpen(false)
          settle(null)
        }}
        width={340}
        centered
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">{t('pin_hint')}</Typography.Paragraph>
        <Input.Password
          autoFocus
          size="large"
          inputMode="numeric"
          maxLength={8}
          value={pin}
          status={error ? 'error' : undefined}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          onPressEnter={submit}
          style={{ textAlign: 'center', letterSpacing: 6 }}
        />
        {error && <Typography.Text type="danger">{error}</Typography.Text>}
      </Modal>
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
