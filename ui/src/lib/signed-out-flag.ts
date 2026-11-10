/** Set on sign-out so /login does not sign this browser straight back in; cleared by an explicit "Sign in" click. Storage may be blocked. */
const KEY = "ftown-signed-out";

function stores(): Storage[] {
  const found: Storage[] = [];
  try { if (typeof sessionStorage !== "undefined") found.push(sessionStorage); } catch { /* blocked */ }
  try { if (typeof localStorage !== "undefined") found.push(localStorage); } catch { /* blocked */ }
  return found;
}
export function markSignedOut(): void {
  for (const store of stores()) { try { store.setItem(KEY, "1"); } catch { /* blocked */ } }
}
export function clearSignedOut(): void {
  for (const store of stores()) { try { store.removeItem(KEY); } catch { /* blocked */ } }
}
export function isSignedOut(): boolean {
  for (const store of stores()) { try { if (store.getItem(KEY) === "1") return true; } catch { /* blocked */ } }
  return false;
}
