import axios from 'axios'

const TOKEN_KEY = 'repo_token'

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
}

const api = axios.create({
  baseURL: '/api',
  headers: { Accept: 'application/json' },
})

api.interceptors.request.use((config) => {
  const token = tokenStore.get()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401 && tokenStore.get()) {
      tokenStore.clear()
      window.dispatchEvent(new Event('auth:expired'))
    }
    return Promise.reject(error)
  },
)

/** First validation message from a Laravel error response (a translation key or text). */
export function errorKey(error) {
  const data = error?.response?.data
  if (data?.errors) return Object.values(data.errors)[0]?.[0]
  return data?.message || error?.message
}

/** Link printed inside the QR code for a serial number. */
export function equipmentUrl(settings, serial) {
  const base = (settings?.base_url || window.location.origin).replace(/\/+$/, '')
  return `${base}/eq/${encodeURIComponent(serial)}`
}

export default api
