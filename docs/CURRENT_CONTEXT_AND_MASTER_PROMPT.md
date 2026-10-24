# ReadyPackets Portal — Current Context and Master Prompt

**Version:** 2026-08-12  
**Status:** Self-hosted production implementation record

## Product mandate

ReadyPackets is a self-hosted customer website and operations portal for structured business-packet services. The platform must run on a native VPS or Docker deployment without Manus runtime dependencies. It provides a public website, customer portal, staff/admin console, secure order lifecycle, collaboration, policies, files, support, integrations, and operational controls.

## Non-negotiable principles

| Principle | Current implementation direction |
|---|---|
| **Self-hosted operation** | Native Ubuntu VPS deployment and Docker Compose deployment are supported by the unified installer. |
| **Security by design** | TLS, nonce-based CSP, CSRF protections, rate limiting, MFA, server-side authorization, encrypted sensitive fields, blind-index account lookup, secure logging, and protected lifecycle helpers. |
| **No public AI positioning** | Public site and customer portal avoid claims or references to AI usage. |
| **ReadyPackets brand** | Navy, teal, and gold visual language; System/Light/Dark user appearance controls; accessible customer/admin surfaces. |
| **Customer ownership** | Policies, secure files, Packet Collective workspaces, referrals, support, self-service security, and customer-facing opaque account references. |
| **Audited administration** | Administrative lifecycle, security, deletion/recovery, integration, automation, backup, and publishing actions create traceable activity records. |

## Implemented platform capabilities

### Customer and order delivery

The portal supports persistent packet-cart selection with one tier per group, coupon methods for percentage, fixed amount, and fixed final cart price, configurable Stripe Checkout readiness, order status/progress, Phase 1 and Phase 2 question workflows, web-based Business Pitch recording, files, support, policies, referral sharing, announcements, and a published Knowledge Base.

Packet Collective allows organization workspaces and scoped order sharing. Customers can be granted view, document-upload, final-deliverable viewing, Business Pitch recording, contributor, or manager permissions.

### Administration and governance

The admin console supports customers, orders, soft-delete trash and bulk restore, question banks, finance, Stripe testing, coupons, referrals, templates, email delivery history/retries/resends, automations, policy center, knowledge base approval, announcements, public FAQ publishing, marketing campaigns and aggregate promotion-link measurement, integrations, backups, security logs, SAML/Entra setup, maintenance gates, changelog publishing, and platform updates.

### Security and operations

Sensitive user and integration fields use AES-256-GCM with bound associated data. Standard configuration exports exclude application keys, database credentials, and integration secrets. The public account reference is opaque and unique in `RP-U-XXXXXXXXXXXX` form; internal relational IDs remain server-side only.

The platform includes protected backup, restore, configuration export, cloud synchronization, release scan/approval/rollback, native installer, Docker installer, factory reset, and operational documentation paths.

### Portal PWA boundary — 2026-10-23

The dedicated Portal split bundle is installable as a PWA. The separate public website and legacy combined bundle do not register a service worker or ship Portal manifest/offline assets. The injected-manifest worker precaches only versioned static JavaScript/CSS, self-hosted fonts, approved brand assets, favicon, and a generic offline notice. It has no runtime caching, background sync, periodic sync, push, API caching, document caching, file caching, upload queue, or offline customer data.

Every `/api/*` response and `portal-service-worker.js` is explicitly `no-store`; user-controlled updates use `updateViaCache: "none"` and a waiting-worker prompt. Offline fallback is limited to anonymous entry paths. Authenticated Portal/admin navigation, uploads, downloads, orders, workflow, and all customer/staff data remain network-only. Explicit logout and server-detected session loss clear ReadyPackets-prefixed browser storage, Portal runtime caches, and in-memory React Query results before another account can use the tab. Operator verification is documented in `docs/PORTAL_PWA_OPERATIONS.md`; regression coverage is in `tests/portalPwa.test.ts`.

## Current priority backlog

| Priority | Remaining item |
|---|---|
| **P0** | Configure and perform verified Stripe test-mode/live-mode webhook and payment lifecycle tests. |
| **P0** | Repair protected backup execution and restore readiness; add provider-specific cloud remote configuration for Amazon S3, Wasabi, Backblaze B2, Azure Blob Storage, SharePoint, Google Drive, OneDrive, and Dropbox; then perform verified backup and restore drills. |
| **P1** | Add a secret-safe platform-setup configuration bundle that records setup-wizard selections, supports administrator-authorized export/import during a new install, and can be retained under a Git-tracked `config/` template directory without committing runtime secrets or customer data. |
| **P1** | Configure Microsoft Graph consent and perform a real SharePoint folder-sync test. |
| **Completed — 2026-08-12** | Administrator-published FAQ system, public WCAG 2.2 AA-focused remediation and accessibility statement, server-rendered SEO/discovery metadata with sitemap and structured data, and administrator marketing workspace are deployed. Continue periodic accessibility, Search Console, and campaign-performance review. |
| **P1** | Add browser-level end-to-end regression coverage for SAML, magic links/MFA, checkout, file upload, policies, backup download, and rollback authorization. |
| **P2** | Migrate the production host to provider-managed encrypted storage or an encrypted volume with a planned downtime/restore procedure. |
| **P2** | Reconcile historic direct-SQL migration journal entries and modernize the remaining chart-library major version in a separately tested release. |

## Current release process

All source changes, database migrations, scripts, reports, and session logs are committed to the private `readypackets/ReadyPackets` GitHub repository. A reviewed release is built, type-checked, tested, migrated, deployed with a rollback artifact, health-checked, security-verified, logged, and pushed to GitHub.
