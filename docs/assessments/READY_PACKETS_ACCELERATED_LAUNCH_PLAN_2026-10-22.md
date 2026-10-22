# ReadyPackets — Accelerated Launch Plan and Decision Gates

**Prepared:** 2026-10-22
**Repository state assessed:** `36572b2973e58329d628a1830d0cac8b63a0a094`
**Companion assessment:** `docs/assessments/ReadyPackets_Production_Readiness_and_Security_Review_2026-10-22.md`
**Purpose:** Define the fastest defensible launch path without misrepresenting an internal acceptance environment as public production.

## Executive decision

A **full public ReadyPackets Portal launch with real customer accounts, documents, orders, payments, integrations, and administrative recovery functions is not safe to approve tomorrow evening or by Monday** based on the current reviewed source. The production-readiness review remains **Blocked** with 25 High findings, and the short source-control review for this plan found that several material risks do not have a safe configuration-only disablement.

No software system can be made “100% secure.” The release objective is instead to remove reachable unacceptable risk, prove the remaining controls with evidence, and operate within an explicitly approved scope.

There are three distinct paths:

| Target date | Permitted release | Decision |
|---|---|---|
| **Tomorrow evening** | Static ReadyPackets public website only, with no authenticated Portal customer service exposed. | **Possible**, after normal hosting/TLS checks for the static site. |
| **Tomorrow evening to Monday** | Internal, administrator-only Portal acceptance environment using synthetic data, an isolated hostname, a short expiry, and network restrictions. | **Potentially possible**, but is not customer production and still requires containment work/evidence. |
| **By Monday** | Public customer Portal processing real personal data, uploaded documents/audio, orders, payments, SSO, mobile access, SharePoint, webhooks, and recovery operations. | **No-go.** The High findings cannot responsibly be closed and proven in this time window. |

## What can and cannot be disabled today

Settings are helpful only where the server actually enforces them. Hiding a button, clearing a client value, or relying on an administrator not to use an API is not a security control.

### Can be disabled server-side with existing controls, after verification

| Function | Safe bounded action | Limitation |
|---|---|---|
| SAML sign-in | Disable the active `saml_configs` database record and keep auto-provisioning off. | Existing browser sessions must be revoked operationally. Do not rely solely on `SAML_ENABLED=false`; the runtime uses the database configuration. |
| Stripe Checkout and webhook fulfilment | Remove effective Stripe settings from both encrypted database settings and environment fallback; verify new checkout and webhook processing reject requests. | This disables Checkout; it does not fix manual payment-status authority. |
| Coupon redemption | Mark every coupon inactive and leave Checkout disabled. | Coupon administration remains an admin function. |
| SharePoint sync | Disable every legacy Graph configuration, selected-site connection, and target binding; cancel pending jobs. | Does not delete historical remote copies or solve retention deletion. |
| New generic webhooks | Disable all endpoints and phase-kickoff webhook configuration; clear queued pending deliveries. | Existing pending/manual delivery paths are not protected by a durable global enablement check. |
| Scheduled deletion/jobs | Run only `INSTANCE_ROLE=web` and no worker-capable instance. | This also stops queues, email, conversions, SharePoint, webhooks, and timers. It is appropriate only for an internal static/read-only acceptance environment. |
| Third-party analytics | Keep Clarity, PostHog, and cross-site analytics settings off and do not store keys. | Separate first-party forum-click telemetry needs code work for a complete telemetry-off claim. |

### Cannot be safely disabled by existing configuration while operating a normal customer Portal

| Function / finding | Why configuration is insufficient | Required outcome before customer launch |
|---|---|---|
| MFA-factor replacement (**RPS-02**) | No switch prevents an authenticated session from replacing an existing factor. | Require fresh password plus existing factor or controlled recovery; notify user and revoke appropriate sessions. |
| Existing native/mobile token families (**RPS-03**) | Removing redirect URIs blocks new authorization codes, but existing refresh tokens can still rotate. | Add global native-session revocation or credential/session epoch and prove recovery revokes browser and mobile credentials. |
| Customer uploads and conversion (**RPS-08**) | No global upload-off/quarantine flag; routes remain mounted and accepted files can queue work. | Add server-side feature gate plus malware/quarantine/resource-bound scan before download, conversion, or SharePoint sync. |
| Delegated order sharing (**RPS-09**) | No sharing feature gate and the existing access evaluator ignores stored scope. | Add central per-operation capability checks and a unique active-grant/revocation model. |
| Staff financial state changes (**RPS-13**) | General staff can set payment status; clearing Stripe keys does not remove this route. | Separate dedicated, step-up, evidence-backed, admin-only financial adjustment workflow. |
| Browser/mobile order creation and writes (**RPS-14**) | Browser creation has no global disablement and mobile idempotency is not concurrency-safe. | Add atomic idempotency claims and a server-side release-mode fence until fully remediated. |
| Direct policy/configuration/backup restore routes (**RPS-04**) | Routes are mounted unconditionally and bypass the normal full administrator guard. | Centralize full-admin authorization or deny these routes in application/reverse proxy until fixed and tested. |
| Encrypted, off-host, consistent recovery (**RPS-06, RPS-18–20**) | No setting makes scheduled backups encrypted, remote-required, atomic across MySQL/objects, fail-closed, or DR-tested. | Code/deployment changes plus a successful isolated restore drill and approved RPO/RTO. |
| Independent audit/paging (**RPS-16–17**) | Local tables and Portal alerts are not an independently retained audit or out-of-band alert channel. | Independently administered immutable sink and tested pager/escalation evidence. |

## Recommended release posture

### 1. Tomorrow: public static website only

Launch the static ReadyPackets website after confirming valid TLS, canonical redirects, basic accessibility, and that its **My Portal** link targets the non-public Portal decision page or remains unavailable until the Portal is ready. Do not expose customer Portal login, registration, uploads, orders, payments, or integrations as a substitute for a safe launch.

This allows public brand/marketing visibility without placing customer data or transactional workflows at risk.

### 2. Tomorrow to Monday: optional internal acceptance environment only

If rapid stakeholder review is needed, create an isolated acceptance environment with all of the following conditions:

- Separate hostname and environment; no production database, uploads, encryption keys, backups, Stripe, SAML, SharePoint, webhook, or mail credentials.
- Synthetic/sample data only; no real customer records, documents, recordings, payments, or confidential work.
- Pre-created local administrator test users only; enforce administrator-only access, MFA, a narrow network allowlist, and a fixed expiry date (for example, 7–14 days).
- No public indexing, public invitation, or production representation.
- SAML inactive; effective Stripe settings removed; all webhook endpoints disabled; all SharePoint connections/bindings disabled; analytics providers disabled; no worker-capable process.
- Explicitly deny or server-side feature-gate uploads, conversion, order writes, sharing, mobile OAuth/refresh use, payment/finance operations, and direct restore/configuration/policy import routes. UI hiding is not sufficient.
- An external health check and a named human escalation contact; snapshot/rollback procedure for the disposable environment.

If the server-side fences cannot be implemented and tested before the review, do not invite anyone outside the internal engineering/administrator team.

### 3. Do not label an invitation-only environment as production

“Invite-only,” “beta,” or “manual invoices” does not neutralize the risks if real customer information, financial status, customer uploads, or orders can enter the system. The customer Portal may be called production only when the relevant security and operational gates are closed with evidence.

## 36-hour containment and acceptance sequence

This is an execution plan for a team with parallel application, identity/payments, SRE, and release/security ownership. It is not a promise that one person can complete all work inside 36 hours.

### Hours 0–6: Freeze scope and establish ownership

1. Freeze the candidate release SHA and stop a public authenticated Portal rollout.
2. Appoint a business launch owner, technical release owner, security approver, incident/operations owner, and rollback owner.
3. Decide in writing whether the goal is static website launch, internal acceptance, or full Portal production. Only the first two are feasible this weekend.
4. Create a remediation board grouping the High findings:
   - Identity/admin boundary: RPS-01–04.
   - Edge/TLS: RPS-05 and RPS-15.
   - Data lifecycle: RPS-06–08.
   - Authorization, payments, and write integrity: RPS-09–14.
   - Evidence, recovery, and availability: RPS-16–21.
   - Build provenance and release governance: RPS-22–25.
5. Create an isolated acceptance environment only if it can remain free of production data and secrets.

### Hours 6–24: Build hard containment, not cosmetic restrictions

1. Implement a server-side release-mode denylist/allowlist for any acceptance environment. It must reject dangerous browser and mobile routes before side effects, and tests must call the routes directly.
2. Deny the direct policy import, configuration restore, and backup restore routes until their shared full-admin middleware is implemented and tested.
3. Disable SAML through the active database configuration, revoke old sessions, and confirm login/ACS are unavailable.
4. Clear effective Stripe settings from database and environment, deactivate coupons, and confirm Checkout and webhook fulfilment reject requests.
5. Disable all SharePoint connections, targets, and legacy Graph configuration; disable webhooks and cancel queued work.
6. Use the selected edge topology only:
   - **Cloudflare-only:** restrict origin ingress to verified Cloudflare paths and use authenticated origin protection/Tunnel; configure validated real-IP handling.
   - **Direct origin:** set `BEHIND_CLOUDFLARE=false`, do not trust CF headers, and validate the direct TLS topology.
7. Apply host controls: no public Node/MySQL/Docker listener; SSH key-only and restricted by approved network/VPN/bastion; host patches; fail2ban/equivalent; disk and certificate monitoring.
8. Make build inputs deterministic for the candidate: frozen lockfile, no unexpected lockfile diff, exact commit record, and retained build/test logs.

### Hours 24–36: Evidence-driven acceptance gate

Run all of the following against the actual isolated hostname, from an independent network where applicable:

- Direct calls to every disabled browser and mobile API return a safe denial and create no database row, queue item, stored object, or provider call.
- Unknown user, restricted user, MFA-pending user, forced-password-change user, unverified user, and off-allowlist administrator cannot access sensitive direct administrative routes.
- A direct-origin request with a forged `CF-Connecting-IP` cannot alter observed client IP, rate limiting, audit attribution, or administrator authorization.
- TLS certificate, SANs, canonical redirect, HSTS, unknown host rejection, and secure cookie behavior validate externally.
- Node and MySQL are not public; SSH and firewall evidence are recorded.
- A test alert reaches an independent human-owned channel. If no independent logging/paging exists, internal acceptance must remain closely supervised and cannot be treated as production.
- The launch owner signs an acceptance charter documenting synthetic-data restrictions, expiry, rollback, scope, and no-go criteria.

Failure of any item means no external invitation. Continue internal testing only.

## Four-day work plan: build the production foundation

By Monday, the realistic deliverable is a tested remediation release candidate and evidence pack—not a claim of complete customer-production readiness.

| Workstream | Day-4 target | Full-production evidence still required |
|---|---|---|
| Identity | Implement SAML issuer/request correlation design, MFA-factor reauthentication/recovery, native session revocation, and route/full-admin guard tests. | Real IdP negative matrix, shared replay-store proof, browser/native revocation proof, delivered notifications. |
| Payments and workflow integrity | Implement central order scope checks, atomic idempotency, exact Checkout totals, provider-event ledger, paid-only fulfilment, coupon reservations, and separated financial state changes. | Disposable MySQL concurrency suite and Stripe test-mode proof for totals, delayed payments, duplicate/parallel events, invoices, and refunds. |
| Data and recovery | Require encrypted remote backup replication, make restore fail closed, select/upload quarantine approach, and begin deletion-outbox design. | Immutable off-host target, cross-store point-in-time manifest, malware corpus, object/SharePoint deletion reconciliation, successful isolated DR drill and measured RPO/RTO. |
| Edge and operations | Fix verified origin topology, TLS acceptance test, external audit sink/paging integration, health coverage, and host baseline automation. | Independent evidence for ingress, origin restriction, alert delivery/failure, restore alerting, and operational drills. |
| Supply chain | Frozen install everywhere, remove audit suppression, pin Actions/images, add scanning and provenance plan. | Required branch protection, SBOM, signed/attested promoted artifact, protected deployment verification. |

## Full customer-production release gates

Before accepting real customer data or financial transactions, all applicable High findings must be remediated or the affected feature must be demonstrably unavailable at the server and edge. The minimum evidence set is:

1. SAML, MFA, browser/native session recovery, and full administrator-route integration tests.
2. Production-equivalent MySQL concurrency tests for sharing, idempotency, coupons, OTP/backup-code consumption, uploads, and workflow transitions.
3. Stripe test-mode tests proving immutable price, paid-only fulfilment, exactly-once event handling, coupon limits, and audited financial exceptions.
4. Quarantine/scan tests proving malicious, malformed, macro-bearing, and high-expansion files cannot be downloaded, converted, or synced.
5. Encrypted, independently credentialed, immutable/versioned off-host backup; cross-store recovery manifest; tested restore that fails closed on error; approved RPO/RTO and completed isolated drill.
6. Externally verified TLS, host/canonical behavior, Cloudflare/direct-origin policy, forged-header resistance, origin restriction, WAF/DDoS settings, and no public Node/MySQL/Docker listener.
7. Independently retained immutable audit records; detailed, search/filterable operational and security logs with data-minimizing redaction; externally delivered alerting, escalation, and delivery-failure test evidence.
8. Immutable artifact/release path: full dependency policy, frozen installs, immutable action/image references, SAST/secret/dependency scanning, SBOM/attestation, protected branches, and verified deployment identity.

## Hard no-go conditions

Do not launch the customer Portal if any one of these is true:

- Real customer data, uploads, orders, payments, or confidential work would enter an acceptance environment.
- A restriction exists only in the UI or depends on operator behavior rather than server/edge enforcement.
- SAML, native refresh tokens, uploads, conversion, sharing, order writes, financial state, or direct restore/import routes remain reachable without their applicable remediation.
- Origin identity can be changed with a forged forwarding header, public TLS is not externally verified, or the origin is exposed outside its selected topology.
- Encrypted off-host backup/restore, external alerting, and immutable audit evidence are absent.
- Full-production testing relies on unit tests only, omits MySQL/Stripe/IdP/storage/proxy evidence, or lacks a rollback owner and documented decision record.

## Recommended immediate decision

1. **Launch the static public website tomorrow if desired.**
2. **Treat the Portal as internal acceptance only until the containment fences and the production remediation plan are implemented and verified.**
3. **Do not promise customers a Portal production launch by Monday.** Set the next honest milestone as: “security remediation release candidate and production-evidence review,” with customer go-live following the independent acceptance gate.

This protects ReadyPackets customers, preserves the credibility of the launch, and keeps the required detailed logging, audit search/filtering, secure SIEM forwarding, alerting, and recovery evidence as first-class release requirements rather than post-launch cleanup.
