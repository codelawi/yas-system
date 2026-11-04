import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import api from './api'

const SettingsContext = createContext(null)

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(null)

  const reload = useCallback(() => api.get('/settings').then(({ data }) => setSettings(data)), [])

  useEffect(() => {
    reload().catch(() => setSettings({}))
  }, [reload])

  return <SettingsContext.Provider value={{ settings: settings || {}, setSettings, reload }}>{children}</SettingsContext.Provider>
}

export const useSettings = () => useContext(SettingsContext)

/** True when QR codes would point to localhost (phones cannot open that). */
export function qrPointsToLocalhost(settings) {
  return !settings?.base_url && ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)
}
