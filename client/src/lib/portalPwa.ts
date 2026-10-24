/**
 * Portal-only progressive web application controls.
 *
 * The service worker is restricted to static application assets. These helpers
 * keep client-owned transient state from surviving a logout or a server-side
 * session loss on a shared device. They intentionally do not unregister the
 * worker: its static code cache contains no account information and supports a
 * safe future sign-in.
 */

const PORTAL_STORAGE_PREFIX = "readypackets.";
const PORTAL_RUNTIME_CACHE_PREFIX = "readypackets-portal-runtime-";

function clearStorageWithPrefix(storage: Storage): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(PORTAL_STORAGE_PREFIX)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

/**
 * Clears browser state that can be tied to a prior Portal user.
 *
 * This includes locally saved order drafts, UI state, and any future Portal
 * runtime cache. The worker precache is deliberately not removed because it is
 * static code and generic offline content only.
 */
export async function clearPortalClientRuntimeState(): Promise<void> {
  if (typeof window === "undefined") return;

  try {
    clearStorageWithPrefix(window.localStorage);
    clearStorageWithPrefix(window.sessionStorage);
  } catch {
    // Privacy cleanup is best effort when browser storage is disabled. The
    // server remains authoritative for every account and order operation.
  }

  try {
    if ("caches" in window) {
      const cacheNames = await window.caches.keys();
      await Promise.all(
        cacheNames
          .filter((cacheName) => cacheName.startsWith(PORTAL_RUNTIME_CACHE_PREFIX))
          .map((cacheName) => window.caches.delete(cacheName)),
      );
    }
  } catch {
    // A storage quota or private browsing restriction must not block logout.
  }

  try {
    const registration = await navigator.serviceWorker?.getRegistration("/");
    registration?.active?.postMessage({ type: "CLEAR_PORTAL_RUNTIME_STATE" });
  } catch {
    // The service worker is optional enhancement only.
  }
}

/** Path emitted by the Portal-only Vite injected-manifest build. */
export const PORTAL_SERVICE_WORKER_URL = "/portal-service-worker.js";
