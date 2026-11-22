import api from '../api'
import { OCR_FILES } from './files'
import { serialIndex } from './text'

/**
 * The page's side of the text reader: one worker for the whole app, started on first use.
 * The models are downloaded once (about 30 MB) and kept on the phone.
 */
let worker = null
let loading = null
let nextId = 1
const waiting = new Map()
const progressListeners = new Set()

/**
 * Starts the reader (downloads the models the first time).
 * @param onProgress (fraction 0..1) while downloading
 */
export function loadOcr(onProgress) {
  if (onProgress) progressListeners.add(onProgress)
  loading ||= new Promise((resolve, reject) => {
    worker = new Worker(new URL('./ocr.worker.js', import.meta.url), { type: 'module' })
    worker.onmessage = ({ data: message }) => {
      if (message.type === 'progress') {
        const fraction = message.total ? message.loaded / message.total : 0
        progressListeners.forEach((listener) => listener(fraction))
      } else if (message.type === 'ready') {
        progressListeners.clear()
        resolve()
      } else if (message.type === 'failed') {
        progressListeners.clear()
        reset()
        reject(new Error(message.error))
      } else {
        const job = waiting.get(message.id)
        if (!job) return
        waiting.delete(message.id)
        if (message.type === 'lines') job.resolve(message.lines)
        else job.reject(new Error(message.error))
      }
    }
    worker.onerror = (event) => {
      progressListeners.clear()
      reset()
      reject(new Error(event.message || 'worker failed'))
    }
    worker.postMessage({ type: 'load', files: absolute(OCR_FILES) })
  })
  return loading
}

/** After a failure the next loadOcr starts again (e.g. the connection came back). */
function reset() {
  worker?.terminate()
  worker = null
  loading = null
  waiting.forEach((job) => job.reject(new Error('stopped')))
  waiting.clear()
}

const absolute = (files) => Object.fromEntries(Object.entries(files).map(([k, url]) => [k, new URL(url, location.href).href]))

/**
 * The text lines in a picture: [{ text, score, box: [[x, y] × 4] }] in the picture's pixels.
 * @param image ImageData (its pixels are handed to the worker: don't use it afterwards)
 * @param opts  { detMax, maxLines }
 */
export async function readText(image, opts = {}) {
  await loadOcr()
  const id = nextId++
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    worker.postMessage({ type: 'read', id, image: { data: image.data, width: image.width, height: image.height }, opts }, [image.data.buffer])
  })
}

/** The system's serial numbers (to recognise readings), fetched at most once a minute. */
let serials = null
export function loadSerialIndex() {
  if (!serials || Date.now() - serials.at > 60_000) {
    const promise = api
      .get('/equipment/serial-list')
      .then(({ data }) => serialIndex(data.serials))
      .catch(() => {
        serials = null // try again next time
        return null
      })
    serials = { at: Date.now(), promise }
  }
  return serials.promise
}
