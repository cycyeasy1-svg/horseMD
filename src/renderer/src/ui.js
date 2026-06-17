// Tiny shared UI helpers used across components.

// Transient toast channel. App listens for this event and shows a bottom-center
// toast; anyone can fire it. Keeping the channel name in one place avoids a typo
// silently breaking toasts (no compile error on a mismatched string literal).
export const HM_TOAST_EVENT = 'hm:toast'
// `opts.sticky` keeps the toast up until the user dismisses it (× button) —
// use it for messages worth reading, like where a file was saved.
export const fireToast = (msg, opts) =>
  window.dispatchEvent(
    new CustomEvent(HM_TOAST_EVENT, { detail: opts?.sticky ? { msg, sticky: true } : msg })
  )

// Copy text to the clipboard and toast `doneMsg` on success (errors swallowed).
export const copyToClipboard = (text, doneMsg) =>
  navigator.clipboard
    ?.writeText(text || '')
    .then(() => fireToast(doneMsg))
    .catch(() => {})
