/**
 * Current-rep identity, persisted in the browser.
 *
 * The dashboard has one shared password, so "who did this" can't come from
 * auth. Instead each rep picks their name once in the header (HeaderTools)
 * and it's remembered per-browser in localStorage. Action POSTs read it at
 * click time and send it as `actor`, which /api/actions/process-order
 * already stores in the processing_actions.actor column.
 *
 * Window guards make this safe to import anywhere — on the server it just
 * returns null.
 */

const KEY = 'dashboard_rep'

export function getCurrentRep(): string | null {
  if (typeof window === 'undefined') return null
  const value = window.localStorage.getItem(KEY)
  return value && value.trim() !== '' ? value : null
}

export function setCurrentRep(rep: string | null): void {
  if (typeof window === 'undefined') return
  if (rep && rep.trim() !== '') {
    window.localStorage.setItem(KEY, rep)
  } else {
    window.localStorage.removeItem(KEY)
  }
}
