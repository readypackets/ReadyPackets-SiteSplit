/// <reference lib="webworker" />

/**
 * ReadyPackets Portal service worker.
 *
 * This worker deliberately precaches only versioned application code, branding,
 * fonts, and a generic offline notice. It has no runtime caching, background
 * sync, push, periodic sync, document caching, or API caching. Authentication,
 * customer data, order records, uploads, and downloads therefore remain online
 * only and are never retained by the browser worker.
 */
import { setCacheNameDetails } from "workbox-core";
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";
import { registerRoute, setCatchHandler, setDefaultHandler } from "workbox-routing";
import { NetworkOnly } from "workbox-strategies";

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision?: string | null }>;
};

const OFFLINE_PAGE_URL = "/offline.html";
const PORTAL_RUNTIME_CACHE_PREFIX = "readypackets-portal-runtime-";

// Namespacing is intentional: the Portal never clears caches belonging to any
// other application that may share an origin during a controlled migration.
setCacheNameDetails({ prefix: "readypackets-portal" });

// Injected at build time from a strict static-asset allowlist in vite.split.config.ts.
// No HTML application shell, API response, customer file, order document, media
// upload, or browser-generated state is added to this manifest.
precacheAndRoute(self.__WB_MANIFEST, { cleanURLs: false });
cleanupOutdatedCaches();

// Make the privacy boundary explicit rather than relying on Workbox defaults:
// every request that is not an exact precached static asset is network-only.
// In particular, /api/* requests, uploads, downloads, media, documents, and
// customer/admin navigation are never stored for later replay.
const networkOnly = new NetworkOnly();
registerRoute(
  ({ request }) => request.mode === "navigate" || request.url.includes("/api/"),
  networkOnly,
);
setDefaultHandler(networkOnly);

function isAnonymousEntryNavigation(request: Request): boolean {
  if (request.mode !== "navigate") return false;
  const path = new URL(request.url).pathname;
  return path === "/" || [
    "/login",
    "/register",
    "/verify-email",
    "/forgot-password",
    "/reset-password",
  ].includes(path);
}

// A failed anonymous entry navigation receives only a generic, non-account
// offline page. Authenticated, administrative, file, download, and workflow
// navigations fail normally rather than rendering cached customer content.
setCatchHandler(async ({ event }) => {
  const request = (event as FetchEvent).request;
  if (isAnonymousEntryNavigation(request)) {
    return (await caches.match(OFFLINE_PAGE_URL)) ?? Response.error();
  }
  return Response.error();
});

async function clearPortalRuntimeCaches(): Promise<void> {
  const cacheNames = await caches.keys();
  await Promise.all(
    cacheNames
      .filter((cacheName) => cacheName.startsWith(PORTAL_RUNTIME_CACHE_PREFIX))
      .map((cacheName) => caches.delete(cacheName)),
  );
}

self.addEventListener("message", (event) => {
  const message = event.data as { type?: unknown } | null;
  if (message?.type === "SKIP_WAITING") {
    void self.skipWaiting();
    return;
  }
  if (message?.type === "CLEAR_PORTAL_RUNTIME_STATE") {
    event.waitUntil(clearPortalRuntimeCaches());
  }
});
