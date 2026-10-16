# ReadyPackets Portal — Self-Hosted Architecture & Security Design

**Document version:** 1.0 (rebuild) — August 2026
**Applies to:** ReadyPackets public website + customer portal + admin panel
**Deployment targets:** single VPS (nginx + systemd) or Docker/Compose container stack
**Author:** Manus AI

---

## 1. Design mandate

This rebuild replaces the previous platform with an implementation that is deployable entirely on infrastructure the operator controls. Three constraints govern every decision below.

The first constraint is **sovereignty**: the application must contain no dependency on the Manus platform. There is no Manus OAuth, no Manus SDK or storage proxy, no Manus Vite runtime plugin, and no Manus-hosted asset delivery. Authentication is performed locally, brand assets are served from the application's own filesystem, and the web fonts are bundled into the build rather than fetched from Google Fonts. The practical consequence is that a running instance makes **zero outbound requests at page load**, which removes an entire category of supply-chain and privacy exposure.

The second constraint is **minimised attack surface**. The application ships with a strict, nonce-based Content Security Policy that permits no inline or evaluated script, a double-submit CSRF token bound to the session, `__Host-`prefixed cookies, and a defence-in-depth request pipeline that rejects hostile traffic before it reaches business logic. Every finding in the Batch 39 gap analysis rated P0 or P1 is resolved structurally rather than patched, and the P2 items are implemented where they affect security or compliance.

The third constraint is **operability by a small team**. Code is organised into small feature modules rather than the monolithic router and data-access files that the gap analysis identified as maintainability risks, the installer is idempotent, and backup, upgrade, and health-check procedures are scripted.

---

## 2. Technology selection

| Layer | Choice | Rationale |
|---|---|---|
| UI framework | React 19 + TypeScript 5 | Component reuse across three surfaces; compile-time type safety across the API boundary |
| Styling | Tailwind CSS 4 with brand design tokens | No runtime CSS-in-JS, therefore no inline `<style>` injection that would require a CSP exemption |
| Routing | Wouter | Small, dependency-light client router |
| API transport | tRPC 11 over Express 4 | End-to-end types without a code-generation step; a single HTTP surface to harden |
| Data access | Drizzle ORM + mysql2 | Parameterised SQL by construction, which eliminates injection through the query path |
| Database | MySQL 8 (utf8mb4) | Operator-familiar, available in every VPS and container registry |
| Password hashing | Argon2id, bcrypt fallback | Memory-hard primary algorithm with transparent rehash-on-login migration for legacy bcrypt hashes |
| Sessions | Signed JWT in `__Host-` cookie plus a server-side session record | Stateless verification with server-side revocation, which JWT alone cannot provide |
| MFA | TOTP (RFC 6238) with single-use backup codes | Offline verification; no third-party dependency |
| Enterprise SSO | SAML 2.0, disabled by default | Optional Entra ID/Okta support without adding a mandatory dependency |
| Mail | SMTP via nodemailer | Operator supplies any SMTP relay; no vendor lock-in |
| File storage | Local encrypted disk by default, S3-compatible object storage for scale-out | Works on a bare VPS; shared object storage enables regional replicas |
| Build | Vite 6 (client) and esbuild (server) | Fast, reproducible, produces a single server bundle |
| Runtime | Node.js 22 LTS | Current LTS with modern crypto APIs |
| Process supervision | systemd unit, or Docker restart policy | Native to each deployment target |
| Reverse proxy | nginx with TLS from Let's Encrypt | Terminates TLS, serves static assets, enforces HSTS |

Payment capture is implemented as an **optional Stripe Checkout hand-off** that is inert unless the operator supplies keys. No card data ever reaches the application, which keeps the deployment outside PCI DSS scope beyond SAQ-A obligations. When Stripe is not configured, orders are created in an `awaiting_invoice` state and the operator invoices out of band.

---

## 3. Runtime topology

```
                    ┌──────────────────────────────────────────┐
   Internet ───443──▶ nginx (TLS 1.2/1.3, HSTS, static assets) │
                    └───────────────┬──────────────────────────┘
                                    │ proxy_pass 127.0.0.1:3000
                    ┌───────────────▼──────────────────────────┐
                    │ Node.js 22 — Express                     │
                    │  1. trust-proxy + real-IP resolution     │
                    │  2. IP blacklist (IP / CIDR / range)     │
                    │  3. adaptive rate limiter (6 categories) │
                    │  4. helmet + nonce CSP + permissions     │
                    │  5. Origin/Host + CSRF double submit     │
                    │  6. session resolution & MFA gate        │
                    │  7. tRPC router (feature modules)        │
                    └───────┬───────────────────┬──────────────┘
                            │                   │
              ┌─────────────▼──────┐   ┌────────▼─────────────┐
              │ MySQL 8 (localhost │   │ Encrypted file store │
              │ socket / compose   │   │ /var/lib/readypackets│
              │ private network)   │   │ or S3-compatible     │
              └────────────────────┘   └──────────────────────┘
```

Neither MySQL nor the Node process is exposed to a public interface. On a VPS the database listens on the loopback socket only; under Compose it sits on an internal bridge network with no published ports. The application binds `127.0.0.1` and is reachable exclusively through nginx.

---

## 4. Request pipeline and security controls

### 4.1 Ordering

Middleware order is itself a security property: cheap rejections precede expensive work, and authentication precedes authorisation. The pipeline is fixed in `server/app.ts` and each stage is independently testable.

| Stage | Module | Behaviour on failure |
|---|---|---|
| Real IP resolution | `security/clientIp.ts` | Falls back to socket address; ignores forwarded headers unless the hop is a configured trusted proxy |
| IP blacklist | `security/ipBlacklist.ts` | `403` with no body detail; hit counter incremented |
| Rate limiting | `security/rateLimit.ts` | `429` with `Retry-After` and `X-RateLimit-*`; progressive penalty applied |
| Security headers | `security/headers.ts` | Not applicable — always applied |
| Body parsing with hard size caps | Express JSON/urlencoded, 256 KB | `413` |
| Origin/Host validation and CSRF | `security/csrf.ts` | `403` for any unsafe method with a missing or mismatched token |
| Session resolution | `auth/session.ts` | Anonymous context; protected procedures then reject with `UNAUTHORIZED` |
| MFA and role gate | `trpc/procedures.ts` | `FORBIDDEN`, with a distinct `MFA_REQUIRED` code that the client turns into a setup redirect |

### 4.2 Content Security Policy

The policy is generated per request with a 128-bit random nonce and contains no `unsafe-inline` or `unsafe-eval` in any directive:

```
default-src 'self';
script-src 'self' 'nonce-<random>';
style-src 'self' 'nonce-<random>';
img-src 'self' data: blob:;
font-src 'self';
connect-src 'self';
frame-ancestors 'none';
form-action 'self';
base-uri 'none';
object-src 'none';
require-trusted-types-for 'script';
upgrade-insecure-requests
```

Achieving this required removing every inline script from the HTML shell and eliminating runtime style injection. The server rewrites the built `index.html` on each response to stamp the nonce onto the module script and stylesheet tags. When the operator enables Stripe Checkout, `script-src` and `frame-src` are extended with `https://js.stripe.com` only, and only for the checkout route.

Accompanying headers are `Strict-Transport-Security` with a two-year max-age and `includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, and a `Permissions-Policy` that denies camera, microphone, geolocation, USB, serial, and payment access except where Stripe requires it.

### 4.3 CSRF

Cookie `SameSite=Strict` is treated as a supplement rather than a control. Every state-changing request must satisfy three independent checks: the `Origin` (or `Referer`) hostname must equal the configured application hostname, a `X-RP-CSRF` header must be present, and its value must match both the `__Host-rp_csrf` cookie and the CSRF binding stored on the session row. Tokens are 32 random bytes, rotate on login and on privilege change, and comparison is constant-time.

### 4.4 Horizontal scaling and worker coordination

The one-host deployment remains the simplest supported starting point. For production growth, request-serving nodes are stateless: sessions, orders, queues, audit records, and rate-limit penalties are durable in MySQL; files move to private S3-compatible object storage; and a web replica can safely serve a request authenticated by any other replica. `INSTANCE_ROLE=web` prevents recurring work from starting on a web node. `INSTANCE_ROLE=worker` owns scheduled work, and MySQL named locks prevent an active/standby worker pair from running the same scheduler job concurrently.

The database remains the single write authority. A globally distributed deployment must keep database/object-store data residency, encryption-key custody, backup location, and recovery objectives explicit rather than assuming that regional compute replicas create a compliant multi-region service. The actionable rollout, region controls, and validation checklist are in [GLOBAL_SCALE_ARCHITECTURE.md](GLOBAL_SCALE_ARCHITECTURE.md).

### 4.5 Rate limiting and progressive penalties

Six categories are configurable at runtime from the admin panel and are stored in `rate_limit_configs`. Defaults:

| Category | Window | Limit | Applies to |
|---|---|---|---|
| Authentication & high risk | 30 min | 5 | login, password reset request, reset-token submission, MFA verification, MNDA signature |
| User logins | 15 min | 10 | session creation attempts per identity |
| Form submissions | 10 min | 20 | contact, intake, review, ticket creation |
| API | 1 min | 120 | authenticated tRPC calls |
| Expensive | 5 min | 10 | ZIP export, data export, CSV export, report generation |
| Standard browsing | 1 min | 300 | public GET traffic |

A first violation triggers a one-minute block, a second a fifteen-minute block, and a third a permanent entry in `ip_blacklist` with an audit record. Under sustained high load the limiter tightens all windows by a configurable factor, shedding abusive traffic before the database saturates. Counters are held in a bounded in-process store with periodic sweeping, so no external cache service is required.

The password-reset request endpoint and the reset-token submission endpoint are both bound to the authentication category, which closes gap-analysis findings 3.1 and 5.1. Reset tokens are 32 cryptographically random bytes, stored only as a SHA-256 hash, expire in thirty minutes, are single-use, and are cleared immediately on successful use.

### 4.5 Authentication semantics

Login is deliberately uniform. The lookup uses the HMAC blind index, and when no user matches, the handler still performs a hash verification against a pre-computed dummy digest so that response timing does not distinguish "unknown account" from "wrong password". All failure modes return the identical message `Invalid email or password.` Registration and password-reset responses are likewise non-committal about account existence, and administrative endpoints that previously returned "user not found" now return a generic failure, resolving findings 4.2 and 5.2.

Administrators cannot reach any `/admin` route or `adminProcedure` without an enrolled second factor. If an administrator authenticates without MFA configured, the session is issued in a restricted state whose only permitted operations are MFA enrolment and logout. This resolves findings 3.6 and 5.5. An optional administrator IP allowlist provides a further restriction for operators who have static addresses.

Email verification is enforced server-side inside the protected procedure guard rather than in the client, so an unverified account cannot reach portal data by calling the API directly.

### 4.6 Encryption at rest

Sensitive columns are encrypted with AES-256-GCM using a key supplied through the environment and never persisted by the application. Each value is stored as `v1:<iv>:<tag>:<ciphertext>`, with the record identifier bound in as additional authenticated data so ciphertext cannot be transplanted between rows. Because encrypted columns cannot be searched, every field that requires lookup carries a companion HMAC-SHA256 blind index; `users.email_index` is mandatory and is written on every insert and update path, which permanently prevents the login failure described in the master prompt's implementation notes.

Twelve fields are encrypted by default: the five name fields, email, phone, company, mailing address, customer notes, intake free-text answers, and ticket bodies.

### 4.7 File handling

Uploads are validated by magic-byte inspection of the decoded buffer rather than the client-declared MIME type, are constrained by an operator-configured extension allowlist, and are size-capped per category. Stored objects receive a random 24-byte object key that is unrelated to user, order, or file name, and the original filename is retained only as metadata, so enumeration of the storage directory yields nothing. Downloads are never served by static path: every request passes through an authorising handler that re-verifies the requester's ownership or administrative role and the file's visibility flag, then streams the object with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`. Short-lived signed tokens are used where a direct link is unavoidable. This closes findings 5.3 and 5.4.

### 4.8 Logging and observability

Three log streams exist. `security_logs` records authentication events, MFA changes, privilege changes, blacklist hits, and rate-limit penalties. `activity_logs` records user and administrator actions with actor, target, before/after summary, and severity. `system_alerts` records unhandled server errors and health-check failures for display in the admin panel. All three support full-text search, filtering by actor, severity, category, and date range, CSV export, and optional syslog forwarding. Secrets, tokens, password material, and full request bodies are never written to any stream; the logger applies a redaction pass over known-sensitive keys.

---

## 5. Data model

The schema is consolidated to **62 tables** grouped by domain. This is a deliberate reduction from the previous 100-table design: tables that existed only to hold a single settings row, near-duplicate log tables, and speculative integration tables have been merged into a typed key-value `site_settings` store or into a unified log table with a discriminator column. Fewer tables mean fewer migration paths and fewer places for an authorisation check to be forgotten.

| Domain | Tables |
|---|---|
| Identity and access | `users`, `user_mfa`, `user_backup_codes`, `user_sessions`, `password_reset_tokens`, `email_verification_tokens`, `login_methods`, `saml_configs`, `registration_fields`, `delegates` |
| Orders and delivery | `orders`, `order_items`, `order_status_history`, `order_phases`, `order_questions`, `order_answers`, `order_answer_history`, `order_notes`, `order_shares`, `intake_submissions`, `intake_answers`, `phase_kickoff_configs`, `phase_jobs` |
| Catalog | `packet_groups`, `products`, `product_features`, `bundle_rules`, `coupons` |
| Files | `files`, `file_versions`, `file_access_log`, `storage_targets`, `file_type_rules` |
| Agreements and policy | `policy_documents`, `policy_versions`, `policy_acceptances`, `mnda_acceptances` |
| Communication | `tickets`, `ticket_replies`, `ticket_attachments`, `messages`, `email_templates`, `email_queue`, `email_log`, `newsletter_subscribers`, `maintenance_subscribers`, `notification_preferences` |
| Community and content | `forum_categories`, `forum_topics`, `forum_posts`, `forum_reactions`, `reviews`, `changelog_entries`, `home_content_blocks` |
| Finance | `invoices`, `payments`, `refunds`, `referrals`, `payouts` |
| Platform | `site_settings`, `feature_flags`, `rate_limit_configs`, `ip_blacklist`, `security_logs`, `activity_logs`, `system_alerts`, `backup_log`, `api_keys`, `webhook_endpoints`, `webhook_deliveries`, `scheduled_jobs` |

Every table carries `created_at` and `updated_at`; user-owned tables carry an indexed `user_id` foreign key so that ownership can be asserted in a single predicate. Soft deletion uses `deleted_at` with a retention sweeper. Migrations are numbered, forward-only SQL files applied by an idempotent runner that records each applied file in `schema_migrations`.

### 5.1 Order lifecycle

An order advances through `new`, `phase_1_intake`, `phase_2_synthesis`, `in_production`, `delivered`, and `closed`, with `cancelled` and `refunded` as terminal branches. Two gates are enforced in the domain layer rather than the UI: an order cannot leave `phase_1_intake` until both a completed intake submission and a recorded MNDA acceptance exist, and it cannot enter `delivered` until at least one customer-visible deliverable file is attached. Each transition writes to `order_status_history` with actor and reason, fires configured webhooks through a retrying queue, and optionally provisions the order's folder structure and placeholder deliverables.

### 5.2 Catalog seeding

The seed loads seven packet groups and nineteen public products from the August 2026 catalogue, plus the unlisted Packet 8 institutional product, which is created with `is_listed = false` so it is quotable by staff but absent from the public catalogue. Prices are integers in cents throughout; no floating-point arithmetic touches money. The All-In bundle rule applies a flat fifteen percent discount when six packet groups are present on one order and recalculates automatically when a group is removed, matching the refund policy's stated behaviour.

---

## 6. Application surfaces

The **public site** presents the hero and value proposition, the packet catalogue with tier comparison and per-tier feature detail, approved reviews, a forum teaser that shows a truncated excerpt with a registration call to action, the public changelog, an about page, a contact form, the four policy documents, and a branded 404 page. It is fully server-cacheable, requires no authentication, and contains no third-party requests.

The **customer portal** opens onto a dashboard with an onboarding checklist for first-time users, then provides order tracking with a phase timeline, the Phase 1 intake form with save-and-resume and typed, uploaded, or recorded answers, MNDA review and acceptance, a file area with per-file visibility, search, and bulk ZIP download, support tickets, community participation, verified-purchase review submission, and a profile area covering personal details, notification preferences, password change, MFA enrolment, active session management, and a self-service data export and account-deletion request that satisfy GDPR portability and erasure obligations.

The **admin panel** covers order operations including the phase workspace with hidden and visible file sections and the per-order question thread, customer management with bulk actions and login-method assignment, catalogue editing, file administration, moderation queues for forum and reviews, the ticket desk, email template and automation editing with test send, and a platform section containing feature flags, maintenance mode, rate-limit configuration, the IP blacklist, security and activity log explorers, the system health dashboard, alerts, backups, webhook and API-key management, changelog authoring, and homepage content blocks. Every destructive action requires an explicit typed or dialog confirmation and writes an audit record.

---

## 7. Accessibility

The interface targets WCAG 2.1 AA. All brand colour pairings used for text were checked for contrast, and the gold accent is restricted to large text and non-text indicators where its ratio against navy is insufficient for body copy. A skip link precedes the navigation, every page exposes a single `<main id="main-content">`, icon-only controls carry accessible names, dynamic status regions announce politely or assertively as appropriate, focus is trapped correctly in dialogs and returned on close, and the entire application is operable from the keyboard. Layouts are verified at 320, 375, 768, and 1280 pixels.

---

## 8. Deployment

Two deployment models are supported, and both are implemented rather than described. `deploy/install.sh` provisions a VPS end to end: it installs Node 22, MySQL, and nginx, creates an unprivileged service account with no login shell, generates every secret locally with the kernel CSPRNG, writes `/etc/readypackets/portal.env` as mode `0640` owned by root with the service account as group, creates the database with a least-privilege user that deliberately lacks `DROP`, `GRANT`, and `FILE`, binds MySQL to loopback, builds both bundles, applies migrations, seeds the catalogue and policies, installs the systemd unit, writes the nginx site, configures `ufw` and fail2ban, installs log rotation and a nightly backup timer, and verifies the readiness probe before reporting success. The script is idempotent: existing secrets are reused on re-run, because regenerating `DATA_ENCRYPTION_KEY` would orphan every encrypted column.

The systemd unit is where host-level containment is expressed. It applies `ProtectSystem=strict` with a single writable path, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, an empty capability bounding set, kernel tunable, module, log, and cgroup protections, `ProtectProc=invisible`, namespace and realtime restrictions, an address-family allowlist of IPv4, IPv6, and Unix only, and a syscall filter limited to `@system-service` with the privileged, raw-I/O, module, and debug groups explicitly denied. `MemoryDenyWriteExecute` is deliberately left disabled and annotated as such, because V8 requires writable-executable pages for its JIT and enabling it would prevent the service from starting at all.

The container path is equivalent. A four-stage Dockerfile separates dependency compilation, build, production pruning, and runtime, so the final image carries no compiler, no source tree, and no package manager. It runs as the unprivileged `node` user under `tini` for correct signal forwarding and zombie reaping. The Compose stack drops all Linux capabilities, sets `no-new-privileges`, mounts the root filesystem read-only with a single `noexec` tmpfs for multipart buffering, publishes the application only on loopback, and never publishes the database port at all.

Because deployments frequently sit behind a CDN, proxy handling is explicit. `TRUST_PROXY_HOPS` states how many proxies to trust rather than trusting the whole forwarded chain, which is what prevents a client from spoofing its apparent address to evade a rate limit or enter an IP allowlist. Setting it too high enables that spoofing; too low collapses every client onto the proxy's address so one abuser throttles everyone. `BEHIND_CLOUDFLARE` prefers `CF-Connecting-IP` where set, and origin validation compares hostnames rather than full URLs.

Operational scripts accompany the installer. `deploy/backup.sh` produces a single archive containing the database dump, the file store, a manifest, and checksums, with configurable retention and optional `age` or `gpg` encryption; it passes the database password through the environment rather than the command line so it never appears in the process table, and it aborts if the dump is implausibly small. `deploy/restore.sh` reverses it, verifying checksums, printing the manifest, comparing the archive's encryption key against the running configuration and warning loudly on mismatch, taking a safety dump of current state, and requiring a typed confirmation. A `--database` flag loads into a scratch database so a backup can be proven restorable without touching production.

Required environment variables are `APP_URL`, `DATABASE_URL`, `SESSION_SECRET`, `DATA_ENCRYPTION_KEY`, and `EMAIL_INDEX_KEY`. SMTP, Stripe, S3, and SAML variables are optional and each subsystem stays dormant until its variables are present. The application refuses to start if any required secret is missing, is shorter than its minimum length, or matches a known development default, which prevents the most common self-hosting misconfiguration: an instance running in production with a predictable key.

---

## 9. Verification

Verification is in two layers, and both are implemented and passing.

The unit suite comprises **106 tests** across six files, and it is written to assert security properties rather than API shapes. The cryptography tests require that ciphertext be non-deterministic, that a tampered envelope fail rather than decrypt to garbage, that associated data prevent a ciphertext being relocated between rows, and that a blind index not disclose its input. The policy tests cover the password rules, including rejection of a password derived from the user's own email or name, and the CIDR arithmetic that the block list and admin allowlist depend on, including a non-byte-aligned prefix, `/32`, `/0`, and a malformed pattern, because an allowlist that fails open is worse than none. The domain tests exercise the order state machine for reachability, terminality, and the rule that cancellation is available only before delivery, and they price the bundle discount against the seeded catalogue rather than a fixture, so the code and the commercial catalogue cannot drift apart unnoticed. The upload tests are written from the attacker's perspective: an ELF binary renamed to `.pdf`, a PE binary behind a double extension, a PHP payload named as an image, binary content presented as text, and a traversal sequence in a filename are each asserted to be refused. The rendering tests attempt script, event-handler, iframe, `javascript:`, `data:`, `vbscript:`, and protocol-relative injections through the Markdown path and require each to render as inert text.

The suite also pins the audit trail's classification rule, because severity is the field an operator scans first and a mislabelled row is worse than a missing one: an omitted outcome must be treated as success rather than as a warning, an explicitly supplied severity must always survive the defaulting logic, and the logger must redact credential-bearing keys and bound deep structures rather than recursing without limit.

The second layer is `scripts/verify-security.ts`, a black-box probe that drives the running HTTP surface and asserts **46 checks**: the policy header and its strictness, the full hardening header set, the absence of fingerprinting headers, host validation, cookie attributes, all three CSRF layers, per-procedure authorisation, error handling and information disclosure, traversal and dotfile refusal, and rate limiting including header advertisement and the health-probe exemption. It passes 46 of 46 against both the development server and the compiled production bundle, and it is intended to run after every deployment against the real hostname.

A third layer is manual, and it earned its place. The application was served over a public URL and driven through a browser as a customer and as an administrator. Four defects surfaced that neither the unit suite nor the black-box probe could see, because all four lived in presentation and routing rather than in the HTTP contract: the administration and portal shells were mounted with a pattern that required a trailing segment, so `/admin` and `/portal` rendered the public 404 while every deep link worked; the audit log classified successful events as warnings; two navigation targets referenced routes that were never registered; and an account created before the index key was configured became unreachable, which is the correct fail-closed outcome and a practical demonstration of the key-custody requirement. The routing faults were found by scripting a comparison of every `/portal` and `/admin` string in the client against the registered route patterns, which is worth repeating whenever routes change.

This process found three genuine defects that review had not. The CSRF token was issued only at login, so an anonymous visitor had none and registration and contact submission would have failed in production while appearing correct in development; the token is now issued with the application shell. The rate-limit penalty was keyed by address alone, so a login burst from one user behind a shared corporate address would have locked every colleague out of the entire site rather than out of the login endpoint; penalties are now scoped per category. The storage key generator retained dot sequences from a caller-supplied extension, so a value such as `../../etc/passwd` left traversal characters in the key; it now considers only the final extension and discards every character outside `[a-z0-9]`. Each is recorded in the gap analysis response alongside the finding it relates to.
