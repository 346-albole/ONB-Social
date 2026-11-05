/**
 * Wraps a promise with a timeout.
 * If the promise doesn't resolve within `ms`, resolves with `fallback`.
 * Prevents infinite loading spinners when Supabase is slow or hanging.
 */
export function withTimeout(promise, ms = 8000, fallback = null) {
  let timer
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Wraps an async load function so `loading` is ALWAYS reset to false,
 * even if the function throws, rejects, or times out.
 *
 * Usage:
 *   const safeLoad = makeSafeLoader(loading)
 *   await safeLoad(async () => { ... })
 */
export function makeSafeLoader(loadingRef, timeoutMs = 8000) {
  return async function safeLoad(fn) {
    loadingRef.value = true
    // Hard ceiling: loading can NEVER stay true longer than timeoutMs
    const hardTimer = setTimeout(() => {
      loadingRef.value = false
    }, timeoutMs)
    try {
      await fn()
    } catch (e) {
      console.warn('[safeLoad] Erreur attrapée:', e)
    } finally {
      clearTimeout(hardTimer)
      loadingRef.value = false
    }
  }
}
