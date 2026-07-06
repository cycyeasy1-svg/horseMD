// Pure Mermaid render core — the theme-keyed LRU cache, lazy import, concurrency
// gate and retry logic, with NO Milkdown/ProseMirror dependency. Split out of
// editor-mermaid.js so the VSCode extension webview can bundle it directly (the
// plugin half pulls in @milkdown/prose). The app and the extension share one
// implementation; only the theme lookup differs, injected via
// setMermaidThemeResolver (default: the app's `dark` body class).

// Capped LRU cache keyed by `theme::code`. Map preserves insertion order, so the
// oldest key is evicted first; a read re-inserts the hit to mark it MRU. Caps the
// growth from a long session editing many distinct diagrams (each keystroke
// produces a new key). Values are { svg } or { error }.
const CACHE_MAX = 120
const cache = new Map()
const cacheGet = (k) => {
  const v = cache.get(k)
  if (v !== undefined) {
    cache.delete(k)
    cache.set(k, v)
  }
  return v
}
const cacheSet = (k, v) => {
  cache.set(k, v)
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
}

// Renders in flight, keyed by theme::code → array of waiting onDone callbacks.
// Using a Map (not a Set) means a SECOND block with the same source (or any
// caller that arrives mid-render) still gets its onDone fired when the render
// lands — otherwise it would sit on "rendering…" forever.
const pending = new Map()
const retried = new Set() // keys whose first render errored and get a one-shot retry
let mermaidMod = null
let mermaidTheme = null // theme mermaid was last initialize()d for
let idSeq = 0 // monotonic render id (guaranteed unique, unlike Math.random)

async function getMermaid() {
  if (mermaidMod) return mermaidMod
  const m = await import('mermaid')
  mermaidMod = m.default || m
  return mermaidMod
}

// Maps the host environment to a mermaid theme ('dark' | 'default'). The app's
// dark mode is a `dark` body class; the VSCode webview injects its own resolver
// (vscode-dark / the keep warm themes) at startup.
let themeResolver = () => (document.body.classList.contains('dark') ? 'dark' : 'default')
export function setMermaidThemeResolver(fn) {
  if (typeof fn === 'function') themeResolver = fn
}
export const curTheme = () => themeResolver()
const keyFor = (theme, code) => theme + '::' + code

// At most this many DISTINCT diagrams render at once. mermaid.render is largely
// synchronous main-thread work, so a diagram-dense doc scrolled quickly could
// otherwise stack many parses into one frame; excess renders queue FIFO (the
// IntersectionObserver in keep mode already staggers arrivals by viewport, this
// bounds the worst case). Same-source callers still coalesce via `pending`.
const MAX_CONCURRENT_RENDERS = 2
let rendersInFlight = 0
const renderQueue = []
function pumpRenderQueue() {
  while (rendersInFlight < MAX_CONCURRENT_RENDERS && renderQueue.length) {
    rendersInFlight++
    const job = renderQueue.shift()
    job().finally(() => {
      rendersInFlight--
      pumpRenderQueue()
    })
  }
}

// Render `code` to an SVG (async, cached), then call every onDone waiting on it.
// Registers the pending entry synchronously (so concurrent same-source callers
// coalesce) and queues the actual render behind the concurrency gate above.
export async function ensureRender(theme, code, onDone) {
  const k = keyFor(theme, code)
  if (cacheGet(k)) {
    onDone?.()
    return
  }
  const waiters = pending.get(k)
  if (waiters) {
    // Already rendering this exact source — just queue, don't start a second.
    waiters.push(onDone)
    return
  }
  pending.set(k, onDone ? [onDone] : [])
  renderQueue.push(() => renderNow(k, theme, code, onDone))
  pumpRenderQueue()
}

// The actual render. Mermaid is initialize()d at most once per theme
// (re-initializing on every render is a known way to break subsequent
// diagrams). The FIRST render after the lazy import can race with Mermaid's
// init and fail — on error we retry once (re-entering ensureRender, i.e. the
// retry re-queues behind the gate) before caching the error.
async function renderNow(k, theme, code, onDone) {
  const id = 'hm-mermaid-' + ++idSeq
  let result = null
  try {
    const mermaid = await getMermaid()
    if (mermaidTheme !== theme) {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme })
      mermaidTheme = theme
    }
    const { svg } = await mermaid.render(id, code)
    result = { svg }
    retried.delete(k)
  } catch (e) {
    if (!retried.has(k)) {
      retried.add(k)
      pending.delete(k)
      document.getElementById(id)?.remove()
      document.getElementById('d' + id)?.remove()
      setTimeout(() => ensureRender(theme, code, onDone), 300)
      return
    }
    result = { error: (e && e.message) || String(e) }
    retried.delete(k)
  } finally {
    if (result) cacheSet(k, result)
    const cbs = pending.get(k) || []
    pending.delete(k)
    document.getElementById(id)?.remove()
    document.getElementById('d' + id)?.remove()
    cbs.forEach((cb) => cb?.())
  }
}

// ---- shared API (KeepEditor, the rich-editor preview, the VSCode webview) -----
// Synchronous cache peek — paint an already-rendered diagram with no async flash
// (keep mode re-renders on every edit). null = not yet rendered.
export function peekMermaidSvg(code, theme = curTheme()) {
  return cacheGet(keyFor(theme, (code || '').trim())) || null
}
// Promise-returning render that shares the cache above. Resolves to { svg } or
// { error }. Concurrent requests for the same diagram share one in-flight render.
export function getMermaidSvg(code, theme = curTheme()) {
  const trimmed = (code || '').trim()
  if (!trimmed) return Promise.resolve({ error: '' })
  const k = keyFor(theme, trimmed)
  const hit = cacheGet(k)
  if (hit) return Promise.resolve(hit)
  return new Promise((resolve) => {
    ensureRender(theme, trimmed, () => resolve(peekMermaidSvg(trimmed, theme) || { error: '' }))
  })
}
