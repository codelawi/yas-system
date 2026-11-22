/**
 * Reads text off the camera picture away from the page, so the camera stays smooth.
 * Messages in: { type: 'load', files: { det, rec, cls, wasm } } and
 * { type: 'read', id, image: ImageData-like, opts }. Messages out: { type: 'progress', loaded, total },
 * { type: 'ready' }, { type: 'failed', error }, and { type: 'lines', id, lines } or { type: 'error', id, error }.
 */
import * as ort from 'onnxruntime-web/wasm'
import { createEngine } from './engine'
import { OCR_CACHE } from './files'

let engine = null

self.onmessage = async ({ data: message }) => {
  if (message.type === 'load') {
    try {
      engine ||= await load(message.files)
      self.postMessage({ type: 'ready' })
    } catch (error) {
      self.postMessage({ type: 'failed', error: String(error?.message || error) })
    }
    return
  }
  if (message.type === 'read') {
    try {
      const lines = await engine.recognize(message.image, message.opts)
      self.postMessage({ type: 'lines', id: message.id, lines })
    } catch (error) {
      self.postMessage({ type: 'error', id: message.id, error: String(error?.message || error) })
    }
  }
}

async function load(files) {
  const urls = [files.det, files.rec, files.cls, files.wasm]
  const sizes = urls.map(() => ({ loaded: 0, total: 0 }))
  const report = () => {
    const loaded = sizes.reduce((sum, s) => sum + s.loaded, 0)
    const total = sizes.reduce((sum, s) => sum + s.total, 0)
    self.postMessage({ type: 'progress', loaded, total })
  }
  const [det, rec, cls, wasm] = await Promise.all(urls.map((url, i) => download(url, sizes[i], report)))

  // One thread unless the page is cross-origin isolated (threads need it)
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1
  ort.env.wasm.wasmBinary = wasm
  ort.env.wasm.wasmPaths = { wasm: files.wasm }
  return createEngine(ort, { det, rec, cls })
}

/** A file from the phone's saved copy (kept for working offline), otherwise from the server, then saved. */
async function download(url, size, report) {
  const cache = await openCache()
  let response = cache ? await cache.match(url, { ignoreVary: true }) : null
  if (!response) {
    response = await fetch(url)
    if (!response.ok) throw new Error(`${url}: ${response.status}`)
    if (cache) await cache.put(url, response.clone()).catch(() => {})
  }
  size.total = Number(response.headers.get('Content-Length')) || 0
  if (!response.body || !size.total) {
    const buffer = await response.arrayBuffer()
    size.loaded = size.total = buffer.byteLength
    report()
    return buffer
  }
  // Content-Length is only a guide: a compressed answer is longer once read
  const reader = response.body.getReader()
  const chunks = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size.loaded += value.length
    size.total = Math.max(size.total, size.loaded)
    report()
  }
  const bytes = new Uint8Array(size.loaded)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  return bytes.buffer
}

async function openCache() {
  try {
    return 'caches' in self ? await caches.open(OCR_CACHE) : null
  } catch {
    return null // e.g. plain http: no saved copy
  }
}
