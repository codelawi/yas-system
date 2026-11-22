// Files the text reader needs (served with the app; the build gives them hashed names)
import det from 'paddleocr-browser/dist/ppocr_det.onnx?url'
import rec from 'paddleocr-browser/dist/rec_en_PP-OCRv3_infer.onnx?url'
import cls from '@ocr-models/ch_ppocr_mobile_v2.0_cls_infer.onnx?url'
import wasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'

export const OCR_FILES = { det, rec, cls, wasm }

/** Where a phone keeps them (also read by the service worker: keep in sync with sw.js). */
export const OCR_CACHE = 'repo-ocr'

/** Saves them on the phone for working offline (the "Work offline" page). */
export async function saveOcrFiles() {
  const cache = await caches.open(OCR_CACHE)
  const urls = Object.values(OCR_FILES)
  const missing = []
  for (const url of urls) if (!(await cache.match(url, { ignoreVary: true }))) missing.push(url)
  if (missing.length) await cache.addAll(missing)
  // Older versions' files
  for (const request of await cache.keys()) {
    if (!urls.some((url) => new URL(url, location.href).href === request.url)) await cache.delete(request)
  }
}
