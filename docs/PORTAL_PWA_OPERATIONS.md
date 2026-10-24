# ReadyPackets Portal PWA Operations

## Purpose and scope

The ReadyPackets Portal is installable as a Progressive Web App (PWA) on the dedicated Portal hostname. It provides a native-like launcher, standalone browser window, branded icon, controlled update prompt, and a generic offline notice for entry pages.

This is intentionally **not** an offline customer-workspace product. Orders, uploads, documents, workflow answers, messages, staff records, checkout data, administration data, and API responses remain online-only.

## Security and privacy design

| Surface | Behavior |
| --- | --- |
| Service worker | Generated only by the `build:portal` split build; never by the public-site split build. |
| Precache | Versioned JavaScript/CSS, self-hosted fonts, approved brand assets, favicon, and generic `offline.html`/`offline.css` only. |
| Runtime cache | Disabled. All unmatched requests use `NetworkOnly`. |
| API and data | `/api/*` responses receive `Cache-Control: no-store, max-age=0, must-revalidate`; the worker does not cache them. |
| Portal navigation | Online-only. A failed navigation renders the generic offline page only for `/`, `/login`, `/register`, `/verify-email`, `/forgot-password`, and `/reset-password`. Authenticated and administrative routes fail normally when offline. |
| Files and uploads | Online-only; no document, upload, download, media, or order/workflow content is precached or runtime cached. |
| Background behavior | No background sync, periodic sync, push, or offline mutation queue is implemented. |
| Shared devices | Explicit logout, a five-minute active-tab revalidation, the server expiry timestamp, and any same-origin `401` clear Portal-prefixed browser storage, future Portal runtime caches, and in-memory React Query results. |
| Updates | The worker is checked with `updateViaCache: "none"`; the user selects **Reload and update** before a waiting worker takes control. Only that initiating tab reloads automatically. Other tabs keep their work until their own user chooses reload. |

## Build and release checks

Run these checks from the Portal repository before deployment:

```bash
pnpm run typecheck
pnpm exec vitest run tests/portalPwa.test.ts tests/headers.test.ts
NODE_ENV=production pnpm run build:client
pnpm audit --prod
```

A successful Portal build must contain these artifacts:

```text
client/dist-portal/portal-service-worker.js
client/dist-portal/manifest.webmanifest
client/dist-portal/offline.html
client/dist-portal/offline.css
```

`build:client` runs `verify:pwa-build` automatically. It verifies the emitted
Portal manifest and 192px/512px approved icon files, inspects the generated
worker's injected static-only precache, and rejects Portal PWA files in both
legacy and public bundles. It must pass before deployment.

The production dependency lock also pins the Microsoft Graph authentication
library to its security-patched MSAL release until Azure Identity widens its
declared compatible range. Always deploy from the committed `pnpm-lock.yaml`
with `pnpm install --frozen-lockfile`; do not regenerate the lockfile on the
VPS.

For a narrow manual check that the static public bundle remains free of Portal
PWA artifacts:

```bash
NODE_ENV=production pnpm run build:public
for path in \
  client/dist-public/manifest.webmanifest \
  client/dist-public/offline.html \
  client/dist-public/portal-service-worker.js; do
  test ! -e "$path"
done
```

## Self-hosted deployment requirements

1. Serve the Portal over HTTPS with the canonical Portal hostname. Service workers are unavailable on insecure origins except localhost development.
2. Preserve the application cache rules: the service worker script and all `/api/*` endpoints must be `no-store`; content-hashed static assets may be immutable.
3. Do not place a CDN rule in front of the Portal that caches HTML, `/api/*`, uploads, downloads, or `portal-service-worker.js`.
4. Keep the existing CSP `worker-src 'self'` and `manifest-src 'self'` directives. Do not weaken CSP with `unsafe-inline` or broad worker sources.
5. Test installability and the update prompt on Android Chrome, iOS Safari's **Add to Home Screen** flow, and a desktop Chromium browser. iOS does not emit Chromium's `beforeinstallprompt`, so the install banner is intentionally absent there while the manifest and Home Screen install remain supported.

## Operator verification checklist

After deployment:

1. Open the Portal sign-in page over HTTPS and confirm the browser application panel sees `manifest.webmanifest` and `portal-service-worker.js`.
2. Install the Portal, open it from the device launcher, and verify it opens at `/login` in standalone mode.
3. Disable network access and open `/login`; the generic offline page may appear. Confirm `/portal`, `/admin`, API calls, downloads, and uploads do **not** reveal cached account information.
4. Sign in, create a harmless draft order configuration, sign out, then sign in with a different test account. Confirm the draft and previous query-backed page data do not reappear.
5. Deploy an updated Portal build. Confirm the current session receives a user-controlled **Reload and update** prompt; verify the initiating tab refreshes only after the user chooses it and another open tab is not refreshed without its own confirmation.

## Intentional limitations

The PWA does not provide offline order drafting, offline file access, notifications, background uploads, or device-to-device sync. Those features would require a separate encrypted offline-data architecture, per-user key management, conflict resolution, explicit consent, threat modeling, recovery controls, and dedicated mobile/offline security review before they could be enabled.
