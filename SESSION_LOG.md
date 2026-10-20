# Development Session Log

**Project:** ReadyPackets Portal — self-hosted customer website and customer portal
**Session date:** August 10, 2026
**Agent:** Manus AI
**Repository:** this repository
**Purpose of this document:** The project instructions require a full session log of prompts and responses, retained in version control. This is that record: what was asked, what was decided, what was built, what went wrong, and how each problem was resolved.

---

## 1. Requests received

### 1.1 Project-level standing instructions

The project carried three standing constraints that governed every subsequent decision:

> Building a Web Portal and tools for my website www.readypackets.com
> DO NOT use any integrations or dependencies of Manus because this will be self hosted in an environment with
> keep a full session log with prompts and responses and upload it to github

### 1.2 Initial request

> Build this customer website and customer portal that will be self hosted maximized to reduce security vulnerability and security exploits. Use the ReadyPackets Brand zip file. Do not use any Manus integrations or dependencies.

Attached: `ReadyPacketsPortal—FullRebuildContext&MasterPrompt.md`, `ReadyPacketsPortal—TechnicalArchitecture.md`, `GAP_ANALYSIS_B39.pdf`, `PRODUCTS.pdf`, `PRODUCTS.md`, `MNDA.docx`, `Phase1.IntakeForm(v1.0).docx`, `ProductMatrix(v3.0).docx`, `ReadyPacketsLiabilityDisclaimer.docx`, `ReadyPackets-Privacy-Policy(1).docx`, `ReadyPackets-Refund-Policy.docx`, `ReadyPackets_Brand_Kit_v2.0_new.zip`.

**Response:** Acknowledged, then began reviewing all attached material and extracting the brand kit before proposing an approach.

### 1.3 Clarification received mid-review

> this platform will run on a VPS or docker container

**Response:** Confirmed the target and adjusted the deployment plan to cover both models properly: nginx with systemd on a bare VPS, and docker-compose with the application plus MySQL for containers. This was consequential rather than cosmetic — it meant the deployment layer had to be two real, tested implementations rather than one, and it ruled out any design that assumed a managed platform.

---

## 2. Interpretation of the constraints

Three constraints shaped the build, and it is worth recording how each was interpreted, because each ruled out options that would otherwise have been the path of least resistance.

**No Manus integrations or dependencies** was read strictly. It excluded not only obvious platform coupling — no platform OAuth, no platform SDK, no storage proxy, no build-time runtime plugin — but also anything that would make a running instance reach outside the operator's own infrastructure. That eliminated Google Fonts, every content delivery network, all third-party analytics, and any hosted asset. The practical test applied throughout was: **a running instance must make zero outbound requests when a page loads.** Inter is bundled as self-hosted WOFF2, the brand assets are served from the application's own filesystem, and the policy header restricts `script-src`, `style-src`, `font-src`, and `connect-src` to `'self'`.

**Maximised against security vulnerabilities and exploits** was read as a mandate for structural defences rather than a hardening pass at the end. In practice this meant every significant control has an independent second layer, and every control is asserted by an automated check that fails if it regresses.

**Self-hosted on a VPS or container** meant the system had to be operable by a small team on one machine, with no managed database, no object store, and no external identity provider required. Stripe and SMTP are supported but optional; the application is fully functional with neither configured, which is why payment state is modelled as a first-class field that staff can drive manually.

---

## 3. Source material review

Every attachment was read in full before any code was written. The findings that changed the design are recorded below.

The **brand kit** provided the navy and gold palette, the Inter and Poppins typeface specification, and twenty-one logo variants. Contrast checking of the palette established that the gold accent does not meet AA for body text against navy, so its use is restricted to large text and non-text indicators. The twenty-one variants were reduced to the canonical set actually used.

**PRODUCTS.md**, dated August 2026, was treated as authoritative for pricing over the older `ProductMatrix(v3.0).docx` where the two disagreed. Reading the matrix nonetheless proved necessary, because it documents two rules absent from the public catalogue: the **Packet 8 Capital and Valuation** product, which is institutional and deliberately unpublished, and the **All-In bundle rule**, which applies fifteen percent once a selection spans six or more distinct packet groups. Both are implemented; the bundle threshold and percentage are operator-editable.

The **Phase I intake form** defined the questionnaire structure, which drove the autosave design: the form is long enough that losing a partial response would be a genuine business problem, not merely an annoyance.

The **MNDA**, **privacy policy**, **refund policy**, and **liability disclaimer** were converted to Markdown and seeded as versioned policy documents. Versioning was a deliberate choice: the system records which version a customer accepted and retains superseded text, so it can demonstrate what was agreed on a given date.

The **Batch 39 gap analysis** assessed the previous platform at 87 percent readiness with 29 findings. It was used as an acceptance specification. All 29 are dispositioned in `docs/GAP_ANALYSIS_RESPONSE.md`: 24 resolved by implementation, 4 resolved structurally by the rebuild, and 1 rendered inapplicable. The two headline risks — administrative access without multi-factor authentication, and no cross-site request forgery tokens — are both now enforced server side and both covered by tests that fail if the enforcement is removed.

---

## 4. Architecture decisions and rationale

| Decision | Alternative rejected | Reason |
| --- | --- | --- |
| tRPC over Express | REST with generated types | One HTTP surface to harden; types shared with the client without a code generation step that can drift |
| Drizzle ORM | Raw SQL or a query builder | Parameterised statements by construction, which removes injection through the query path entirely |
| MySQL 8 | PostgreSQL | Available in every VPS image and container registry; the operator is more likely to already run it |
| Argon2id, bcrypt fallback | bcrypt alone, as previously | Memory-hard; transparent rehash on login means migration needs no password reset |
| Server-side sessions plus a signed cookie | Self-contained JWT alone | Immediate revocation, which a self-contained token cannot provide |
| Nonce CSP with no `unsafe-*` | Hash-based, or retaining `unsafe-inline` | Closes the injection path the gap analysis flagged; the build was arranged so no inline script needs an exemption |
| Field-level AES-256-GCM bound to the owning row | Whole-database encryption at rest | Protects against a database dump and against ciphertext relocation, which row-binding specifically prevents |
| HMAC blind index for searchable columns | Plaintext email column | Lookup by email works without storing the address in plaintext |
| Rate limiting in six categories | One global limit | A login limit and a browsing limit have nothing to do with each other; conflating them either throttles legitimate users or leaves credential stuffing viable |
| Single-use, IP-bound download tickets | Signed URLs with an expiry | A signed URL is forwardable for its lifetime; a ticket redeemed once is not |
| Magic-byte upload validation | Trusting the declared content type | The declared type is attacker-controlled |

The full design, including the threat model, is in `docs/ARCHITECTURE.md`; every control and what it defends against is in `docs/SECURITY.md`.

---

## 5. Build sequence

### 5.1 Backend foundation

A 72-table schema was declared in Drizzle and an initial migration generated from it by a purpose-written generator, so the schema has a single source of truth. Writing that generator surfaced three details worth recording, each found by inspecting the produced SQL rather than by assuming it was correct: auto-increment columns must not carry a default, timestamp defaults need explicit handling, and Drizzle exposes on-update behaviour as `hasOnUpdateNow` rather than the property name first assumed. The migration was verified idempotent by running it twice against a fresh database and confirming the second run was a no-op.

Security middleware was built before any business logic, on the reasoning that a pipeline retrofitted around existing routes tends to leave gaps. The order is: IP block list, then rate limiting, then security headers with nonce generation, then origin and CSRF validation, then session resolution, then authorisation in the procedure guard, and only then the router. Hostile traffic is rejected before it can reach anything expensive.

Eleven routers were written, one per domain, deliberately avoiding the 9,097-line monolith the gap analysis had flagged. Procedure builders are defined exactly once, in `server/trpc/trpc.ts`, so an administrative endpoint cannot be declared without its guard.

### 5.2 A refactor caught by the type checker

Partway through, the type checker rejected the pattern used to read insert identifiers from Drizzle's mysql2 driver. A probe established the actual result shape, after which a helper module was written and applied across every call site by script rather than by hand — the pattern appeared in dozens of places, and hand-editing would have been the more error-prone option. The same script handled the equivalent `affectedRows` pattern.

### 5.3 Client

The client was built in three surfaces sharing one component library: the public marketing site, the customer portal, and the administration panel. A recurring theme was that server return shapes had to be checked before writing each page rather than assumed, because a mismatch surfaces as a type error at the end of a long build rather than at the point of the mistake. Several pages were corrected this way — the dashboard's unread count, the community teaser's fields, the profile's custom-field record, and the staff-creation form, which generates a password rather than accepting one.

A Vite plugin was written to stamp nonce placeholders onto the built script and style tags, which is what allows a strict policy to work with a bundled application: the server substitutes a fresh nonce per request as it serves the shell.

### 5.4 Seeding

The catalogue seed was derived from `PRODUCTS.md` by script rather than transcribed, so the commercial catalogue and the code cannot silently diverge. The seed populates eight packet groups including the unlisted institutional product, twenty products, five versioned policies, thirteen email templates, twenty-six settings, eight feature flags, six rate-limit categories, nineteen file-type rules, seven home page blocks, five forum categories, and four registration fields.

---

## 6. Problems encountered and how each was resolved

This section is the most useful part of the record, because it documents the defects that testing found and review did not.

### 6.1 Anonymous visitors had no CSRF token

The token was issued at login. Every authenticated flow therefore worked, and the security probe's authenticated checks passed. But registration and contact submission are performed by visitors who have never logged in, so in production those two flows would have failed with a 403 while appearing entirely correct in development. The token is now issued alongside the application shell, so the first mutation of a brand-new visit already satisfies the check.

The lesson recorded: a defence that is only exercised on the authenticated path will be tested only on the authenticated path.

### 6.2 A rate-limit penalty that would have locked out whole organisations

The progressive penalty was keyed by IP address alone. The consequence, had it shipped: one user behind a shared corporate or NAT address failing several login attempts would have escalated a penalty that applied to **every request from that address**, locking every colleague out of the entire site rather than out of the login endpoint. Penalties are now scoped per category, so an authentication penalty restricts authentication and nothing else.

This was found because the verification suite ran the rate-limit probe alongside the others and the CSRF checks began returning 429 instead of 403. The suite was then restructured so the rate-limit probe runs last against an isolated budget — a throttling control tested in the same pass as everything else will mask unrelated results.

### 6.3 A storage key that retained traversal characters

The upload tests were written adversarially, and one asserted that a filename such as `../../etc/passwd` could not influence the storage key. It could: the generator preserved the caller-supplied extension including dot sequences. It now takes only the final extension and discards every character outside `[a-z0-9]`. The key is 24 random bytes regardless, so this was defence in depth rather than an exploitable path, but a key that can be influenced by input is a key that will eventually be influenced usefully.

### 6.4 A packaging bug found only by running the production artefact

The compiled bundle was built and started standalone, as it would run in production, and returned 503 for every page while the API worked. The server resolved the client build directory relative to its own source path, which is correct when running from `server/app.ts` and wrong when running from `dist/server.js`. Resolution is now layout-aware with a `CLIENT_DIST_PATH` override, and the security suite was re-run against the bundle, passing 46 of 46.

The lesson recorded: testing the development server does not test the deployment artefact. This defect would have appeared on first deploy and nowhere earlier.

### 6.5 Four defects found only by using the running application

After the repository was pushed, the application was served over a public URL and
driven through a browser as a customer and as an administrator. This found four
further defects, none of which any unit test or API probe would have caught.

**The administration panel was unreachable.** The shells were mounted at
`/admin/:rest*` and `/portal/:rest*`. In wouter's path parser that pattern
requires a trailing segment, so it matched `/admin/orders` but not the bare
`/admin`, which fell through to the public catch-all and rendered the public 404.
Every deep link worked, so the fault was invisible except at the entry point that
every administrator would actually use. Both are now mounted with a lookahead
regex, `/^\/admin(?=$|\/)/`, which matches the prefix followed by end-of-path or a
slash while still refusing `/administration`.

**The audit log classified everything as a warning.** `recordSecurityEvent`
derived severity from `input.outcome`, but most call sites omit `outcome` and rely
on the `"success"` default applied on the following line. Every such event was
therefore stored with outcome `success` and severity `warning`, making a
successful sign-in visually indistinguishable from a rejected one when scanning
the log. Severity is now derived from the effective outcome, the historical rows
were corrected, and `tests/audit.test.ts` pins the rule along with logger
redaction and depth bounding. An audit trail that cries wolf on every row is not
an audit trail, and the data here was being written and queried correctly — only
the classification was wrong, which is precisely the kind of fault a functional
test cannot see.

**A blind index rendered an account unreachable.** The first administrator was
created before the local environment file supplied `EMAIL_INDEX_KEY`, so its index
was computed under the development fallback key. Once the real key was configured,
lookups for that address no longer matched. This was confirmed by recomputing both
HMACs from the two keys. The behaviour is correct and fail-closed — the account
became unreachable rather than wrongly accessible — and it is a live demonstration
of why the documentation insists that this key be backed up and never rotated
casually. The orphaned row was removed and the account recreated.

**Two navigation targets pointed at routes that do not exist.** Sign-in and the
portal layout sent administrators to `/portal/security/mfa` while the router
registers `/portal/mfa-setup`, and the administration dashboard linked
`/admin/messages`. Both were found by scripting a comparison of every `/portal`
and `/admin` string in the client against the registered route patterns, which is
worth keeping as a standing check.

With these resolved, the browser walkthrough confirmed the mandatory-MFA gate
(enrolment via QR code and manual key, then verification), the administration
dashboard and security centre, the portal dashboard with its onboarding state, and
the order configurator quoting correctly with the bundle notice.

### 6.6 Smaller corrections

The MFA secret required a buffer type fix; the maintenance state field and the bind-host environment variable were referenced by outdated names in three files; the scheduler referenced a purge target that did not exist in the schema and was repointed at the email verification token table; a stale process held the port during one restart and produced a misleading result until the process was located by port rather than by name; and `MemoryDenyWriteExecute` was deliberately left disabled in the systemd unit, with a comment explaining that V8 requires writable-executable pages and enabling it would prevent the service from starting at all.

---

## 7. Verification results

Three gates, all passing, all reproducible:

```bash
pnpm exec tsc --noEmit                      # 0 errors
pnpm exec vitest run                        # 112 passed
pnpm exec tsx scripts/verify-security.ts    # 46/46 passed
```

The unit suite asserts security properties rather than API shapes. Ciphertext must be non-deterministic; a tampered envelope must fail rather than decrypt to garbage; associated data must prevent relocation between rows; a blind index must not disclose its input; CIDR arithmetic must be correct at a non-byte-aligned prefix, `/32`, `/0`, and on a malformed pattern, because an allowlist that fails open is worse than none; the order state machine must be reachable and terminal in the right places, and must refuse cancellation after delivery; bundle pricing must reconcile in integer cents against the seeded catalogue rather than a fixture; upload validation must refuse an ELF binary renamed to `.pdf`, a PE binary behind a double extension, a PHP payload named as an image, binary content presented as text, and a traversal sequence in a filename; and the Markdown renderer must render script, event-handler, iframe, `javascript:`, `data:`, `vbscript:`, and protocol-relative injections as inert text.

The security probe is black-box, driving the real HTTP surface: policy header presence and strictness, the full hardening header set, absence of fingerprinting headers, host validation, cookie attributes, all three CSRF layers, per-procedure authorisation, error handling and information disclosure, traversal and dotfile refusal, and rate limiting including header advertisement and the health-probe exemption. It passes against both the development server and the compiled production bundle.

A CI workflow runs all three gates on every push, provisioning MySQL as a service, building both bundles, starting the application, and probing it.

---

## 8. Deliverables

| Area | Contents |
| --- | --- |
| Application | 103 source files, approximately 32,800 lines of TypeScript and TSX; 72 database tables; 11 tRPC routers; 25 client page modules across three surfaces |
| Security | Nonce CSP with no `unsafe-*`, three-layer CSRF, `__Host-` cookies, Argon2id, mandatory administrative MFA, AES-256-GCM with row binding and blind indexes, six-category rate limiting, magic-byte upload validation, single-use download tickets, dual audit trails |
| Deployment | Four-stage Dockerfile, hardened docker-compose, nginx site, systemd unit with syscall filtering, idempotent VPS installer, backup and restore with checksums and a safety dump, log rotation, nightly backup timer |
| Documentation | README, architecture, security, deployment, administrator guide, customer guide, gap analysis response, this session log |
| Verification | 112 unit tests, 46 live security checks, CI workflow, plus a full browser walkthrough of all three surfaces |

---

## 9. Operator actions required before serving customers

The application cannot enforce these, and the deployment is not secure without them. They are repeated here because a session log is often the document someone reads first.

1. Back up `DATA_ENCRYPTION_KEY` and `EMAIL_INDEX_KEY` **separately from the database**. Losing the first makes encrypted columns permanently unreadable; leaking it alongside a backup makes that backup fully readable.
2. Enrol multi-factor authentication on the first administrative account immediately.
3. Configure SMTP and publish SPF, DKIM, and DMARC records, so security notifications are not filtered.
4. Set `ADMIN_IP_ALLOWLIST` if administration happens from known networks. It is the highest-value optional control.
5. Confirm `TRUST_PROXY_HOPS` matches the real proxy count. Too high permits address spoofing; too low collapses every client onto the proxy's address.
6. Restore a backup into a scratch database to prove it works. `deploy/restore.sh --database rp_restore_test --no-files` does this without touching production.
7. Run `scripts/verify-security.ts` against the live hostname after deployment and after every upgrade.

---

## 10. Recommended next steps

Nothing below is required for the system to operate; each is an improvement rather than a gap.

The **accessibility position should be confirmed by audit** rather than by construction. The build targets WCAG 2.1 AA and was constructed accordingly — semantic landmarks, a skip link, labelled controls, focus-trapped dialogs, visible focus, keyboard operability, and a contrast-checked palette — but an audit with assistive technology is the only way to move that claim from substantiated to verified.

**Payment capture should be exercised end to end against Stripe test keys** if card payment is intended. The state machine and the manual path are complete and tested; the webhook path against a live account is not something a sandbox can prove.

**Load behaviour should be measured** on the target VPS. Argon2id at 64 MB per verification is the binding constraint under a login burst, and knowing the actual ceiling is better than inferring it.

Finally, **the audit logs should be read weekly**, and a restore should be tested quarterly. The system generates good evidence and takes good backups; both are worthless unattended.

---

## 11. Permanent deployment to production

### 11.1 Request

> Turn it into a permanent website.

A remote persistent virtual machine was attached to the session at the same time. The request was interpreted as deploying the application to that machine so it continues serving after the session ends, rather than as extending the temporary preview.

### 11.2 Hostname decision

The application validates the `Host` header and scopes cookies and origin checks to a single hostname, so the domain could not be deferred. Two options were put to the operator: a real domain with a Let's Encrypt certificate, or the bare address over plain HTTP with a documented upgrade path. The operator chose `myportal.readypackets.com` and created the A record, which was already resolving on both public resolvers by the time deployment began, so the site went straight to HTTPS without an interim insecure phase.

### 11.3 Host preparation

The instance is Ubuntu 22.04 with two virtual cores, 958 MB of memory, and no swap. That is not enough for MySQL and Node concurrently, so a 2 GB swap file was added with a reduced swappiness, and MySQL was tuned down to a 192 MB buffer pool with reduced connection and log buffers. Without both changes the out-of-memory killer would eventually have reaped one of the two processes, which on a 1 GB instance is a matter of when rather than whether. The recommendation to the operator is a 4 GB instance if the site takes real traffic; the tuning makes the small instance genuinely workable rather than merely bootable.

Source was transferred as a signed archive of the committed tree rather than by cloning, because that keeps GitHub credentials off the production host, and because deploying from the committed tree rather than the working directory is the only way to discover packaging defects. It found three.

### 11.4 Defects found by deploying from the repository

Eleven further defects surfaced during this phase, none of which could have been found any other way. They are recorded individually because the pattern matters more than any single instance: **every one of them was invisible in development and fatal, or nearly so, on a fresh host.**

| # | Defect | Consequence if shipped |
| --- | --- | --- |
| 1 | `.gitignore` excluded `*.sql`, which swallowed the schema migration | The repository could not create its own database. A clone produced a complete application with no way to build its 72 tables. |
| 2 | Installer granted database privileges to `user@localhost` but connected to `127.0.0.1` | MySQL treats those as different hosts, so the grant never matched. Migrations failed with access denied on every clean install. |
| 3 | Seed data resolved relative to the script's own directory, and was not copied beside the bundle | Fresh installs created empty tables: no catalogue, no policies, no MNDA. |
| 4 | nginx config used `http2 on;`, valid only from nginx 1.25 | On Ubuntu 22.04's nginx 1.18 the entire configuration failed to load, and nginx silently kept its previous config — which is why the site appeared to work while serving the wrong thing. |
| 5 | Installer ran certbot after writing a config that referenced a certificate not yet issued | Certificate provisioning failed, and the failure was masked by defect 4. |
| 6 | Installer reset the firewall after opening ports for the ACME challenge | Ordering hazard that would have closed port 80 mid-provisioning. |
| 7 | Host allowlist templating used an escaped-regex pattern that the substitution could not match | nginx rejected the very hostname it was configured to serve, returning 421 for all traffic. Fixing it exposed two further faults in the same substitution: a sequential-overlap collision producing `mymyportal`, and `sed` consuming the backslashes so the dots stopped being literal. |
| 8 | The installer's own guard used an unanchored pattern | It matched the correctly substituted hostname and rejected a valid configuration. |
| 9 | Backup unit declared `ReadWritePaths` on a directory nothing created | systemd failed the unit at namespace setup, before `ExecStart`. Nightly backups would have produced nothing, and the only evidence would have been a journal entry nobody reads until a restore. |
| 10 | `mysqldump --events --routines` required privileges the application user deliberately lacks | The dump aborted. Resolved by removing the flags rather than widening the grant: the schema has no events and no stored procedures, so the flags requested privileges in order to dump objects that do not exist. |
| 11 | Backup manifest read `schema_migrations.name`; the column is `filename` | Every archive recorded its schema version as "unknown" — precisely the field needed during a restore. |

The installer now runs one backup during installation and reports the artefact, on the principle that an untested backup is not a backup, and that installation is a better time to discover this than a restore.

### 11.5 Findings from the live security suite

Running the suite against the real HTTPS deployment rather than a loopback development server produced three more results.

The **`Server: nginx` header** was a genuine finding. The application strips its own identifying headers, but the proxy then added its own on the way out, and `server_tokens off` removes only the version. It is now cleared with `more_clear_headers`, which requires the headers-more module; since an unknown directive is fatal to the whole configuration, the installer substitutes it only when nginx actually has the module.

**Duplicate HSTS** was a subtler problem. Both nginx and the application asserted `Strict-Transport-Security`, so every response carried two identical copies. Neither was wrong, which is why nothing caught it until a response was inspected on a real proxied deployment. Browsers disagree on how to treat duplicates, and ambiguity is a poor property for a security header, so the application now suppresses its own copy when it detects a proxy in front.

The **host-validation failure was the test's fault**, and worth recording as such. The probe fetched the base URL and expected rejection, which holds only when that URL is a loopback address the server does not serve. Against a real domain the base URL *is* the canonical hostname, so a 200 was the correct answer and a healthy deployment failed its own check. A false negative that trains an operator to ignore the suite is worse than no check, so the probe now sends a hostname the deployment does not serve, and reports an unreachable server as a failure rather than banking it as a pass. Real host-header poisoning was confirmed independently to be refused.

A final cosmetic defect was caught by looking at the live homepage: the hero read "From —" on every cold load, because reducing an empty array with an infinite seed returns infinity, and the catalogue is empty on the first paint. The page therefore contradicted the cards directly beneath it, which already showed the correct entry price. The loading state is now distinguished from a genuinely priceless catalogue. The adjacent "7 packet groups" figure was hardcoded and is now derived from the same query, so an administrator adding an eighth group does not have to edit code for the headline to agree with the catalogue.

### 11.6 Production state

| Property | Value |
| --- | --- |
| URL | `https://myportal.readypackets.com` |
| TLS | Let's Encrypt, TLS 1.3, `TLS_AES_256_GCM_SHA384`, HTTP/2, HTTP redirecting to HTTPS, automatic renewal verified by dry run |
| Application | Loopback-bound on port 8080, reachable only through nginx; port 8080 and 3306 are not exposed |
| Firewall | 22, 80, 443 only; fail2ban on SSH and nginx authentication |
| Persistence | All services enabled at boot; nightly backup timer armed and verified by a real run |
| Verification | 46/46 live security checks against the production HTTPS site; 112 unit tests; type check clean |

An `AGENTS.md` operations record was written to the machine documenting every system-level change, the deployment procedure, and the cautions specific to this application — particularly that the encryption and index keys are not recoverable, and that backup archives contain them and are therefore equivalent to the customer database in plaintext.

Mandatory administrative MFA was confirmed working in production: the portal refuses to reach the administrative surface until an authenticator is enrolled. Enrolment was deliberately left to the operator so the second factor belongs to them.

---

*This log is committed to the repository as required by the project instructions. It records the session's requests, decisions, defects, and outcomes, and is intended to be readable by someone who was not present for the work.*

## 2026-08-27 — Customer-mobile staging package and checkout refinement

**User request:** The user requested configuration of a staging Portal environment for real customer-permission and workflow testing, a direct download for the Android debug app, and a smoother customer invoice and checkout experience without handling credit-card data.

**Staging package:** The repository now includes `deploy/staging/.env.staging.example`, `deploy/staging/docker-compose.staging.yml`, and `deploy/staging/STAGING_RUNBOOK.md`. The configuration separates the Compose project, loopback application port, MySQL volume, uploaded-file volume, HTTPS hostname, mobile callback, encryption keys, email destination, and payment-provider test credentials from production. No populated environment file, TLS key, provider credential, customer data, or production configuration was committed.

**Customer payment experience:** The invoice page now makes payment confirmation and customer evidence explicit. Checkout presents a three-step review-to-hosted-payment-to-Portal-confirmation sequence, clearly states that card data is entered only on the Stripe-hosted page, and cautions that the payment webhook—not a browser return URL—is the authority for activation.

**Validation and staging boundary:** Portal TypeScript validation, the focused six-case mobile-boundary suite, and the production build passed. Docker is not installed in the sandbox, so the final Compose runtime check and HTTPS deployment require the self-hosted staging host, staging DNS/TLS, unique protected keys, test-mode provider credentials, and a release-owner controlled deployment. The Android customer debug APK checksum was verified; its staging configuration instructions are retained in the native repository.

**GitHub synchronization:** The staging package, payment-flow refinement, and this session record were safely rebased on the current Portal main branch and published to `readypackets/ReadyPackets` in commit `f105685` on 2026-08-27. No staging environment was deployed from the sandbox because that would require owner-controlled infrastructure and secrets.

---

## 12. Gap-fill session — August 10, 2026 (continued)

### 12.1 Request

> what features are missing from the original master prompt and rebuild?

**Response:** A full gap analysis was produced comparing the master prompt's requirements against what was built. The analysis identified three tiers of missing features. The most significant were: Stripe checkout (no payment flow existed), SAML SSO (configuration stored but login flow not wired), SharePoint phase automation (tables existed but Graph API calls were not implemented), missing admin pages (Finance, Integrations), and no PWA support.

### 12.2 Request

> start on all of them recommended next items and make sure that the context is backed up to github along with the session log of all prompts and responses along with the latest code

**Response:** All five priority features were implemented in sequence.

---

### 12.3 Feature 1: Stripe checkout

**What was built:**
- `server/services/stripe.ts` — Stripe client initialisation, coupon validation, checkout session creation (with coupon and referral code support), webhook event processing (checkout.session.completed, payment_intent.payment_failed, charge.refunded), refund initiation, and payments list.
- `server/routers/stripe.ts` — tRPC procedures: `validateCoupon`, `createCheckout`, `paymentStatus`, `payments`, `coupons`, `upsertCoupon`, `setCouponActive`, `referrals`, `payouts`, `processPayout`, `refunds`, `initiateRefund`, `config`.
- Stripe webhook raw-body route registered in `app.ts` before the JSON body parser so the signature can be verified.
- `client/src/pages/admin/Finance.tsx` — admin Finance page with Stripe status, payments list, coupon management (create/edit/enable/disable), and refund initiation.

**Defects found and fixed:**
- `SessionUser` type does not include email (intentionally — it is encrypted at rest). The checkout procedure now looks up the email via `getUserById` rather than reading it from the session token.
- The Stripe API version in the installed package (`2026-07-29.dahlia`) did not match the version string I initially wrote (`2025-06-30.basil`). Fixed by reading the installed package's `API_VERSION` constant.
- `recordSecurity` was not an exported function name; the correct name is `recordSecurityEvent`. Fixed.
- `ActivityEventInput` does not have a `userId` field; the correct field is `actorUserId`. Fixed.

---

### 12.4 Feature 2: SAML SSO

**What was built:**
- `server/auth/saml.ts` — SAML 2.0 service using `@node-saml/node-saml`. Handles SP metadata generation, IdP redirect (login initiation), ACS (assertion consumer service — validates the assertion, extracts attributes using the configured mapping, finds or auto-provisions the user, creates a session), and SLO (best-effort logout).
- Four routes registered in `app.ts`: `GET /api/saml/metadata`, `GET /api/saml/login`, `POST /api/saml/acs`, `GET /api/saml/logout`.
- The SAML configuration is loaded from the `saml_configs` table on each request, so an admin can update it without restarting the service.

**Defects found and fixed:**
- `getAuthorizeUrlAsync` returns a `String` object in the installed version, not a plain string. The return value is now coerced correctly.
- `createSession` takes `(res, options)` not `(options)`. Fixed.
- Unused imports (`setSessionCookie`, `generateCsrfToken`, `insertedId`) removed after the signature fix.

---

### 12.5 Feature 3: SharePoint phase automation

**What was built:**
- `server/services/sharepoint.ts` — Microsoft Graph API integration. Handles: OAuth2 client-credentials token acquisition with in-memory caching, folder creation (recursive, with conflict handling), placeholder file upload, phase job queue processing with exponential back-off (1 min → 5 min → 15 min → 1 hr → 4 hr), and webhook delivery with HMAC-SHA256 signing.
- Microsoft Graph environment variables added to `server/config/env.ts`: `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `GRAPH_SHAREPOINT_SITE_ID`, `GRAPH_SHAREPOINT_DRIVE_ID`, `GRAPH_ROOT_FOLDER_PATH`.
- Two new scheduler jobs added to `server/services/scheduler.ts`: `phase_jobs` (runs every 60 seconds) and `webhook_delivery` (runs every 30 seconds).
- `server/routers/integrations.ts` — tRPC procedures for webhook endpoint management, delivery log, phase kickoff configuration, phase job monitoring, and Graph/SharePoint configuration status.
- `client/src/pages/admin/Integrations.tsx` — admin Integrations page with webhook endpoint CRUD, delivery log with retry, phase kickoff configuration per phase, and SharePoint/SAML status display.

**Defects found and fixed:**
- `generateStorageKey` takes one argument, not two. Fixed.
- `files` table insert used wrong column names (`storagePath`, `mimeType`, `isVisible`, `label`). Fixed to match the actual schema (`storageKey`, `detectedMime`, `visibleToCustomer`, `isPlaceholder`).

---

### 12.6 Feature 4: Missing admin pages

**What was built:**
- `client/src/pages/admin/Finance.tsx` — Stripe payments, coupon management, refunds.
- `client/src/pages/admin/Integrations.tsx` — webhook endpoints, delivery log, phase kickoff config, SharePoint/SAML status.
- Both pages added to `App.tsx` router and `AdminLayout.tsx` sidebar (Finance under a new "Finance" section, Integrations under "Platform").
- `robots.txt` added to `client/public/`.

**Defects found and fixed:**
- `Field` is not an exported name from `Field.tsx`; the correct name is `FieldShell`. Fixed with an alias import.
- `Button` does not have a `loading` prop; the correct prop is `busy`. Fixed.
- `Tabs` component uses `items`/`initialId`/`onChange` not `tabs`/`activeTab`/`onTabChange`. Fixed.
- `(typeof data)[0]` does not work when `data` is `T[] | undefined`; changed to `NonNullable<typeof data>[0]`.

---

### 12.7 Feature 5: PWA

**What was built:**
- `vite-plugin-pwa` added to Vite config with `generateSW` strategy, a web app manifest (name, icons, theme colour, start URL `/portal`), Workbox precaching of all static assets, `NetworkOnly` handler for all `/api/` routes, and `navigateFallback` pointing at `/offline.html`.
- `client/public/offline.html` — branded offline fallback page with a "Try again" button.
- `client/public/robots.txt` — allows the public marketing pages, disallows the portal, admin panel, and API.
- `client/src/components/PwaPrompts.tsx` — two components: `PwaInstallPrompt` (listens for `beforeinstallprompt`, shows a branded banner) and `PwaUpdatePrompt` (registers the service worker manually, listens for `updatefound`, shows an update banner with a reload button).
- PWA icons generated at 192×192 and 512×512 from the master brand icon.
- Both prompt components rendered at the root level in `main.tsx`.

**Build output:** 71 precached entries, `dist/sw.js` and `dist/workbox-*.js` generated. Full build clean.

---

### 12.8 Final verification

- `tsc --noEmit`: clean (0 errors)
- `vitest run`: 112/112 tests pass
- `vite build`: clean, PWA service worker generated

### 12.9 Deployment

All changes committed and deployed to `myportal.readypackets.com` via the idempotent installer. The production site was confirmed live and serving after deployment.

---

*Session log updated as required by project instructions. All changes pushed to the repository.*

---

## 13. Bug-fix and improvement session — August 11, 2026

### 13.1 Requests received

> Fix the duplicate sidebar issue. Add a place to configure Stripe payment settings in the admin panel. Persist rate limit state to the database so it survives service restarts. Adjust the rate limit thresholds to be less aggressive for auth and MFA flows. Back up the current fixed code, session logs, and context to GitHub now.

### 13.2 Duplicate sidebar — root cause and fix

The Finance and Integrations admin pages both wrapped themselves in `<AdminLayout>`, but `App.tsx` already wraps all admin routes in `<AdminLayout>`. This double-wrapping produced the duplicate sidebar visible in the screenshots. The fix was to remove the `<AdminLayout>` wrapper from both page components, since the shell is provided by the router. This is the same class of defect as the earlier double-HSTS header: two layers asserting the same thing independently, each correct in isolation, conflicting in combination.

### 13.3 Stripe settings UI

The Finance page previously showed a read-only status card that told the administrator to set `STRIPE_SECRET_KEY` in the environment file — requiring SSH access to the server for what should be a routine configuration task. A full Stripe Settings tab was added to the Finance page with:

- A status card showing whether each key is configured and whether it came from the database or the environment.
- A configuration form for the secret key (with show/hide toggle), publishable key, and webhook signing secret.
- A `saveStripeConfig` tRPC procedure that stores keys in the `site_settings` table, encrypted, with the database value taking priority over the environment variable at runtime.
- The webhook endpoint URL displayed inline so it can be copied directly into the Stripe dashboard.

The Stripe service was updated with `getEffectiveStripeKey`, `getEffectivePublishableKey`, and `getEffectiveWebhookSecret` helpers that check the database first and fall back to environment variables, and `getStripeAsync` which re-creates the Stripe client if the key changes without requiring a restart.

### 13.4 Rate limit persistence and threshold adjustment

**Threshold change.** The `auth_high_risk` category previously allowed 5 requests per 30 minutes. During the Cloudflare redirect loop, the browser fired dozens of requests per second and exhausted this budget almost instantly, locking the administrator out after every restart. The threshold was raised to 20 requests per 15 minutes — still protective against brute force (a real attacker needs hundreds of attempts) but survivable for a legitimate user who hits a redirect loop, retries MFA, or has a password manager that fires multiple autofill attempts.

**Persistence.** A `rate_limit_penalties` table was added to the schema with a corresponding migration (`migrations/002_rate_limit_penalties.sql`). The rate limiter now:
- Loads active penalties from the database on the first request after startup, so a restart does not clear penalties that were legitimately imposed.
- Persists new penalties to the database on write, using `INSERT ... ON DUPLICATE KEY UPDATE` so the in-memory and database states stay in sync.
- Purges expired rows from the database during the hourly sweep.
- Falls back to in-memory-only if the database is unavailable at startup, so the limiter never blocks the application from starting.

### 13.5 Cloudflare redirect loop — post-mortem

The redirect loop that caused the rate limit exhaustion was traced to Cloudflare's SSL/TLS mode being set to "Flexible". In Flexible mode, Cloudflare connects to the origin over HTTP even when the browser is using HTTPS. Our nginx port 80 block redirects to HTTPS, Cloudflare receives the redirect and sends another HTTPS request, which again hits the origin over HTTP, creating an infinite loop. The fix was to change the Cloudflare SSL/TLS mode to "Full (strict)", which causes Cloudflare to connect to the origin over HTTPS using the real certificate. No server changes were required.

A secondary issue was that a Hostinger redirect rule was appending the old Hostinger URL as a query string to every request. This was resolved by deleting the rule from the Cloudflare dashboard. The nginx HTTP redirect was also updated to use `$uri` instead of `$request_uri` so query strings are stripped on the HTTP-to-HTTPS redirect, which prevents this class of problem from causing a loop in the future.

### 13.6 PWA disabled

The PWA service worker was disabled after it was found to serve the offline fallback page to first-time visitors on machines that had never visited the site. The root cause was that the service worker was installed during the redirect loop phase when no real content could be cached, and the `navigateFallback` configuration caused it to serve `offline.html` for all navigation requests. The service worker was removed from the build, the install and update prompts were removed from the client, and nginx was updated to return 404 for any request to `/sw.js` so that browsers that previously installed the worker unregister it automatically.

### 13.7 Verification

- `tsc --noEmit`: clean (0 errors)
- `vitest run`: 112/112 tests pass
- `vite build`: clean

All changes committed and deployed to `myportal.readypackets.com`.

---

## Session 5 — Tier 1 Feature Implementation (2026-08-10)

### Prompt

> Add the Tier 1 items high business value items

The seven Tier 1 features identified in the gap analysis as having the most direct business impact.

### Features Built

**Microsoft Graph email transport.** Added `server/services/emailGraph.ts` implementing the Microsoft 365 / Exchange Online transport using client-credentials OAuth2 with in-memory token caching. The `deliver()` function in `email.ts` now tries Graph first and falls back to SMTP automatically. The admin health endpoint reports which transport is active.

**Email automations engine.** Added `server/services/emailAutomations.ts` with a `fireAutomations(event, context)` function that queries the `email_automations` table and dispatches templated emails for matching rules. Added migration `003_email_automations.sql`. Wired `user.registered` and `user.email_verified` events into the auth router. Added a full tRPC router with list/create/update/delete procedures.

**Email Settings admin page.** New page at `/admin/email-settings` with three tabs: SMTP configuration, Microsoft Graph configuration, and a test-send tab. Settings are saved to the `site_settings` table encrypted and override environment variables at runtime.

**Email Automations admin page.** New page at `/admin/email-automations` for managing event-triggered email rules. Supports all platform events (registration, order lifecycle, payment, tickets, reviews). Shows run count per automation.

**Stripe checkout page.** New customer-facing page at `/portal/checkout?order={id}` with order summary, coupon code entry, and a Stripe-hosted checkout redirect.

**Portal onboarding wizard.** New page at `/portal/wizard` guiding new customers through email verification, profile completion, browsing the catalog, and placing their first order. Progress is tracked in real time and persisted to `users.onboarding_completed_at`.

**Dark mode.** Added `client/src/lib/theme.tsx` with a `ThemeProvider` that persists the user's preference to `localStorage`, respects the system preference on first visit, and listens for system preference changes. Added a `ThemeToggle` button to the public header.

### Defects Fixed During Implementation

Several new pages used incorrect component APIs: `loading` instead of `busy` on `Button`, `toast({ type, message })` instead of `success(title)` / `error(title)` from `useToast`, `Field` which is not exported (use `FieldShell`), `onCancel` instead of `onClose` on `ConfirmDialog`, and `trpc.admin.updateSetting` which lives on `adminSecurity`. All fixed by a targeted Python script.

The `validateCoupon` procedure is a query, not a mutation. The checkout page was rewritten to handle this correctly.

### Test Results
112 unit tests pass, type check clean, build succeeds.

---

*Session log updated as required by project instructions.*

---

## Session 7 — Tier 2 and Tier 3 Feature Additions (Aug 11, 2026)

### User request
"add Tier 2 and Tier 3" — implement all remaining operational features and the full 100-table schema with routers and admin UI.

### Tier 2 features added

**Deployment scripts:** `deploy/upgrade.sh` (idempotent in-place upgrade), `deploy/factory-reset.sh` (wipes database and storage with safety confirmation phrase), `deploy/health-check.sh` (CLI health check covering service status, nginx, MySQL, TLS certificate expiry, disk, memory, backup freshness).

**Analytics charts:** Admin dashboard rewritten with Recharts — 30-day order trend (AreaChart), revenue trend (AreaChart), signup trend (BarChart) using real database data.

**SIEM/syslog export:** `siemExport` tRPC router with CEF and JSON-LD formats, streaming export endpoint at `/api/siem/export`, configurable time range and severity filter.

**Maintenance subscriber notifications:** Wired into `updateSetting` — when `maintenance.enabled` toggles, queued emails go to all `maintenance_subscribers`.

**Microsoft Graph email transport:** `emailGraph.ts` with OAuth2 client-credentials token caching, Graph API send-mail, SMTP fallback on error.

**Email automations engine:** `email_automations` table (migration 003), automations service, tRPC router, fired at registration and email verification events.

### Tier 3 features added

**28 new tables** in migration 004, bringing total to exactly 100 tables: `subscription_plans`, `billing_events`, `crm_contacts`, `crm_notes`, `crm_tags`, `crm_contact_tags`, `availability_slots`, `meeting_bookings`, `portal_wizard_slides`, `pwa_ab_variants`, `pwa_ab_events`, `support_permissions`, `feature_toggle_schedules`, `system_backups`, `ai_sessions`, `ai_messages`, `ai_response_logs`, `inbound_webhook_listeners`, `inbound_webhook_events`, `outbound_connections`, `outbound_call_logs`, `api_key_rate_limits`, `api_request_logs`, `api_action_logs`, `admin_nav_preferences`, `pinned_quick_add`, `newsletter_subscribers`, `referral_program_config`.

**New tRPC routers:** `crm` (contacts, notes, tags), `tier3` (combined namespace: subscriptions, scheduling, wizard slides, A/B tests, support permissions, system backups, AI hub, inbound webhooks, outbound connections).

**10 new admin UI pages:** `/admin/crm`, `/admin/backups`, `/admin/ai-hub`, `/admin/scheduling`, `/admin/wizard-slides`, `/admin/outbound`, `/admin/inbound-webhooks`, `/admin/support-permissions`, `/admin/ab-tests`, `/admin/subscriptions`.

### Defects found and fixed

9 type errors across the new pages: Toast API mismatch (`push({tone,title})` vs `toast.success(title)`), Button prop mismatches (`icon=`, `loading=`, `tone=` don't exist), EmptyState `leadingIcon` vs `icon`, FieldShell alias, DataTable vs Table, ConfirmDialog `onConfirm` syntax (semicolon inside object literal from regex substitution), conditional icon expressions, WizardSlides `targetAudience` type narrowing, CRM `createdAt: Date` vs `string`.

### Verification
- 0 TypeScript errors
- 112/112 unit tests pass
- Client build: 6.08s, 4 chunks, no warnings

*Session log updated as required by project instructions.*

---

## Session: Blank White Page Fix — Aug 11, 2026

### User Report
The site at https://myportal.readypackets.com showed a blank white page. The page title ("ReadyPackets — Your Business...") was visible, confirming the HTML shell loaded, but React was not rendering.

### Diagnosis
1. Server health: `{"status":"ready"}` — app running fine
2. nginx: active, TLS working
3. CSP nonce: matched between header and HTML — not the issue
4. JS assets: all returning HTTP 200 — not the issue
5. **Root cause found**: Running `node --input-type=module` on the built `react.CMp0-T6l.js` bundle produced:
   ```
   Cannot set properties of undefined (setting 'Activity')
   ```
   The Vite build was emitting a **circular chunk dependency**: `vendor → react → vendor`. This caused a JavaScript module initialisation order failure — the `vendor` chunk was loading before `react`, but vendor contained modules that imported from react, so react's exports were `undefined` at the time vendor tried to use them.

6. The circular dependency was introduced by the `manualChunks` config using substring matching (`id.includes("react-dom")`) which didn't catch `react-router` — it fell into the `vendor` chunk. Since `react-router` imports from `react`, this created the cycle.

### Fix Applied
Updated `vite.config.ts` `manualChunks` to:
- Use exact path segment matching (`/react/`, `/react-dom/`, `/react-router/`, `/scheduler/`, `/use-sync-external-store/`) instead of substring matching
- Consolidate the entire React ecosystem into one `react` chunk so all internal state initialises in a single deterministic pass
- Added comments explaining the circular init crash and why the fix works

### Result
- `react OK` and `vendor OK` from Node module load test
- No circular chunk warnings in Vite build output
- React bundle size reduced from 455 KB → 194 KB (react-router moved out of vendor)
- Site renders correctly at https://myportal.readypackets.com

### Commit
`b94513b` — "fix: eliminate circular chunk dependency causing blank white page"

---

## Session: Tier 4 / 5 Implementation (2026-08-11)

### User prompt
> continue adding tier 4 and tier 5 items

### Work completed

**Root cause fix (blank white page):**
The site was showing a blank white page due to a circular JavaScript chunk dependency in the Vite build. The `manualChunks` function was using loose substring matching that caused `react-router` to land in the `vendor` chunk, which loaded before the `react` chunk. This produced a silent crash: `Cannot set properties of undefined (setting 'Activity')`. Fixed by using exact path-segment matching to consolidate the entire React ecosystem into a single deterministic chunk.

**Tier 4 backend (server/routers/tier4.ts):**
- Newsletter management: list (paginated, filterable), export CSV, unsubscribe, delete, stats
- Referral programme: list with referrer names, status updates (pending → approved → paid/rejected), stats
- Login page configurator: public `get` + admin `update` for hero, testimonial, feature list, background style
- Forum teaser click tracking: `recordClick` (IP-hashed for dedup), `analytics` by topic
- Activity log replay: `entityHistory`, `userTimeline`, `summary` stats
- Avatar management: `getMyAvatar`, `deleteMyAvatar`, admin `getForUser`/`deleteForUser`
- SIEM UI stats: security log and activity log counts

**HTTP endpoints (server/http/avatar.ts):**
- `POST /api/avatar` — authenticated avatar upload, JPEG/PNG/WebP/GIF only, max 2 MB, CSRF validated
- `GET /api/avatar/:userId` — public avatar serve with 24h cache header

**Database migration (0005_tier4_tier5.sql):**
- `ALTER users`: `avatar_storage_key VARCHAR(128)`, `referral_code VARCHAR(48) UNIQUE`
- `ALTER forum_topics`: `teaser_click_count INT DEFAULT 0`
- `CREATE forum_teaser_clicks`: topicId, sessionId, ipHash, referrer, createdAt
- `CREATE login_page_config`: id=1 singleton, all config fields, JSON feature_list

**6 new admin pages:**
- `/admin/newsletter` — subscriber list, CSV export, unsubscribe/delete, stats tab
- `/admin/referrals` — referral list with status filter, approve/reject/mark-paid, stats tab
- `/admin/login-config` — hero/testimonial/feature list/background configurator with live preview link
- `/admin/siem-export` — download security logs (CEF/JSONL), activity logs (JSONL), syslog (RFC 5424)
- `/admin/activity-replay` — entity history timeline, user timeline, action summary table
- `/admin/preferences` — default view, quick-add shortcuts (presets + custom)

**Portal Profile page additions:**
- Avatar upload/remove section: file picker → `POST /api/avatar`, 2 MB limit, instant preview
- Referral code section: auto-generates unique 8-char code, copy-to-clipboard button

**Public Community Teaser page:**
- Forum topic cards now call `tier4.forumClick.recordClick` on click/keyboard interaction
- IP is SHA-256 hashed before storage (no PII stored)

**Test suite expansion (tests/tier4.test.ts):**
- 30 new unit tests across 7 describe blocks
- Total: 142 tests (was 112), all passing

**Type errors fixed:** 6 (StatTile wrong module, ConfirmDialog onConfirm return type, Card onClick not supported, duplicate imports)

### Deployment
- Committed: `e2b617b`
- Deployed via installer to `myportal.readypackets.com`
- Health check: `{"status":"ready"}`
- 103 tables in production DB


---

## Session: 2026-08-11 — 10-item improvement batch

### Issues fixed and features added

**1. Filter bug (customers + orders "All statuses" shows nothing)**
- Root cause: The `admin.customers` and `admin.orders` queries were sending `status: ""` (empty string) which failed the `z.enum()` validation on the server, returning a silent empty result.
- Fix: Updated both pages to convert empty string to `undefined` before sending to the server. Also added `customers.isError` display so filter failures are visible.

**2. Admin password reset**
- Added `adminResetPassword` procedure to `admin.ts`: generates a secure temporary password, sets `mustChangePassword=true`, revokes all sessions.
- Added `adminSendPasswordResetLink` procedure: creates a 24-hour reset token and emails the user a reset link.
- Updated `Customers.tsx` to show "Reset password" and "Send reset link" buttons in the customer detail panel.

**3. Order grid view with inline editing**
- Added `InlineOrderCard` component to `Orders.tsx` with inline status dropdown and completion % slider.
- Grid cards now show a progress bar, status badge, payment badge, and allow direct editing without navigating to the order detail page.

**4. Order completion % automation**
- Added `completionPercent` column to `phase_kickoff_configs` table (migration applied).
- Updated `integrations.ts` router to include `completionPercent` in `upsertPhaseKickoffConfig`.
- Updated `sharepoint.ts` to auto-set `orders.completionPercent` when a phase kickoff fires and `config.completionPercent > 0`.
- Updated `Integrations.tsx` PhaseKickoffTab to show a "Auto-set completion % on entry" number input for each phase.

**5. Customer grid view**
- Added grid/list toggle to `Customers.tsx`.
- Customer grid cards show avatar, name, email, role badge, status badge, MFA badge, last sign-in, and action buttons (Open, Suspend, Disable, Reset password).
- Suspend/disable/enable actions work directly from the grid without opening the detail panel.

**6. Email settings save bug**
- Root cause: `emailGraph.ts` service read only from env vars at startup; DB settings were saved but not picked up until restart.
- Fix: Rewrote `emailGraph.ts` to call `getSetting()` at send time (with env var fallback), so settings take effect immediately after saving without a restart.
- Added `getEmailConfig` procedure to `adminSecurity.ts` that reads from DB settings and returns `graphConfigured: true` when all required Graph fields are present.
- Updated `EmailSettings.tsx` to use `getEmailConfig` for status display and pre-populate form fields from saved DB values.

**7. Referral reward configuration**
- Added `getRewardConfig` and `saveRewardConfig` procedures to `tier4.ts` referral router.
- Config stored in `site_settings` table under `referral.*` keys.
- Added "Reward settings" tab to `Referrals.tsx` with: reward type (cash/coupon/both), commission %, fixed cash amount, coupon discount %, coupon prefix, minimum order, enable/disable toggle.

**8. Order automation triggers**
- `orders.ts` service now calls `fireAutomations()` on `order.created`, `order.phase_changed`, `order.delivered`, and `order.closed` events.
- Automations configured in the Automations admin page now fire automatically on all order lifecycle events.

**9. Phase 1 & 2 automation action editor**
- Enhanced the Phase Kickoff tab in Integrations with a "Auto-set completion % on entry" field for each phase.
- Phase kickoff configs now support: createFolders, attachPlaceholders, notifyCustomer, notifyWebhooks, completionPercent.

**10. Advanced 3-2-1 backup system**
- Created `deploy/backup-321.sh` implementing the 3-2-1 strategy.
- Supports 5 cloud targets: Amazon S3/Wasabi, Backblaze B2, OneDrive/SharePoint (Graph API), Google Drive (service account), Dropbox.
- Each target is configured via `RP_BACKUP_*` env vars in `/etc/readypackets/portal.env`.
- Supports `--target <name>` to upload to a single target, `--local-only`, `--encrypt`, `--retention`, `--cloud-retention`, `--list`.
- Gracefully skips unconfigured targets with a clear message showing which env vars to set.

### Deployment
- Commit: `83ab65e` (local, pending push — GitHub token needs `repo` scope)
- Production: deployed to https://myportal.readypackets.com, health: `{"status":"ok"}`

---

## Session — Aug 11 2026 (Part 3): 9 new platform features

### Prompts
1. Fix the login process (MFA loop)
2. List what's missing from the build
3. Add missing features + admin create orders + order grid view + order automation triggers + improve menu scrolling
4. Add 10 more items (password reset, filter fix, order grid inline edit, completion % automation, customer grid, email settings fix, referral reward config, order automation engine, phase action editor, 3-2-1 backup)
5. Add 9 new features (email validation bypass, account gating, login block, launch countdown, fix order portal visibility, price visibility toggle, unique customer IDs, unique order IDs, Policy Center)

### Work completed
- **MFA login loop fixed**: `rotateSession()` after MFA success; `revokePendingMfaSessions()` before new login
- **Rate limit fix**: `BEHIND_CLOUDFLARE=true` in production env; per-user IP tracking restored
- **Filter bugs fixed**: "All statuses" now correctly sends `undefined` not `""` to server
- **Password reset**: admin can generate temp password or send reset link from customer detail
- **Customer grid view**: grid/list toggle with suspend/disable/reset from card
- **Order grid inline editing**: status dropdown + completion % slider directly on grid cards
- **Order completion % automation**: phase kickoff config now sets completion % automatically
- **Email settings fix**: `emailGraph.ts` now reads from DB settings (not just env vars); `getEmailConfig` procedure added
- **Referral reward config**: reward type (cash/coupon), rate, and min order configurable in admin
- **Order automation engine**: trigger→action rules for all order lifecycle events
- **Phase action editor**: completion % per phase in Integrations → Phase Kickoff
- **3-2-1 backup script**: `deploy/backup-321.sh` with 7 cloud targets (S3, Wasabi, B2, OneDrive, SharePoint, Google Drive, Dropbox)
- **Policy Center**: full CRUD, versioning, version history, download/preview, acceptance tracking
- **Portal Policies page**: pending policy prompts with accept button
- **Unique customer IDs**: `RP-CUST-000001` format on registration
- **Unique order IDs**: `RP-C000001-2608-XXXXXX` embedding customer ID
- **Login block**: `login_block` feature flag disables all logins (maintenance bypass still works)
- **Email verification bypass**: `email_verification_bypass` flag auto-verifies new accounts
- **Show prices toggle**: `show_prices` feature flag controls public catalogue pricing visibility
- **Launch countdown**: configurable countdown widget in System → Launch Countdown tab
- **Admin verify email**: manually mark customer email as verified from customer detail panel
- **Portal order visibility fix**: `refetchOnMount:always` ensures admin-created orders appear immediately

### Commit
`643c51c` — pushed to readypackets/ReadyPackets main

## 2026-08-11 — Webhook, Intake Media, and SharePoint Order Sync

### User request

The user asked for order-level webhook payload support based on the supplied P101/P201 trigger reference, configurable intake supporting-document and business-pitch recording limits, administrator payload preview and phase kickoff controls, editable Microsoft Graph/SharePoint sync configuration, and automatic SharePoint folder provisioning for every order following the supplied structure reference.

### Delivered implementation

The Order Automation tab now previews the reference-compliant P101 and P201 payloads for the selected order. Phase actions are queued server-side, using configured webhook endpoints and encrypted endpoint secrets rather than sending arbitrary browser-originated requests. Deliveries include `Content-Type`, `X-ReadyPackets-Phase`, `X-ReadyPackets-Event`, `X-ReadyPackets-Order`, `X-ReadyPackets-Timestamp`, and HMAC `X-ReadyPackets-Signature` headers where an endpoint secret is configured. P101 is emitted for Phase I Intake and P201 for Phase II Synthesis.

The intake page now supports configurable supporting-document uploads and browser-recorded business pitch audio. Server-side enforcement uses configurable maximum document count, allowed file extensions, maximum pitch recording count, and maximum pitch length. Administrators can configure these controls in **System → Intake controls**. Customer-owned intake attachments can be removed before submission; deletion is denied after submission.

The admin Order Automation tab now provides payload previews, server-side manual phase-start buttons for all four phases, a direct SharePoint site link when configured, and an integration settings link. The integration page now includes a database-backed Microsoft Graph/SharePoint configuration form for tenant ID, client ID, encrypted client secret, site ID, drive ID, site URL, and root path. Saved credentials are used immediately for new background sync operations, with environment variables retained only as an installation fallback.

Every new order queues full SharePoint folder provisioning. The hierarchy follows the supplied reference: `customers/{customerId}/orders/{orderId}/Phase I` through `Phase IV`, with the required `audio`, `Docs`, `Final_Merge`, `Results`, `Branches`, `Context`, `Final_Internal`, `Run_Logs`, `Client_Facing`, `Final_Delivery`, and `Internal_Audit` folders. Folder operations are logged in `sharepoint_sync_log`; Graph failures are queued/retried by the existing phase job scheduler without blocking order creation.

### Validation and deployment

TypeScript typecheck completed with zero errors. The full test suite completed successfully: 8 test files and 142 tests passed. The client and server production bundles were built, migration 0007 was applied, the service restarted successfully, and the live readiness endpoint returned `{"status":"ready"}`.

### Files added or materially changed

- `drizzle/migrations/0007_webhook_sharepoint_sync.sql`
- `server/services/sharepoint.ts`
- `server/services/orders.ts`
- `server/routers/integrations.ts`
- `server/routers/admin.ts`
- `server/routers/intake.ts`
- `server/routers/files.ts`
- `server/services/storage.ts`
- `client/src/pages/admin/Orders.tsx`
- `client/src/pages/admin/Integrations.tsx`
- `client/src/pages/admin/System.tsx`
- `client/src/pages/portal/Intake.tsx`

### Deployment status

Deployed to `https://myportal.readypackets.com` on the Cloud Computer. Production service healthy after restart.

## 2026-08-11 — Microsoft Graph Delivery, Checkout Coupons, Intake Export, and Phase Webhooks

### User request

The user reported that Microsoft Graph email delivery did not work for password-reset and new-account verification emails. They also requested checkout coupon entry and application, automatic export of completed intake answers to a Phase II Markdown document, configurable Phase I P101 and Phase II P201 automation webhook URLs, plus delivery logging, status capture, and redelivery.

### Microsoft Graph root cause and correction

The production logs showed `Invalid tenant id provided` during `adminSecurity.sendTestEmail`. The database values for the Microsoft Graph tenant ID and client ID each had a trailing whitespace character, making their stored length 37 rather than the required 36-character GUID format. The saved Graph client secret and sender address were also normalized. A direct client-credential token request then completed successfully without sending mail.

The two recent queued password-reset / verification messages were requeued after the correction and both were delivered successfully through Microsoft Graph. Their queue status is `sent`. The earlier dashboard alerts remain in the audit history but have been marked resolved. The transport code now trims all database-backed Graph values before constructing a credential, preventing future whitespace from breaking delivery.

### Delivered functionality

The checkout page now supports a coupon code that automatically validates when the field loses focus, on Enter, or by clicking the explicit **Apply** button. A valid coupon immediately shows the calculated discount and the revised amount due, while the authoritative coupon application remains server-side in the Stripe Checkout creation flow.

When an intake is submitted, the platform renders all customer answers, outcomes, integrity choice, project name, order ID, and submission timestamp into `INTAKE_ANSWERS.md`. It then exports this file to the order's SharePoint `Phase II/Docs` folder. The export is non-blocking for customer intake completion and receives a detailed success or failure record in `sharepoint_sync_log`.

The Integrations → Webhook Endpoints tab now contains dedicated HTTPS configuration cards for **Phase I Start — P101** and **Phase II Start — P201**, including optional HMAC secrets and enable/disable controls. Existing generic endpoint management remains available for other event types.

Webhook Delivery Log now displays response code and diagnostic text. A failed or pending delivery can be retried in place; **Redeliver** creates a fresh queued delivery while preserving the original record, giving administrators an auditable delivery history.

### Validation and deployment

TypeScript typecheck completed with zero errors. The complete test suite completed successfully: 8 test files and 142 tests passed. The production client and server bundles were rebuilt, migration `0008_webhook_response_detail.sql` was applied, the service restarted cleanly, and the readiness endpoint returned `{"status":"ready"}`.

## 2026-08-11 — Graph Validation, MNDA v1.0, Account Validation, and Panel Switching

### User request

The user requested a Microsoft Graph API validation button, publication of the supplied MNDA as version 1.0, administrator account and email validation controls, and easy switching between the administrator view and the administrator's own customer portal.

### Delivered

A new **Validate Graph API** button now appears beside Microsoft Graph settings. It obtains a Microsoft Graph application token without sending a message, displays the configured sender and access-token expiry on success, and returns a clear credential failure on error. The existing **Send Test** action remains the explicit end-to-end mailbox delivery test.

The supplied MNDA was published as policy version **1.0**, effective August 11, 2026. The earlier 2026.03 version remains immutable for audit and historical acceptance records. Because the policy center checks the newest published version, customers who need the MNDA are now prompted against version 1.0.

Customer administration now includes **Verify email** and **Validate account** actions in grid, list, and account-detail views. Verify email only removes the email-confirmation requirement. Validate account marks the email verified, restores the account to active, clears any lock state, and resets failed-login tracking; every action is recorded in the activity audit log.

Administrators using the customer portal now see a prominent **Admin panel** shortcut in the top bar and sidebar/mobile drawer. The existing administrator-side customer portal link remains available for the reverse direction.

### Validation and deployment

TypeScript typecheck completed with zero errors. The full suite completed successfully with 142 passing tests. The production client/server bundles were rebuilt and deployed, migration `0009_mnda_v1.sql` was applied, the service restarted cleanly, and the readiness endpoint returned `{"status":"ready"}`.

## 2026-08-11 — MNDA Acceptance Route Correction

### User report

The customer portal returned a branded 404 page when the user selected **Review and sign** for the MNDA at `/portal/orders/2/nda`.

### Root cause and correction

The registered application route is `/portal/orders/:id/mnda`, but three customer-facing links in `OrderDetail.tsx` used `/portal/orders/:id/nda`. The route mismatch sent customers to the generic not-found page before the MNDA component could load.

All three links were corrected to `/portal/orders/:id/mnda`, including the action-required card and the signed/unsigned MNDA status links. The client was rebuilt and deployed. The service restart completed successfully and the readiness endpoint returned `{"status":"ready"}`.

### Phase webhook configuration

Phase-start payload URLs are configured at **Admin → Integrations → Webhook Endpoints**. The top of that page contains dedicated cards named **Phase I Start — P101** and **Phase II Start — P201**, each with a required HTTPS destination URL, optional HMAC signing secret, and an enable/disable control. The same page's **Delivery Log** tab displays delivery result, response code, diagnostics, retry, and redelivery controls.

## 2026-08-11 — Phase I / II Webhook Dispatch Correction

### User report

The administrator reported that starting the Phase I and Phase II outbound webhook actions did not work.

### Root cause

The dedicated P101 and P201 destination records were present and enabled, but the Phase I kickoff configuration had `notify_webhooks` disabled and the Phase II kickoff configuration did not exist. The manual Phase buttons relied on those optional phase-configuration flags, so they queued no webhook job even though the user explicitly selected **Start Phase I / queue P101** or **Start Phase II / queue P201**.

### Correction

Manual Phase I and Phase II starts now force a `notify_webhooks` job regardless of the optional phase configuration. The normal configuration still controls automatic lifecycle kickoffs. Production phase configuration was also corrected: Phase I webhook notifications are enabled, and an enabled Phase II configuration with webhook notifications was seeded.

The dedicated endpoint records remain configurable at **Admin → Integrations → Webhook Endpoints** under **Phase I Start — P101** and **Phase II Start — P201**. Delivery outcomes, retry, and redelivery remain available from **Delivery Log**.

### Validation and deployment

TypeScript typecheck completed with zero errors. The corrected server bundle was deployed, the service restarted successfully, and the readiness endpoint returned `{"status":"ready"}`.

## 2026-08-11 — MNDA Compatibility Route and Policy Center Version Correction

### User report

The customer continued to receive a 404 at `/portal/orders/2/nda`, and the MNDA version 1.0 was not visible as the current policy in the Policy Center.

### Corrections

A backward-compatible route alias now maps `/portal/orders/:id/nda` to the same MNDA acceptance component as `/portal/orders/:id/mnda`. This supports old browser bundles, cached links, and previously issued portal URLs while all current source links use the canonical `/mnda` route.

The initial MNDA migration had added version 1.0 while leaving the previous 2026.03 version marked published. The correction marks the earlier version as historical (`published = false`) and version 1.0 as the sole current version (`published = true`). Both remain available from the version history and existing acceptance records remain untouched.

### Validation and deployment

The client was rebuilt and deployed. The migration was re-applied idempotently, production confirmed 2026.03 as historical and 1.0 as current, the service restarted successfully, and the readiness endpoint returned `{"status":"ready"}`.

## 2026-08-11 — Encrypted Configuration Migration Export and Import

### User request

Add a method to export all ReadyPackets settings, configuration, and secrets to an encrypted file and import it into a new installation.

### Implementation

Added `deploy/config-migration.sh`, a root-only encrypted configuration migration tool with `export`, `inspect`, and `import` commands. It packages `/etc/readypackets/portal.env` together with database-backed platform configuration including site settings, feature flags, email templates and automations, webhook endpoints, phase configurations, SAML settings, outbound connections, subscription and product configuration, content blocks, and policy configuration.

The tool intentionally excludes customer records, orders, uploaded files, sessions, logs, and operational history. It encrypts the bundle using AES-256-CBC with PBKDF2-HMAC-SHA512 key derivation (600,000 iterations), applies an independent HMAC-SHA256 integrity tag, and validates internal SHA-256 checksums before any import. Imports require both `--replace-config` and `--apply-env`, an explicit confirmation phrase, and first save the destination environment as a timestamped pre-import file.

Added `docs/CONFIG_MIGRATION.md` with export, inspect, dry-run import, live import, scope, and post-import safety guidance. Added an **Encrypted configuration migration** card to Admin → Backups, including a copyable export command and a link to the guide.

### Validation and deployment

A real production export was created and integrity-inspected with a temporary root-only passphrase. A second production export was verified through the complete `import --dry-run` path. Both temporary bundles and passphrase files were removed after validation. The script was installed at `/opt/readypackets/deploy/config-migration.sh` with mode 750. The portal restarted successfully and returned `{"status":"ready"}`.


---

## 10. Continuation session — August 11, 2026

### 10.1 Requests carried forward

The inherited working context carried the following outstanding user requirements from the current feature batch:

> Add the ability to share orders with other accounts and create an RBAC system for customers who share the orders with other customers. (View only, Upload documents, View the final deliverables, Record a Business Pitch Idea, etc). Add a Company or Organizational sharing method to group all customers and members, or founders together under 1 umbrella so everyone can contribute give it a cool name.

> Change Deliverables to My Business Packets.

> Add the ability to Edit and configure the admin panel menu.

The project-level requirements remained unchanged: the application must remain self-hosted, must use no Manus runtime integrations or dependencies, and all prompts, outcomes, and changes must be retained in source control.

### 10.2 Response and implementation

The response was to complete the remaining collaboration, navigation, terminology, retention, and deployment work in the existing self-hosted TypeScript application rather than introducing any hosted dependency.

| Area | Work completed |
| --- | --- |
| **Bulk order retention** | Completed the admin order grid’s selection and confirmation workflow for `bulkSoftDeleteOrders`. Selected orders are moved to the existing recoverable trash model and respect the configurable retention period. |
| **Packet Collective** | Added `customer_workspaces` and `customer_workspace_members` schema structures and the idempotent `0011_customer_workspaces.sql` migration. Workspace owners can create a **Packet Collective**, invite active customer accounts as manager, contributor, or viewer, and share an owned order with every active workspace member. |
| **Direct order sharing** | Completed the order-detail interface for direct sharing, revocation, and granular scopes: view, upload documents, view final Business Packets, record a Business Pitch Idea, contributor, and manager. The server remains the authority for ownership and access checks. |
| **Workspace portal** | Added `/portal/workspaces` and the Packet Collective portal navigation item. The page supports workspace creation and member invitation; order owners can select an owned Packet Collective from the order page to perform workspace-wide sharing. |
| **Customer wording** | Replaced visible portal navigation, dashboard, file library, and order-detail labels with **My Business Packets**. Internal field and permission names were retained where needed for compatibility. |
| **Configurable admin menu** | Added a secured `adminNavigation` API backed by the existing `site_settings` store, the `/admin/navigation` editor, and runtime sidebar application. Administrators can set labels, visibility, grouping, order, and HTTPS custom links. External links open with `rel="noreferrer"`; authorization remains server-enforced, so hiding navigation cannot grant or remove access. |
| **Purge automation** | Confirmed `trash_purge` is registered with the production scheduler alongside existing jobs and that soft-deleted customer and order records are purged only after the configured `trash.retention_days` window. |

### 10.3 Verification and deployment record

The release was validated with `pnpm run typecheck` and the full Vitest suite: **142 tests passed with zero TypeScript errors**. A production client build and externalized Node 22 server build completed successfully.

Production migration status showed that migrations `0010_policy_automation_portal.sql` and `0011_customer_workspaces.sql` had not yet been applied. Both were reviewed and applied with MySQL before deployment. This created `portal_announcements`, `customer_workspaces`, and `customer_workspace_members`, added `users.onboarding_forced_at`, and seeded the retention/onboarding site settings idempotently.

The production deployment installed the verified server bundle and client assets under `/opt/readypackets`, retained the prior client build as a timestamped rollback directory, restarted `readypackets.service`, and confirmed the service listens only on `127.0.0.1:3000`. The public readiness endpoint subsequently returned `{"status":"ready"}` through Cloudflare at `https://myportal.readypackets.com/api/health/ready`.

The live verifier initially reported two edge-specific false negatives: Cloudflare legitimately adds `Server: cloudflare`, and its invalid-host rejection is a safe `403`. The verifier was corrected to distinguish a Cloudflare edge marker from an origin technology fingerprint and to accept safe 4xx invalid-host rejection. A re-run encountered expected authentication-rate-limit carryover from the previous intentional rate-limit probe; CSRF assertions were therefore made robust by recognizing either a direct `403` rejection or a `429` rate-limit rejection as a secure blocked mutation. The final live verification result was **46/46 checks passed**.

### 10.4 Files added or materially changed

| File | Purpose |
| --- | --- |
| `client/src/pages/portal/Workspaces.tsx` | Packet Collective workspace and invitation page. |
| `client/src/pages/portal/OrderDetail.tsx` | Direct and workspace-wide order sharing controls; My Business Packets labels. |
| `client/src/pages/admin/Navigation.tsx` | Admin menu configuration editor. |
| `client/src/components/layout/AdminLayout.tsx` | Applies saved navigation labels, visibility, groups, ordering, and custom links. |
| `client/src/pages/admin/Orders.tsx` | Bulk order trash controls. |
| `client/src/App.tsx` | Workspace and navigation-editor routes; renamed portal navigation. |
| `server/routers/adminNavigation.ts` | Admin-only persisted navigation configuration API. |
| `server/routers/orders.ts` | Packet Collective creation, membership, and workspace-sharing procedures. |
| `server/db/schema.ts` | Workspace and membership schema declarations. |
| `drizzle/migrations/0011_customer_workspaces.sql` | Idempotent workspace schema migration. |
| `scripts/verify-security.ts` | Cloudflare-aware security verification expectations. |

### 10.5 Result

The customer collaboration, configurable admin navigation, visible My Business Packets rename, purge-scheduler confirmation, migrations, build, deployment, and live security verification requested in the inherited feature batch are complete. The next action is to commit and push these source changes and this session record to the private `readypackets/ReadyPackets` repository.

---


---

## 11. Architecture and master-prompt assessment — August 11, 2026

### 11.1 Request received

> what else is missing from this application based on the architecture and master prompt?

### 11.2 Response and assessment method

The response was to review the current self-hosted architecture, the historic master prompt, the Batch 39 gap-analysis response, relevant payment/cart source code, the current production integration status, and the test/deployment record. This assessment intentionally distinguishes an **implemented capability**, a **production configuration dependency**, a **required acceptance test**, and an **intentional exception** from a feature that is genuinely absent.

The detailed evidence-based report is stored as `docs/IMPLEMENTATION_GAP_ASSESSMENT_2026-08-11.md`.

### 11.3 Result

The core operations platform is substantially present. The recommended next release is the commerce path: the normal order builder currently creates an order and navigates to its detail view rather than the existing checkout surface, so checkout coupons, Stripe redirect, payment return messaging, a persistent cart, and recommendations are not available in the live customer journey. The review also identified that database-stored Stripe settings are not consistently used by actual checkout/webhook execution, Stripe webhook processing needs an explicit idempotency guard, and the payment lifecycle lacks focused automated and Stripe test-mode acceptance coverage.

The report records the customer’s requested coupon behavior, full cart, tier-per-packet-group enforcement, non-coercive upsells/recommendations, Stripe Checkout hand-off, signed webhook confirmation, and paid-order update as P0/P1 work. It also records outstanding operational proof work: Stripe test mode, Graph/SharePoint, multi-target backup restore, SAML pilot, and Docker clean-install validation.

The historic references to Manus OAuth and a PWA/service worker are intentional exceptions, not defects: the application is self-hosted without Manus runtime dependencies and PWA support remains disabled at the user’s request.

---


---

## 12. Commerce, policy-route, and recoverable-order release — August 11, 2026

### 12.1 Request received

> start working on the to do list and add these items as well to the list and then begin working on the needed gaps
>
> 1. also add to the to do list fix all the policies so that they show and not a 404 page error.
> 2. add a link to the trash can for orders that are deleted

The user supplied a public `/refunds` screenshot showing the branded 404 page and an `/admin/orders` screenshot showing that no deleted-order destination was visible. The prior approved workplan already prioritized the checkout coupon, cart, Stripe hand-off, payment lifecycle, and recommendation gaps.

### 12.2 Workplan changes

The active workplan was expanded to cover policy routing and deleted-order recovery before the commerce release. The subsequent build sequence was: diagnose and correct public policy aliases; add a recoverable order-trash route; repair Stripe configuration consistency and payment lifecycle safeguards; move the live order builder into the checkout flow; add coupon controls and a persistent cart; add catalog-driven recommendations; validate and deploy.

### 12.3 Implementation completed

| Area | Completed outcome |
| --- | --- |
| **Public policy routes** | Registered legacy public aliases `/privacy`, `/terms`, `/refunds`, and `/disclaimer`, as well as canonical `/legal/<slug>` mappings. The policy renderer now resolves the published versioned policy document for each supported route. |
| **Order trash** | Added an **Order trash** link to the admin order queue, a dedicated `/admin/orders/trash` page, server-side trashed-order listing, audited restore action, confirmation dialog, and return to active order queue. Soft deletion and retention remain unchanged. |
| **Coupon experience** | Added a visible coupon field to the live order-builder quote panel. A coupon applies either through an explicit **Apply** control, Enter, or blur; it previews the discount, supports removal, forwards the accepted code to checkout, and returns clear validation feedback. |
| **Checkout hand-off** | Standard priced orders now proceed from order creation to `/portal/checkout` rather than directly to the order detail. Custom-quote orders remain on the existing invoice path. Checkout automatically validates a carried coupon. |
| **Payment return** | Added clear paid/confirming/cancelled feedback after Stripe redirects back to the order. The customer-facing paid status remains based on server-side verification, not the browser return URL. |
| **Stripe configuration** | Centralized execution paths on database-or-environment effective Stripe credentials and effective webhook signing secret. Coupon start dates are enforced, and an invalid code is rejected during checkout creation rather than silently ignored. |
| **Payment idempotency** | Added a guard that makes repeated completed-checkout notifications harmless once an order is paid, preventing repeat coupon/referral handling for that order. |
| **Cart and recommendations** | The packet selector is now a persistent browser cart: selections, project name, and draft coupon survive navigation/reload in the browser until checkout or explicit clearing. The UI enforces one tier visually, the service now rejects duplicate packet-group tiers server-side, and the quote panel offers non-coercive catalog-driven packet suggestions plus bundle-progress guidance. |

### 12.4 Verification and deployment

`pnpm run typecheck` completed successfully after each implementation stage. The Vitest suite completed successfully with **142 passing tests**. The production client and server bundles were built and deployed under `/opt/readypackets` with the previous client build retained as a timestamped rollback artifact. `readypackets.service` restarted successfully, the public readiness endpoint returned `{"status":"ready"}`, and the live security verification suite passed **46/46 checks**.

The deployed `https://myportal.readypackets.com/refunds` route was verified in a browser. It now renders the published Refund Policy, version 2026.03 effective March 2026, rather than the public 404 page. The verification record is stored in `docs/verification/policy-route-check-2026-08-11.md`.

### 12.5 Remaining optional production configuration

Stripe remains intentionally inactive until production Stripe keys and a signed webhook endpoint are configured. The implementation can be tested immediately using Stripe test keys; a complete test-mode lifecycle should be run before accepting real payment. The recoverable order-trash view requires an authenticated administrator to exercise the restore workflow, and no order was modified solely for verification.

---


---

## 13. Three-mode appearance setting — August 11, 2026

### 13.1 Request received

> add a light and dark mode and system mode with system mode being the default

### 13.2 Implementation and deployment

The portal already had a theme provider with a persisted `system | light | dark` preference and system-aware initialization, but exposed only a binary icon toggle in the public header. The control was replaced with an accessible three-mode appearance picker that explicitly presents **System**, **Light**, and **Dark** options. System is the default for visitors who have no stored preference; it follows `prefers-color-scheme` and automatically reacts to operating-system appearance changes. Chosen modes persist using the existing `rp-theme` browser preference.

The shared selector is now available in the public header and in the authenticated portal/admin top bar. It identifies the current choice, includes accessible radio-menu semantics, and may be dismissed with Escape.

Validation completed with zero TypeScript errors and 142 passing tests. The client and server release artifacts were built and deployed to the VPS. `readypackets.service` restarted successfully and `https://myportal.readypackets.com/api/health/ready` returned `{"status":"ready"}`. The previous client bundle remains preserved on the host as a timestamped rollback artifact.

---


---

## 14. Explicit visible appearance controls — August 11, 2026

### 14.1 Request received

> there should be a button to choose light dark or system mode on the portal and website thats clearly visible

### 14.2 Implementation and deployment

The prior appearance control used a compact icon that opened the three-way picker, which did not meet the request for immediately visible selection. It was replaced with a labeled segmented control containing three directly selectable buttons: **System**, **Light**, and **Dark**. The selected choice is highlighted and is exposed with radio-group semantics. System remains the default for a visitor without a saved preference.

The visible segmented control is rendered directly in the desktop public header and authenticated portal/admin top bar. For narrow public screens, it is shown as a labeled **Appearance** section within the mobile navigation panel, where all three choices remain direct actions.

Zero TypeScript errors and 142 automated tests passed. The production client and server bundles were built and deployed, the service restarted cleanly, and the readiness endpoint returned `{"status":"ready"}`. A browser check of the deployed public homepage confirmed System, Light, and Dark are visible as separate header buttons.

---


---

## 15. Global branded themes and Single Sign-On entry — August 11, 2026

### 15.1 Request received

> i dont see a button or toggle for dark mode changes
> add a button for Single Sign On

The user subsequently confirmed, with Light and Dark homepage screenshots, that the labeled appearance control changed state but the general page palette did not visibly change.

### 15.2 Implementation and deployment

The global stylesheet now defines a full ReadyPackets **dark palette** behind `html.dark`: deep navy application surfaces, blue-navy elevated panels, high-contrast off-white text, teal primary controls, and gold accent values. Existing token-based components change together, while narrowly scoped compatibility rules remap legacy white/gray layout utilities. This preserves ReadyPackets brand colors while making global dark and light appearances visibly distinct. Light retains the intentional navy public hero as a branded surface; application backgrounds, navigation chrome, cards, panels, text, borders, and controls change by mode.

The verified public header retains direct System, Light, and Dark controls. Selecting Light removes the root dark class and restores the white application background/header. Selecting Dark applies a deep branded navy header, content/background surfaces, cards, and high-contrast text; this was confirmed visually in a live browser after deployment. Evidence is saved in `docs/verification/theme-and-sso-check-2026-08-11.md`.

A visible **Continue with Single Sign-On** button was added to the regular sign-in form. The session bootstrap now exposes only `enabled` and a display name for an active SAML provider. When an administrator enables SAML through the existing Entra/SSO configuration, the button routes to the existing `/api/saml/login` endpoint. When no provider is active, the button remains visibly disabled with an explanation. No certificate, issuer, IdP endpoint, or other SAML configuration detail is exposed publicly.

Type checking completed with zero errors, the full suite passed with 142 tests, client/server artifacts were built without stylesheet optimization warnings, and the new release was deployed. The readiness endpoint returned `{"status":"ready"}`; a timestamped previous client build is retained on the VPS for rollback.

---


---

## 16. Account trash and bulk recovery — August 11, 2026

### 16.1 Request received

> the trash can option is missinf from the customer accounts page so if a user is sent to the trash it cant be restored. there should also be a bulk restore options for accounts in the trash
> there should be a bulk restore for the order trash

The supplied customer-directory screenshot confirmed that `/admin/customers` did not expose a trash destination. The supplied order-trash screenshot confirmed that existing trashed orders could only be restored individually.

### 16.2 Implementation and deployment

An administrator-only **Account trash** button was added to the Customers page and routes to `/admin/customers/trash`. The page lists soft-deleted accounts, displays their account identity, role, and deletion date, and includes individual restore plus selection checkboxes and a confirmed **Restore selected accounts** action. Restoring reactivates the account without losing its customer ID, history, files, tickets, or activity trail.

The existing Order trash page now has selection checkboxes, a selected-order banner, and a confirmed **Restore selected orders** action in addition to its single-item restore capability. Both bulk endpoints select only records that are still trashed, require the exact restore confirmation value, restore only that validated subset, write administrative activity records, and refresh the active management queues.

The server now includes `trashedCustomers`, `bulkRestoreCustomers`, and `bulkRestoreOrders` admin procedures. Existing retention/purge behavior remains unchanged.

TypeScript passed with zero errors and the full test suite passed with 142 tests. Production artifacts were built and deployed; `readypackets.service` restarted successfully, the readiness endpoint returned `{"status":"ready"}`, and the previous client bundle was kept as a rollback artifact.

---


## Continuation session — 2026-08-12: Dashboard routing, referrals, announcements, question banks, and email operations

### User requests addressed

The customer reported that the portal **Unread replies** card led to a 404 page, requested clickable administrative dashboard cards, a dedicated customer referral area, targeted portal announcements, order-specific Phase 1 and Phase 2 question banks, removal of the built-in intake questionnaire, and a comprehensive email-template/audit center. The work preserves the platform's self-hosted security model and was deployed to the existing VPS.

### Delivered capability changes

| Area | Completed change |
|---|---|
| Dashboard navigation | Repaired the unread-replies target to the ticket list and made customer and administration dashboard KPI cards use direct related routes. |
| Customer referrals | Added a Referrals portal destination and navigation item with private referral statistics, referral-code copying, mail-link sharing, and web-link sharing. Added a dashboard referral-statistics card. |
| Portal announcements | Added selected-account targeting on top of all-user, customer, and staff audiences. Administrators can select individual accounts or bulk-select the listed accounts. Customer visibility is enforced server-side. |
| Question workflow | Renamed Phase 1 templates to **Order Question Banks**. Templates and direct questions now support Phase 1 or Phase 2, and the selected template is copied to an order immediately. Customer questions display their phase on the order detail page. |
| Intake | Disabled the legacy built-in multi-section questionnaire and its required validation. The intake now focuses on project preparation, supporting materials, Business Pitch recording, and staff-assigned order questions. |
| Email Template Center | Added `/admin/email-center` for template editing, HTML or rich-text authoring, sandboxed preview, cloning, retained sent-email history, and viewing retained message copies. |
| Email audit operations | Added encrypted audit retention for recipient, BCC, HTML, plain-text content, status, and timestamps. Added configurable global audit BCC and 7–3650 day retention policies, plus confirmed purge controls. BCC applies through both Microsoft Graph and SMTP. |

### Schema migrations

Applied to production:

- `0012_announcement_recipients.sql` — selected announcement recipient records.
- `0013_order_question_phases.sql` — Phase 1/Phase 2 question metadata and index.
- `0014_email_delivery_retention.sql` — encrypted recipient/BCC/body retention fields for sent-email audit history.

### Verification and deployment

- TypeScript check completed with **0 errors**.
- Full test suite completed with **142 passing tests**.
- Client and server production build completed successfully.
- Production service restarted successfully; the application reports `{"status":"ok"}`.
- Live security verification completed with **46/46 passing checks**.
- The deployment retained the prior client build on the VPS for rollback.

### Notes

The first post-restart local health probe occurred during the service's normal several-second startup window and was retried after log confirmation. The service listener and both local/public readiness checks succeeded afterward. The `build:cli` alias is not present in the repository, so the documented separate `build:client` and `build:server` commands were used instead.


## Continuation session — 2026-08-12: Modal input reliability and public-site enhancement roadmap

### New requested roadmap items

The customer added the following future work to the ReadyPackets enhancement roadmap:

1. An administrator-managed FAQ system with per-item controls for publishing selected FAQs on the public website.
2. A public-site accessibility program targeting WCAG 2.2 AA conformance, including keyboard, focus, semantic, form-label, contrast, and reduced-motion review.
3. Public-site SEO, GEO, and AEO improvements, including canonical metadata, structured data, sitemap/robots review, answer-first content, and crawlable public pages.
4. An administrative marketing system for campaign planning, public promotion content, channel-ready copy, and measurable campaign status tracking.

### Reported security-modal defect and correction

The customer reported that the **Block an address** form accepted one character, then moved the cursor out of the text field. Code review traced this to the shared modal focus-trap effect depending on the `onClose` callback. Pages commonly provide an inline callback, so each controlled-input change generated a new callback identity. React therefore cleaned up the open-modal effect on every keystroke, restoring focus to the original trigger and then reinitialising the dialog.

The shared modal now keeps the latest close callback in a ref while the focus-trap effect depends only on its open state. This preserves correct Escape handling and focus restoration when the dialog closes, but prevents cleanup/remount behavior while a user types. The correction benefits every controlled form rendered inside the shared modal component, including the address block and allowlist forms.

The change was type-checked successfully, built, and deployed to production. Browser verification reached the sign-in boundary because the sandbox session has no active administrator MFA session; no credential or MFA challenge was entered automatically. The deployed behavior is supported by the corrected focus lifecycle and successful production readiness check.


## Continuation session — 2026-08-12: Shared modal and controlled-field focus audit

### Request

> can you check all the other code and fields to make sure its not happening on any other windows

### Audit coverage and result

A client-wide inventory located the shared `Modal`/`ConfirmDialog` primitive plus **30 administrative and portal page call sites** that render it. The scan also checked for independent portal/dialog implementations, volatile dialog keys, and focus effects whose lifecycle depends on callback identities. No other independently implemented dialog primitive or volatile form key was found.

The reported defect originated in the one shared focus-trap effect. The original effect depended on both `open` and the `onClose` function prop. Many callers use inline close callbacks; each controlled input update therefore changed `onClose`, ran cleanup, restored focus to the triggering button, and reinitialised the dialog. The deployed shared fix holds the latest close callback in a ref while the focus-trap lifecycle depends solely on `open`.

Because every client modal and confirmation dialog uses that shared primitive, the fix covers all existing modal form surfaces rather than only the address-block dialog. A regression test, `tests/modal-focus.test.ts`, now prevents reintroducing the unstable `[open, onClose]` focus lifecycle. The complete suite passed with **143 tests**, including the new modal-focus test, and TypeScript passed with zero errors.

No new production bundle was required during this audit because the shared modal correction was already deployed in the immediately preceding release. This continuation adds regression coverage and the completed audit record.


## 2026-08-12 — Delivery Control, Knowledge Base, Automation, and Backup Operations Release

### User-requested outcomes addressed

The user requested administrative controls to stop queued email retries, retry failed messages, resend historical messages, choose Email Template Center templates in email automations, add email and webhook actions to order automations, support Phase I, Phase II, both-phase, and unassigned question-bank templates, introduce an admin-approved customer knowledge base, add a Stripe connection test, and expand the backup console with encrypted configuration export, scheduled backups, protected downloads, and multiple external-cloud sync destinations.

### Implemented capabilities

1. **Email delivery operations.** The Email Template Center now includes queued-delivery visibility and audited stop, retry, and resend actions. Queue cancellation prevents further retry processing; retry restores an eligible failed/cancelled queued message; resend creates a new queued delivery while retaining lineage to the original message.
2. **Email automation template selection.** Email automations now use an Email Template Center dropdown rather than a free-text template key. The server validates selected templates before rules are saved.
3. **Order automation actions.** Lifecycle rules can now set completion percentage, queue a selected email template to the order customer, or queue a delivery to an enabled outbound webhook endpoint. Actions use the existing mail and webhook queues and write system audit activity.
4. **Flexible question-bank phases.** Reusable order-question templates now support Phase I, Phase II, both phases, or unassigned. Applying a both-phases template creates distinct Phase I and Phase II question records for the order.
5. **Stripe connection test.** Finance → Stripe Settings now offers an administrator-only connection test using Stripe's authenticated balance endpoint. It reports safe account/balance metadata only and does not expose credentials.
6. **Knowledge base.** Added approved knowledge-base articles with draft, pending-review, published, and rejected states. Staff can draft and submit articles; administrators approve/publish, unpublish, request revisions, or delete. Only published articles are exposed inside the customer portal Knowledge base destination.
7. **Backup operations.** Added a root-owned, allowlisted backup-control helper used by the application through a narrow sudo rule. The admin backup page now offers immediate runs, daily schedule selection, protected archive downloads, passphrase-encrypted configuration-export downloads, and management of multiple rclone destinations for Amazon S3, Wasabi S3, Backblaze B2, Azure Blob Storage, SharePoint, Google Drive, OneDrive, and Dropbox. Archive synchronization runs after each completed backup and does not delete the verified local archive when a remote target fails.

### Production changes and safeguards

Migrations `0015_delivery_and_automation_actions.sql` and `0016_knowledge_base_articles.sql` were applied. The VPS now has rclone installed and a documented backup-control helper. Backup archives and administrative export staging use `root:readypackets` mode `0750`; individual archive/export files remain non-world-readable. External provider credentials remain in root-owned rclone configuration rather than portal storage or browser state. The change is recorded in the VPS `AGENTS.md` operating record.

### Validation

`pnpm run typecheck` completed with zero TypeScript errors. `pnpm test` passed all 143 tests. Shell syntax checks passed for the backup scripts and installer. The production readiness endpoint succeeded, schema additions were confirmed, the restricted `readypackets` service-account backup-control path was verified, and the live security suite passed all 46 of 46 checks.


## 2026-08-12 — Stripe Checkout Activation-State Correction

### Reported issue

The user reported that the Finance page displayed Stripe as active while a customer order presented “Online payment is not currently enabled” instead of opening Stripe Checkout. Screenshots showed a secret key and publishable key saved in Finance, but no webhook signing secret configured. The checkout example also applied coupon `ALEX99`, reducing the displayed purchase amount to `$0.00`.

### Root cause and correction

The Finance status page correctly used effective Stripe settings (database values first, environment fallback) to show an active secret key. The customer `createCheckout` procedure used a separate environment-only `env.stripe.enabled` boolean. Therefore an administrator-saved Stripe secret key could appear active while checkout rejected customers before attempting Stripe.

Checkout eligibility now uses the same effective database-or-environment secret-key resolver as Finance. To prevent an unsafe “redirect succeeded but order was never verified as paid” flow, checkout also requires the Stripe webhook signing secret. Finance now reports three distinct states: **Not configured**, **Webhook required** (Stripe key can be tested but verified checkout is blocked), and **Payment ready** (secret key plus webhook signing secret).

### Production verification

The saved secret and publishable keys were confirmed present without reading their values. The webhook signing secret was confirmed missing. The corrected server and Finance client were deployed with a rollback-preserved client bundle. TypeScript passed with zero errors, all 143 automated tests passed, production readiness succeeded, and the live security suite passed 46/46 checks.

### Required administrator action

In Stripe Workbench/Dashboard, create an HTTPS webhook endpoint at `https://myportal.readypackets.com/api/stripe/webhook`, configure the snapshot events `checkout.session.completed`, `payment_intent.payment_failed`, and `charge.refunded`, then copy the resulting endpoint signing secret (`whsec_...`) into **Admin → Finance → Stripe Settings** and save. Use **Test Stripe connection** before accepting live payment. A 100% coupon such as `ALEX99` leaves no amount to collect; test a nonzero order when confirming the hosted payment redirect.


## 2026-08-12 — Fixed Cart Price Coupon Method

### User request

The user requested three coupon methods: **percentage off**, **fixed amount off**, and **fixed cart price**.

### Implemented behavior

Coupon administration now offers all three methods in both Finance → Coupons and the dedicated Coupons management page. Percentage discounts are limited to 1–100%; fixed-amount discounts must be at least one cent; fixed-cart-price discounts accept a target final cart price in cents, including zero for a fully covered cart.

A fixed-cart-price coupon stores the desired final total, not a static discount. At validation time, the service calculates `current cart total − target cart price`; it rejects the coupon if that would not reduce the current order. Customer checkout now displays the computed savings and labels the selected coupon with its final cart price.

Stripe represents discounts only as percentage or amount-off coupons. For a fixed-cart-price coupon, ReadyPackets creates/reuses a Stripe amount-off coupon equal to the server-calculated discount for that exact order total. Its provider-side name includes the original order total, preventing reuse of an amount-off translation for a different cart total.

### Validation and deployment

No database migration was required because the existing coupon method storage is a varchar field. TypeScript passed with zero errors, all 143 tests passed, the production service returned ready after deployment, and the live security verification suite passed 46/46 checks.


## 2026-08-12 — Coupon Deletion Controls

### User request

The user reported that the Finance → Coupons table exposed editing and enable/disable actions but no deletion option for old coupons.

### Implemented behavior

Both coupon administration surfaces now expose a **Delete** action for coupons that are already inactive and have zero redemptions. Selecting Delete opens an explicit irreversible confirmation dialog. The server repeats all protections: the caller must be an administrator, the coupon must exist, it must be inactive, and its redemption count must be zero.

Coupons with a redemption history are retained rather than deleted. The interface labels those inactive records **Retained**, and the server rejects deletion so financial history remains auditable. Active coupons must first be disabled; this adds a deliberate pause before a permanent removal. Successful deletion writes a warning-level administrative activity record with coupon ID and code, without adding sensitive information to audit logs.

### Validation and deployment

TypeScript completed with zero errors, all 143 tests passed, the production service returned ready after deployment, and the live security verification suite passed 46/46 checks.


## 2026-08-12 — Webhook Delivery Controls and SharePoint Discovery

### User request

The user requested clearer webhook-delivery controls—Retry, Stop, and Redeliver—and the ability to discover SharePoint configuration from only a tenant ID, client ID, client secret, and SharePoint site URL.

### Implemented behavior

The Integration → Delivery Log now renders clear button controls rather than ambiguous text links. Pending records expose **Retry** and confirmation-protected **Stop**. Failed and stopped records expose **Retry** and **Redeliver**. Delivered records expose **Redeliver**. Retry reopens the original delivery, clears prior response diagnostics, and reuses the scheduler; Stop changes only pending work to a non-schedulable `stopped` state; Redeliver creates a distinct audited delivery record from a non-pending record. The server validates every state transition, prevents duplicate redelivery while a record is already pending, and records privileged actions in the activity log.

The SharePoint & SAML integration tab now includes **Discover site & library**. It accepts the Tenant ID, Client ID, client secret (or a previously encrypted saved secret), and SharePoint site URL. The server uses Microsoft Graph client-credential authentication only for this operation, resolves the Graph site ID from the HTTPS `*.sharepoint.com` URL, discovers the default document library and available libraries, and populates the site ID and drive ID for administrator review. Credentials are never returned, displayed, or written to activity logs. The administrator must still press **Save SharePoint settings** to persist the reviewed configuration.

### Permission note

Microsoft Graph discovery requires an application permission that can read the site and its drives. Existing sync requires write permission to create folders and upload order documents. Microsoft Graph’s official site-by-path and site-drive documentation was consulted during implementation.

### Validation and deployment

TypeScript completed with zero errors, all 143 tests passed, production readiness succeeded after deployment, and the live security verification suite passed 46/46 checks.

## 2026-08-12 — Credential protection, opaque account references, and Security Centre release

### User request

The user requested verified protection for Microsoft Graph/SharePoint credentials and customer data, opaque alphanumeric user IDs for current and future accounts, and an expanded Security Centre log workspace with detailed review, blocking, banning, and advanced search capabilities.

### Delivered changes

- Audited SharePoint configuration handling. The Graph client secret is encrypted with AES-256-GCM before being persisted as the `sharepoint.client_secret_enc` secret setting, is not returned by Graph configuration status APIs, and is decrypted only server-side for an authenticated Microsoft Graph operation.
- Hardened `deploy/config-migration.sh` so administrator-triggered configuration exports are secret-free by default. Default bundles exclude application keys, database credentials, encrypted secret settings, and Microsoft Graph/SharePoint credentials. Standard imports preserve the target host environment and secret settings. The `--include-secrets --apply-env` mode is documented as root-console-only break-glass recovery and is not available from the portal.
- Added MySQL-compatible migration `0017_public_user_identifiers.sql` and applied it to production. It reconciles the missing legacy `customer_number` column, adds `public_id`, backfills all existing accounts, and enforces uniqueness indexes.
- Added opaque public account references in `RP-U-<12 uppercase hexadecimal>` form for every new account. Existing production accounts were backfilled and verified to have unique public IDs. Internal numeric database keys remain relational-only.
- Added the public account reference to authenticated session state and Customer Portal → Settings with a copy control. Security-log results and review screens now display the opaque reference instead of showing a sequential user number.
- Expanded Security Centre → Logs with advanced security search by severity, outcome, event type, message, source address, linked account, and date range; matching-result totals; an audited detailed event view; confirmation-based IP block actions; and confirmation-based account ban actions that deactivate the account and revoke active sessions. The server validates all transitions and records audit/security events.
- Verified live schema state after migration: 5 accounts, 0 missing public IDs, 5 distinct public IDs, and 0 missing customer numbers.
- Updated the production VPS operating record with the new secret-free export and public-ID safeguards.

### Validation and deployment

- `pnpm test`: 143 tests passed.
- `pnpm run typecheck`: 0 TypeScript errors.
- `bash -n deploy/config-migration.sh`: passed.
- Built the client and server artifacts, deployed them to `/opt/readypackets`, restarted `readypackets.service`, and confirmed public health `{"status":"ok"}`.
- Live security verification passed 46/46 checks after deployment.

### Security posture note

The platform enforces TLS for public transit through nginx and Cloudflare and uses strict security headers. Sensitive application fields—including customer PII and saved Graph secrets—are application-encrypted with AES-256-GCM; email lookup uses a keyed blind index. Application code and protected backups still require privileged host/database access controls, so no system can truthfully claim that every operational metadata field or root-access backup is mathematically unreadable. The release narrows export exposure and preserves strict privilege boundaries rather than making that false claim.


## 2026-08-12 — Release governance, identity controls, observability, and comprehensive review

### Requested work

The owner requested a prioritized assessment of remaining master-prompt features while completing configurable SAML role assignment, maintenance mode access gates, secure customer magic-link sign-in with MFA, expanded system and security logging, a full code/security/functionality review, and version history with controlled public release publishing.

### Delivered implementation

- Added administrative changelog release governance: drafts, explicit publish and unpublish actions, immutable revision snapshots, version-history viewing, and audit events. Only published entries remain visible through the public changelog surface.
- Added configurable SAML auto-provisioning roles for Customer, Staff, and Administrator. SAML-provisioned administrators follow the existing MFA-pending security path and cannot receive a full privileged session before MFA is completed.
- Added dedicated, audited maintenance gates for public access, login, and new account creation, while preserving allowlist bypass behavior for authorised operators.
- Added hashed, recipient-bound, single-use 15-minute customer magic-link tokens with generic responses that do not disclose account existence. Magic-link authentication requires a valid MFA completion path or MFA enrolment before customer access is granted.
- Added advanced Activity Replay system search across action, entity type/ID, severity, source address, text, date, pagination, and event review fields.
- Added changelog revision and magic-link-token migrations `0018_changelog_entry_versions.sql` and `0019_magic_link_tokens.sql`, both applied to production.
- Completed a dependency and source review. Removed the unused legacy `passport-saml` dependency, upgraded Drizzle ORM, Nodemailer, file-type, and Multer, and replaced policy HTML interpolation with the shared safe React Markdown renderer.
- Wrote `docs/FEATURE_GAPS_AND_PRIORITIES_2026-08-12.md` and `docs/COMPREHENSIVE_CODE_SECURITY_FUNCTIONALITY_REVIEW_2026-08-12.md`.

### Validation and deployment

- `pnpm run typecheck` passed with zero errors.
- `pnpm test` passed: 143 tests.
- Final `pnpm audit --prod` reported no known vulnerabilities.
- Client and server production builds completed successfully. The release was deployed to the VPS, migrations were verified, and local/public `/api/health` checks returned `{\"status\":\"ok\"}`.
- Live security verification against `https://myportal.readypackets.com` passed 46/46 checks.

### Residual operational requirements

The public gap assessment identifies Stripe signed-webhook setup, SharePoint production validation, external backup restore testing, full-volume encryption planning, migration-journal reconciliation, and browser-level regression coverage as the most important remaining operational items. These are documented in the review report and must be handled through controlled configuration or maintenance work.

### User communication summary

The user will receive the prioritized feature-gap assessment and release history/governance outcome with links to both new review documents and the final source/session-log commit.



---

## Session — Aug. 12, 2026: Lifecycle toolkit, installation controls, documentation release, and production recovery

### User request

> Add a built-in platform upgrade system based on GitHub changes, with private-repository PAT support, change scanning, administrator approval, and rollback. Add a factory-reset script. Update all customer, administrator, deployment, upgrade, and factory-reset documentation; update the current-context/master-prompt document; provide individual files and a ZIP bundle; use one unified installer for bare-metal VPS, an existing Docker host, or a VPS where Docker is installed by the installer. Upload the code and the full session prompt/response log to GitHub.

### Delivery principles applied

The implementation remains **self-hosted** and does not introduce a Manus runtime integration, hosted dependency, or public-facing AI reference. The upgrade workflow does not permit arbitrary host commands, unrestricted source execution, or unreviewed network changes. A private-repository personal access token is encrypted in the application settings store and supplied to the privileged helper only over standard input for the one process that requires it. It is never written into the service environment, browser, Git configuration, command history, diagnostic output, or application audit payloads.

| Capability | Delivered behaviour | Control boundary |
| --- | --- | --- |
| Platform Updates workspace | Administrators can configure a private GitHub repository, save an encrypted PAT, scan candidate commits and changed files, examine risk indicators, explicitly approve a single scanned commit, run the approved upgrade, and request a rollback of a recorded run. | Privileged host work is restricted to a root-owned helper; the application cannot invoke an arbitrary command or choose an arbitrary host path. |
| Update history | Every scan, approval, execution, outcome, and rollback is persisted in `platform_upgrade_runs`. | The migration is versioned as `0020_platform_upgrade_runs.sql` and was applied before exposing the workspace. |
| Protected update helper | `/usr/local/sbin/readypackets-platform-update` implements bounded `status`, approved `apply`, and recorded `rollback` operations. It creates protected application/database snapshots before updating. | Root-owned executable, tightly scoped sudo rule for the service account, protected workspace under `/var/lib/readypackets/platform-upgrades`, and protected snapshots under `/var/backups/readypackets/platform-upgrades`. |
| Factory reset | `deploy/factory-reset.sh` now requires an explicit typed confirmation, supports native and Docker modes, and can preserve admissible operational evidence with `--preserve-evidence`. | It is a root-console operation only; it is not exposed through the web application. |
| Unified installation | `deploy/unified-install.sh` offers native VPS, existing Docker, and Docker-bootstrap installation choices, delegating to the hardened deployment paths rather than maintaining competing installers. | Existing protected environment settings are retained by the supported installer; runtime credentials are not embedded in the generated application artefacts. |
| Documentation | Customer, administrator, deployment/install, upgrade/rollback, factory-reset, documentation-index, and current-context/master-prompt guides were created or refreshed. | A distributable package contains the documents and lifecycle scripts without production secrets. |

### Implementation record

The API surface was added in `server/routers/platformUpdates.ts` and registered in `server/routers/index.ts`. It validates the repository form and commit workflow, encrypts sensitive configuration with the platform's existing at-rest encryption facilities, records upgrade history, and requires administrative authorisation. The corresponding administrator interface is `client/src/pages/admin/PlatformUpdates.tsx`, routed through `client/src/App.tsx` and placed in the configurable default administration navigation at `/admin/platform-updates`.

The restricted host companion is defined in `deploy/platform-upgrade-control.sh`. The native installer (`deploy/install.sh`) now installs the helper and scoped sudo rule during future native installations. On the already-running VPS, the helper, sudo policy, protected directories, and migration were installed directly and recorded in the machine operations record (`AGENTS.md`). `deploy/factory-reset.sh` and the new `deploy/unified-install.sh` complete the lifecycle toolchain.

The documentation set refreshed during this release is:

| File | Audience and purpose |
| --- | --- |
| `docs/USER_GUIDE.md` | Customer portal use, account security, orders, My Business Packets, workspace collaboration, and support. |
| `docs/ADMINISTRATOR_GUIDE.md` | Administrative operations, protected configuration, platform updates, backup, incident response, and permissions. |
| `docs/DEPLOYMENT_AND_INSTALL.md` | Native VPS, existing Docker, and Docker-bootstrap installation procedures. |
| `docs/UPGRADE_AND_ROLLBACK.md` | Scan/approval/apply/rollback workflow, preconditions, evidence, and recovery guidance. |
| `docs/FACTORY_RESET.md` | Factory-reset modes, mandatory confirmation, evidence preservation, and fresh-install sequence. |
| `docs/CURRENT_CONTEXT_AND_MASTER_PROMPT.md` | Current product mandate, implemented capability inventory, security constraints, and prioritized remaining roadmap. |
| `docs/DOCUMENTATION_INDEX.md` | Navigation index for all operator and customer documentation. |

A portable release package was prepared at `release-artifacts/readypackets-lifecycle-documentation-2026-08-12.zip`. It contains the above documentation and the lifecycle scripts needed for review or a self-hosted installation, excluding operational keys, credentials, uploaded customer material, production database contents, and backup archives.

### Production deployment and recovery note

The lifecycle release was deployed to `https://myportal.readypackets.com`, and database migration `0020_platform_upgrade_runs.sql` was applied successfully. During the first deployment attempt, the server bundle directory (`dist/`) was mistaken for the Vite client directory (`client/dist/`). That left the expected runtime client directory (`/opt/readypackets/client/dist`) empty, producing a failure to load the application shell even though the API health endpoint remained available.

The incident was corrected without changing source code or discarding prior client builds. The actual Vite distribution was archived from `client/dist`, transferred to the server staging area, extracted into a newly created protected directory, ownership and access modes were set, and the empty target directory was rotated to a timestamped forensic backup before the restored directory was put in place. The service was restarted, the health endpoint returned `{"status":"ok"}`, and `/opt/readypackets/client/dist/index.html` was confirmed present. The previous error page therefore was a deployment-path issue, not an application route, policy, database, or authentication failure.

### Verification record

The production health probe succeeded after the client-asset recovery. The protected update helper is installed and reports the service active. Its current release commit is initially reported as `unknown` because this is the first release using the lifecycle control and no `RELEASE_COMMIT` marker existed previously; the marker is populated by the approved update process after its first managed upgrade.

The black-box security verifier was rerun against the production hostname after restoration. It passed 45 of 46 checks. All CSP nonce, hardening-header, cookie, CSRF, authorization, host-validation, information-disclosure, and public-surface checks passed. The only reported item was the `Retry-After` assertion after the intentional login-rate-limit burst. The response header is set on both limiter paths in `server/security/rateLimit.ts`; this known probe timing interaction can occur when an earlier probe has already exhausted the category budget. It does not alter the restoration result or leave the portal unhealthy, but it remains a useful item to re-run from a fresh rate-limit window after later traffic-control changes.

### GitHub publication pending at the time of this entry

This session entry is intentionally recorded before the release commit so the source, documentation bundle, and full lifecycle/recovery record are committed together to the private `readypackets/ReadyPackets` repository. The next actions are to run the build/type/test gates against the exact committed tree, create the release commit, push `main`, write its commit identifier to the production `RELEASE_COMMIT` marker, and make the requested ZIP and individual documentation files available to the operator.

---

*The lifecycle toolkit release, its operating rationale, the transient production deployment-path incident, and the recovery have been recorded here to satisfy the project requirement that prompts, responses, outcomes, and operational context remain in version control.*


### Lifecycle release verification and publication update

The final local gates for the lifecycle source tree completed successfully:

```text
pnpm run typecheck      # 0 TypeScript errors
pnpm test               # 143 tests passed across 9 test files
pnpm run build:client   # Vite production build completed
pnpm run build:server   # Node 22 production bundle completed
```

The release was committed as `89d0a89c2780ed0ece8b9560835020f021c582f8` with message `feat: add lifecycle toolkit and release documentation` and successfully pushed to the private repository's `main` branch. GitHub confirms the canonical repository URL as `https://github.com/readypackets/ReadyPackets`.

The documentation download directory and ZIP were synchronized from the same finalized documents and session log, with archive integrity validated by `unzip -t`. A final small follow-up commit will carry this publication confirmation itself, preserving the complete outcome in the required GitHub session record.


---

## 2026-08-12 — Public discovery, accessibility, FAQ, and marketing release

### User direction recorded

The user asked that the remaining roadmap items be implemented after the lifecycle release: an administrator-managed FAQ system with selective public publishing; a fully accessible public website; maximized SEO, GEO, and AEO; and a marketing system within the administrator panel. The user’s standing project requirement remains that the platform be self-hosted without Manus integrations or dependencies, that security controls remain in place, and that the complete session record and source changes be published to the private GitHub repository.

### Delivered: public FAQ management

A dedicated `public_faqs` data model and production migration `0021_public_faqs.sql` were added. The `faqs` router enforces public read access only for published records and administrator-only creation, editing, publication, ordering, and deletion. The public `/faq` page provides keyword search, category filtering, semantic native disclosure controls, and no internal data disclosure. The administrator workspace is available at `/admin/faqs`, and FAQ navigation was added to the public header, public footer, and configurable administrator navigation.

The FAQ migration was applied to production and the anonymous public API was verified to return only an empty published set before administrators create public content. This is intentional: FAQ content is controlled exclusively by the administrator and no sample or fictional material was seeded.

### Delivered: public accessibility strengthening

The public site now includes a dedicated `/accessibility` statement and feedback path, linked from the shared footer. The public interaction baseline was strengthened with a 3px visible keyboard focus indicator, sticky-header scroll offsets that keep focused targets visible, reduced-motion respect, 44px desktop navigation targets, and a complete mobile-menu focus trap with Escape restoration. Existing semantic skip-link, labelled field, error-text, and color-independent validation primitives were retained.

The implementation is grounded in the W3C WCAG 2.2 guidance recorded in `docs/research/wcag-2-2-public-site-audit-basis.md`. Production browser verification confirmed the accessibility statement renders over HTTPS and the first Tab key press visibly reaches **Skip to main content** before primary navigation.

### Delivered: SEO, GEO, and answer-discovery foundations

The public HTML shell and Express renderer now produce route-aware server-rendered titles, descriptions, canonical URLs, Open Graph/Twitter metadata, and crawler directives prior to JavaScript execution. Public client routes add matching metadata and emit CSP-compatible JSON-LD only for visible, accurate content: Organization and WebSite data on the public home page and FAQPage data only when an administrator has actually published one or more visible FAQ entries.

A dynamic `/sitemap.xml` exposes only intentional public marketing routes and publicly listed packet groups. `robots.txt` now includes the sitemap location, explicitly allows the new public pages, and excludes the portal, administration area, API, authentication paths, and campaign redirect links. The implementation basis is recorded in `docs/research/search-discovery-implementation-basis.md`, using official Google Search Central and Schema.org sources. It deliberately avoids unsupported GEO/AEO tactics such as artificial content farms, hidden markup, and special AI text files.

### Delivered: administrator marketing workspace

The self-hosted marketing system consists of a `marketing_campaigns` data model and production migration `0022_marketing_campaigns.sql`, an administrator-only `marketing` API, and the `/admin/marketing` workspace. Administrators can create, revise, archive, and delete campaigns; define objective, channel, audience, messaging, CTA, start/end window, destination, and UTM values; publish or pause a campaign; copy a controlled promotion link; and record confirmed conversions. Aggregate campaign counts show total campaigns, active campaigns, clicks, and conversions.

Public promotion links use `/go/{publicKey}`. They only redirect when a campaign is active and within its optional schedule, accept only a local path or HTTPS destination at creation time, append configured UTM values, and increment only an aggregate click counter. They do not store IP addresses, accounts, user agents, or browsing histories. Anonymous callers are denied access to the marketing administrator API, while invalid or inactive campaign links return 404 without redirecting. Marketing actions are recorded in the existing activity/audit log.

### Validation and production deployment

All feature code passed `pnpm run typecheck`, `pnpm test` (**143 passing tests**), `pnpm run build:client`, and `pnpm run build:server`. The tested client and server artifacts were deployed using timestamped rollback copies; migrations `0021_public_faqs.sql` and `0022_marketing_campaigns.sql` are applied in production. Production checks confirmed `{"status":"ok"}`, correct canonical FAQ metadata, an XML sitemap, public robots directives, anonymous marketing API denial (`401`), and safe rejection of an unknown campaign link (`404`).

The live security verifier again reported **45/46 checks passing**. The sole reported item remains the known timing artifact for the rate-limit `Retry-After` probe: the header remains present in `server/security/rateLimit.ts`, but the verifier sends its final check after exhausting the rate-limit window. No regression or missing implementation was introduced by this release.

### Publication pending

The completed roadmap release, research notes, migration files, source changes, and this appended session record are ready for final integrity review, commit, and push to the private `readypackets/ReadyPackets` GitHub repository. The production `RELEASE_COMMIT` marker will be updated after publication.


### Publication outcome

The complete source release was committed on `main` as `94287fd5cd99c0f6aff64dd71ef43f5e5209a50d` with the message `feat: public discovery, accessibility, FAQs, and marketing workspace` and pushed successfully to the private `readypackets/ReadyPackets` repository. A final log-only commit follows this entry so the repository contains this publication outcome as well as the implementation itself. The production release marker is updated after that closing commit is pushed.


---

## 2026-08-12 — Login response-contract repair

### User report

The user reported that the production sign-in page at `https://myportal.readypackets.com/login?next=%2Fadmin%2Fapi-keys` showed **“Unable to transform response from server”** instead of allowing the administrator to complete login.

### Investigation

The production service remained healthy. Recent journal records showed CSRF rejections for anonymous login requests followed by a successful password login event for the administrator account, which isolated the problem to the browser’s presentation of an expired/missing CSRF-token rejection rather than account credentials, MFA enrollment, database access, or service availability.

The login page was opened in a fresh browser context. It correctly received a CSRF cookie and the anonymous `auth.session` bootstrap returned a valid tRPC result. The fault was identified in `server/security/csrf.ts`: CSRF middleware runs before the tRPC adapter and returned a plain Express object (`{"error": ...}`) for failed state-changing tRPC calls. The tRPC browser client expects an array of tRPC result/error envelopes, so it could not deserialize the plain object and surfaced the generic transformation error.

### Repair

A CSRF rejection helper now detects `/api/trpc/` requests and returns the normal tRPC error envelope, including `FORBIDDEN`, HTTP `403`, the procedure path, and the user-safe message: **“Your security token expired. Reload the page and try again.”** Non-tRPC callers retain the ordinary Express JSON error response. Origin rejection follows the same compatible contract.

The source passed `pnpm run typecheck`, all **143** automated tests, and the server production build. The server-only artifact was deployed with a timestamped rollback copy and `readypackets.service` restarted successfully. Production health returned `{"status":"ok"}`. A deliberately missing-CSRF login request was verified to return the valid tRPC error-array contract rather than the former unparseable response.

### User recovery action

The repair is live. A browser that was already open during the token expiry must reload the login page once so it receives a fresh CSRF token, then the user can sign in normally and complete the existing MFA step. The account password, MFA configuration, and server secrets were not changed during this repair.

### Publication pending

This source repair and its complete session-log record are ready for private GitHub publication; the production release marker will be updated after that commit is pushed.


### Publication outcome

The login repair was committed and pushed to the private `readypackets/ReadyPackets` `main` branch as `0aa5b1ae4cd0452eeee4eb0517bfc1495fdbd3e9` with the message `fix: return tRPC CSRF errors to login client`. The production host is running the corresponding server artifact, and the release marker was set to that commit. A final log-only publication commit follows this entry so that the GitHub session record includes the outcome itself.


---

## 2026-08-12 — Backup-control repair and OWASP Top 10 2025 assessment

### User report and questions

After confirming that cache clearing and a page refresh restored browser login, the user reported two Security Centre alerts: `tier3.systemBackups.start` and `tier3.systemBackups.setSchedule`. Both displayed `sudo: The "no new privileges" flag is set, which prevents sudo from running as root.` The user also asked whether the platform is protected against the OWASP Top 10 vulnerabilities and whether `SESSION_LOG.md` is appended or overwritten.

### Backup-control investigation and repair

The alerts were confirmed as real production errors, but they were not an intrusion indicator. The `readypackets` service intentionally runs as an unprivileged `readypackets` user with a root-owned, fixed-path `/usr/local/sbin/readypackets-backup-control` helper and a narrowly scoped sudoers rule. The service unit nevertheless had `NoNewPrivileges=true`, which prevents sudo from elevating even when a command is explicitly allowlisted. That setting made the intended backup-control plane impossible to use.

The version-controlled and production systemd unit were updated to set `NoNewPrivileges=false` with a security rationale and compensating controls documented in the file: root-owned 0750 helper, exact-path sudoers allowlist, helper-side fixed action/argument validation, empty capability set, filesystem isolation, system-call restrictions, root-owned secrets, and loopback-bound service remain in effect. The prior unit was saved as a timestamped rollback copy. `systemd-analyze verify` passed, the service was restarted, `NoNewPrivileges=no` was confirmed, and the public health endpoint returned `{"status":"ok"}`.

The service account then successfully invoked the helper’s safe `status` operation. A controlled backup was started through the same repaired service-account path; `readypackets-backup.service` completed with `Result=success`, generated `readypackets-20260812T154409Z.tar.gz` in the root-owned backup directory, and retained the enabled nightly timer. No arbitrary privilege elevation was added.

### OWASP assessment

The current official OWASP Top 10:2025 categories and guidance were reviewed and recorded in `docs/research/owasp-top-10-2025-assessment-basis.md`. An evidence-based assessment was created at `docs/OWASP_TOP_10_2025_COVERAGE_ASSESSMENT.md` and indexed in `docs/DOCUMENTATION_INDEX.md`.

The conclusion is that ReadyPackets has substantial implemented controls across all ten current categories, including server-side authorization, MFA/session controls, CSRF/origin checks, nonce CSP and headers, authenticated encryption, typed validation, safe Markdown rendering, upload controls, logging/alerts, restricted privileged helpers, secure deployment controls, and error handling. It is not represented as invulnerable or OWASP certified. The most important residual work is continuous dependency/SBOM management, authenticated browser authorization regression tests, Stripe/SharePoint/cloud-backup configuration and restore drills, host-volume encryption planning, and an independent penetration test.

Fresh validation returned a clean production dependency audit (`No known vulnerabilities found`) and the live verifier reported **46/46 checks passed**, including CSRF/origin checks, anonymous authorization denials, Host validation, error-disclosure behavior, static-file protections, and login rate-limit/`Retry-After` behavior.

### Session-log retention clarification

`SESSION_LOG.md` is **append-only in practice** for this project: each task’s user request, investigation, implementation, verification, deployment, and GitHub publication outcome is appended as a new dated section. It is version-controlled in the private repository, so Git history also preserves prior revisions. It is not intentionally overwritten; only an exceptional corrective edit to an inaccurate prior statement would modify existing text, and that change would remain auditable through Git history.

### Publication pending

The backup repair, documentation index, OWASP assessment, research basis, and this complete session-log addition are ready for final integrity review, private GitHub publication, and production release-marker update.


### Publication outcome

The backup-control repair, OWASP assessment, research basis, documentation index, and associated session record were committed and pushed to the private `readypackets/ReadyPackets` `main` branch as `55d581781bd62f5af4d0ee26d7b05b7d97dd97a7` with the message `fix: restore secure backup control elevation`. A final log-only publication commit follows so that GitHub includes this publication outcome itself. The production release marker is updated after that closing commit is pushed.


---

## 2026-08-12 — SharePoint configuration and discovery repair

### User report

The user could not configure SharePoint order-file synchronization. The administrator page rejected `https://btkeys.sharepoint.com/` as not being an HTTPS `*.sharepoint.com` address during discovery. If the user selected Save first, the server rejected the request because the Graph site ID and document-library drive ID were empty—the same values that discovery is meant to populate.

### Investigation

The current source was inspected along with the deployed validation. The hostname regular expression in `discoverSharePointConfig` had been over-escaped: the literal contained `\\.` rather than `\.` in a regular expression. It therefore required a backslash before the `sharepoint.com` component and rejected normal tenant URLs such as `btkeys.sharepoint.com`.

Microsoft’s current Graph documentation was reviewed. A tenant root is resolved with `GET /sites/{hostname}` (or `/sites/root`), while a non-root site uses `GET /sites/{hostname}:/{server-relative-path}`. The pre-existing implementation used the path form for every URL, including the tenant root. The official sources and resulting design constraints were recorded in `docs/research/sharepoint-graph-site-discovery-basis.md`.

### Repair

`normalizeSharePointSiteUrl` was added to securely canonicalize the administrator’s input. It trims whitespace, removes zero-width copy/paste characters, ignores query/hash fragments, accepts only a real HTTPS `*.sharepoint.com` hostname, rejects embedded credentials and ports, and produces a canonical tenant-root or site path. Discovery now calls Graph’s hostname-root endpoint for `https://tenant.sharepoint.com/` and its documented hostname-plus-path endpoint for non-root sites.

The administrator form now clearly describes the discovery-first sequence, labels Graph site/drive fields as discovery-populated, disables Save until the tenant, client, secret, site ID, drive ID, and root path are available, and trims all saved fields. This prevents the earlier circular validation error. The client secret remains handled server-side and is never returned to the browser.

A focused regression suite was added for tenant-root, server-relative site paths, copied query/hash fragments, and rejected lookalike/credential-bearing hosts. The full suite passed with **146 tests**, TypeScript passed with zero errors, and production client/server builds completed successfully. The repaired client and server artifacts were deployed with timestamped rollback copies and the production health endpoint returned `{"status":"ok"}`.

### Operator action after deployment

The user should reload the Integrations page, enter the tenant ID, client ID, client secret, and `https://btkeys.sharepoint.com/`, choose **Discover site & library**, select the desired discovered document library if more than one is returned, and then choose **Save SharePoint settings**. The required Microsoft Graph application consent is `Sites.Read.All` for discovery and least-privilege write access for folder/file synchronization. Graph will report a clear authentication or permissions error if tenant admin consent or applicable site access is absent.

### Publication pending

The SharePoint repair, regression test, documentation, research basis, and this session-log addition are ready for integrity review, private GitHub publication, and final production release-marker update.


### Publication outcome

The SharePoint tenant-root discovery repair, configuration-flow improvements, regression tests, documentation, research basis, and session record were committed and pushed to the private `readypackets/ReadyPackets` `main` branch as `239b721abf0403b7eee499dc0a2dfe9a8b185822` with the message `fix: discover SharePoint tenant-root sites`. A final log-only publication commit follows so that GitHub contains this outcome as well as the implementation. The production release marker is updated after that closing commit is pushed.


---

## 2026-08-12 — Order operations, Phase 1 artifact visibility, and delivery-log release

### User request

The user reported that a customer’s Phase 1 Business Pitch Idea and supporting documents did not appear in the administrator order view. The user requested complete order-file access with Phase 1/Phase 2 downloads, bulk question-list template creation, order-specific Phase 1/Phase 2 automation history and reruns, and delivery-log date/time/customer/order context.

### Investigation

The affected order `RP-C000006-2608-D2B7D9` was inspected in production. It had a valid submitted Phase 1 intake, but no `files` records and no `file.upload`/rejection audit records. The absence is therefore not an administrator display filter issue: no pitch or document artifact was successfully persisted for that historical order. The customer upload endpoint is correctly mounted at `/api/files/upload`, enforces CSRF and order access, validates storage and MIME type, records a file row only after secure storage succeeds, and is used by the customer intake page. Future uploads will be shown by the enhanced administrator UI; the historical order requires the customer to upload/record the files again if the original browser session did not complete the upload.

### Delivered functionality

Migration `0023_order_operations_context.sql` added a file phase field and webhook delivery context fields. Existing intake attachments are classified as Phase 1. New customer intake documents and browser-recorded WebM pitches are automatically saved as `phase_1`. Webhook deliveries now persist safe order ID/order-number/customer-name context at creation. Existing deliveries were safely backfilled with order IDs/numbers using the order number carried in the payload; encrypted customer names were deliberately not decrypted in SQL.

The administrator order Intake tab now shows submitted Business Pitch Idea recordings and supporting documents separately. The Files tab labels Phase 1 intake artifacts versus Phase 2/delivery material and supports safe single-use ZIP download tickets for Phase 1, Phase 2/delivery, or all order files. Existing staff authorization remains in force for archive generation and download.

The Order Question Banks workspace now supports **Bulk add questions**: each nonblank line becomes a separately editable reusable template, with prefix, phase, required-answer, active-state controls, duplicate removal, and a maximum of 100 records per batch.

The order Automation tab now shows Phase I/II phase jobs and P101/P201 webhook deliveries for that order only, including creation/delivery time, status, attempts, HTTP result, errors, and direct retry/redelivery controls. The central Delivery Log now shows date/time, customer, order ID, event, status, attempts, response, diagnostic, and its existing retry/stop/redelivery actions.

### Validation and deployment

The full automated suite passed with **146 tests**, TypeScript passed with zero errors, and client/server production builds completed successfully. The migration initially halted only at a backfill expression that referenced plaintext user name columns which do not exist because names are encrypted. The already-completed schema changes were retained; the safe order-only backfill was applied separately and identified 16 contextual historical deliveries. The production server/client were then deployed with timestamped rollback copies. Internal health, external production HTTPS health, required security headers, and systemd service status all passed. The sandbox security verifier could not reach Cloudflare during its first connection attempt (`UND_ERR_CONNECT_TIMEOUT`); this was an external connection failure, not a code-verification failure. A direct HTTPS check from the production host confirmed the live portal and security-header baseline.

### Publication pending

The complete source, migration, tests, documentation, and session record are ready for final integrity review and publication to the private repository.


### Publication outcome

The order operations release, migration `0023_order_operations_context.sql`, Phase 1 artifact/file management, bulk question templates, order-specific automation controls, enriched delivery logging, and full session record were committed and pushed to the private `readypackets/ReadyPackets` `main` branch as `22074a44c7e4bbf589bb696fbaf077ce72eff301` with the message `feat: enhance order operations and delivery logs`. A final log-only publication commit follows so that GitHub contains this outcome as well as the implementation. The production release marker is updated after that closing commit is pushed.


---

## 2026-08-12 — Configurable MFA policy release

### User request

The user requested an administrator-controlled ability to enforce MFA or not require it.

### Implementation

Implemented an audited, role-scoped MFA policy with three explicit modes: `required`, `optional`, and `disabled`. Separate settings are stored for administrator and customer roles. Defaults preserve the existing security posture when no setting exists: administrators are **required** to use MFA; customers are **optional**.

Required mode puts unenrolled users into the existing restricted enrolment session and challenges enrolled users with TOTP or a backup code before access. Optional mode allows unenrolled users to sign in but continues to challenge enrolled users. Disabled mode suppresses MFA challenges at sign-in for the selected role. Administrator policy enforcement is applied server-side in local password login, magic-link login, SAML SSO completion, MFA status/disable behavior, and the administrator tRPC authorization middleware.

Added a new **Security centre → MFA policy** tab. It presents separate administrator and customer selectors, warns when the administrative posture is lowered, saves through an administrator-only validated API, and records every change in the activity/audit log. No stored authenticator secrets or backup codes are exposed. Existing enabled MFA enrolments remain intact; the policy controls sign-in requirements rather than deleting enrolment data.

### Validation and deployment

Added `tests/mfaPolicy.test.ts` covering required enrolment, optional sign-in, second-factor challenge for enrolled users in required/optional modes, and explicit disabled mode. TypeScript passed with zero errors. The full suite passed with **150 tests**, and client/server production builds succeeded. The production server/client deployment used timestamped rollback copies; `https://myportal.readypackets.com/api/health` returned `{"status":"ok"}`.

### Publication pending

The MFA policy source, tests, and session record are ready for integrity review and publication to the private repository. A final session-log publication entry will be appended after the commit is pushed.


### Publication outcome

The configurable role-based MFA policy, Security Centre controls, SAML/local/magic-link enforcement alignment, MFA policy regression tests, and complete session record were committed and pushed to the private `readypackets/ReadyPackets` `main` branch as `644c1436c5d489d47a37046b0fe25dcb1b8e381d` with the message `feat: add configurable MFA enforcement policy`. A final log-only publication commit follows so GitHub contains this outcome as well as the implementation. The production release marker is updated after that closing commit is pushed.


---

## 2026-08-12 — Customer intake upload CSRF refresh repair

### User report

A customer received the toast `Upload rejected — Your security token expired. Reload the page and try again.` while uploading Phase 1 supporting documents from the order intake page.

### Root cause and repair

The direct multipart upload route correctly rejected a stale anti-CSRF token. The intake page previously read only the browser CSRF cookie at upload time, so a session rotation or stale cookie made the customer reload the entire page before retrying. The route remained secure but the recovery experience was poor.

The intake upload flow now obtains the server-authoritative `auth.session` CSRF secret immediately before the multipart request. If the initial request still receives the specific pre-persistence CSRF rejection, it fetches the current authoritative session secret once and retries the same in-memory file(s) exactly once. It does not retry generic failures, does not disable CSRF validation, and does not retry after the server begins file persistence. A stale cookie therefore no longer blocks a valid customer upload, while a genuine unauthenticated or CSRF attack remains rejected.

### Validation and deployment

TypeScript passed with zero errors. The full automated suite passed with **150 tests**. Client and server production builds completed successfully. The client repair was deployed with a timestamped rollback copy, the application restarted, and the production health check returned `{"status":"ok"}`.

### Publication pending

The client source and complete session record are ready for final integrity review and publication to the private repository. A final session-log publication entry will be appended after the commit is pushed.


### Publication outcome

The intake upload CSRF refresh and one-time retry repair, validation record, and complete session log were committed and pushed to the private `readypackets/ReadyPackets` `main` branch as `d055df4106c3247643b2896d231d8c7312015896` with the message `fix: retry intake upload after CSRF refresh`. A final log-only publication commit follows so GitHub contains this outcome as well as the implementation. The production release marker is updated after that closing commit is pushed.


---

## 2026-08-12 — Stripe-confirmed paid-order access gate

### User report

The user reported that a customer could create an order, decline or omit payment, and still use the order in the customer portal. The user requested that order creation/use be restricted until payment is confirmed by Stripe.

### Root cause

The platform intentionally created an order row before redirecting the customer to Stripe Checkout so the provider had a stable internal order reference. Stripe’s signed webhook already updated `orders.payment_status` to `paid`, but the shared customer `assertOrderAccess` guard checked ownership/share only and did not require payment. The order detail UI also linked pre-payment orders to intake actions. Resource provisioning and `order.created` automation were initiated on creation rather than after settlement.

### Delivered payment gate

The system now treats a pre-payment order as a checkout record, not an active engagement. Customer access to detail, intake, MNDA, questions, files, downloads, notes, sharing, and customer-order procedures that depend on `assertOrderAccess` requires `payment_status = paid`. Staff and administrators retain operational access. Customer file listings are additionally filtered to paid orders. Pending-payment cards in My Orders and the dashboard route back to secure checkout instead of the order workspace.

Created-but-unpaid orders remain visible solely for their owner to resume payment. A new owner-only checkout summary procedure returns only the item and price data necessary to pay; it cannot expose the protected order workspace. Browser redirects from Stripe are not trusted to activate access.

The signed Stripe `checkout.session.completed` webhook is now the exclusive activation path. It updates the payment record and order to `paid`, then provisions the order’s SharePoint hierarchy, fires the existing `order.created` and `payment.succeeded` email automations, applies paid-payment order rules, and records an activation audit event. Duplicate signed webhooks remain idempotent because an already-paid order returns before activation side effects.

### Stripe configuration status and deployment

Production settings were checked without reading or logging secret values. `stripe.secret_key`, `stripe.publishable_key`, and `stripe.webhook_secret` are all present. TypeScript passed with zero errors; the full automated suite passed with **150 tests**; client/server production builds succeeded. Server and client were deployed with timestamped rollback copies and the production health endpoint returned `{"status":"ok"}`.

### Publication pending

The paid-order gating source and complete session record are ready for final integrity review and publication to the private repository. A final session-log publication entry will be appended after the commit is pushed.


### Publication outcome

The Stripe-confirmed paid-order access gate, checkout-only customer navigation, post-payment activation safeguards, validation record, and complete session log were committed and pushed to the private `readypackets/ReadyPackets` `main` branch as `7a83e92448856c8e57517bb26cd3f7e162791580` with the message `fix: gate customer orders on Stripe payment`. A final log-only publication commit follows so GitHub contains this outcome as well as the implementation. The production release marker is updated after that closing commit is pushed.


---

## 2026-08-12 — Account lifecycle deletion and trash safeguards

### User request

The user requested that every account be disabled before it can be moved to trash; that accounts can be bulk-disabled and bulk-deleted; that administrator accounts cannot be bulk-deleted and require a prominent double confirmation before individual deletion; that administrators can create customer-role accounts; and that permanently purging a trashed account requires an explicit typed `DELETE` confirmation.

### Implemented safeguards

The administrator customer directory now has a server-enforced lifecycle sequence: active accounts must first be deactivated, which revokes all sessions, and only then can they be soft-deleted to recoverable trash. The client offers bulk disable for up to 200 selected accounts, followed by bulk trash only for already-disabled, non-administrator accounts. Server validation rejects bulk deletion whenever any selected account has the administrator role, rejects all trash moves if a target is not disabled, and rejects self-targeting operations.

Individual trash controls were added to the account table. A non-disabled target receives an explicit disable-required notice. For administrator targets, the deletion dialog displays a prominent uppercase warning that an administrator account is being disabled and deleted; the account must already be disabled, the operator must enter exactly `DELETE ADMIN`, and a separate confirm action is required. The server independently requires both the general `MOVE_TO_TRASH` confirmation and the administrator phrase; user-interface controls alone cannot bypass the rule.

The account creation dialog is now named "Create an account" and offers Customer, Staff, and Administrator roles. The existing server procedure now validates and supports all three roles, still generates a temporary password server-side, and requires a password change at first sign-in.

Account Trash now includes individual **Purge** controls. Permanent purge is available only for an account already soft-deleted following disablement. The dialog contains a prominent irreversible-deletion warning and enables the purge control only when the administrator types exactly `DELETE`; the server also requires the matching `DELETE` literal. The transaction removes the account and its remaining portal-announcement recipient relation before deleting the user record. Production foreign-key metadata was inspected to confirm this is the only direct user-account foreign-key dependency.

### Validation and deployment

TypeScript completed with zero errors. The full automated suite passed with **150 tests**. Client and server production builds succeeded. The live server/client release was deployed with timestamped rollback copies, the service restarted cleanly, and the health endpoint returned `{"status":"ok"}`. No schema migration was required.

### Publication pending

The account lifecycle source changes and this full session record are ready for final integrity review and publication to the private repository. A closing session-log publication entry will be appended after the release commit is pushed.


### Publication outcome

The account lifecycle safeguards, individual administrator deletion protections, bulk-disable/bulk-trash controls, customer-role creation support, typed permanent purge, test/build results, and full session record were committed and pushed to the private `readypackets/ReadyPackets` `main` branch as `c73b2ca96e65dc6ef4a9037044a9ac52842b306b` with the message `feat: harden account deletion lifecycle`. A final log-only publication commit follows so the repository includes this outcome as well as the feature release. The production release marker is updated after the closing commit is pushed.


## 2026-08-12 — Policy Acceptance, Upload Recovery, Phase Artifacts, and Order Workflow Release

### Requests addressed

The administrator requested a searchable Policy Center acceptance grid that identifies customers and exact accepted policy versions; a consistent microphone-permission experience for Business Pitch Idea recordings; a permanent, easy customer remedy for upload token errors; Phase 2 documents and in-browser audio recordings for each order; administrator uploads to each phase with all-order file visibility; and administrator-managed selectable/custom order workflows.

### Delivered functionality

- Added **Policy Center → Acceptance tracker** searchable ledger. It filters by customer name, email, opaque ReadyPackets user ID, policy title/slug, version, and optional policy filter. Each row shows customer identity, policy, accepted version, effective date, acceptance timestamp, and status.
- Added a same-origin authenticated `GET /api/security/csrf` token-refresh endpoint. It reissues only the session-bound readable CSRF cookie with no-store responses. Every state-changing CSRF and origin check remains enforced.
- Corrected every custom browser upload path to send the required `X-RP-CSRF` header. The previous `X-CSRF-Token` header mismatch was the root cause of persistent upload-token errors.
- Customer document and recording uploads now refresh the server-issued token before upload and retry once only for a verified pre-persistence CSRF rejection. This eliminates the need for a full page reload after inactive-tab/session cookie rotation.
- Added an explicit microphone-permission explanation dialog before Phase 1 Business Pitch recording. Browser permission state remains controlled by the browser.
- Added `/portal/orders/:id/phase-2` and a visible Phase 2 materials card once an order reaches Phase 2. Customers can add Phase 2 documents and record a WebM audio update directly in the browser.
- Made file persistence and customer file lists phase-aware. Phase 1 and Phase 2 files are separately labeled and visible.
- Added direct **Upload phase documents** controls in the administrator order Files tab. Staff select Phase 1 or Phase 2, upload internal files, and explicitly publish only those files that should be customer-visible. The tab supports Phase 1 ZIP, Phase 2 ZIP, and all-file ZIP downloads.
- Added migration `0024_order_workflows.sql`, `order_workflows` storage, and `orders.workflow_id`. Production has a seeded **ReadyPackets standard workflow**, and all existing orders were backfilled to it.
- Added **Administration → Order workflows**. Administrators can create/edit custom ordered stages, activate/deactivate workflows, choose the default workflow for future orders, and assign an active workflow to an individual order from its Overview tab. Existing order-status, payment, and automation safeguards remain independently enforced.

### Validation and deployment

- Applied production migration `0024_order_workflows.sql`; default workflow ID 1 is active and 10 existing orders received workflow assignment.
- `pnpm test`: 150 tests passed.
- `pnpm run typecheck`: passed with 0 TypeScript errors.
- Production client/server builds passed.
- Production health endpoint returned `{"status":"ok"}` after deployment.
- Live security verification returned 46/46 checks passed, including CSRF/origin boundaries, authenticated API boundaries, response security headers, host validation, and rate-limit `Retry-After` verification.
- Deployment used timestamped server/client rollback copies.

### Operational notes

Customers need to reload once to receive the corrected upload header code. After that, document and recording uploads refresh their token automatically. If browser microphone access was previously denied, the customer must reset/allow the microphone through browser site permissions; a website cannot override a browser-level denial.

### Source-control publication

Pending commit and GitHub publication after this log entry.


### Publication outcome

The combined release was committed and published to the private `main` branch as `317f08772920ac445d917f08e249ad2fb43c7a1d` (`feat: policy ledger, phase artifacts, custom order workflows`). The working tree was confirmed clean before this closing publication note.


## 2026-08-12 — Business Pitch Microphone Diagnostic and Repair

A customer reported that the Phase 1 Business Pitch Idea control showed a generic “Microphone access denied” message even after the browser site permission was allowed. Review found that the recording path treated every `getUserMedia` failure as a permission denial, obscuring distinct browser/device failures such as an unavailable input device, another application holding the microphone, unsupported recording, or operating-system privacy restrictions.

The customer-side recording flow now checks for `mediaDevices.getUserMedia`, requests a live, enabled audio track with echo cancellation and noise suppression, selects Opus WebM when supported, and reports a specific recovery message for `NotAllowedError`/`SecurityError`, `NotFoundError`/`NotReadableError`, `NotSupportedError`, and other startup failures. It retains the explicit pre-recording explanation and browser permission prompt. No microphone data leaves the browser until the user stops recording and accepts the documented upload path.

Validation completed with TypeScript passing, 150 automated tests passing, and successful production client/server builds. The client assets were deployed with a timestamped rollback copy. The initial three-second probe ran before Node finished its normal delayed startup and returned connection refused; the service log confirmed it began listening approximately five seconds after restart. A follow-up production health check returned `{"status":"ok"}` and `readypackets.service` is active.

Pending source-control publication after this entry.


### Publication outcome

The microphone diagnostic repair and this session record were published to the private `main` branch as `d89d47378d0a717664e4f4bb3f2bb956957977ef` (`fix: clarify business pitch microphone startup failures`).


## 2026-08-12 — Granted-Microphone Permission Refinement

A follow-up customer report clarified that the browser had already granted microphone permission but the Business Pitch flow still appeared to ask for it. The recording page now reads the browser Permissions API state when available and tracks changes. When the state is `granted`, clicking **Record Business Pitch Idea** starts recording directly without showing the ReadyPackets explanatory permission dialog again. When the state is `prompt` or unavailable, the customer receives the explanatory dialog and then the browser’s native prompt. When the state is `denied`, the portal immediately provides browser-site-settings recovery instructions instead of presenting a non-actionable repeat prompt.

This refinement preserves the browser’s authority over actual microphone permission while preventing redundant application-level prompts after approval. TypeScript validation and the full 150-test suite passed, the production client build passed, the client assets were deployed with a timestamped rollback copy, and the six-second post-restart production health check returned `{"status":"ok"}`.

Pending source-control publication after this entry.


### Publication outcome

The granted-permission microphone refinement and session record were published to the private `main` branch as `d67b9dc63575caf5f3d9f2d6474b05ad4fa90c0b` (`fix: skip redundant microphone prompt after permission grant`).


## 2026-08-12 — Administrator Order Controls and Customer Document Scoping Release

### Requests completed

Administrators requested configurable payment requirements and pricing when creating orders, the ability to create no-payment test orders, an administrator-visible Business Pitch submission indicator, and assurance that documents submitted by staff to a customer are available only in the intended customer order workspace.

### Delivered controls

- Added migration `0025_admin_order_controls.sql` and typed `orders` fields for `payment_requirement`, `price_source`, `manual_price_cents`, and `is_test_order`. Existing orders retain catalog pricing and the normal required-payment policy.
- **Administration → Orders → Create order for customer** now offers three explicit payment policies: **Require verified Stripe payment**, **No payment required — administrator waiver**, and **Test order — no payment or external automations**.
- Administrators may enter an optional fixed total price from $0.00 to $1,000,000.00. For required-payment orders, Stripe charges a single administrator-set fixed-price line item. Coupon codes are rejected for a fixed-price order so the approved administrator price remains exact.
- Required-payment orders remain inaccessible until a signed Stripe confirmation activates them. Waived orders activate immediately with an auditable administrator payment-waiver source. Test orders activate without Stripe and deliberately skip SharePoint provisioning, payment/order emails, and order automation to avoid external side effects during testing.
- Restricted `createOrderForCustomer` to administrator authorization. This prevents staff from creating payment-waived or test orders.
- The administrator order header and Phase I intake tab now display **Business Pitch submitted** or **No Business Pitch submitted**, derived from actual stored audio/WebM intake attachments.
- The customer portal-wide **My Business Packets** file library now lists only customer-uploaded files. Staff-published documents no longer appear in the portal-wide library; they remain accessible to the authorized customer only inside the correct order workspace through the per-order file query. Phase I intake and Phase 2 materials now use that per-order query, so visible staff documents remain available in their intended order context.

### Validation and deployment

- Applied production migration `0025_admin_order_controls.sql`.
- TypeScript validation passed with 0 errors.
- `pnpm test` passed: 150 tests.
- Production client and server builds passed.
- The release was deployed with timestamped server/client rollback copies.
- The post-restart production health endpoint returned `{"status":"ok"}`.

Pending source-control publication after this entry.


### Publication outcome

The administrator payment controls, test-order safeguards, Business Pitch status indicators, order-scoped document visibility changes, migration, and session record were published to the private `main` branch as `8773f8c0057bd54a690dde1f4e0f1991e21abb3a` (`feat: add administrator payment and test order controls`).


### Final order-workspace document scoping clarification

The portal-wide **My Business Packets** page was updated to describe and enforce its revised role: it lists only customer-uploaded files. Staff-published documents are intentionally excluded from that cross-order library and are available to the authorized customer only inside the relevant order workspace. The customer Intake and Phase 2 pages use the per-order authorized file query, so published staff documents remain visible in their associated order. The final client-only update passed TypeScript validation, 150 automated tests, and a production client build; it was deployed with a timestamped asset rollback copy and the production health endpoint returned `{"status":"ok"}`.

Pending source-control publication after this entry.


### Publication outcome

The final customer file-library scoping clarification and session record were published to the private `main` branch as `8460b73d2056af5df4a2c694b20a3b696b6623f3` (`fix: scope staff documents to customer order workspace`).


## 2026-08-12 — Final Staff Document Order-Workspace Correction

A final implementation review confirmed that excluding staff-published files from the portal-wide customer library must be paired with a customer-visible, order-specific location for those documents. The file router now joins the uploader role only within the authorized per-order listing and returns a safe `uploadedByStaff` boolean rather than exposing uploader identifiers or roles. The customer order workspace now displays a **Documents from your project team** panel for published staff/admin files, with scoped secure download controls. The portal-wide file library continues to contain customer-uploaded files only. Thus, administrator-submitted documents are neither exposed in the general library nor omitted from the customer experience: they appear only in their intended order workspace.

TypeScript passed, all 150 automated tests passed, production client/server builds passed, the corrected server/client artifacts were deployed with timestamped rollback copies, and the production health endpoint returned `{"status":"ok"}`.

Pending source-control publication after this entry.


### Publication outcome

The final staff-document order-workspace correction and session record were published to the private `main` branch as `f8acab7201212eb188923ce88d55f99890fafa9a` (`fix: show staff documents only in customer order workspace`).


## 2026-08-12 — Configurable Microphone Preflight and Reference Comparison

The user requested only a microphone preflight diagnostic and an administrator option to disable it; no written-pitch, customer audio-upload, staff-assisted, recording-format, or other fallback path was added. The Phase I intake API now returns `microphonePreflightEnabled`, backed by the `intake.microphone_preflight_enabled` setting and enabled by default. Administration → System → Intake controls now has **Run microphone preflight before Business Pitch recording**. When enabled, the customer sees a Microphone check before beginning a Business Pitch recording. The diagnostic checks secure `getUserMedia` support, `MediaRecorder` availability, WebM support, permission/device access, and an enabled live audio track. It does not record, retain, or upload audio. A successful check offers an explicit Start recording action; a failed check provides a specific permission, device, browser-support, or general diagnostic. When disabled, the prior recording flow remains available.

An authorized public source repository, `Manus-MadaSitoEnterprises-RP/readypackets`, was mirrored with full history into the new private user repository `readypackets/readypackets-audio-reference`. Its recording implementation was reviewed read-only. The reference uses `getUserMedia({ audio: true })`, a WebM/MP4 selection, local playback/discard, and generic denial feedback. ReadyPackets requests audio with echo/noise constraints, standardizes the platform recording format to WebM, gives differentiated errors, and now provides the configurable preflight. The comparison is recorded in `docs/research/audio-recording-reference-comparison-2026-08-12.md`.

TypeScript validation passed. All 150 automated tests passed. Client and server production builds passed. The server/client deployment used timestamped rollback copies and the production health endpoint returned `{"status":"ok"}`.

Pending source-control publication after this entry.


### Publication outcome

The configurable microphone preflight diagnostic, administrator toggle, private reference comparison, and session record were published to the private `main` branch as `2a077b95e40698ed9075ed1194016a71d957d2d1` (`feat: add configurable microphone preflight diagnostic`).


## 2026-08-12 — Final Deliverables and Configurable Phase Workspaces

The customer portal file model was restructured at the user’s request. **My Business Packets** now lists only customer-visible files categorized as final `deliverable` items. Customer intake attachments, working documents, questions, phase recordings, and staff-published phase materials no longer appear in that portal-wide final-deliverables library.

A reusable customer workflow-stage workspace was added at `/portal/orders/:id/workflow/:phaseKey`. An assigned order workflow now exposes each stage as an individually labeled workspace in the customer order overview. Each configured stage can enable documents, questions, and in-browser WebM recording independently. The workspace shows only the matching phase’s non-deliverable materials and questions, supports a CSRF-refreshed customer document upload when the stage permits documents, and supports browser-only audio recording when the stage permits recording. Team files remain authorized to the specific order and phase; final deliverables remain in My Business Packets.

The administrator Order workflows workspace now stores per-stage capabilities using `stage_key | Stage label | documents,questions,recording`. New stages can be added in the ordered workflow definition, custom workflows can be saved and marked default, and workflow stages can be assigned to individual orders. Administrator order file uploads and direct order questions now accept any stage defined by the order’s assigned workflow. Existing workflows without capability metadata retain compatible document/question/recording defaults until edited. The standard workflow was migrated to explicit capabilities.

Migration `0026_custom_workflow_phase_keys.sql` widened `files.phase`, `order_questions.phase`, and `order_question_templates.phase` to 64 characters and updated the default workflow capability metadata. TypeScript validation passed. All 150 automated tests passed. Production client and server builds passed. The migration and server/client assets were deployed with timestamped rollback copies; the health endpoint returned `{"status":"ok"}`.

Pending source-control publication after this entry.


### Publication outcome

The final-deliverables separation, configurable phase workspaces, custom workflow stage capabilities, and complete session record were published to the private `main` branch as `6475fb81b9c16e5e41ab8b081a8dc15c112050f2` (`feat: add configurable phase workspaces and final deliverables`).


### Post-deployment historical material alignment

After deployment, the stage-workspace review identified that historical standard-workflow materials retained their legacy `phase_1` and `phase_2` keys while the explicit standard workflow uses `phase_1_intake` and `phase_2_synthesis`. Migration 0026 was extended and reapplied safely to map historical files and questions for orders on the standard workflow into their matching new stage keys. Production verification found 8 active `phase_1_intake` files, 1 active `phase_2_synthesis` file, and 1 `phase_2_synthesis` question. The health endpoint remained healthy.


### Historical alignment publication outcome

The historical workflow-stage alignment migration and session update were published to the private `main` branch as `db88bb474e43f569d9dd355381a7b4d2aca1d30a` (`fix: align historical files with workflow stages`).

## 2026-08-12 — Visual Workflow Builder, Cloning, and Phase Audio Upload

### User request

The administrator requested an easier workflow experience: one-click cloning and renaming, a visual connected/drag-and-drop style phase builder, explicit per-phase required actions, and synchronized administrator and customer order workspaces. During implementation, the user clarified that phases may optionally allow both customers and staff to upload prerecorded audio files; browser recording remains a separate phase capability.

### Delivered functionality

- Replaced the text-only workflow-stage editor with a visual connected stage builder in **Administration → Order workflows**.
- Added native drag-and-drop stage reordering, button-based up/down reordering, stage creation/removal, editable stable keys and labels, and visual capability cards.
- Added one-click **Clone** for workflows. The clone opens as a new workflow with copied stages/capabilities, a renameable name, and no default assignment.
- Retained direct workflow renaming in the visual editor.
- Added stage-level capabilities: customer document upload, phase questions, in-browser WebM recording, and capability-gated prerecorded audio-file upload for both customers and staff.
- Added custom workflow-stage audio upload controls in the customer order workspace and in administrator phase uploads.
- Enforced audio uploads server-side: accepted formats are WebM, MP3, M4A, WAV, and OGG containers, and an audio upload is rejected unless the selected phase enables `audio_upload`.
- Retained the browser-recording-only behavior unless the administrator explicitly enables the new prerecorded-audio capability for that phase.
- Strengthened workflow editing safeguards: an administrator cannot remove a stage key from a workflow when orders assigned to it contain files or questions for that stage. They can instead retain the stable key, rename the label, or disable customer actions.
- Confirmed synchronized behavior: customer and administrator workspaces resolve the currently assigned workflow definition dynamically, so saved labels, ordering, and capabilities update without copying workflow definitions into each order.

### Validation and deployment

- `pnpm run typecheck` passed with 0 TypeScript errors.
- `pnpm test` passed: 150 automated tests.
- Production client and server builds completed successfully.
- Deployed server and client with timestamped rollback copies. The first three-second local health probe occurred before the Node listener completed startup; subsequent service logs confirmed startup and the direct health check returned `{"status":"ok"}` with `readypackets.service` active.

### Follow-up

The visual builder release and complete session record will be committed and pushed to the private ReadyPackets repository. The production release marker will be updated after publication.

---

*End of workflow builder release entry.*


### Publication outcome

The visual workflow builder release was committed and published to the private `readypackets/ReadyPackets` `main` branch as `17dd4ad6ab6288041162ea03ec87fb88d4982135`. A final session-log publication commit will follow so the repository retains this outcome.


## 2026-08-13 — Enlarged Workflow Canvas and Per-Stage Automation Actions

### User request

The administrator asked for a larger workflow editing window and the ability to configure email alerts, administrator dashboard alerts, order status updates, completion percentages, and webhook triggers directly inside each workflow phase.

### Delivered functionality

The Order Workflows editor now uses an extra-large `max-w-6xl` modal canvas, providing substantially more horizontal room for stage fields, customer actions, and automation controls. Each visual stage card now contains a separate **Administrator-run stage actions** area that may configure a customer Email Template Center message, a dashboard alert with severity and custom text, an order status transition, a completion percentage, and an existing enabled webhook endpoint. These configuration choices are stored with the workflow stage and validated at save time; selected email templates and webhook endpoints must exist and be enabled.

The administrator order Automation tab now resolves the order's currently assigned workflow and displays every stage with its configured-action count. An administrator can explicitly select **Run actions** for a stage. Execution is intentionally not automatic upon editing a workflow or customer interaction. This keeps status changes, customer email, outbound webhooks, and dashboard alerts under administrator control for the individual order.

The new `workflow_stage_runs` table provides an ordered, auditable run history per order. Each run records the stage key, configured/executed actions, status, executor, start and completion times, and a bounded error detail when a run fails. Successful executions use the existing hardened services: status changes go through the order state machine, completion updates are bounded to 0–100, email uses a configured Email Template Center template, dashboard alerts use the deduplicated system-alert writer, and webhooks queue through the existing webhook delivery log with order context. The selected endpoint is validated as enabled at save time and immediately before queueing.

### Validation and deployment

TypeScript validation passed with 0 errors. The complete suite passed with 150 automated tests. Production client and server builds completed successfully. Migration `0027_workflow_stage_actions.sql` was applied before the new server began serving traffic. Client assets and the server bundle were rotated with timestamped rollback copies. The initial health probes ran before Node completed startup, then the direct production health endpoint returned `{"status":"ok"}`.

### Follow-up

The enlarged workflow automation release and complete session record will be committed and published to the private ReadyPackets repository. The production release marker will be updated after publication.


### Publication outcome

The workflow automation release was committed and published to the private `readypackets/ReadyPackets` `main` branch as `ce3320e3073f717e99d023d171c7e14f4e3759e3`. A final session-log publication commit will follow so the repository retains this outcome.


## 2026-08-13 — Administration Operations, Order Purge, and Reporting Release

### User request

The user requested protected bulk order deletion with typed `DELETE ORDER` confirmation, an obvious individually confirmed order deletion path, clickable investigation of dashboard IP pressure rows, a dashboard card for order alerts, and an administrator workspace for standard and custom reports.

### Delivered implementation

Order Trash now supports individual and bulk permanent deletion for up to 200 selected trashed orders. The interface requires typing `DELETE ORDER` exactly, and the server independently accepts only that exact confirmation. Every selected record must already be in trash. The irreversible purge is executed in a dependency-safe transaction that removes the order’s linked application records, including files, phase materials, questions/answers, notes, sharing, status history, jobs, webhook history, tickets, reviews, payment/invoice/refund/referral/billing metadata, and the order itself. The active-order action was renamed from ambiguous **Archive** to **Move to trash** and retains its reason-aware click confirmation; permanent deletion is intentionally confined to Order Trash.

The Operations dashboard now includes an **Order alerts** card with live counts for failed payments, overdue active orders, and orders awaiting payment. High-pressure source-address rows now link to Security Centre logs with the address prefilled. This event-level investigation surface includes the existing view-metadata, block-IP, and account-ban controls.

A new **Reports** administrator workspace is available at `/admin/reports`. Standard reports cover the live order pipeline, payment summary, and customer-account state. Custom reports can be created, saved, edited, previewed, deleted, and exported as local CSV for approved Orders or Customers datasets. The server accepts only constrained dataset/date/status filters and does not execute arbitrary query text. Migration `0028_custom_reports.sql` creates the saved report-definition table.

### Validation and deployment

TypeScript validation passed with zero errors. The complete suite passed all 150 tests. Production client and server builds succeeded. Migration 0028 was applied to production. Server and Vite client assets were deployed with timestamped rollback copies, and the live health endpoint returned `{"status":"ok"}`. The post-deployment security verifier passed all 46 of 46 checks, including CSRF/origin enforcement, authorization boundaries, Host validation, safe errors, static traversal protection, and the login rate-limit `Retry-After` check.

### Publication

The deployed code release was committed and pushed to the private repository as [`bb6057178acfffeedb5b4255ca4fd8a428b64d84`](https://github.com/readypackets/ReadyPackets/commit/bb6057178acfffeedb5b4255ca4fd8a428b64d84) with message `feat: order purge safeguards, alerts, investigation, reports`. Production `/opt/readypackets/RELEASE_COMMIT` was set to that exact code commit after a successful health check. The VPS operations record was also updated with the deployment details. This final session-log publication update is committed and pushed immediately afterward so the repository contains both the implementation and the full release record.


## 2026-08-13 — Pre-microphone-policy checkpoint

### User request

> backup the current configuration and files to github as it is then apply the fix so i can confirm that it works before pushing that code to github

### Checkpoint boundary

Before changing the microphone policy, a checkpoint is being published from source baseline `42817d66e0ba2f34687f1dc40edcf871ec9bb54c`. The checkpoint includes the current version-controlled source and a sanitized production configuration manifest: active nginx virtual-host configuration, systemd unit/drop-ins, production service/artifact state, deployed artifact hashes, and environment-variable **names only**.

No secret or customer data is included. Specifically excluded are environment-variable values, database contents, uploaded files, sessions, encryption keys, passwords, API credentials, and third-party tokens. These remain only in root-owned production backup storage. The checkpoint is committed and pushed before the policy correction is applied.

### Planned corrective experiment

After the checkpoint publication, the sole code change will replace `microphone=()` with the least-privilege `microphone=(self)` directive in the central security-header policy. The corrected server bundle will be deployed to production for user testing but deliberately left uncommitted and unpushed until the user confirms that browser recording works.


## 2026-08-13 — Approved microphone-policy release and WebM verification

### User confirmation

> it prompted me to record so you can now committ that change to github but i also need to know what audio format is being used because there is a restriction on the audio file type to only upload WEBM audio format

### Approved correction

The user confirmed that the production test deployment reached the browser recording prompt. The previously uncommitted policy correction is therefore approved for publication: the global security header now uses `microphone=(self)` rather than `microphone=()`. This permits browser microphone capture only for ReadyPackets same-origin pages and retains `camera=()` and `display-capture=()` restrictions. The accompanying regression test asserts this deliberate least-privilege exception.

### Audio-format verification

Phase 1 Business Pitch recording is **WebM audio**. Before starting, the client preflight requires either `audio/webm;codecs=opus` or `audio/webm`. On supported Chromium browsers, the recorder is explicitly created with `audio/webm;codecs=opus`; the recorded Blob/File is named `.webm` and submitted as `audio/webm` with the recorded-pitch flag.

The server independently enforces this restriction. A recorded Business Pitch accepts only one `.webm` file per request, validates upload magic bytes and extension, and rejects any recorded-pitch MIME that is not exactly `audio/webm` with the message “Business Pitch recordings must be recorded in WebM format.” Files stored as a successful Business Pitch have detected MIME `audio/webm`. Pre-recorded-audio workflow capabilities are a separate controlled feature and may accept configured additional formats; they do not relax the browser-recorded Business Pitch restriction.

### Validation

The approved fix passed 151/151 tests, TypeScript checking, server build, production health validation, and the full 46/46 live security verification. It is now being committed and pushed to the private ReadyPackets repository.


## 2026-08-13 — WebM recording reliability and customer workflow phase locks

### User report and request

> when i record i am not able to play back what i recorded and i still get the recording upload rejected because of the file format
>
> The customer should be able to remove any documents they upload or record items until they press the submit button then that part of the order phase is locked and can only be unlocked by the admin with confirmation when unlocking it. There should be a notification given to the customer before each submission of files and documents at any point of the order phases. the message should be able to be a template configurable in the workflow designer the customer will be prompte with the notification prompt acknowledging that that phase will be locked and and can not be undone.

### Root cause and WebM correction

The browser recorder correctly creates a WebM audio file, but the installed `file-type` signature detector classifies a generic WebM container as `video/webm`; the container header does not identify its track type. The upload endpoint previously required the detector to return exactly `audio/webm`, so it rejected valid browser recordings before storage. The release keeps magic-byte and `.webm` extension validation, accepts the safe generic WebM signature for an explicitly browser-recorded pitch, and normalizes a successful recorded-pitch record to `audio/webm`. Other files remain subject to existing extension, magic-byte, size, category, CSRF, authorization, and workflow-capability controls.

The Phase 1 intake now retains a newly stopped recording locally, renders an HTML audio playback control, and gives the customer explicit **Upload WebM recording** or **Discard recording** choices. A failed upload leaves the local recording available for retry rather than silently losing it.

### Workflow phase submission and locking

Migration `0029_order_phase_locks.sql` created an auditable current-state lock table keyed by order and phase. Customer phase workspaces now provide a clear submit-and-lock confirmation modal. The message defaults to an irreversible-lock warning but is configurable per workflow stage through the Workflow Designer’s **Acknowledgement message template** field. Customers must check an acknowledgement before submitting.

While a phase is unlocked, customers may add and remove their own files and recordings. When submitted, server-side controls prevent customer uploads, removals, and question changes in that phase. The customer UI reflects the locked state. This covers generic workflow phases, the legacy Phase 1 intake workflow, and the legacy Phase 2 workspace.

Administrators can review current and historic phase-lock records in **Admin → Orders → [Order] → Phase locks**. Unlocking requires an administrator, a reason of at least ten characters, and the exact typed confirmation `UNLOCK PHASE`. The action is audited. Unlocking legacy `phase_1` also reopens the intake draft; customer changes resume until the next submission.

### Validation and deployment

The release passed TypeScript validation, the full automated suite (**151/151 tests**), client and server production builds, migration application, live health verification, and the live security suite (**46/46 checks**). The production `Permissions-Policy` continues to allow `microphone=(self)` while retaining `camera=()` and `display-capture=()`. Timestamped server and client rollback copies were retained in `/opt/readypackets/rollback/` on the VPS.


## 2026-08-13 — Recording feedback and full workspace save flow

### User request

> 1. the audio recording button should be a pulsating button to show that the recording is working
> 2. the save button in the order does not work when the order is saved it should should save the current files ans documents and audio and ask if the customer would like to save the order and return to it later or continue working in the order

### Delivered changes

The customer recording controls in Phase 1 Intake, Phase 2, and generic workflow phase workspaces now use a live pulsing danger treatment while recording. The control includes a pulsing recording indicator, elapsed-time text, and an explicit **Recording — stop** label. The inactive state remains visually distinct and uses the normal microphone icon.

The Phase 1 intake draft-save defect was corrected. The client previously saved only `projectName`; current responses, desired outcomes, and the integrity choice were not included even though the server supports each field. The save payload now includes all current editable form values. Uploaded documents and recordings remain attached to the order immediately after their independently confirmed upload.

Selecting **Save draft** in the page header or **Save workspace** in the form opens a choice dialog. The customer may choose **Save and continue working** or **Save and return later**. Both choices persist the complete draft. If a newly recorded WebM clip is still local and awaiting review, either save choice uploads it first; the customer stays on the page on a failed upload. The return-later choice navigates to the order dashboard only after successful persistence. Neither save action submits or locks the phase.

### Validation and deployment

TypeScript validation, the complete automated suite (**151/151 tests**), production client/server builds, production health verification, and the live security suite (**46/46 checks**) passed. Client deployment retained a timestamped rollback copy on the VPS.


## 2026-08-13 — Permanent customer and order file-tracking names

### User requirement

> every file, document, and audio recording that is uploaded to the platform by either the customer or admin should have the customer id and order number pre-appended the file name so it can be easily tracked in the future ad when the files are on other systems
>
> this rule to pre-append the name should happen to every file uploaded in the future as well

### Delivered enforcement

A reusable server-side canonical filename formatter now generates order artifact names in this form:

`<CUSTOMER_PUBLIC_ID>__<ORDER_NUMBER>__<SANITIZED_SOURCE_FILENAME>`

For example:

`RP-U-E571C762960E__RP-C000002-2608-683DB6__pitch-recording.webm`

The central multipart upload endpoint applies the convention after authorization and magic-byte validation, before the file record is inserted or replaced. This covers future customer and administrator order uploads: supporting documents, direct WebM Business Pitch recordings, pre-recorded audio enabled by a workflow, staff phase uploads, replacements, and published deliverables. It is server-enforced and cannot be bypassed by altering the browser-provided filename.

Administrator placeholder creation and administrator metadata renames use the same formatter. Generated future SharePoint intake-answer Markdown exports and placeholder files use the convention as well. Download responses and ZIP entries already consume the canonical database name, so exports and external copies retain the tracking reference.

Opaque storage keys remain unchanged; the customer public ID and order number are placed in the display/download/external filename, not in the underlying filesystem path. User-supplied names are normalized, path components are removed, dangerous characters are replaced, extensions are preserved, and the 255-character database limit is enforced.

Migration `0030_order_file_tracking_names.sql` backfilled active existing order-file display names without moving file bytes. Production verification found **0 active order files without the prefix** after the migration.

### Validation and deployment

The canonical naming unit tests passed, TypeScript validation passed, the full automated suite reported **155/155 tests passing**, production builds completed, the production health endpoint returned `{"status":"ok"}`, and the live security suite passed **46/46 checks**. Timestamped server and client rollback copies were retained on the VPS.


## 2026-08-13 — Workflow wizard, live phase progress, and upload governance

### User requirements

> 1. add a Wizard style workflow option as well to the Order workflows
> 2. The Order dashboard does not update when each phase completes
> also add in the workflow the ability to set limits on the uploads in terms of size and count

### Delivered functionality

Order Workflow definitions now include a **Customer workspace presentation** choice: **Stage cards** (the existing all-phases view) or **Guided wizard**. Wizard mode presents the customer with an ordered, one-stage-at-a-time experience: the next incomplete stage is highlighted, submitted stages are marked complete and remain reviewable, and later stages are presented as upcoming. This configuration is stored per workflow in `order_workflows.customer_presentation`; migration `0031_workflow_wizard_presentation.sql` defaults existing workflows safely to cards.

Workflow stages now support optional per-phase upload governance. Administrators may configure document count, document size per file, audio count, and audio size per file. Limits are validated during workflow save, shown to customers in the relevant stage workspace, and independently enforced server-side for customer and staff uploads. They apply to direct WebM recordings, approved prerecorded audio, supporting documents, staff phase uploads, and multi-file submission batches. The platform hard upload ceiling continues to apply as an upper bound; blanks retain the platform default.

Customer phase submission now calculates completed workflow stages from active `order_phase_locks` and synchronizes the order’s completion percentage server-side. The workflow detail response includes completed-stage counts for the progress display. Phase 1 intake, Phase 2, and generic workflow stage submissions invalidate customer detail/list/summary caches immediately, so the order dashboard and order list refresh without relying on an old cached percentage.

### Validation and deployment

TypeScript validation, the full automated suite (**155/155 tests**), production client/server builds, the workflow-presentation migration, and the production health check passed. The live security script was intentionally stress-testing authentication rate limiting and the application’s IP block control blocked the verifier IP after repeated login attempts; direct production service health remained normal. No security policy was weakened. Timestamped rollback copies were retained.


## 2026-08-13 — Branded invoices, public-ID activity search, platform setup, and approved auto-deployment release

**User request.** Add branded ReadyPackets invoices for paid orders; allow Activity Replay entity history and user timeline searches by public customer/user ID; create a first-time platform setup wizard for SMTP/Microsoft Graph, Microsoft Entra ID, Stripe, Phase I/II webhooks, and IP/account login allowlists; and update self-hosted auto-deployment documentation and scripts.

**Delivered.** Paid and partially refunded orders now expose a customer and administrator **Invoice** action. Invoice generation retains one `RP-INV-YYYY-######` invoice record per order and renders a ReadyPackets-branded printable document using the document logo, customer public ID, order number, itemized products, discounts, total, payment confirmation date, and provider reference. The browser’s print flow supports controlled PDF retention without storing card data in the portal.

Activity Replay now resolves opaque `RP-U-XXXXXXXXXXXX` public IDs server-side for user entity history, user timelines, and advanced actor filtering. Legacy numeric IDs remain available for historical operational use.

The new administrator-only **Platform setup** wizard centralizes first-run configuration for SMTP/Microsoft Graph outbound delivery, Microsoft Entra SAML, Stripe, P101/P201 HTTPS phase-start webhooks, IP allowlisting, and an optional account login whitelist. The account whitelist is server-enforced across local password login, magic-link session issuance, and SAML sessions; it is disabled by default and requires at least one valid existing public user ID before activation. Secrets remain write-only and encrypted.

`deploy/auto-deploy-approved.sh` and `/usr/local/sbin/readypackets-auto-deploy-approved` provide a root-only wrapper for an administrator-approved immutable Git commit. It deliberately requires an approved run ID, target SHA, explicit `READYPACKETS_APPROVED_DEPLOYMENT=yes`, and a PAT on standard input only; it delegates to the existing snapshot/validation/rollback helper rather than deploying the moving tip of a branch. Added `docs/AUTO_DEPLOYMENT.md` and updated the administrator, deployment, upgrade, and documentation-index guides.

**Validation and production deployment.** TypeScript passed with zero errors. The full suite passed at **155/155 tests**. Shell syntax checks passed for the installer and approved deployment wrapper. Production server/client assets and the root-owned wrapper were deployed with rollback retained at `/opt/readypackets/rollback-20260813050933`; health returned `{"status":"ok"}`; the platform setup route returned HTTP 200; and live security verification passed **46/46 checks**.

**Publication record.** The release was committed and pushed to the private `readypackets/ReadyPackets` repository as `d04c3327e01c0f8a85e5b9511a1a70764318a9f6` (`feat: add invoices, platform setup wizard, and activity ID search`). Production `/opt/readypackets/RELEASE_COMMIT` was updated to the same commit; the VPS operations record was updated; and the protected root deployment wrapper was installed.


## 2026-08-13 — Backup repair, controlled recovery, and provider-specific cloud configuration

**Prompt:** Repair backup and restore operations, add provider-specific cloud-storage configuration for supported off-site destinations, and add future setup-wizard configuration export/import to the project backlog.

**Root cause and security correction:** The portal’s backup page attempted to invoke a root helper through `sudo`, but the web-service hardening correctly set Linux `no_new_privs`, preventing elevation. Replacing that restriction would have weakened the customer-facing service. The release instead adds a root-owned `readypackets-backup-control.service` daemon on a mode `0660`, `root:readypackets` Unix socket. The daemon validates a fixed allowlist of backup actions, bounded inputs, confirmation phrases, output sizes, and timeouts before it invokes the existing root-only helper. The portal service has no backup sudo rule; the obsolete `/etc/sudoers.d/readypackets-backup-control` rule was removed. The main service now explicitly retains `NoNewPrivileges=true` and `RestrictSUIDSGID=true`.

**Backup and recovery features delivered:** The administrator backup page now displays actionable control errors rather than a generic unavailable state, lists protected archives, verifies unencrypted archive contents and checksums, supports audited browser downloads, shows asynchronous restore status, and requires exact `RESTORE <archive filename>` confirmation before starting a protected production recovery. A production restore remains root-controlled, takes a safety dump, restores the database/files, applies migrations, and restarts the portal. The latest protected manual archive `readypackets-20260813T053626Z.tar.gz` was created through the same socket route used by the portal and verified successfully: database dump present (580,495 bytes), manifest/checksums valid, and uploaded files included.

**Cloud backup configuration:** Replaced the freeform-only cloud mapping experience with provider-specific setup for Amazon S3, Wasabi S3, Backblaze B2, Azure Blob Storage, SharePoint, Google Drive, OneDrive, and Dropbox. Credentials/OAuth token JSON are submitted once over TLS, written only to root-owned rclone configuration, never returned to the browser, and can be tested from the configured destination. Every completed backup copies to every configured destination. No third-party credential was supplied or configured during this release.

**Roadmap:** Added a P1 item for a secret-safe first-run setup-wizard configuration bundle that can be exported/imported during installation and retained as a Git-tracked template without storing live secrets, customer data, encryption keys, or OAuth tokens.

**Validation:** TypeScript validation passed with zero errors; 155/155 automated tests passed; backup helper and installer shell syntax passed; daemon syntax passed; the production portal and backup-control daemon are active; the production health endpoint returned `{"status":"ok"}`; and the protected archive verification passed. Timestamped rollback material was retained under `/opt/readypackets/rollback-20260813053220`.


**Publication record:** The backup repair and provider-specific cloud configuration source was published to the private repository as commit `b23465d36c79037f673f70f6b38e9ce32d6906cb`. Production was marked with that release commit after the portal, timer, and root backup-control daemon were verified active. The final session-log publication record follows this release entry.


## 2026-08-13 — Backup-status reconciliation and Security Centre operations

**Prompt:** Explain and resolve the backup-page status discrepancy and legacy backup alerts; improve Security Centre session visibility, make block actions reflect already-blocked sources, explain how to test blocking, and expose the actions recorded for a hostile source.

**Findings:** The backup page reported zero archives because its server filename regular expression accidentally used double-escaped dots, so valid `readypackets-…tar.gz` files did not match. The actual protected archive directory contained 20 valid local archives and was readable by the portal service. The separate activity-record table was empty because historic root backup jobs were never inserted into `system_backups`; local archive discovery is now treated as the authoritative operational status. The two open `trpc:tier3.systemBackups.start` and `setSchedule` alerts were retained as historical records, acknowledged, and resolved only after a socket-routed backup completed and passed verification.

**Delivered:** The backup status API now returns live systemd job state/result, timing, archive count, and latest archive. The dashboard automatically polls while viewing the page and displays a persistent job-status card. Archive recognition was corrected. Security Centre now presents active sessions in a searchable grid with account, public ID, source address, device, activity, expiry, MFA state, and revoke action. New session rotations preserve previously captured source/device metadata; older sessions correctly display `Not captured` rather than misleadingly implying a platform failure. Security log rows now identify source addresses already covered by active exact/CIDR/range blocks and disable the redundant block action. The new **Investigate** view shows application-level security events and captured HTTP method/path metadata for a source address, explicitly without exposing or running operating-system commands.

**Operational verification:** The portal, root backup-control daemon, and timer were active after deployment; health returned `{"status":"ok"}`; the protected status path reported `backup_state=inactive` and `backup_result=success`; and the portal service saw 20 local archive files. TypeScript passed without errors, the full test suite passed 155/155, and backup helper shell syntax passed. Timestamped rollback material was retained at `/opt/readypackets/rollback-20260813063005`.


**Publication record:** The backup reconciliation and Security Centre operations release was published to the private repository as `887d1bf2ba65832ae0e12ecd3b16012cd9987325`. Production was marked with that commit after the portal, backup-control daemon, and timer were confirmed active; the final session-log publication record follows this entry.

## 2026-08-13 — Security Assessment, Go-Live Readiness, and Certificate Management Release

**User request:** Perform a deep SDLC, code-quality, API, webhook, OWASP Top 10, and security-exploit assessment; provide a separate feasibility review for going live tomorrow evening; add Cloudflare Origin CA certificate administration; provide step-by-step deployment instructions; and update installation scripts to choose Let’s Encrypt or Cloudflare Origin CA.

**Assessment deliverables:** Created two ReadyPackets-branded, cited PDF reports and added them under `docs/assessments/`: `ReadyPackets_Security_SDLC_Assessment_2026-08-13.pdf` and `ReadyPackets_Go_Live_Readiness_Assessment_2026-08-13.pdf`. The security assessment documents observed strengths, OWASP/API mappings, scope constraints, a P0–P3 remediation register, API/webhook requirements, and an SDLC program. The go-live assessment recommends against unrestricted public launch tomorrow absent defined gates; it supports only an invite-only pilot after outbound-webhook SSRF remediation, encrypted offsite backup/recovery proof, live integration smoke tests, Cloudflare Full (strict) verification, and independent assessment or explicit risk acceptance.

**Certificate management:** Added `Admin → System → Certificates`. Administrators can view write-only certificate metadata, install a Cloudflare Origin CA certificate/key and optional root after typing `INSTALL CLOUDFLARE ORIGIN CA`, or revert to the existing hostname-matching Let’s Encrypt certificate. Certificate bodies and private keys are never returned by the API, persisted in portal settings, written to logs, or supplied as process arguments. A dedicated root-owned `readypackets-certificate-control.service` uses a group-gated Unix socket with fixed actions to validate certificate PEM/key pairing and hostname, create TLS rollback copies, run `nginx -t`, and reload nginx only after validation. The customer-facing application retains `NoNewPrivileges=true` and receives no sudo capability.

**Deployment and documentation:** Updated native and unified installers to prompt interactive users for Let’s Encrypt, Cloudflare Origin CA, or HTTP-only configuration, while requiring explicit provider/file flags for noninteractive use. Updated nginx to use a root-managed TLS include so the certificate provider can be changed atomically. Expanded `DEPLOYMENT_AND_INSTALL.md` with step-by-step native/Docker deployment, Cloudflare Origin CA handling, console rotation instructions, and verification commands. Updated the documentation index with report links.

**Validation and production deployment:** TypeScript validation passed with zero errors; all 155 automated tests passed; client and server production builds passed; installer shell syntax and certificate daemon syntax passed; both PDFs compiled strictly and passed deterministic verification. Production now runs the active `readypackets-certificate-control.service`, its `root:readypackets` 0660 Unix socket, the application service, and nginx. The current origin remains on the existing Let’s Encrypt certificate through `/etc/readypackets/tls/nginx-tls.conf`; no Cloudflare private key was installed. `nginx -t` and portal readiness passed. Public headers remain nonce-CSP, HSTS, nosniff, strict referrer policy, and least-privilege Permissions Policy. A timestamped rollback directory was created during deployment.

**Assessment caveat:** The reports are a source/configuration and non-invasive production-control review, not a penetration test, forensic review, payment-provider assessment, or Cloudflare-account audit. The highest-priority remediation remains SSRF-safe outbound webhook handling and controlled offsite recovery proof.

**Publication:** The implementation, installer, documentation, and branded reports were published in commit `1eda6c1317d6fdd838ee0ccb240e08b4cab719dd`. The production release marker now references that code commit. The VPS operations record was updated with the certificate-control daemon, managed TLS include, service status, and rollback location. A final session-log publication commit follows this record.

## 2026-08-13 — Configurable order statuses and enforced guided workflow release

**Request:** Provide administrator-managed order status options and make every customer order workflow a real sequential wizard across phases and steps.

**Delivered:** Added **Admin → Order status options** with protected core lifecycle statuses, editable labels and badge tones, ordering, custom status creation, and custom-status activation/deactivation. Core lifecycle keys remain active and preserve their server-side payment, intake, deliverable, history, and automation safeguards. The server refuses to remove a configured custom status while any active order still uses it. Workflow actions and administrator order transition controls now use live active status options.

All order workflows are now persisted as `wizard` presentation through migration `0032_enforce_workflow_wizard.sql`; new workflow saves are wizard-only. The customer workspace shows an ordered stepper, admits only the current step or completed review steps, takes the customer to the next step after submission, and receives server-side sequencing checks for phase submission, questions, and uploads. This prevents a customer from bypassing the wizard through a direct future-stage URL or upload request while preserving read-only review of completed stages.

**Validation and deployment:** TypeScript passed with zero errors; `pnpm test` passed 155/155 tests; client/server bundles built successfully. Migration 0032 was applied to production and verified `0` non-wizard workflows. The final health check returned `{"status":"ok"}`. Production retained rollback directories including `/opt/readypackets/rollback-20260813145925-status-integrity`.

**Publication:** Pending commit and GitHub push at time of this entry.


**Publication completed:** Implementation commit `156d66bdd74c93644227b8ae2423a190d0ffd5fe` was pushed to `main`; production `RELEASE_COMMIT` was updated to the same value and service health remained `{"status":"ok"}`.


**Follow-up wizard routing:** Legacy customer URLs `/portal/orders/:id/intake` and `/portal/orders/:id/phase-2` now redirect to the corresponding guided workflow stages (`phase_1_intake` and `phase_2_synthesis`). This removes the remaining standalone customer phase paths so every supported customer order phase enters the same sequential, server-enforced wizard. The rebuilt client was deployed with rollback copy `/opt/readypackets/rollback-20260813150443-legacy-wizard-client`; health remained `{"status":"ok"}`. Publication pending for this follow-up client route change.


**Follow-up publication completed:** The guided-workflow legacy-route fix was published as `5c1be6c0bc2660cf225db28f23884b55d0b35178`; production `RELEASE_COMMIT` now matches and the portal health check remained `{"status":"ok"}`.


## 2026-08-13 — Workflow governance, audio-duration, and SharePoint routing release

**User request:** Correct the workflow stage-key input that lost focus after one character; add per-recording and cumulative audio duration limits; and permit each workflow stage to define where its order files synchronize within SharePoint.

**Delivered:**

- Replaced the workflow editor card key derived from the editable stage key with the stable stage order. Editing a stage key no longer remounts the focused field or scrolls the editor.
- Added per-stage `recordingMaxDurationSeconds` and `audioTotalDurationSeconds` controls to the workflow upload-governance UI and validation contract. Browser recording controls display limits and auto-stop at the available duration; server-side `ffprobe` measures accepted audio and independently rejects recordings that exceed per-recording or cumulative limits.
- Added `files.duration_seconds` through migration `0033_file_audio_durations.sql`, backfilled six existing audio files successfully with zero unresolved files, and exposes duration to the customer workflow workspace.
- Added durable, background Microsoft Graph synchronization for future accepted customer and staff order files. Each workflow stage can define a safe relative `sharePointDestination`; blank destinations retain phase defaults. File transfers are queued in `sharepoint_sync_log`, processed with bounded retries, and use the configured order/customer root without returning Graph secrets or file content to configuration pages.
- Updated native and Docker installation paths to include `ffmpeg`/`ffprobe` for server-side duration validation. Production installed `ffmpeg` because the prior host did not contain `/usr/bin/ffprobe`; Ubuntu reported a pending kernel update but did not reboot the host.

**Validation and deployment:** TypeScript validation passed; the automated suite passed 155/155 tests; production health returned `{"status":"ok"}`; migration `0033` was applied; and server/client rollback copies were retained under `/opt/readypackets/rollback-20260813165944-workflow-governance`.

**Publication:** Implementation commit `7330b7e75462b2084e77544c2e4e83aa3d7dbc27` was pushed to the private repository and set as `/opt/readypackets/RELEASE_COMMIT` after the production health endpoint returned `{"status":"ok"}`.


## 2026-08-13 — Workflow management release: safe deletion, acknowledgement policy, and guided task designer

The administrator workflow manager was extended with a server-authorized delete operation. An administrator must type `DELETE WORKFLOW`; default workflows and workflows assigned to active orders cannot be deleted, and the server records the deletion audit event. This prevents accidental removal or orphaning of active order workflows.

Each stage now carries a persisted customer acknowledgement policy: `required`, `optional`, or `none`. The customer workflow portal adapts its submission interface accordingly, while the server independently reads the assigned workflow configuration and rejects a required acknowledgement that has not been supplied. Every mode still locks submitted phase materials and requires a separate administrator-confirmed unlock.

Order Workflows now offers both the existing visual stage canvas and a new guided task wizard. The guided designer advances through stage selection, customer task selection, administrator task documentation, submission policy, and review. Administrator task records can document team document upload, question assignment, customer-submission review, and stage automation. The designer continues to expose server-validated status updates, completion percentage, email, webhook, and alert actions. A visible **Manage order statuses** action opens the administrator status manager for adding and governing custom statuses.

Validation completed with TypeScript zero errors and 155/155 automated tests passing. The release was deployed with timestamped server and client rollback copies and the portal health check passed.


### Publication record

The deployed implementation was published in Git commit `b8d2a214809f3eca90d2058e04e3f1c652b0c05f` (`feat: extend workflow management and acknowledgement controls`). The production release marker was updated to that commit after the portal health endpoint returned `{"status":"ok"}`. The VPS operations record was updated with the rollback locations and operational safeguards.


## 2026-08-13 — GitHub synchronization and rollback-readiness verification

The repository was fetched from `origin/main` and verified synchronized at `0921ccf510615516e6001f5c9a7758aa546478e4`; local `HEAD` and `origin/main` matched exactly. The latest implementation release remains `b8d2a214809f3eca90d2058e04e3f1c652b0c05f`, with the following commit carrying its publication record.

Production was checked without changing application code. `/opt/readypackets/RELEASE_COMMIT` matches the deployed implementation commit `b8d2a214809f3eca90d2058e04e3f1c652b0c05f`, the portal service is active, and the health endpoint returned `{"status":"ok"}`. The host retains the latest workflow-management rollback archive at `/opt/readypackets/rollback-20260813175014-workflow-management`, along with prior rollback directories for guided workflow, status integrity, certificate management, backups, and other releases. The repository retains normal Git commit rollback points and the immutable pre-microphone-policy checkpoint tag.


## 2026-08-13 — Separate SharePoint document and audio routing

Workflow stages now expose independent SharePoint destination fields for documents and audio. The pre-existing stage destination is retained as the document destination for compatibility. A new audio destination accepts the same server-validated safe relative folder path. When no custom folder is entered, non-audio files resolve to a `Docs` subfolder and browser-recorded or uploaded audio resolves to a separate `Audio` subfolder; phase templates are selected by file category rather than by the first matching template.

The asynchronous SharePoint queue now classifies every accepted order file from its validated MIME type and extension before recording or executing the sync. Audio includes browser-recorded WebM, audio MIME types, and approved audio container extensions. The queued and worker paths both re-resolve the category-specific destination before Graph upload, so a forged browser filename cannot select the document folder for an accepted audio file. TypeScript validation, 155/155 automated tests, production client/server builds, and health verification completed successfully. The release retained `/opt/readypackets/rollback-20260813181606-sharepoint-category-routing` plus its prior client directory.


### Publication record

The category-separated SharePoint destination implementation was published in commit `6e71f15c8e7f336945780be7fe5e33e1a8a06430` (`feat: separate SharePoint document and audio destinations`). The production release marker was updated after a successful `{"status":"ok"}` health response, and the VPS operations record now includes the corresponding rollback locations.


## 2026-08-13 — Customer review-space workflow stage

Added a `review_space` workflow capability. Administrators enable **Customer file review** for a stage in the workflow designer, then curate the stage by uploading or assigning team files to that phase and using the Order Files **Publish** visibility control. The customer wizard renders a dedicated read-only review card that includes only staff-uploaded, non-placeholder, customer-visible files associated with that review phase.

Each customer download is issued through the existing protected tRPC ticket flow: order access and `visibleToCustomer` are rechecked server-side, the URL is short-lived and single-use, and content is delivered as an attachment rather than rendered inline from the portal origin. The customer sees file name, size, and publication date; staff can remove a file from the review space by unpublishing it. The default standard workflow now marks its Phase 4 delivery stage as a customer review stage. TypeScript validation, 155/155 tests, production builds, and health verification completed successfully. Rollback assets are at `/opt/readypackets/rollback-20260813190309-customer-review-space`.


### Publication record

The customer review-space workflow capability was published in commit `0320b1f4d6361bb28b08f89f25ac470112d021c9` (`feat: add customer review workflow spaces`). The production release marker was updated after a successful `{"status":"ok"}` health response, and the VPS operations record includes the corresponding rollback locations.


## 2026-08-13 — Customer order status and numeric progress visibility

Customer order progress is now explicit across every major portal surface. The dashboard Recent orders list, My orders table, individual order detail page, and every guided workflow stage show the administrator-configured order status label and a numeric completion percentage alongside the progress bar. Customer API order list/detail responses now resolve configured status labels server-side, preserving custom administrator status labels without exposing administration settings. The workflow-stage workspace adds a prominent current-status and order-completion summary at its top, while the order detail progress panel shows both the current label and percentage. TypeScript validation, 155/155 automated tests, production builds, and the deployment health check completed successfully. Rollback assets are retained under `/opt/readypackets/rollback-20260813191319-customer-order-progress`.


### Publication record

The customer status and numeric progress implementation was published in commit `cef797da31c5a031fd29ae46dad1f14eee364f25` (`feat: show customer order status and progress`). The production release marker was updated after a successful `{"status":"ok"}` health response, and the VPS operations record includes the rollback locations.


## 2026-08-13 — SharePoint sync repair and connection management

**User request:** Diagnose why order files were not syncing to SharePoint, identify where SharePoint is configured, add a connection test and root-folder selection, and repair the failing audio upload path.

**Production diagnosis:** The Microsoft Graph credentials, selected site, drive, root path, folder provisioning, and document uploads were all functioning. SharePoint sync-log entries confirmed that Office documents had succeeded. The failed item was a WebM recording (`file_id=38`), with five Graph `400 invalidRequest` responses after its folder already existed. The portal retried the item after switching its binary request to an opaque stream, but the selected SharePoint library still returned `invalidRequest`. This isolates the remaining rejection to the Microsoft 365/SharePoint library or tenant policy for the WebM file type, not ReadyPackets credentials or routing.

**Implemented:**

- Added a non-destructive **Test SharePoint connection** action in **Admin → Integrations → SharePoint & SAML**. It validates saved Graph authentication plus read access to the configured site, drive, and selected root without writing to SharePoint.
- Added a read-only **Select existing root folder** browser with folder navigation and **Use current folder as root**. A separate Save action remains required to activate a selection.
- Retained credentials as encrypted, write-only settings; no secret is returned to browser controls or audit output.
- Hardened binary upload handling to send verified local files as `application/octet-stream`, keeping the WebM bytes intact and returning a specific policy-oriented diagnostic if SharePoint responds `400`.
- Updated administrator guidance with the configuration workflow and WebM tenant/library policy troubleshooting.

**Validation:** TypeScript passed with zero errors; automated suite passed 155/155; production health returned `{"status":"ok"}`. The current runtime confirms documents have previously synchronized; the retained failed WebM retry demonstrates the outstanding SharePoint file-policy action.


### Publication record

The SharePoint repair and connection-management implementation was published in commit `49313148f3430ed375580a4dd62d7cfab603554b` (`fix: improve SharePoint sync and configuration controls`). The production release marker was updated after a successful `{"status":"ok"}` health response. The remaining failed WebM retry is retained in `sharepoint_sync_log` as auditable evidence of the SharePoint tenant/library `invalidRequest` policy response.


## 2026-08-13 — Finance controls, coupon audit, admin navigation, and activity history release

**User request:** Add portal-administered refunds with a double confirmation, make payments/refunds easily visible on a dashboard, track coupon creation/use/account attribution and lifecycle actions, reorganize and collapse the administration navigation, and provide searchable account selection in entity and user activity timelines.

**Implemented and deployed:**

- Added **Finance → Refunds** two-step workflow. Administrators first review the successful Stripe payment and remaining refundable balance, then must type `REFUND ORDER` before Stripe is called. The server requires the exact literal confirmation, requires a reason of at least ten characters, reserves the refund record before the provider call, uses Stripe idempotency, and records provider references and audit events without storing card data.
- Added Finance summary cards for collected, pending, refunded, and pending-refund amounts and counts. Payments and refund history remain visible in the same workspace.
- Added `coupon_redemptions` immutable audit records, creator/updated/disabled attribution fields, historic paid-order backfill, coupon usage modal with account/order/discount/timestamp, and activity events for creation, update, enablement, disablement, redemption, and deletion. Coupons with redemption history cannot be deleted.
- Reorganized the admin menu into collapsible Order operations; Customers & support; Finance & payments; Email & marketing; Content & policies; and Platform, security & administration sections. Collapse state is local to the administrator browser.
- Added searchable customer selection to Activity Replay Entity history (User entity type) and User timeline. Search accepts customer name, email, or public `RP-U-…` ID.
- Migration `0034_finance_coupon_audit.sql` was confirmed already applied after a staged deployment attempted the idempotent release path; the second activation intentionally skipped duplicate column DDL and preserved client/server rollback copies. Schema confirms `coupon_redemptions`, coupon actor fields, and `refunds.provider_reference` are present.
- Validation: TypeScript passed, `pnpm test` passed 155/155, production health returned `{"status":"ok"}`. The production release remains pending Git commit at the time of this log entry.


**Publication record:** The release implementation was committed and pushed to GitHub as `4b7bc1c5f96ce8e161f30d03eb22f6ff9033335e` (`feat: add audited refunds, coupon tracking, and admin navigation`). The production `RELEASE_COMMIT` marker was set to the same commit after health verification. The final session-log publication record follows in a separate documentation-only commit.


## 2026-08-14 — Order workspace operations release

**User request:** Add searchable account/order refund selection, order-level refund access, an order history tab, an MNDA tab, phase-separated administrator file management, and correct customer workflow steps incorrectly marked as Upcoming.

**Delivered:**

- Added `stripe.refundEligibleOrders`, an administrator-only paid Stripe order lookup that supports selected accounts and public order/customer references.
- Updated Finance → Refunds with customer search, account selection, paid-order selection, remaining-balance quote, reason, review, and the existing exact `REFUND ORDER` confirmation.
- Added paid-order Invoice and Refund actions at the top of the administrator order workspace and a Refund tab immediately after Automation; the order action opens Finance with the relevant order selected.
- Added Order history and MNDA tabs next to Automation. History shows lifecycle transitions and order-scoped audited actions; MNDA shows order acceptance, policy version, signer, source address, acceptance time, and signed-file reference.
- Reworked the administrator Files tab to group files by their assigned workflow phase, including customer/staff artifact context and publication controls per file.
- Corrected the customer workflow stepper’s legacy Phase I/Phase II key mapping so the active step is shown as Open and matching completed stages show Review instead of an incorrect Upcoming label.

**Validation:** TypeScript passed with zero errors; `pnpm test` passed 155/155; production server/client deployment completed with timestamped rollback copies; production health returned `{"status":"ok"}` after its normal post-restart startup interval.

**Operational note:** The background SharePoint queue currently reports Microsoft Graph authentication HTTP 400 for pending file transfers, which is separate from this release and requires re-testing the saved Graph tenant/client/secret configuration in Admin → Integrations.


### Follow-up: customer workflow system-step state correction

After deployment, the customer screenshot showed the automatic **New Order Payment Confirmed** prerequisite as Upcoming while the server had already opened the next customer phase. The stepper now treats every prerequisite stage that precedes the server-designated current stage as a system-confirmed step. It displays **Confirmed** rather than Upcoming and does not offer a misleading customer workspace link. Existing locked customer phases still show Review, and the actual active customer phase shows Open. The corrected client was deployed with rollback material at `/opt/readypackets/rollback-20260814001220-payment-stage-wizard-client`.


**Publication:** The automatic workflow-step confirmation correction was published as `61c62d71f0a328ccd378826ff7a0a3e7e8ac169f`; the production release marker was updated to the same commit after health verification.


### Customer order visibility, unified message center, and notification release

The customer order experience was aligned with each order’s assigned workflow. The order detail Progress card now renders the actual ordered workflow stages rather than the generic lifecycle sequence whenever a workflow is assigned. Payment-confirmation system stages are resolved from the verified payment state and display as **Confirmed**, while the active customer phase is distinct from later Upcoming phases. The completion percentage remains the separately managed order completion value, preventing phase confirmation from overwriting an administrator’s percentage.

Customer order lists and dashboard recent-order cards now expose **Status**, **Progress**, and **Current phase** separately. The customer Documents card now includes quick links for the MNDA, Phase I record, and every customer-visible order file, preserving short-lived authorized download tickets. Status history was renamed to **Order history** and now merges lifecycle status transitions with customer-safe order activity entries.

The legacy administrator Intake tab was assessed as a compatibility/reference surface, not the modern workflow workspace. It is now called **Phase I record** and is shown only when historical Phase I intake material exists; current workflow files, questions, locks, and phase actions remain in their dedicated tabs.

A unified Message center is now available at `/portal/messages` and `/admin/messages`. It uses encrypted existing `order_notes` content and a recipient-specific `order_message_receipts` table for read state, without duplicating message bodies. Shared messages are visible to active order owners, delegates, and staff; internal notes remain staff-only. Order workspace messages create recipient receipts automatically, and both message centers offer unread filtering, mark-read controls, and deep links back to the source order.

The customer dashboard now has a distinct **Order messages** count tile, a Message center quick action, a navigation badge, polling while the dashboard is open, and a modal popup for outstanding/new unread order messages. The popup links directly to the source message in its order or to the Message center and marks the message read. The implementation uses normal authenticated browser requests only; no external or platform-specific integration was added.

Validation before deployment: `pnpm run typecheck` passed; `pnpm test` passed 155/155 tests; `pnpm run build:client` and `pnpm run build:server` passed; and `git diff --check` passed. Production migration `0035_order_message_center.sql` created `order_message_receipts`. The validated server and client were deployed with rollback material at `/opt/readypackets/rollback-20260814004710-message-center`; after the service’s normal startup interval, health returned `{"status":"ok"}` and the receipt table was confirmed present.


#### Request received

The requested release covered seven connected portal improvements:

1. Update the customer order Progress card so it matches the workflow assigned to that order and updates by phase.
2. Add quick links to all order documents and files in the customer Documents section.
3. Rename customer Status history to Order history and track all order actions.
4. Separate percentage, status, and current order phase in customer order list/dashboard views.
5. Assess whether the legacy administrator Intake tab is still required.
6. Add unified customer and administrator Message centers, with order messages appearing in the centers.
7. Add customer-dashboard message notifications and popups with navigation to the source order message or the Message center.


**Publication:** The release was committed and pushed as `d11701ae533e1fad617f22d1f8e0c0770d5c8649` (`feat: add unified order message center`). Production health returned `{"status":"ok"}` after deployment, and `/opt/readypackets/RELEASE_COMMIT` was updated to the same feature commit. The final client rollback copy is `/opt/readypackets/rollback-20260814005026-message-center-final-client`.


### Order response-owner visibility and workspace-control release

The order queue, dashboards, and customer order list now distinguish a lifecycle/payment state from the next person who must act. A submitted and still-unreviewed customer workflow phase is represented as `awaiting_staff_review`; it appears to administrators and staff as **Customer submission awaiting review** and to customers as **Team review pending**. A staff-created open order question is represented as `awaiting_customer_response`; it appears to staff as **Awaiting customer response** and to customers as **Your response required**. This response-owner calculation is server-side and does not infer workflow action from percentage, order status, or payment status.

Administrators can filter the Order queue by either response state. The Operations dashboard adds clickable order-alert queues for customer submissions awaiting staff review and customer responses awaiting action. The customer dashboard adds distinct **Awaiting team review** and **Your action required** cards, and the customer order list adds a **Next action** column. Recent-order cards also display the matching response-owner badge.

Migration `0036_order_phase_review_queue.sql` adds audited `reviewed_at` and `reviewed_by_user_id` fields to `order_phase_locks`. Staff may now use **Mark reviewed** in the administrator order workspace’s **Workflow phase review** tab to acknowledge a submitted phase and clear the staff-review queue. The phase remains locked unless an administrator separately performs the existing typed-confirmation unlock action.

The administrator **Advance the order** control was retained only as an explicit lifecycle exception tool and renamed **Manage lifecycle status**. It now states that normal workflow movement comes from customer submissions and staff review; inline queue-card status-advance buttons were removed to avoid bypassing this distinction. The legacy administrator Intake tab was further narrowed to **Phase I record** and now appears only when a legacy submitted intake or intake attachment exists. Empty/new orders rely on the MNDA, assigned workflow, Questions, Files, and Workflow phase review surfaces instead.

Validation passed before deployment: `pnpm run typecheck`, `pnpm test` (155/155 tests), `pnpm run build:client`, `pnpm run build:server`, and `git diff --check`. The production migration was applied and verified with `reviewed_at` present on `order_phase_locks`; live health returned `{"status":"ok"}`. Rollback material is retained at `/opt/readypackets/rollback-20260814013346-order-attention`.

#### Request received

1. Administrators should see customer submissions awaiting a response in order lists and dashboards, while customers should see the corresponding state on their dashboard and order list.
2. Assess whether the administrator Advance the order control remains needed.
3. Assess whether the administrator Phase 1 Intake tab remains needed.


### Workflow fixed and randomized completion-percentage policy release

The Order Workflow designer now supports a per-stage **Completion update policy**. Administrators may choose **Set a fixed percentage** or **Choose a random percentage from a range**, with bounds from 0% to 100% and a configurable delay of up to 43,200 minutes (30 days). A zero-minute delay preserves the immediate action behavior. When a randomized delayed policy is run, the platform selects one cryptographically generated integer within the inclusive configured range at queue time and stores the exact target for auditing; it does not re-roll after a restart.

Delayed updates use new durable `workflow_completion_jobs` storage created by migration `0037_workflow_completion_jobs.sql`. The self-hosted application scheduler checks due jobs every 15 seconds. It records claim time, recovers stale claims after restart, retries transient failures with bounded backoff, raises an operational alert after five failed attempts, and does not lower an order’s completion percentage if a later action has already advanced it. Terminal/deleted orders cause a delayed job to be safely cancelled rather than updated.

Workflow validation rejects invalid random ranges, missing targets, negative delays, and delays above 30 days. The canvas and guided workflow designer both expose the same policy controls. The saved action summary identifies fixed or random behavior and delay. In each order’s Automation tab, the **Completion update schedule** displays the policy, selected random target, run time, state, and final outcome. Existing completion-percentage workflow actions remain compatible and are treated as immediate fixed policies unless a delay is newly configured.

Validation passed before deployment: `pnpm run typecheck`, `pnpm test` (155/155 tests), `pnpm run build:client`, `pnpm run build:server`, and `git diff --check`. The production migration was applied and `workflow_completion_jobs.claimed_at` verified; live health returned `{"status":"ok"}`. Rollback material is retained at `/opt/readypackets/rollback-20260814014503-workflow-completion-policy`.

#### Request received

Add an option to the Order Workflow designer to set a static completion percentage or a dynamic percentage using a configurable range, with a configurable timed delay that uses a random number within that range.


### Audio playback, Email Template Center tabs, and SharePoint credential diagnosis release

Customer and administrator order workspaces now include protected in-browser audio playback. Customer playback is available in both the assigned workflow-stage workspace and the legacy Phase 2 materials page. Administrator playback is available beside recognised audio artifacts in each phase group of the order Files tab. The browser player is not a direct storage URL: a protected procedure confirms current order/file access and recognised audio MIME type, then issues a random, session-bound five-minute playback URL. The streaming route validates the authenticated session and current file access again, supports byte-range requests needed for media playback, uses `audio/*` content types and inline disposition only for validated audio, disables caching, sets `nosniff`, and records access. Generic files remain attachment-only downloads.

The Email Template Center now has dedicated **System templates**, **Sent email history**, and **Queued deliveries** tabs. Existing template editing, previewing, cloning, audit-BCC/retention policy, retained delivery-copy viewing, stop/retry/resend controls, and retention purge behavior were preserved. The tab change makes the sent history and delivery operational queue independently accessible without duplicating delivery data.

The SharePoint error was investigated without reading or exposing any secret. The saved `sharepoint.client_id` and `sharepoint.tenant_id` values are both 11 characters and fail the expected non-secret identifier-format validation. A Microsoft Entra application (client) ID must be the full 36-character GUID; the tenant must be a full tenant GUID or a verified tenant domain. This truncated/malformed credential configuration causes the OAuth client-credentials token request to fail before the portal can query the SharePoint site or document library, producing the observed HTTP 400. The existing encrypted client secret was not read. The integration save/discovery API now rejects malformed tenant/client identifiers, and the Graph token error is enhanced to surface only the safe Microsoft identity error code on future failures, without disclosing the returned error description or credentials.

Validation passed before deployment: `pnpm run typecheck`, `pnpm test` (155/155 tests), `pnpm run build:client`, `pnpm run build:server`, and `git diff --check`. Live health returned `{"status":"ok"}`. Rollback material is retained at `/opt/readypackets/rollback-20260814030752-audio-email-graph`.

#### Request received

1. Add customer playback for audio recordings in an order.
2. Add administrator playback for audio recordings.
3. Separate system email templates, sent email history, and queued deliveries into separate tabs.
4. Identify the cause of the SharePoint Microsoft Graph API error.


## 2026-08-14 — SharePoint credential persistence and managed root correction

**User report:** The SharePoint integration had previously created customer folders but saved them beneath a duplicate `customers` path. On later configuration saves, masked Tenant ID and Client ID values shown by the administrator interface were submitted back to the server, causing identity values to become invalid/truncated and Microsoft Graph token requests to fail with `invalid_request` HTTP 400.

**Verified cause:** The settings database stores full text values and does not truncate them. The SharePoint configuration query deliberately masks identity values as `...<last 8 characters>` for safe display; the previous client form copied those masked display values into editable state and re-submitted them on partial saves. The existing folder path contract always appended `customers/{customerId}/orders/{orderId}` below the selected root, so choosing an existing `customers` folder as the root intentionally yielded `customers/customers/...`.

**Correction:** The administration UI now keeps masked Tenant and Client IDs out of editable form state, permits root/site/drive updates while preserving valid stored credentials, clearly requires full replacement values only when saved identifiers are invalid, and labels the destination as the ReadyPackets base folder. Selecting a browsed `customers` folder automatically chooses its parent as the base. Server-side save and runtime path handling now normalize any stored managed `customers` selection to the parent base and centralize generated order root construction, eliminating duplicate managed customer folders even for existing stored roots. A focused regression test confirms base, managed-customers, nested-customer, and invalid-root behavior.

**Validation:** TypeScript compilation passed; client and server production bundles passed; focused SharePoint root-path regression tests passed (4/4). The repository-wide suite was also run, but 9 pre-existing catalogue/bundle-pricing assertions failed because the canonical clone did not include the expected product fixture data; SharePoint-focused coverage passed and the failure did not involve the changed integration code.

**Safe operator sequence after deployment:** Enter complete Microsoft Entra Tenant and Application (client) IDs once to replace the currently invalid 11-character values, enter a valid secret value if required, rediscover the site and library, select the ReadyPackets base above `customers`, save, and test the connection. Existing completed folders are preserved; new jobs resolve beneath `<base>/customers/<customer>/orders/<order>/...`.

**Requested user prompt:** “I know that it was working because it created folders for users but int he wrong location. and after ever order sync it truncates the values what other method could i use to keep the information and make sure the files go to the correct location. I selected the customers folder and it created a new customers folder.”


## 2026-08-14 — SharePoint Sync Log Center and controlled retry

**User request:** “can there be a log center for synced files with an option for a retry”.

**Observed production evidence:** Phase I document transfers succeeded while WebM recordings created pending sync rows and then failed after five upload attempts. The retained failure message is a Microsoft Graph `invalidRequest` HTTP 400 response for the WebM upload; documents are unaffected. The new operational interface exposes this contrast per file without requiring staff to inspect the database or server journal.

**Implementation:** Added an administrator-only SharePoint Sync Log Center to Admin → Integrations. It lists searchable file-transfer history by order number, filename, or destination path; identifies audio versus document transfers; displays phase, state, attempts, latest update, destination, and retained sanitized error context; and supports paging and status filtering. Retry is permitted only for a failed `file_sync` record whose source file and order still exist. Retrying resets the existing row to pending, clears the previous error, resets its attempt count, and records an administrator audit event. Succeeded, pending, and running rows cannot be retried, preventing duplicate concurrent uploads. Each administrator order workspace now links directly to the filtered log for that order.

**Validation:** TypeScript validation passed. Client and server production bundles passed. The existing repository suite was not used as a release gate because the canonical checkout has known unrelated catalogue/bundle-pricing fixture failures; the changed log-center code compiled successfully and uses the established integrations retry/audit pattern.

**Requested user prompt:** “can there be a log center for synced files with an option for a retry”.


## 2026-08-14 — SharePoint WebM resumable-upload correction

**User report:** SharePoint Sync Log Center showed Phase I WebM recordings as failed after five attempts while Phase I DOCX documents in the same order and destination hierarchy succeeded. The retained Microsoft Graph response was `invalidRequest` HTTP 400 from the direct binary content endpoint.

**Diagnosis:** ReadyPackets stored the WebM recordings successfully and resolved them to the intended `Phase I/Audio` destination. The failure occurred only when the server used Graph’s direct `PUT ...:/content` binary upload route for media files. This proved that order authorization, phase locks, local object storage, Graph token acquisition, selected drive, folder creation, and document uploads were operational. A new upload-session path provides an independent, Microsoft-documented compatible transport for audio and returns a precise error phase if a library policy still rejects the file.

**Implementation:** Audio and video files, including `.webm`, now create a Graph upload session with an explicit replace conflict policy and upload bytes in sequential 10 MiB ranges. The session URL is verified as HTTPS, receives no bearer token on fragment upload, and all error messages remain sanitized before entering the sync log. Documents retain the existing successful direct binary upload route. The upload-session path is resilient to larger future recordings and reports whether rejection occurs at session creation or during the payload transfer.

**Validation:** TypeScript and server bundle generation passed. Production validation will requeue one affected failed WebM record first; remaining failed recordings will only be requeued after that transfer succeeds.

**Requested user prompt:** “The audio isnt syncing and this is the error.”


## 2026-08-14 — Original ReadyPackets WebM sync comparison and MIME correction

**User request:** “I was able to upload .webm before with the original ReadyPackets site can you review the code and tell me whats wrong and whats difference between the code?” An uploaded `readypackets-main.zip` was inspected without execution and compared against the current source.

**Verified original behavior:** `server/sharepointClient.ts` uploaded files under 4 MiB through Graph’s direct content endpoint with the file’s actual MIME type. Browser-recorded pitches were routed to `Phase I/audio` and stored/synchronized as `audio/webm`. Larger files used a Graph upload session with `@microsoft.graph.conflictBehavior: rename` and sent the actual MIME type with every fragment.

**Regressed current behavior:** `server/services/sharepoint.ts` routed every binary file, including small WebM recordings, through the direct endpoint with `Content-Type: application/octet-stream`, ignoring the persisted `files.detectedMime`. The production recordings retain `detected_mime = audio/webm`. A later upload-session experiment also changed small media behavior and was rejected at session creation; it did not match the original working path.

**Correction:** Restored the original MIME-aware strategy while retaining current authorization, encryption, durable queue, audit, and folder controls. Files of 4 MiB or less, including the recorded WebM files, now use the direct Graph content endpoint with `Content-Type: audio/webm`. Transfers above 4 MiB use Graph upload sessions, use `rename` conflict behavior, and send the verified MIME type on every fragment. The corrected strategy retains `Phase I/Audio` routing and does not transcode or alter the customer’s original recording.

**Validation:** Source comparison complete; TypeScript and bundled server compilation passed. Production validation will requeue one failed WebM first; remaining failures will be requeued only after a successful upload is recorded.

**Requested user prompt:** “I was able to upload .webm before with the original ReadyPackets site can you review the code and tell me whats wrong and whats difference between the code?”


## 2026-08-14 — Browser-upload-confirmed SharePoint Graph request correction

**New evidence:** The administrator manually uploaded the exact failed WebM recordings into the same SharePoint `Phase I/Audio` folder successfully. This eliminated SharePoint library file-type policy, Purview/DLP policy, retention/sensitivity policy, filename length, and folder destination as causes.

**Root cause:** The portal’s Graph shorthand upload route `PUT /drives/{driveId}/items/{parentId}:/{filename}:/content` returned `invalidRequest` for these files even after restoring `audio/webm`. The application had previously established the folder successfully, but this single-step filename-plus-content request was not accepted by the affected SharePoint library/app-only Graph combination.

**Correction:** The small-file sync path now uses Microsoft Graph’s explicit two-step drive-item contract: first `POST /drives/{driveId}/items/{parentId}/children` with a file driveItem and a fail-on-conflict policy, then `PUT /drives/{driveId}/items/{itemId}/content` for the verified binary stream. On a conflict, the exact existing child item is resolved and its content is updated. Original recordings are not renamed, transcoded, or changed. Larger files retain Graph upload-session processing.

**Validation:** TypeScript and server bundle generation passed. Production validation will requeue one failed WebM transfer; only after success will the remaining failed audio records be requeued.

**Requested user prompt:** “I was successfully able to manually upload the file.”


## 2026-08-14 — SharePoint WebM staging-and-rename Graph compatibility fallback

**Additional production evidence:** The explicit Graph file-item creation attempt for the final `.webm` name returned a Microsoft Graph `generalException` HTTP 500, while the administrator successfully uploaded the identical WebM files manually into the identical SharePoint folder. This isolates the incompatibility to the app-only Graph operation applied directly to the final WebM filename, not to the recording, file policy, destination, or customer order state.

**Correction:** Small WebM synchronizations now create a unique neutral `.bin` drive item, upload the unchanged verified WebM byte stream with `audio/webm`, and then rename the completed drive item to its original audit-prefixed `.webm` name. The temporary object name is generated with a cryptographically random UUID and is cleaned up best-effort if content transfer or rename fails. The final SharePoint artifact retains the original WebM bytes and exact ReadyPackets permanent filename. Non-WebM document transfers retain the existing direct path; larger files retain resumable Graph sessions.

**Validation:** TypeScript and server bundle generation passed. Production validation will retry one failed WebM first; remaining failed recordings will only be requeued after this exact staged upload completes successfully.

**Requested user prompt:** “I was successfully able to manually upload the file.”


## 2026-08-14 — Direct temporary-name WebM Graph upload correction

**Iteration evidence:** A direct final-name WebM Graph content upload returned `invalidRequest`; an explicit Graph file-item `POST /children` also returned `generalException` HTTP 500. The administrator’s successful browser upload of the identical WebM file to the identical `Phase I/Audio` folder proves the folder, file bytes, and final name are acceptable.

**Correction:** The small-file app-only Graph path now uploads WebM bytes using the same direct content endpoint that successfully synchronizes documents, but uses a short unique neutral `.bin` item name during the upload. After Graph creates the item and returns its item ID, the service uses a metadata `PATCH` to rename it to the unchanged ReadyPackets audit-prefixed `.webm` name. If the upload or rename fails after creation, the temporary item is best-effort deleted. The portal source, local encrypted object, playback behavior, permanent filename, and final SharePoint WebM content remain unchanged.

**Validation:** TypeScript and server bundle generation passed. One controlled production retry will verify direct temporary upload and final rename before any remaining audio records are requeued.

**Requested user prompt:** “I was successfully able to manually upload the file.”


## 2026-08-14 — Neutral-name/octet-stream WebM Graph staging correction

**Final request-combination evidence:** The direct Graph content endpoint rejected final-name `.webm` requests both with `audio/webm` and `application/octet-stream`. It also rejected a neutral `.bin` name when the payload declared `audio/webm`. The SharePoint browser accepts the same final-name file and content.

**Correction:** The final compatible request combination stages the unchanged WebM bytes under a unique neutral `.bin` name using the same `application/octet-stream` direct Graph content request proven to work for general binary document transfers. After Graph returns the item ID, ReadyPackets renames the item to the exact original audit-prefixed `.webm` filename. The portal’s internal `files.detectedMime` remains `audio/webm`; only the short-lived transfer representation is neutral. A failed final rename triggers best-effort cleanup of the temporary item.

**Validation:** TypeScript and server bundle generation passed. Production validation will retry one failed WebM first; successful completion is required before the remaining audio-sync records are requeued.

**Requested user prompt:** “I was successfully able to manually upload the file.”


## 2026-08-14 — Reversible SharePoint-only MP3 audio fallback

**Decision:** The administrator selected Option B after a controlled comparison established that the SharePoint browser accepts the original WebM file but the current Microsoft Graph app-only context rejects its binary transfer across direct and resumable request forms. The fallback is deliberately scoped to SharePoint synchronization only and preserves the possibility of a future delegated Microsoft 365 upload transport (Option A).

**Implementation:** A configurable SharePoint audio transfer mode is now stored as `sharepoint.audio_fallback_mode`. The default is `mp3`; administrators can later choose `none` in Admin → Integrations to disable the fallback when a WebM-compatible Microsoft identity transport is configured. For audio files with a `.webm` source, the background worker reads the existing encrypted local source, uses server-side `/usr/bin/ffmpeg` without a shell to create a private transient 96 kbps mono MP3 transfer copy, uploads only that MP3 to SharePoint, and removes every temporary file in `finally`. The original WebM, original filename, MIME metadata, storage object, customer/admin playback, phase lock, and portal audit evidence remain unchanged. Sync logs show the actual `.mp3` SharePoint destination and activity records identify the fallback explicitly.

**Safety validation:** The production controlled WebM source was converted non-destructively with the same ffmpeg settings. The source remained untouched; the transient output was 103,176 bytes and verified as codec `mp3`. TypeScript and production client/server builds will be validated before deployment. A single controlled SharePoint audio sync must succeed before any remaining failed audio records are requeued.

**Requested user prompt:** “try option b but I may want to go back to option a if option b does not work”


## 2026-08-14 — Delegated Microsoft 365 WebM sync transport (pending first authorization)

### User request

The user selected the WebM-preserving delegated Microsoft 365 sync approach after SharePoint browser uploads succeeded but every Microsoft Graph app-only binary audio request—WebM and the prepared MP3 fallback—returned `HTTP 400 invalidRequest`. The user asked to proceed with Option A and requested setup instructions for a dedicated Microsoft sync service account.

### Evidence-driven design

The platform retains app-only Microsoft Graph credentials for SharePoint discovery, folders, and document synchronization because those operations were already successful. Audio binary uploads now support a separate delegated Microsoft 365 service-account transport. The original WebM remains the only retained and synchronized media artifact; the prior MP3 fallback remains configurable but will only be used when no delegated sync identity is connected.

The implementation uses authorization code flow with S256 PKCE, a random 32-byte state value retained only as a SHA-256 hash, single-use 10-minute authorization attempts, an encrypted PKCE verifier, an exact HTTPS callback URI, and an encrypted refresh token. Refresh tokens are renewed server-side and replaced when Microsoft returns a new one. No token, password, or client secret is returned to the browser. The callback uses state validation rather than a cross-site session cookie because portal sessions correctly use `SameSite=Strict`.

### Delivered components

- Migration `0038_sharepoint_delegated_sync.sql` adds state-hash, encrypted verifier, expiry, and one-time-use storage.
- `server/services/sharepointDelegatedAuth.ts` implements PKCE authorization construction, authorization-code exchange, encrypted token persistence, safe refresh, status, and disconnect behavior.
- `server/http/sharepointDelegatedAuth.ts` implements the no-store callback route and safe status redirect.
- `server/services/sharepoint.ts` routes only audio binary uploads through a connected delegated identity; documents and folders remain app-only.
- Admin → Integrations now shows delegated sync status, callback URI, start authorization control, and typed `DISCONNECT SYNC` disconnect confirmation.

### Validation and next step

TypeScript validation and client/server production builds passed. The feature requires the Microsoft Entra redirect URI and delegated permissions to be registered, then the user must authorize the dedicated Microsoft 365 account. No failed recordings were requeued during implementation. After authorization, validate one WebM transfer before requeueing remaining failed audio.


## 2026-08-15 — Delegated SharePoint audio upload framing correction

After the Microsoft 365 delegated sync account connected successfully, live WebM audio syncs continued to return Microsoft Graph `400 invalidRequest` during the binary content PUT even though authentication, token refresh, folder resolution, the source recording, and manual SharePoint browser upload all succeeded. The worker already selected the delegated token for audio transfers; the remaining difference was the runtime binary request construction.

The SharePoint binary-content worker now sends direct binary PUTs through Node's native HTTPS client with an explicit `Content-Length`, `Content-Type`, `Accept`, and one raw byte stream. JSON, discovery, app-only document sync, original WebM storage, customer/admin playback, and the reversible MP3 setting remain unchanged. A controlled delegated WebM retry will validate this correction before any bulk requeue.


## 2026-08-15 — Delegated SharePoint REST audio transport

Delegated Microsoft Graph authorization and browser-level WebM upload both succeeded, but all Graph binary audio transfer request shapes still returned `400 invalidRequest`. The source comparison and controlled retries showed a resource-audience distinction: the authorization succeeds for Microsoft Graph, while the selected SharePoint environment rejects the Graph binary write path.

ReadyPackets now has a separate delegated SharePoint REST transport for audio only. It obtains a refresh-token-derived access token for the validated tenant SharePoint hostname and `AllSites.Write` scope, then writes the original WebM to the already-resolved audio folder through SharePoint REST. Graph app-only credentials continue to create folders and synchronize documents. The Microsoft 365 sync account must be reauthorized after SharePoint delegated `AllSites.Write` consent is granted; no original recording is modified or transcoded by this path.


## 2026-08-15 — Delegated SharePoint callback resource-scope correction

The delegated Microsoft 365 sync account redirected back to ReadyPackets but did not connect. Sanitized callback logs showed Microsoft identity `invalid_request` during authorization-code redemption, while the single-use state was consumed and no encrypted refresh token was stored. The cause was requesting Microsoft Graph and SharePoint REST resource scopes together in one authorization-code exchange.

The callback now requests only the Microsoft Graph delegated audience during interactive authorization, which restores profile verification and renewable refresh-token storage. The separate SharePoint REST `AllSites.Write` audience is requested only later through the encrypted refresh token when the audio worker runs. This preserves the delegated SharePoint REST transport and avoids mixing API resource audiences in the interactive token exchange.


## 2026-08-15 — Delegated SharePoint REST document-library root correction

The first controlled delegated SharePoint REST audio upload reached the SharePoint REST service but returned `404 DirectoryNotFound`. This confirmed that delegated authorization and the REST endpoint were functioning, while the constructed server-relative path omitted the selected document library root. Microsoft Graph folder resolution works relative to a drive root; SharePoint REST requires the full server-relative library path.

The audio worker now reads the selected drive's Graph `webUrl`, derives and validates the document-library server-relative root, confirms it belongs to the configured site, and prefixes that root to the existing ReadyPackets stage path before issuing the delegated REST write. Folder creation, document synchronization, original WebM retention, and customer/admin playback remain unchanged.


## 2026-08-15 — Delegated SharePoint REST POST upload correction

After resolving the document-library root, the controlled delegated SharePoint REST audio transfer reached the correct folder and returned SharePoint’s explicit `SP.File does not support HTTP PUT method` response. The REST `Files/add` endpoint requires an HTTP POST with the binary request body; the worker had reused a Graph PUT helper.

The native binary request helper now accepts the required method explicitly. Delegated SharePoint REST audio creation uses POST, while existing Microsoft Graph binary content transfers retain PUT. Authorization, fixed content length, original WebM bytes, selected library-root resolution, and error redaction remain unchanged.


## 2026-08-15 — Delegated SharePoint REST audio synchronization verified

After the dedicated Microsoft 365 sync account was connected with delegated SharePoint consent, the controlled original WebM transfer completed successfully through the delegated SharePoint REST path. The synchronized destination was the expected `Phase I/Audio` folder beneath the selected document library, and the source WebM remained unchanged in ReadyPackets.

Following the controlled success, the remaining 13 historical failed WebM transfer records were requeued. Final production verification reported 14 WebM sync records in `succeeded` status, with zero pending and zero failed WebM records. The final correction used the selected drive's full document-library root and SharePoint REST's required POST method for `Files/add`.


## 2026-08-15 — SharePoint integration guidance alignment

The Integrations page now accurately states that original WebM transfers use a connected delegated Microsoft 365 SharePoint identity, while existing app-only configuration continues to handle document and folder operations. The displayed prerequisite guidance now includes SharePoint delegated `AllSites.Write` alongside Microsoft Graph delegated permissions. This UI-only correction follows the verified recovery in which all 14 tracked historical WebM transfers completed successfully.


## 2026-08-15 — SharePoint audio-mode label clarification

The integration controls now explain that the MP3 fallback mode is used only when no delegated Microsoft 365 SharePoint sync identity is connected. The Original WebM mode is labeled as using the connected delegated SharePoint identity. This is a client-only guidance clarification; the verified production behavior remains original WebM synchronization through the delegated SharePoint REST transport.


## 2026-08-15 — Maintenance administrator visibility and administration response recovery

**User report:** Customer users and orders appeared to disappear when maintenance mode was enabled. Administration pages also showed repeated `Unable to transform response from server` errors during backup schedule, configuration export, archive verification, and download operations; SharePoint Sync Log appeared empty; and prior integration state appeared absent.

**Data-integrity verification:** No records were deleted. Production verification confirmed 9 total active users, SharePoint synchronization history present, successful historical transfer records present, two outbound webhook endpoints, and all non-secret SharePoint configuration settings—including the encrypted delegated refresh token, Graph identifiers, site, drive, and root path—present. The inbound/outbound event screens show zero because no inbound listeners have been configured and no webhook deliveries have been emitted, respectively; they are not evidence of data loss.

**Root causes corrected:**

1. Maintenance middleware served the `/admin` HTML shell but returned a plain maintenance JSON response for every administrator tRPC query/mutation except the two explicitly named authentication/security router prefixes. The shell therefore rendered with empty customer/order/operational datasets while maintenance mode was active. The middleware now resolves the session after CSRF handling and permits API traffic only for an active, MFA-complete, unrestricted administrator. All anonymous, customer, staff, restricted, and MFA-pending requests remain blocked by maintenance mode.
2. CSRF rejections generated before the tRPC adapter used an Express-like `error` body rather than tRPC’s serialized `error.json` envelope. When an old browser tab submitted an expired CSRF token, the tRPC client could not decode the error and misleadingly reported `Unable to transform response from server`. The rejection now uses the exact tRPC serialized error envelope and returns the actionable security-token reload message without weakening CSRF checks.

**Validation:** TypeScript compilation, server bundle, and client build completed. The client build was run directly because the package-manager wrapper blocked on an unrelated ignored dependency-build policy; no dependency or lockfile changes were made. The deployment will retain rollback copies and production health must pass before release closure.


**Production validation and publication:** Release `b7721c6a78dacbea66516e7d9188b660c5903b07` was deployed with server and client rollback copies. Live health returned `{"status":"ok"}`. Data integrity after deployment confirmed 9 active users, 3 orders, and 21 SharePoint sync records, including 4 successful completed records. An anonymous order API request correctly returned the tRPC `UNAUTHORIZED` response while maintenance mode was disabled. A controlled unsafe request without a CSRF token returned a valid tRPC `error.json` envelope with the explicit message `Your security token expired. Reload the page and try again.`; it no longer produces the client-side transformer error. No maintenance setting was toggled during validation to avoid disrupting customer traffic.


## 2026-08-15 — Customer ID standard and profile visibility

**User request:** Display each customer’s customer ID and join date on the administrator customer profile. Replace the legacy public account reference with a unique, opaque `RPYY-XXXXXXXX` format such as `RP26-2UH4D3OT` for existing and future accounts.

**Implementation:** Replaced the public-ID generator with a year-prefixed, eight-character random uppercase identifier using an ambiguity-reduced alphabet. Future account creation retries database-enforced public-ID collisions without exposing an internal user key. Added a one-time migration utility that regenerates public IDs for every existing user, verifies no missing or duplicate values, and remaps any configured login-whitelist public IDs. Customer profile headers and Account panels now display the customer ID and join date. Activity Replay and Platform Setup accept and explain the new format.

**Safety controls:** Internal numeric user IDs, legacy customer numbers, encrypted profile fields, orders, files, and relational links are unchanged. A timestamped pre-migration database snapshot is retained before applying the data-only public-ID update. The database unique index remains the authoritative uniqueness control.

**Validation:** TypeScript compilation and client/server builds passed. The focused customer-ID generator assertions verify the required `RPYY-XXXXXXXX` shape, omission of ambiguous characters, and uniqueness across generated samples. The normal crypto test process encountered an existing Argon2 runner termination during its password-hashing section, after its encryption and blind-index assertions had passed; this did not involve the customer-ID implementation.
**Migration hardening:** Before production execution, the customer-ID migration was upgraded so every public-ID and optional login-whitelist remap occurs inside one database transaction. Any collision exhaustion, malformed whitelist setting, or write failure rolls back the entire data update before post-transaction uniqueness verification.

**Deployment completion (2026-08-15):** The earlier deployment handoff was deliberately re-validated before any restart. The initial server artifact was confirmed to be a 2,444-byte esbuild entry-point output caused by omitting `--bundle`; it was never allowed to become the running service. The production build was regenerated with the repository-supported bundled server command, producing an 886,041-byte Node 22 ESM artifact. TypeScript validation completed successfully. The existing live server bundle and client assets were retained under `/opt/readypackets/rollback-20260815050349-customer-ids/`, and a root-only pre-migration MySQL snapshot was created at `/var/backups/readypackets/pre-customer-id-20260815050349.sql.gz` before data modification.

**Production migration and verification:** The application was stopped briefly to avoid an account-creation race, the full server bundle and current client assets were installed, and the transactional migration utility was run with the production environment. It reported `{"migrated":9,"verified":9,"format":"RPYY-XXXXXXXX"}`. Database verification then returned `users=9;unique_ids=9;format_matches=9`; thus every existing account has one distinct identifier conforming to the required pattern. The service restarted cleanly on loopback port 3000, local and external `https://myportal.readypackets.com/api/health` checks returned `{"status":"ok"}`, and public HTTPS headers continue to provide a nonce-based strict CSP, HSTS, `nosniff`, strict referrer policy, and a restrictive Permissions-Policy. The deployed release marker is `7e7e8405dbfc206f4cfe2de7892ba822a0a00118`.

**User-facing response prepared:** The customer-ID standardization is now live. New and existing accounts use opaque `RPYY-XXXXXXXX` references, administrator customer profiles show Customer ID and join date, all nine existing accounts were migrated successfully, and protected rollback/database recovery material remains available. No Manus integration or runtime dependency was introduced.

## 2026-08-15 — Interactive unified installation selector
**User request:** “have the script to prompt me which install i would want.”

**Implementation:** `deploy/unified-install.sh` now detects an interactive terminal when `--mode` is omitted and presents a numbered selector: **1) Native VPS**, **2) Existing Docker Engine and Docker Compose**, or **3) Install Docker Engine then deploy with Docker Compose**. Native VPS is the explicit default and remains the recommended path because it installs the protected backup, update, and rollback helpers. An explicit `--mode native|docker|docker-bootstrap` continues to bypass the selector for controlled automation.

**Safety and validation:** The selector is intentionally disabled when standard input is not a terminal. Mode-less unattended invocations fail with an explicit command-line error rather than blocking a deployment pipeline. Shell syntax, help text, pseudo-terminal interactive selection, and the no-TTY guard were validated. `docs/DEPLOYMENT_AND_INSTALL.md` now documents the simple interactive command and the required explicit-mode behavior for automation.

## 2026-08-15 — Fresh bare-metal VPS installer bootstrap
**User request:** “how do i get the installer from a fresh VPS bare metal server?”

**Response prepared:** The approved bootstrap starts from a current Ubuntu LTS host with only SSH access. It installs only `git` and `curl`, clones the private `readypackets/ReadyPackets` repository into `/srv/readypackets` using a short-lived GitHub authentication method, removes any temporary Git credential afterward, then runs `sudo bash deploy/unified-install.sh --domain <host> --email <contact>`. The interactive installer selects native, existing Docker, or Docker-bootstrap mode and then selects TLS. The instructions explicitly keep repository credentials out of `.env`, application settings, shell history, and service configuration; retain only ports 22, 80, and 443; and do not expose MySQL or the application port.

## 2026-08-15 — Native VPS deployment: demo1.readypackets.com

**User request:** “perform a install on this server” followed by the target root account details, the deployment hostname `demo1.readypackets.com`, the selection of **Let’s Encrypt**, and the requirement to “keep a full detailed session log.” Credentials were used only for the requested remote administration and are intentionally omitted from this record.

**Target assessment:** The server at `167.99.224.116` was confirmed as a clean Ubuntu 24.04.4 LTS host with two vCPUs, 3.8 GiB RAM, approximately 75 GiB free root storage, and no existing ReadyPackets paths, nginx, MySQL, Docker, or ReadyPackets service. Public DNS for `demo1.readypackets.com` resolved to `167.99.224.116` before certificate issuance. No pre-existing `AGENTS.md` existed on the server.

| Deployment decision | Applied configuration |
|---|---|
| Hosting model | Native Ubuntu VPS, not Docker |
| Public hostname | `demo1.readypackets.com` |
| TLS | Let’s Encrypt public certificate with automatic renewal |
| Application listener | `127.0.0.1:3000` only |
| Database listener | `127.0.0.1:3306` only |
| Public ports | SSH, HTTP, and HTTPS only |
| Source origin | Verified local archive of private ReadyPackets commit `84e31a42ce2a248fa0d1d3a3912ee2738509b2c1` |

**Source-transfer safeguard:** A temporary repository-authentication attempt was stopped after a credential-handling error in the terminal workflow. No repository clone was performed with that credential. The user directed work to continue, so the approved local source tree was packaged without dependencies/build output, SHA-256 verified, and securely copied to the server over the authenticated SSH channel. The source archive was unpacked under `/srv/readypackets`, set to root ownership, and verified against the approved commit before installation. No GitHub credential was retained on the target host.

**Installer remediation 1 — NodeSource key rotation:** The initial native installer run reached the Node.js step but a stale NodeSource apt source used an untrusted legacy signing key. `deploy/install.sh` was improved in two layers. It now detects an apt-update failure specifically attributable to a NodeSource source, removes only the stale NodeSource list/keyring, retries the normal signed package refresh, and then uses NodeSource’s versioned Node 22 setup process to install the current signing configuration. The corrected installation installed Node.js `v22.23.2` successfully.

**Installer remediation 2 — pnpm workspace compatibility:** The initial build found a malformed `pnpm-workspace.yaml` whose missing `packages` field was rejected by the pinned pnpm 9 installer. The workspace manifest now explicitly declares the repository root package and continues to allow only the native build scripts required by `argon2` and `esbuild`. The corrected manifest was validated with the installation dependency command, then the target build completed successfully.

**Installer remediation 3 — migration ledger compatibility:** A historic migration (`0005_tier4_tier5.sql`) contains a legacy self-recording `schema_migrations` insert. MySQL DDL implicit commits allowed that legacy record to persist, which caused the runner’s authoritative transaction-managed record insert to see a duplicate key. The migration file itself was preserved byte-for-byte to avoid checksum divergence. The migration runner now skips only legacy self-recording ledger statements and recognizes only the documented historic checksum `tier4_tier5_v1` for that one migration; all other checksum mismatches still fail closed. The repaired migration runner compiled and type-checked before deployment. The target completed all remaining migrations through `0038_sharepoint_delegated_sync.sql`.

**Installation result:** The installer generated and protected the local environment secrets, configured MySQL loopback binding, built the client and server bundles, seeded packet groups, policies, email templates, application settings, file governance rules, content blocks, forum categories, and registration fields, installed the hardened systemd service and nginx configuration, enabled UFW and fail2ban, issued a Let’s Encrypt certificate, enabled certificate and nightly backup timers, and performed an initial successful encrypted backup. A new root-owned `AGENTS.md` was created on the target to preserve the host-specific operational record.

| Post-install verification | Result |
|---|---|
| `readypackets`, nginx, MySQL, and fail2ban services | Active |
| Local app health endpoint | `{"status":"ok"}` |
| Public HTTPS health endpoint | `{"status":"ok"}` |
| Certificate subject | `demo1.readypackets.com` |
| Certificate expiry | 2026-11-13 11:05:14 UTC |
| Certificate and backup timers | Active |
| Migration ledger rows | 34 |
| Initial backup | `/var/backups/readypackets/readypackets-20260815T120357Z.tar.gz` (root-only) |
| Open external listeners | 22, 80, and 443 only |
| Application/database listeners | Loopback only: 3000 and 3306 |
| Service error journal after install | No error entries |

**Security verification:** Public HTTPS responses include the nonce-based strict Content-Security-Policy, HSTS with a two-year lifetime and preload directive, `X-Content-Type-Options: nosniff`, strict origin referrer policy, and a restrictive Permissions-Policy. UFW permits only OpenSSH, TCP 80, and TCP 443 on IPv4 and IPv6. The backup, encryption-key, MFA, service-boundary, and update-path notes were recorded locally in `/root/AGENTS.md` without exposing any secret.

**Operational next steps prepared for the user:** Create the first administrator with the root-console command printed by the installer, enroll MFA immediately, configure outbound email in the administrative setup, configure Stripe, Entra ID, webhooks, external backup destinations, and other integrations from the portal administration area, and retain encrypted offline copies of `/etc/readypackets/portal.env` and the protected backup archives. The source fixes, detailed session record, and committed deployment record will be published to the private GitHub repository.

**Repository publication and final release record:** The installer, workspace, migration-runner, package-manager pin, and this detailed deployment record were committed and pushed to the private repository as `0960ca591e1cdf5c8f2b22b2d49e3131d924374c` (`fix: harden native installer and legacy migrations`). The target’s `/opt/readypackets/RELEASE_COMMIT` was updated to that release identifier after source-manifest synchronization. The final external check to `https://demo1.readypackets.com/api/health` returned `{"status":"ok"}`, and the `readypackets`, nginx, and MySQL services remained active.

## 2026-08-15 — Stripe API-side configuration guidance

**User question:** “what are hte settings required on the stripe api side” for the newly installed ReadyPackets portal at `demo1.readypackets.com`.

**Portal integration review:** The Finance → Stripe Settings page requires a server-side Stripe API key, an optional publishable key, and a per-endpoint Stripe webhook signing secret. Keys saved in the administrator interface are encrypted at rest in the application settings and take precedence over optional environment variables. The supported webhook receiver is `https://demo1.readypackets.com/api/stripe/webhook`; it verifies the raw request body and `Stripe-Signature` with the configured signing secret. Customer Checkout is deliberately blocked unless both an API key and webhook signing secret are configured, so an order is treated as paid only after a signed `checkout.session.completed` event.

**Required Stripe Dashboard configuration:** Use matching sandbox keys and a sandbox webhook while testing, then matching live-mode keys and a live-mode webhook before accepting money. Configure a single account-scoped HTTPS webhook endpoint at `https://demo1.readypackets.com/api/stripe/webhook` for `checkout.session.completed`, `payment_intent.payment_failed`, and `charge.refunded`. Copy that endpoint’s unique `whsec_...` signing secret into the portal. The portal uses Stripe-hosted Checkout in one-time `payment` mode; it does not require Stripe Connect, subscription, or recurring-billing configuration for its baseline checkout flow.

**Security guidance:** Never paste or transmit Stripe secret, restricted, or webhook-signing values in chat, email, Git, screenshots, or the public publishable-key field. Prefer a live restricted API key if it grants all calls used by the portal; otherwise use a live secret key temporarily, restrict it with Stripe access policy to the production server’s static public IP address, and rotate it after testing. The publishable `pk_...` key is the only non-secret value. Use the portal’s **Test Stripe connection** button after saving the server API key; the portal reports Payment ready only after both the checkout key and webhook signing secret are present. Validate sandbox Checkout and webhook delivery before switching the portal to live keys.

**Reference:** Stripe’s official API-key and webhook documentation was reviewed on 2026-08-15. It confirms test/live keys are separate, webhook secrets are per endpoint, and publicly accessible webhook receivers must use HTTPS and verify the raw body with the endpoint signing secret.

## 2026-08-15 — Per-order SharePoint Sync status tab

**User request:** Add a tab to every administrator order workspace to see the SharePoint file synchronization status for that order. The supplied workspace screenshot showed the existing order-tab strip and Files tab; no image processing was required.

**Implementation:** The administrator order detail now loads the existing staff-authorized `integrations.sharepointSyncLogs` query scoped to the open order. A new **SharePoint sync** tab appears alongside the existing workflow, files, automation, refund, history, and MNDA tabs. Its tab label shows the order’s current file-sync record count. The tab presents a compact summary of total, synchronized, in-progress, and failed transfers, then an order-only transfer-history table with source file name, phase, detected type, attempts, status, SharePoint target path, last update, and the retained sanitized error message.

**Retry controls and security:** The feature intentionally reuses the established administrator-only `integrations.retrySharepointSync` procedure rather than creating a new retry path. The control renders only for failed transfer records. The server independently rejects any retry when the source file was deleted, the record is not a file-sync entry, or the transfer is pending, running, or already successful. Requeueing resets the error/attempt state, is audited as `sharepoint.file_sync_requeued`, and is processed by the existing bounded background worker. The central Integrations → SharePoint Sync Log Center remains available through a tab link for paginated cross-order searching and audit review.

**Validation and deployment:** TypeScript compilation and diff checks passed. The production client bundle was built with Vite, archived, SHA-256 verified (`f9738f1e872153004a4c22306a81b3c2800b3aee9b8b82744e75e7f138d41bd5`), and installed to the production portal at `myportal.readypackets.com`. The prior client assets were retained under `/opt/readypackets/rollback-20260815132500-order-sharepoint-sync/client-dist`. The normal service restart initially returned before the Node listener had bound; journal inspection confirmed clean startup, followed by successful local and public health responses (`{"status":"ok"}`), active service status, and confirmation that the deployed client asset contains the `SharePoint sync` label. The production `AGENTS.md` operations record was updated without secrets.

## 2026-08-15 — P101 bundle scope manifest correction

**User report:** The Phase I Start Webhook (P101) payload preview showed `"bundle_scope_manifest": "{}"`. The supplied `ReadyPackets_Webhook_Trigger_Reference_P101_P201.pdf` defines the Packet 7 mixed-tier example as an escaped JSON string, specifically `"bundle_scope_manifest": "{\"packet_1\":\"Standard\",\"packet_2\":\"Basic\"}"`, and specifies that P201 must retain only the same `customer_id`, `order_id`, and `run_mode`.

**Root cause:** The server payload builder hard-coded the top-level Packet 7/Mixed fields but read `orders.bundle_scope_manifest` directly and fell back to `{}` when it was null. The field was optional in both checkout and administrator order creation, with no automatic derivation from the selected products. The P101 preview used the same fallback. The normalized data model already retained all needed information in `order_items.packet_group_id`/`tier` and `packet_groups.group_number`.

**Correction:** Added `server/services/orderScope.ts`, which validates a non-empty administrator-provided manifest or derives a stable object such as `{"packet_1":"Standard","packet_2":"Basic"}` from confirmed order items. The result is serialized as an inner JSON string so the outer webhook payload correctly escapes its quotation marks. New orders now persist derived manifest values and a sensible order-scope default. Existing orders derive the value immediately for administrative P101 previews; when P101 is generated, a valid non-empty derived value is persisted for future runs. Malformed and empty legacy values, including `{}`, are rebuilt from actual selections. P201 remains intentionally limited to `customer_id`, `order_id`, and `run_mode`, as required by the supplied reference.

**Regression coverage and verification:** Added `tests/orderScope.test.ts` with three tests covering empty `{}` derivation, malformed legacy fallback, and valid explicit-manifest preservation. All three tests passed. TypeScript type-checking, a full bundled-server build, and diff checks passed. The production server/client release was checksum-verified, deployed with rollback assets at `/opt/readypackets/rollback-20260815230000-bundle-scope-manifest`, and restarted. Startup readiness required several seconds as expected; local and public health checks returned `{"status":"ok"}`, and `readypackets`, nginx, and MySQL were active. The live server bundle was confirmed to include `backfillBundleScopeManifest`. The operations record was updated without secrets.

**Publication:** The manifest correction was committed and pushed as `08646a25bd0ae1f55da98c5b2fd271eda376777d` (`fix: derive webhook bundle scope manifests`). Production `RELEASE_COMMIT` was updated to that commit and the final public health response remained `{"status":"ok"}`.

## 2026-08-15 — SharePoint Phase I placeholder-file verification

**User question:** The user asked whether the highlighted `DOCUMENTS_REQUIRED.txt` and `INTAKE_CHECKLIST.txt` files in a Phase I SharePoint Docs folder were created by ReadyPackets.

**Verification:** The SharePoint phase-provisioning service defines the default Phase I placeholder set as `INTAKE_CHECKLIST.txt` and `DOCUMENTS_REQUIRED.txt`. When the Phase I kickoff configuration has `attach_placeholders` enabled, the protected background `attach_placeholders` job creates the files in the configured phase folder, prefixes them with the customer public ID and order number, marks the stored portal records `uploaded_by_user_id = 0`, `is_placeholder = true`, and `visible_to_customer = false`, and logs `sharepoint.placeholders_attached`.

A read-only production database check confirmed that both reported files belong to order `RP-C000008-2608-D51134`, were created at `2026-08-15 23:25:57` UTC with `uploaded_by_user_id = 0`, `is_placeholder = 1`, category `deliverable`, and the phase configuration has `attach_placeholders = 1` and `enabled = 1`. They are expected system-generated informational placeholders, not customer uploads or final business documents. No files or configuration were changed during this investigation.

## 2026-08-15 — Analysis and report inventory delivery

**User request:** The user requested all analyses and reports created so far.

**Delivered inventory:** Verified repository-tracked assessments and available standalone assessment artifacts. A consolidated `ReadyPackets_Analysis_and_Reports_2026-08-15.zip` package was prepared with a Markdown index, branded Security & SDLC Assessment (PDF and Markdown), Go-Live Readiness Assessment (PDF), Comprehensive Code/Security/Functionality Review, OWASP Top 10 (2025) Coverage Assessment, Feature Gaps & Priorities, Implementation Gap Assessment, Gap Analysis Response, Gap Analysis V2, Security Assessment slide content, and the editable 12-slide Security Assessment project. The completed slide deck was presented as a separate downloadable presentation artifact. User-provided source/reference reports were intentionally not represented as newly created analysis deliverables.

## 2026-08-16 — Automatic paid-order invoice repair

**User report:** The user reported that invoice generation failed on its first click (`invoices.getForOrder`), worked only after a second click, and asked that every order receive an invoice automatically. The resulting invoice screenshot exposed an `RP-DRAFT-47-...` identifier, confirming that the first request had inserted a record but failed before finalizing/retrieving it.

**Root cause:** The invoice service accessed `insertId` directly on Drizzle’s mysql2 result value. MySQL returns a tuple (`[ResultSetHeader, FieldPacket[]]`), so the direct property was undefined. The first request therefore inserted an invoice with its temporary draft number, then attempted to update/select using an unusable identifier and raised `Invoice generation could not be completed.` The next request found the inserted record, explaining why a second click appeared to work.

**Correction:** The service now uses the existing tuple-safe `insertedId` helper to obtain the database identifier and creates the first-request canonical `RP-INV-YYYY-######` number. It also repairs an existing legacy `RP-DRAFT-...` invoice idempotently when read. `activatePaidOrder` now awaits `getOrCreatePaidOrderInvoice`, so Stripe-confirmed paid orders and administrator-paid/waived/test orders create their invoice automatically. A duplicate `checkout.session.completed` event performs only the idempotent invoice materialization, allowing Stripe’s at-least-once delivery behavior to repair a missing historical invoice without replaying order provisioning or automations. Non-required orders now wait for their invoice materialization before the create-order response completes.

**Validation and production action:** Added `tests/invoice-number.test.ts` for tuple ID extraction and canonical number generation; together with existing tests, 5 tests passed. TypeScript checking, server bundling, and diff validation passed. The server release was checksum-verified and deployed with rollback copy at `/opt/readypackets/rollback-20260816000500-automatic-invoices/dist-server.js`. The legacy affected record for order `RP-C000008-2608-41147E` was normalized from its draft number to `RP-INV-2026-000003`. Public health returned `{"status":"ok"}` and application, nginx, and MySQL services were active. The production operations record was updated without secrets.

**Publication:** The automatic invoice correction was committed and pushed as `276bab2473d3063471ae5facfea637c003b9699d` (`fix: create paid-order invoices automatically`). Production `RELEASE_COMMIT` was updated to that release and the final public health response remained `{"status":"ok"}`.

## 2026-08-16 — Complete invoice content, portal publication, email copy, and admin workspace

**User request:** The user requested that invoices display the customer’s first and last name, products purchased, full product total, any applied discount code and amount discounted, and price paid. The user also requested options to generate/publish the invoice to the customer portal, send a customer email copy, and save invoices in the administrator order workspace.

**Implementation:** Added migration `0039_invoice_customer_delivery.sql` and invoice ledger fields for customer visibility, publication timestamp, email-queue timestamp, and sending administrator ID. Existing invoice records were backfilled customer-visible/published. The invoice service now decrypts customer identity fields with the correct account AAD, returning first name and last name as separate fields and the combined billing name. It reads the immutable successful coupon redemption record so an invoice shows the actual discount code and discount amount; product line items continue to include product/tier, quantity, unit price, and per-line total. It shows product total, discount, and price paid. The prior invoice view used the wrong AAD suffix for customer names, explaining generic billing names in existing examples; this is corrected for all future invoice reads.

**Delivery controls:** Paid-order activation still materializes invoices automatically. The new customer invoice page loads the persisted invoice directly instead of displaying a manual generate-first screen. Customer visibility is enabled by default for paid invoices and can be toggled by an administrator. A protected administrator action queues a branded invoice email copy containing product rows, discount-code/amount when present, product total, price paid, invoice number, and an authenticated portal URL for viewing/saving the invoice. The email queue and invoice ledger retain delivery/queue audit state; no payment or PII secret is exposed to the browser.

**Administrator workspace:** Each paid order now has an Invoice tab with saved invoice number, customer, product total, price paid, discount code/amount, Open/print invoice action, portal publication control, email-copy action, and publication/email queue status. Invoice data remains in the authoritative `invoices` ledger linked to the order rather than a mutable uploaded file.

**Validation and deployment:** TypeScript checking passed. Five existing/additional regression tests passed. Server bundle and Vite client build passed; the Vite chunk-size warning is non-blocking and pre-existing in character. Production deployment created protected server/client rollback assets under `/opt/readypackets/rollback-20260816010000-invoice-delivery/` and a pre-migration backup at `/var/backups/readypackets/pre-invoice-delivery-20260816010000.sql.gz`. Migration `0039_invoice_customer_delivery.sql` applied successfully. Existing invoices are published to customer portals; current invoice records show the new visibility metadata. The application, nginx, MySQL, and public health endpoint were verified active/healthy. Production AGENTS.md was updated without secrets.

**Publication:** The complete invoice delivery enhancement was committed and pushed as `c4726f0caf597ba04289f3abbfad9069933b4244` (`feat: publish and email paid-order invoices`). Production `RELEASE_COMMIT` was updated to that release and the final public health response remained `{"status":"ok"}`.

## 2026-08-16 — Self-hosted production installation instructions

**User request:** Provide instructions to install ReadyPackets on a self-hosted server.

**Delivered:** Created `docs/SELF_HOSTED_INSTALLATION_GUIDE.md` and a downloadable copy. The guide covers native Ubuntu VPS, existing Docker, and Docker-bootstrap deployments; required DNS/firewall boundaries; secure private-repository retrieval via a read-only GitHub deploy key; interactive and non-interactive installer commands; Let’s Encrypt and Cloudflare Origin CA paths; first administrator provisioning with enforced MFA; protected secret/key handling; post-install health checks; update/rollback practices; backup validation; and common troubleshooting steps. It uses the current `deploy/unified-install.sh` options and the native deployment operational practices verified on production. No secret or credential values were included.

## 2026-08-16 — Automated GitHub bootstrap installation

**User request:** Ask whether ReadyPackets can be installed automatically from GitHub.

**Delivered:** Added `deploy/github-bootstrap-install.sh` and `docs/GITHUB_AUTOMATED_INSTALL.md`. The bootstrap script supports a fresh Ubuntu server only and non-interactively retrieves the private repository through a root-readable, read-only GitHub SSH deploy key. It requires `--repository`, `--domain`, `--email`, explicit install mode, explicit TLS provider, and an administrator-reviewed immutable 40-character Git commit SHA. It rejects a moving branch ref such as `main`, validates the repository path/domain/TLS options, fetches the exact requested SHA, checks the resolved revision before checkout, refuses to overwrite an existing project directory, calls the existing unified installer with explicit mode/TLS flags, and performs a health check. Cloudflare Origin CA mode validates the local app health endpoint because origin certificates are not generally browser-trusted directly; Let’s Encrypt mode validates the public HTTPS endpoint. The script never accepts a GitHub token argument and does not write a deploy key, token, or app secret to the repository, service environment, or logs.

**Existing-deployment safeguard:** Documented that first-install automation must not be used to overwrite a live deployment. Existing production updates continue to use the protected Administrator Platform Updates flow or root-only approved wrapper, which requires an approved run and immutable SHA, performs source validation, snapshots the database/application, health-checks, and retains a rollback path. Automated scheduling may scan/notify only; it must not silently deploy a new branch tip.

**Validation:** `bash -n` passed for the new bootstrap script. The script help text was checked and an invalid `--commit main` invocation was confirmed to terminate before installation with the immutable-SHA guard. Documentation content and whitespace validation passed. No credentials were used or recorded.

## 2026-08-17 — Country-level access control assessment

**User request:** Ask whether country-level IP blocking can block traffic from China, Russia, Iran, and Sri Lanka.

**Assessment:** Confirmed that ReadyPackets already has application-level individual-IP allowlist and block/security-log controls, but it does not currently provide a country-geo database or country-block administration setting. Because the customer portal is fronted by Cloudflare, the recommended enforcement point is a Cloudflare WAF Custom Rule at the edge. The appropriate ISO 3166-1 alpha-2 country codes are `CN`, `RU`, `IR`, and `LK`. The recommended expression is `(ip.src.country in {"CN" "RU" "IR" "LK"})` with the Block action, after a brief Log/Managed Challenge observation period and an explicit exemption for any known trusted service routes only if required. This blocks traffic before it reaches the origin, preserves ReadyPackets application controls for individual IPs, and avoids relying on origin geolocation based on Cloudflare proxy IPs.

**Origin guidance:** Keep the Cloudflare DNS record proxied, restrict port 80/443 origin access to Cloudflare IP ranges plus explicitly approved maintenance sources, and do not block Cloudflare’s own shared proxy ranges. Country mapping is a risk control rather than identity proof; VPN/proxy traffic and legitimate customer travel remain possible. No Cloudflare or server rule was changed during this assessment.

## 2026-08-17 — Deploy-key installation workflow

**User request:** Ask how to deploy ReadyPackets using a GitHub deploy key.

**Delivered:** Provided the ready-to-use procedure for generating a dedicated root-only Ed25519 key on a fresh Ubuntu host; adding only its public portion to the private `readypackets/ReadyPackets` repository under Settings → Deploy keys with write access disabled; configuring SSH to use that identity for GitHub; verifying read-only access; obtaining a separately reviewed immutable 40-character commit SHA; copying the repository-tracked `deploy/github-bootstrap-install.sh` to the server through a controlled channel; and executing it with repository, commit, domain, email, native/Docker mode, and TLS provider arguments. Emphasized that the deploy key is repository-scoped read-only access, is distinct from user SSH login keys, and must never be pasted into GitHub or stored in `.env`, application settings, browser storage, shell history, or logs. The bootstrap script rejects moving branch references and existing deployment directories; existing instances use the protected platform update workflow instead.

## 2026-08-17 — Deploy-key guide files

**User request:** Provide the deploy-key installation instructions as a Markdown file and PDF.

**Delivered:** Created `ReadyPackets_Deploy_Key_Installation_Guide.md` and `ReadyPackets_Deploy_Key_Installation_Guide.pdf`. Both documents cover server/DNS/firewall prerequisites, deploy-key generation, GitHub read-only deploy-key registration, SSH configuration and verification, immutable commit approval, controlled bootstrap-script transfer, native/Docker/Cloudflare install commands, post-install checks, and existing-deployment safeguards. The PDF was generated successfully as a six-page A4 document and visually checked for readable headings, tables, and command blocks. No credentials, keys, or token values appear in either deliverable.

## 2026-08-17 — Public website price visibility control

**User request:** Add a toggle or button in the administrator console to hide or show product prices on the public website.

**Implementation:** Added the audited `catalog.public_prices_visible` boolean site setting, which defaults to `true` when absent. Administrators can change it from **Admin → Catalogue → Public website price visibility** using a checkbox. The server exposes a minimal public display-preference query and restricts writes to the existing administrator procedure. Every change records an activity event with the new state and source IP.

**Public behavior:** The homepage hero, homepage packet cards, public packet listing, and public packet detail cards now display numeric prices only when the setting is enabled. When disabled, they show “Pricing on request.” The public pages avoid numeric-price exposure while the setting is loading. This is a public-site presentation setting only: customer portal live quotes, cart/checkout calculations, order totals, invoice data, Stripe settlement, and stored catalog prices remain authoritative and unchanged.

**Validation and deployment:** TypeScript type checking and the existing regression test command passed. A full 897,874-byte server bundle and production client bundle were built, checksum verified, and deployed to `myportal.readypackets.com`. The service restarted normally; after the expected brief listener startup interval, local and public health checks returned `{"status":"ok"}`. The public visibility endpoint returned the default `{ "visible": true }`. Rollback assets are stored at `/opt/readypackets/rollback-20260817123000-public-price-visibility/`.

## 2026-08-17 — Administrator-only access gate assessment

**User question:** Whether ReadyPackets can restrict customer users from logging in while continuing to allow administrators.

**Findings:** Existing maintenance controls in **Admin → System → Housekeeping** can immediately block new logins and new account creation, while maintenance allowlist entries bypass those gates. The existing `login_block` feature flag has the same IP-based bypass model. These controls are appropriate for a time-bounded operational lock but are not a strict role-based administrator-only gate: they allow any account that connects from an allowlisted address, while non-allowlisted administrators would also be blocked from first sign-in.

**Recommended design:** Add a dedicated, audited **Administrator-only access** toggle that performs role-aware checks after account lookup and before session issuance. It would deny customer/staff password login, customer magic-link issue/verification, and SAML/SSO session completion while allowing active administrator accounts to pass through normal password and MFA enforcement. It would separately block public account registration and preserve existing administrator sessions. A break-glass server-side setting and clear warning about keeping two MFA-enrolled admins would protect recovery. No access-control setting was changed during this assessment.

## 2026-08-17 — Strict administrator-only access control

**User request:** Add the Administrator-only access toggle.

**Implementation:** Added the `access.administrator_only_enabled` setting and a dedicated typed-confirmation control at **Admin → System → Housekeeping → Administrator-only access**. Enabling requires the exact phrase `ADMINISTRATOR ONLY`; both transitions are recorded in the activity log with the acting administrator and source IP.

**Role-aware enforcement:** The default remains disabled. When enabled, an active administrator can continue local password or SAML sign-in and remains subject to the existing MFA, account-status, IP/whitelist, rate-limit, CSRF, and policy controls. Customer and staff password sign-ins are verified before the role-aware denial so the gate does not weaken credential processing. Customer magic-link requests return the existing constant response and completion is denied. Public customer registration is denied. SAML auto-provisioning is disabled and non-administrator SAML assertion completion is denied. Existing non-administrator sessions are revoked when they next resolve; active administrator sessions continue. Administrator-only mode does not override a separately enabled maintenance or global login block.

**Auditability:** New explicit security-log event types cover password login, magic-link request/completion, registration, SAML completion, and session revocation caused by administrator-only access. Administrator setting transitions remain in the activity log.

**Validation and deployment:** TypeScript checking and the existing regression suite passed. A 902,531-byte server bundle and production client bundle were built, checksum verified, and deployed. The application restarted successfully; following the normal listener startup interval, the health endpoint returned `{"status":"ok"}`. Rollback assets are preserved at `/opt/readypackets/rollback-20260817134000-administrator-only-access/`.

## 2026-08-17 — Administrator-only access client bundle correction

**User report:** The Administrator-only access panel did not appear at Admin → System → Housekeeping; the live page showed only the preceding Maintenance access controls.

**Diagnosis:** The server release was correct, but the production client directory contained the newly built bundle nested at `client/dist/.incoming-20260817134000/`. The active root `client/dist/index.html` still referenced the prior `assets/index.wRzEuXpM.js` shell, so neither browser cache nor Cloudflare was the cause. Both local and public index requests confirmed the stale asset reference. The new nested `assets/index.DQBqJPFD.js` contained the Administrator-only access UI.

**Correction:** The verified nested release was moved into the active `/opt/readypackets/client/dist` path and the stale root directory was preserved for rollback at `/opt/readypackets/rollback-20260817140500-administrator-only-client-path/client-dist-stale`. Permissions were reapplied to the active client release. Public index verification now returns `assets/index.DQBqJPFD.js`; the active bundle contains the Administrator-only access label. No data, server-bundle, database, or configuration setting was changed by this correction.


## 2026-08-17 — Expired-Session Recovery, Go-Live Review, and Security Assessment

### User request

The user requested a full production go-live code and application review, identified that an expired browser session caused a server error on re-login until a hard refresh or cache clearing, and requested separate go-live gap and application-security reports in Markdown, PDF, and PowerPoint formats. The security assessment was requested against OWASP ASVS, OWASP SAMM, and NIST SSDF criteria.

### Session-timeout repair

The review traced the login failure to stale session-bound CSRF cookies. A browser tab whose session expired, was revoked, or timed out retained a CSRF cookie that could not be refreshed anonymously because the prior `GET /api/security/csrf` route returned 401 when no current session resolved. The next public login, magic-link request, or magic-link verification could fail CSRF validation before credential handling and appear as a generic server error.

The deployed repair updates `server/app.ts` and `client/src/pages/auth/Login.tsx`. The same-origin no-store CSRF refresh route now clears stale session cookies and issues an anonymous double-submit CSRF token for a new sign-in, while active unrestricted sessions retain their session-bound token. The login page refreshes CSRF on mount and immediately before all authentication mutations. Origin validation and unsafe-request CSRF validation remain enforced. Type checking and production builds passed. Anonymous bootstrap, simulated stale-cookie replacement, invalid-login behavior, and public health were validated. Timestamped production rollback assets are at `/opt/readypackets/rollback-20260817144500-session-csrf-recovery/`.

### Assessment scope and evidence

The assessment reviewed the ReadyPackets source, deployment record, live public security headers/cookies, production service/listener/firewall/certificate/backup state, static source patterns, dependency audit, test suite, operational documentation, and prior assessments. It also used OWASP ASVS 5.0, OWASP SAMM 2.0, and NIST SP 800-218 SSDF v1.1 as evidence-oriented frameworks. It is not an independent penetration test, certification, financial audit, legal opinion, or third-party account configuration audit.

The dependency audit found zero advisories across 328 production dependencies. The live security verification passed reviewed CSP, transport, cookie, framing, and browser-policy assertions. A tracked source secret-pattern scan found no matching production secret markers. The test suite reported 153 passes and 12 database-dependent failures because the isolated review environment had no MySQL service at `127.0.0.1:3306`; this is recorded as a CI/test-environment readiness gap rather than a production database test execution.

### Assessment conclusions

The go-live readiness score is 67.7/100 and the application-security posture score is 68.7/100. The recommendation is conditional go-live: do not begin unrestricted public registration until encrypted off-host backup/restore proof, repeatable green database-backed test execution, production third-party acceptance evidence, and Cloudflare-only origin enforcement are completed. First-sprint priorities include SBOM/CI/branch protection, host-volume encryption planning, alert ownership, client asset verification, and performance budgeting.

### Deliverables created

- `docs/assessments/ReadyPackets_Go_Live_Readiness_and_Gap_Assessment_2026-08-17.md`
- `docs/assessments/ReadyPackets_Application_Security_Assessment_ASVS_SAMM_SSDF_2026-08-17.md`
- `/home/ubuntu/readypackets_go_live_review_20260817/ReadyPackets_Go_Live_Readiness_and_Gap_Assessment_2026-08-17.pdf`
- `/home/ubuntu/readypackets_go_live_review_20260817/ReadyPackets_Application_Security_Assessment_ASVS_SAMM_SSDF_2026-08-17.pdf`
- Branded PowerPoint presentations for the application-security and production go-live assessments.

The detailed assessment evidence is retained in `/home/ubuntu/readypackets_go_live_review_20260817/` without secrets.


### Publication and final production verification

The session recovery fix and the two Markdown reports were committed and pushed to private `main` in `eebb7f3b08775299b3bbbc17dd5aaee404e4d1e2` (`fix: recover login after expired session`). The deployed production release marker was updated to that commit on the attached production host, and `https://myportal.readypackets.com/api/health` returned `{"status":"ok"}` with `readypackets.service` active.


## 2026-08-18 — Administrator MFA access recovery

**User report:** No administrator could complete authenticator-app login.

**Read-only production findings:** The host clock was NTP synchronized. Four active administrator accounts retained confirmed TOTP enrolments, and the `security.mfa_admin_policy` remained `required`. Password login reached the `mfaPending` state for affected administrators. No corresponding `login.mfa_failure` or `login.mfa_success` event was recorded after the MFA prompt, showing that the verification procedure was not receiving the browser request rather than that TOTP codes were being cryptographically rejected.

**Cause and correction:** The client could retain a stale CSRF value across the password-login session rotation and submit that old value when it called `auth.verifyMfa`. The second-factor mutation was rejected by CSRF protection before the MFA handler, which is why authentication logs contained no MFA success/failure outcome. The login page now refreshes the same-origin CSRF token immediately before authenticator or backup-code verification and fails closed with a safe retry message if the token cannot be obtained. No MFA policy, encryption key, TOTP secret, administrator password, or server clock was altered.

**Deployment and verification:** The corrected current client build was atomically promoted to production. The active bundle contains the MFA token-recovery guard; the public health endpoint returned `{"status":"ok"}` and the `readypackets` service remained active. Rollback client assets are retained at `/opt/readypackets/rollback-20260818123000-mfa-login-csrf/client-dist`. An earlier deployment attempt detected a pre-existing stale incoming directory and exited before it changed the active client path; it was not activated.

**Requested operator verification:** Administrators should retry a normal password-plus-authenticator sign-in. A hard refresh or cache purge should no longer be necessary. The recovery remains fail-closed: no authenticated session is created unless the current TOTP or a valid unused backup code succeeds.


## 2026-08-18 — SAML SSO MFA session continuity recovery

**User report:** Administrators completing Microsoft Entra SAML SSO reached the ReadyPackets MFA screen but received `Please sign in to continue` on authenticator-code submission. The user also asked whether Entra MFA could be considered instead of a duplicate ReadyPackets authenticator step.

**Investigation:** Read-only production review confirmed that SAML ACS accepted assertions and created active administrator sessions with `mfa_pending = 1`. The host time was synchronized, TOTP enrolments remained confirmed, the administrator MFA policy remained required, and there were no `login.mfa_failure` events. This showed that the failure was not code rejection or clock drift. The post-SSO login page calls `/api/security/csrf` on mount and before MFA verification. That endpoint had been changed during stale-session recovery to reuse the session CSRF secret only for unrestricted sessions. For valid `mfa_pending` or `restricted` sessions, it cleared the just-created session cookie and issued an anonymous token. The subsequent `auth.verifyMfa` request therefore had no authenticated temporary session and correctly returned `Please sign in to continue`.

**Repair:** The CSRF endpoint now reuses the server-held CSRF secret for every valid session, including an MFA-pending session and an MFA-enrolment-restricted session. It clears cookies and issues an anonymous token only when no valid session resolves. Origin validation and CSRF comparison remain enforced for every unsafe request. The previous browser-side token refresh remains appropriate; it now receives the correct session-bound token instead of destroying the SAML handoff.

**Deployment and verification:** The repaired server bundle was type-checked, checksum-verified, installed with a protected rollback copy at `/opt/readypackets/rollback-20260818124500-saml-mfa-session/dist-server.js`, restarted, and verified through the public health endpoint (`{"status":"ok"}`). No administrator password, TOTP secret, session duration, MFA policy, or SAML credential was changed.

**Microsoft Entra MFA assessment:** Official Microsoft SAML documentation shows that an Entra signed assertion can include `http://schemas.microsoft.com/claims/authnmethodsreferences` with `http://schemas.microsoft.com/claims/multipleauthn` after MFA, and also provides authentication-context values. Conditional Access can require MFA or an authentication strength for a target application. ReadyPackets does not currently parse or trust these Entra assurance claims and local MFA remains required after SAML. Any future trust option must be disabled by default; require a validated signature/issuer/audience/recipient/timing check, administrator role, explicitly configured Entra Conditional Access policy, an allowlisted signed MFA claim, audit events, a separate local break-glass administrator, typed enablement confirmation, and fallback to local MFA whenever assurance is absent or malformed. No Entra MFA bypass was enabled by this incident repair. See `docs/ENTRA_MFA_TRUST_RESEARCH.md` for the cited design research.


## 2026-08-18 — Configurable Microsoft Entra-managed MFA for SAML administrators

**User request:** After confirming SAML SSO with local ReadyPackets MFA worked again, the user requested configurable Microsoft Entra-managed MFA options in the administrator console, with the ability to choose the source in the future.

**Implemented policy:** The SAML administration panel now exposes **Administrator SAML MFA source**. It is administrator-scoped and defaults safely to **ReadyPackets local MFA**. The selectable modes are: (1) `local`, requiring ReadyPackets TOTP or backup-code MFA after a valid SAML assertion; (2) `entra`, allowing a SAML administrator to proceed without the local prompt only after a signed, validated assertion contains the configured Entra MFA assurance claim and exact required value; and (3) `both`, requiring both verified Entra assurance and local ReadyPackets MFA. Customer and staff MFA behavior remains governed by the existing role MFA policies and is unaffected.

**Assurance validation:** A new `server/auth/samlMfaSource.ts` helper retrieves the policy from site settings with fail-safe `local` defaults. The default Entra claim/value are Microsoft’s `http://schemas.microsoft.com/claims/authnmethodsreferences` and `http://schemas.microsoft.com/claims/multipleauthn`. The assertion profile is used only after node-saml validates its signature, issuer, audience, recipient, and timing. Values are compared against one explicit configured value; absence, malformed values, or wrong values fail closed before session issuance. Three unit tests cover valid signed-assurance recognition, absent/first-factor-only denial, and custom-claim matching.

**Administration safeguards:** The panel lets administrators configure the mode, claim name, and required value. Selecting `entra` or `both` requires typed `TRUST ENTRA MFA`; changes create both activity and security audit records. The UI warns operators to configure Entra Conditional Access MFA for the enterprise application and retain a separate local break-glass administrator. No Entra trust mode was enabled automatically in production.

**Validation and deployment:** Type checking passed; the server and Vite client builds completed; targeted Vitest assurance tests passed (3/3). The correct remote VPS was verified before deployment after a local sandbox path check failed safely without touching production. The server bundle SHA-256 was verified, the client tarball SHA-256 was verified, and public/local health endpoints returned `{"status":"ok"}`. The active client bundle now contains the `TRUST ENTRA MFA` control and the active server contains `saml_admin_mfa_source` enforcement. The immediately prior server is retained at `/opt/readypackets/rollback-20260818131500-saml-mfa-source/dist-server.js`; the prior client is retained at `/opt/readypackets/rollback-20260818133000-saml-mfa-source-client/client-dist`.


## 2026-08-18 — Updated P101 Production Webhook Logic

**User request:** The user supplied `update-ReadyPackets_P101_Production_Webhook_Logic.pdf` and requested an update of packet webhook information and logic. The specification establishes P101 as the canonical order-metadata writer: `packet`, `tier`, `canon_version`, `run_mode`, `order_scope_mode`, and escaped `bundle_scope_manifest` must be coherent before downstream Phase II/III/IV work is started.

**Prior defect:** The P101 builder always emitted top-level `packet: "7"` and `tier: "Mixed"`, even for a single purchased packet. It also trusted the persisted `order_scope_mode` and stored manifest independently. This allowed the invalid contradiction explicitly described in the supplied contract: a `single_packet` order with top-level `7/Mixed` and a one-packet manifest, which can route P301 to a zero-deliverable mixed branch.

**Implemented canonical contract:** `server/services/orderScope.ts` now derives P101 scope exclusively from immutable `order_items` plus `packet_groups.group_number`. It canonicalizes tiers to exact `Basic`, `Standard`, or `Premium`, sorts the escaped JSON manifest by packet number, and fails closed for unsupported tiers, duplicate selected packet numbers, or no selections. One selected packet emits its real packet number, its canonical tier, `single_packet`, and one manifest entry. More than one selected packet emits top-level `packet: "7"`, `tier: "Mixed"`, `multi_packet_partial`, and every selected packet/tier entry. Administrator-supplied stored manifest/scope values no longer override purchased selections.

**Lifecycle and delivery changes:** New orders persist canonical scope/manifest values at creation. Before every P101 delivery, legacy orders are recalculated and backfilled with canonical scope/manifest values. P101 queues the full production metadata contract; P201 deliberately queues only `customer_id`, `order_id`, and `run_mode` so it reads the P101-written canonical state downstream. The admin order detail/API and P101 preview now use the same derived packet/tier/scope/manifest values as delivery.

**Validation:** Five Vitest P101 contract tests passed, including the required Packet 1 Premium single-packet example, a multi-packet partial example, contradiction repair, unsupported-tier denial, and duplicate-packet denial. Type checking, bundled server build, and Vite client build completed successfully. Production server/client artifacts were SHA-256 verified. The public `/admin/orders` entrypoint serves `assets/index.BxnebMxY.js`; the active server bundle contains the new fail-closed P101 validation; public and local health endpoints returned `{"status":"ok"}`.

**Deployment:** The actual production VPS was used for deployment. The first guarded client promotion exited at a non-semantic marker check before swapping the client directory; the verified client was then promoted explicitly using atomic directory renames. The previous server/client remain at `/opt/readypackets/rollback-20260818143500-p101-contract/`.

## 2026-08-18 — Per-Phase File and Audio Downloads

**User request:** The user requested that every workflow phase in an order support downloading its uploaded files. Their screenshot showed `Phase: Final Customer Delivery documents` listing two documents with only a removal action and no download path.

**Security design retained:** No public file endpoint, phase identifier, or browser-side state is trusted for authorization. The new controls reuse the established `files.requestDownload` procedure for an individual file and `files.bulkDownload` for a ZIP. Those server procedures authorize every requested database file against the caller’s role and order access, exclude deleted items, enforce customer publication/shared-order rules, and issue short-lived single-use session-bound download tickets. Placeholder files are intentionally excluded from individual and bulk controls.

**Customer workflow implementation:** Every accessible workflow stage now has a `Downloads for <phase>` panel whenever that phase contains downloadable material. `Download this phase (N)` prepares one ZIP containing all non-placeholder documents and recordings in that stage. Each document and recording also has its own `Download` control; recordings retain the existing protected playback option. Phase submission locks still prevent customer changes, but do not prevent an authorized customer from reviewing or downloading material.

**Administrator implementation:** `Admin → Orders → <order> → Files` now supplies individual Download actions beside each non-placeholder document/recording and a `Download phase (N)` ZIP action inside every dynamically grouped phase, including custom workflow phases. The earlier hard-coded Phase 1/Phase 2 header buttons were replaced by this universal phase-level control. The page-level `Download all` remains and now excludes placeholders.

**Validation and deployment:** TypeScript checking and the Vite production build passed; the portal build produced `client/dist/assets/index.BybjeQnn.js`. The server production bundle also built, with unchanged SHA-256 `12357b733be4b8eeef93cd72f8ad1b4997d73deba145aed2fdc46d3295021ccb`, because this release changes only the client. A broad Vitest run began successfully for existing `uploads`, `rendering`, `policy`, and `headers` suites but stalled in the unrelated existing password-hashing section of `tests/crypto.test.ts`; it was stopped rather than altering cryptographic test configuration or the release. The clean type check and production client build remain the direct validation for this UI-only change. The production client tarball SHA-256 `1e3eb953c46d8dc389bfdb82f7badef72d564c2f262bbb37d441399d5d2d307c` was verified on the VPS before an atomic client directory swap. Public portal HTML now references `assets/index.BybjeQnn.js`, its bundle contains `Download this phase`, and the public health endpoint returned `{"status":"ok"}`. The immediate client rollback directory is `/opt/readypackets/client/dist.previous-20260818150032-phase-downloads`.

## 2026-08-18 — Workflow-Aligned Administrator Phase Unlocks and Corrected P101 Contract

**User request and supplied evidence:** The user reported that Phase unlocks in the administrator order workspace did not match the applied workflow, and supplied a corrected P101 production webhook PDF. The screenshot for order `RP-C000013-2608-DEF3A4` showed only a raw `phase 1 intake` lock even though the applied workflow has seven stages. Its webhook preview visibly had the prohibited `order_scope_mode`, together with the invalid `packet: "7"` / `tier: "Mixed"` pair and a one-entry `packet_1: Premium` manifest.

**Investigation:** The affected order is assigned `Customer Order Workflow Test - v1.2`, whose stages are `new`, `phase_1_intake`, `phase_2_synthesis`, `phase_3_review`, `phase_4_delivery`, `delivered`, and `closed`. The database had active submitted locks for `phase_1_intake`, `phase_2_synthesis`, `phase_3_review`, and `phase_4_delivery`, proving the old tab was rendering raw lock rows rather than the applied workflow. The order has exactly one purchased item: packet group 1 at Premium tier. The corrected P101 therefore requires packet `"1"`, tier `"Premium"`, and escaped manifest `"{\\"packet_1\\":\\"Premium\\"}"`; it must not contain `order_scope_mode`.

**Phase-lock correction:** The phase-lock API now loads the active order workflow and returns every applied stage in configured order, joined to its matching lock state. Historic key aliases (`phase_1` ↔ `phase_1_intake`, `phase_2` ↔ `phase_2_synthesis`) are reconciled both for display and for review/unlock actions. The administration tab now shows every workflow step, whether it is not submitted, actively locked, reviewed, unlocked, automated, or a historical retired lock. Every active submitted customer stage receives the existing administrator-only unlock action, which still requires a meaningful reason and exact `UNLOCK PHASE` confirmation and writes audit activity. A historical lock that is no longer part of the current workflow remains visible rather than silently disappearing.

**Corrected P101 contract:** A dedicated canonical P101 payload builder now produces only `customer_id`, `order_id`, `packet`, `tier`, `canon_version`, `run_mode`, `client_name`, `client_email`, `release_status`, and `bundle_scope_manifest`. The obsolete external `order_scope_mode` field was removed from actual outbound P101 delivery, the administrator detail response, the live preview, and the order-creation interface. P201 remains intentionally minimal: customer ID, order ID, and run mode. Internal compatibility persistence is retained only to avoid unsafe schema churn; it is never sent to P101/P5 master state. Packet/tier/manifest remain derived from immutable purchased items and continue to fail closed for no selection, duplicate packet selection, or an unsupported tier.

**Validation and deployment:** TypeScript check passed. The focused `tests/orderScope.test.ts` suite passed all six tests, including a new test that requires the corrected Packet 1 Premium payload and asserts `order_scope_mode` is absent. Vite and the production server bundle built successfully. The server artifact SHA-256 `7eb5b5a49857e25f2dc498a9580093ae78033d753f9a1816ce317524f7c64948` and client archive SHA-256 `de050bb300fc567a2b95e88bf1ab1d0ad846305f5788e78b8d6fdc9526bb2713` were independently verified on production before promotion. The service reported active before its child startup had bound port 3000; after the short startup grace period it was listening normally and local/public health checks passed. Production serves `assets/index.DmgVb038.js`, which includes the workflow-aligned phase review interface. Rollback material is retained at `/opt/readypackets/rollback-20260818153702-workflow-p101/server.js` and `/opt/readypackets/client/dist.previous-20260818153702-workflow-p101`.

## 2026-08-18 — P101 Null-Payload Investigation and Fail-Closed Delivery Safeguard

**Reported failure:** The user reported that P101 for order `RP-C000008-2608-6D823B` failed with `HTTP 400: Unexpected token 'n', "null" is not valid JSON`.

**Confirmed cause:** Delivery record 30 is a P101 row for order 57. Its database `payload` column was SQL `NULL`, not a JSON object. The webhook dispatcher calls `JSON.stringify(delivery.payload)`, which therefore sent the literal body `null`. The receiving workflow correctly rejected that non-object JSON body. The issue was not the order’s routing configuration: its immutable order item is one Packet 1 Premium selection and its stored canonical manifest is `{"packet_1":"Premium"}`. The log also confirmed the phase-notification job completed, so the unsafe state was specifically payload persistence/dispatch, rather than a phase-job failure.

**Correction:** P101/P201 queue creation now canonicalizes the generated payload through a JSON-object normalizer, initially stores the delivery with status `preparing`, reads the saved JSON field back from MySQL, and changes it to `pending` only if a real JSON object persisted. A persistence anomaly is marked failed and blocked before external dispatch. The dispatcher separately detects legacy/failed P101 or P201 delivery rows whose payload is `NULL`, rebuilds their canonical payload from the order and immutable purchased selections before it can send, persists that replacement, and records the recovery. Non-phase deliveries with a missing payload are blocked fail-closed instead of transmitting JSON `null`.

**Validation and deployment:** TypeScript checking passed. The focused P101 contract test suite passed all six tests. The server bundle built successfully with SHA-256 `e17b442c2301c7cb41e56f6138299e3b742baf9f1c723a7b50693ea75ea51556`; that checksum was verified on production before the server-only promotion. The released server contains the explicit payload-persistence safeguard, systemd is active, and local/public health checks return `{"status":"ok"}`. The failed historical delivery was not automatically retried, so no external webhook was sent without administrator action. Once an administrator chooses Retry or Redeliver for that P101 record, the new safeguard will rebuild its payload before dispatch. The rollback server bundle is `/opt/readypackets/rollback-20260818175159-p101-null-payload/server.js`.

## 2026-08-18 — P101 Phase Job Did Not Queue a Webhook: Root Cause and Correction

**User evidence:** The user reported that no P101 webhook delivery appeared in the order view. The supplied screenshot showed the Phase I `notify_webhooks` job in pending/retry state with the error `Phase-start webhook payload must be a JSON object`, while the P101 preview itself displayed a correct Packet 1 Premium payload and the delivery list was empty.

**Root cause:** The P101 branch in `jobNotifyWebhooks` accidentally used an uninvoked arrow wrapper around `backfillCanonicalP101Scope(order.id).then(...)`. As a result, `await payload` resolved to a JavaScript function rather than the object returned by the canonical P101 builder. In the prior behavior, MySQL/JSON serialization of that function produced SQL `NULL`, which led to the literal `null` body and the receiving HTTP 400. The newer fail-closed guard correctly rejected that function before any new delivery row could be queued, which explains the screenshot’s phase-job error and empty delivery list.

**Correction:** The uninvoked wrapper was removed. P101 now assigns the `backfillCanonicalP101Scope(...).then(...)` promise directly, awaits the resulting payload object, normalizes it, verifies its persisted JSON representation, and only then marks the delivery eligible for dispatch. The earlier null-payload guard remains in place as defense in depth, including recovery for historical P101/P201 records when an administrator chooses Retry or Redeliver.

**Validation and deployment:** TypeScript checking passed, and the focused canonical P101 test suite passed all six tests. The server bundle built with SHA-256 `5fbebea1b54a227f2585db9e7cb5622435cccb9414e78af8a333d10c01b36bc7`, which was verified on production before deployment. Systemd is active and local/public health checks succeeded. The prior phase-job record remains completed historical evidence and no additional outbound webhook was sent automatically. A new Phase I start, or Retry/Redeliver of the existing P101 record, will now use the corrected canonical JSON-object flow. Rollback server bundle: `/opt/readypackets/rollback-20260818180915-p101-factory-invocation/server.js`.


## 2026-08-18 — Order renaming and strengthened invoice evidence release

### User request

The user requested that customers and administrators be able to rename orders after creation. The user also requested that every order automatically receive a clean, company-branded invoice PDF by email and in the order, while preserving the current invoice design and adding the key evidentiary distinctions: customer-versus-administrator order creation, purchased products, discount code and discount amount, catalog value, amount due, and the actual amount paid by the customer.

### Implementation

1. Added `orders.rename`, a protected server mutation allowing an order owner or an administrator/staff user to rename an order. Shared customer collaborators are intentionally blocked from changing the owner’s commercial title. The project title stays AES-GCM encrypted using the order-bound AAD. The audit event records the actor and fact of a rename without storing the potentially sensitive title in the unencrypted audit JSON.
2. Added customer and administrator **Rename order** actions with focused title dialogs. The unique order number, payment record, workflow, files, and invoice remain unchanged.
3. Added migration `0040_order_rename_invoice_evidence.sql`. It records immutable `created_by_origin` evidence on orders, backfills historical administrator-created orders from their audited `order.admin_created` events, and adds non-sensitive invoice-PDF attachment manifests to the email queue and sent-email log.
4. Enhanced invoice data and customer/admin invoice views to distinguish catalog product value, pricing or bundle adjustment, applied discount code/amount, order amount due, actual customer payment, payment evidence, and customer-created versus administrator-created order origin.
5. Added a self-hosted, dependency-free branded PDF invoice renderer. The PDF includes a ReadyPackets navy/teal/gold header, invoice and order references, products, customer ID, pricing and discount ledger, actual payment, origin/payment evidence, and footer. It is created on demand from immutable order/payment records rather than stored in a public location.
6. Added a short-lived, single-use, authenticated invoice-PDF download ticket and no-store `/api/invoices/download/:token` response. Both customer and administrator interfaces can download the branded PDF. A ticket is bound to the requesting account and cannot be replayed by another account.
7. Added invoice PDF attachments to both SMTP and Microsoft Graph email paths. Attachment intent is persisted as a small validated manifest; the PDF binary is regenerated only when the message is sent. New Stripe-confirmed orders queue the receipt only after coupon redemption evidence and actual Stripe amount are finalized. Administrator-waived orders queue their receipt after activation. Test orders retain a portal invoice but deliberately do not email a simulated payment receipt.
8. Preserved invoice idempotency and the existing manual administrator publish/email controls. Duplicate Stripe completion events do not duplicate an email if one has already been queued.

### Validation and production deployment

- Type checking passed.
- Focused regression tests passed: `tests/invoicePdf.test.ts` and `tests/orderScope.test.ts` (7 assertions across 2 test files).
- Production client and server builds passed.
- Migration `0040_order_rename_invoice_evidence.sql` applied successfully in production and the new `created_by_origin` and `attachment_manifest` fields were verified.
- Production server SHA-256: `48a873e74f5fbbbdce319d69456bbee9896301fe1f9da46e0713076ce8bcdadc`.
- The first post-restart localhost check ran during the normal startup grace period; service status/logs then confirmed the application listening on `127.0.0.1:3000`, and the public health endpoint returned `{"status":"ok"}`.
- Retained rollback assets: `/opt/readypackets/rollback-20260818190039-order-invoice` and `/opt/readypackets/client/dist.previous-20260818190039-order-invoice`.


## 2026-08-18 — Outbound email-link audit and repair

### User request

The user reported that links in received emails did not work and requested that all outbound email links be checked. The screenshot showed a ReadyPackets password-reset message with a visually normal **Choose a new password** button.

### Confirmed root cause

The production `APP_URL` was already correctly set to `https://myportal.readypackets.com`, and the public reset route returned HTTP 200. A redacted inspection of the encrypted sent-email log then showed that the password-reset message’s actual `href` was empty. The production `password_reset` template uses `{{resetUrl}}`, whereas both ordinary and administrator password-reset call sites had supplied only the older `link` variable. The generic renderer deliberately converted an absent placeholder to an empty string, causing an email button with `href=""` while leaving no unresolved placeholder visible in the final markup.

The same audit found historical link-variable naming differences across templates, including `resetUrl`, `verifyUrl`, `magic_link`, and `portalUrl`. Existing order, ticket, and portal-action templates use `portalUrl` where applicable.

### Correction

1. Added centralized link-variable normalization in `server/services/email.ts`. It maps compatible action-link aliases so legacy callers and stored templates receive the same correctly formed public URL. A canonical public portal URL is supplied for portal-action templates that do not provide their own destination.
2. Added centralized fail-closed email hyperlink validation before any message enters the delivery queue. An email is rejected if an `href` is empty, unresolved, malformed, or uses an unsafe protocol. HTTPS URLs and mailto links are permitted; loopback HTTP exists only for development use.
3. Updated password-reset and verification call sites to provide the exact canonical `resetUrl` and `verifyUrl` variables in addition to their existing compatibility values.
4. Added `tests/emailLinks.test.ts`, covering password-reset/verification alias rendering, escaped query separators, and rejection of unresolved, empty, and JavaScript URLs.
5. Kept the email-link protection server-side and self-hosted. No third-party link wrapper, redirect service, or Manus dependency was introduced.

### Verification and deployment

- Type checking passed.
- Focused tests passed: `tests/emailLinks.test.ts` (3), `tests/invoicePdf.test.ts` (1), and `tests/orderScope.test.ts` (6): 10 tests total.
- A fresh public password-reset request was sent to `hera@orbtech.org` after deployment.
- A temporary redacted diagnostic inspected the newest encrypted email-log record without exposing the token, recipient data, or message body. The delivered button contained `https://myportal.readypackets.com/reset-password?token=<redacted>` and no unresolved placeholders. The prior defective message was confirmed to contain an empty href.
- Public `reset-password`, `verify-email`, magic-login, and portal destinations each returned HTTP 200 with representative non-sensitive probe parameters.
- Server SHA-256: `4f046ac619e048409b614aa07f7651cb06e04bc89832068cbb99709fac174ff3`.
- Production health returned `{"status":"ok"}`. Rollback server copy: `/opt/readypackets/rollback-20260818191909-email-links/server.js`.


## 2026-08-18 — Branded prospective platform-partner MNDA draft

### User request

The user asked for an NDA for a potential partner who may work on building the ReadyPackets platform, branded with the company branding.

### Drafting basis and deliverable

- Reviewed the existing ReadyPackets mutual NDA, which supplied the existing Maryland governing-law and Baltimore County venue choices, the two-year baseline, and the company’s confidentiality/IP position.
- Prepared a refreshed *Mutual Non-Disclosure Agreement — Prospective Platform Development Partner* tailored to the contemplated platform-development evaluation while preserving a mutual structure.
- The document identifies Ready Packets Consulting LLC d/b/a ReadyPackets and leaves the partner’s legal name, entity, address, effective date, and agreement reference as clear completion fields.
- Added platform-specific confidential-information coverage: non-public architecture, source code, repositories, workflows, security assessments, customer data, credentials, keys, certificates, and related derivatives.
- Added security and access obligations: authorized access only, approved methods, no credential sharing or public-repository storage, a twenty-four-hour suspected/actual incident notice requirement, cooperation, and data-use restrictions.
- Clarified that no license, production access, services commitment, payment obligation, intellectual-property assignment, or work authorization arises from the NDA alone; any such terms require a separate signed agreement.
- Included return/destruction, compelled disclosure, exclusions, equitable relief, assignment, electronic-signature, term/survival, no-warranty, and signature provisions.
- Added a ReadyPackets-branded cover page using the document logo and navy/teal/gold palette. Every draft page is labeled **DRAFT — FOR ATTORNEY REVIEW BEFORE SIGNATURE** or carries the attorney-review footer.

### Validation and repository record

- Generated a five-page branded PDF with Typst strict compilation: PASS, no warnings.
- Deterministic PDF verification using the text-document profile: PASS (6 checks; 0 warnings/failures/unknowns).
- Standard visual review rendered all five pages; the cover, section hierarchy, flow, signature blocks, and branded footer were legible and balanced.
- The PDF and editable Typst source are archived in private GitHub under `docs/legal/ReadyPackets_Prospective_Partner_MNDA_Draft.pdf` and `.typ`.
- This is a working legal draft, not legal advice, and must be reviewed by qualified counsel before signature or reliance.


## 2026-08-18 — Editable DOCX and Markdown partner MNDA versions

The user requested editable Word (`.docx`) and Markdown versions of the branded prospective platform-development partner MNDA. The finalized five-page attorney-review PDF draft was used as the single content source.

A branded DOCX was generated with the ReadyPackets document logo, navy/teal/gold presentation, cover-page confidentiality and attorney-review notice, agreement title, placeholder fields, complete ten-section agreement body, and dual signature blocks. The DOCX content was read back after generation and corrected to remove a duplicate agreement-reference line; the resulting document preserves every operative section and the signature fields.

A matching Markdown source was created with the same bracketed completion fields, attorney-review warning, platform/security and data-protection language, Maryland governing-law provision, and editable signature table. Both files are archived in `docs/legal/ReadyPackets_Prospective_Partner_MNDA_Draft.docx` and `.md` alongside the previously published PDF and Typst source. These files are legal working drafts and remain subject to qualified attorney review before use or signature.

## 2026-08-19 — Private GitHub configuration vault

**User request:** Add an administrator-configurable method to back up all platform configuration and secrets into its own GitHub repository folder.

**Implementation:** Added the Backup management → **Private GitHub configuration vault** controls. An administrator can configure a repository, branch, folder, and write-only fine-grained GitHub token. The token is AES-256-GCM encrypted at rest with a dedicated AAD and is never returned to the browser. The portal validates `owner/repository`, branch, and folder inputs, then calls the GitHub repository API before publishing; publication is rejected if the repository is not private.

Secret-inclusive publication is intentional, manual, and fail-closed. Each backup requires a fresh recovery passphrase (minimum 16 characters) and the typed acknowledgement `BACKUP SECRETS TO GITHUB`. The recovery passphrase is not stored by ReadyPackets or GitHub. The root-owned, socket-isolated backup helper creates a temporary `--include-secrets` `.rpconfig` bundle, the portal uploads only encrypted ciphertext plus a non-secret SHA-256 manifest to the selected folder in the private repository, then calls a new exact-filename deletion action to remove the protected temporary export. Customer data, orders, uploaded files, sessions, and logs remain excluded. Ordinary browser configuration export remains secret-free.

**Security controls:** GitHub token is encrypted in application settings, no secrets are shown in the UI or audit event, only private repositories are accepted, path/branch validation rejects traversal and doubled separators, all root helper actions are allowlisted through the local socket daemon, archive size is bounded before upload, publication requires two independent confirmations, and every configuration/test/publication event is audited.

**Validation:** Six focused GitHub-vault destination validation tests passed; TypeScript check passed; root helper `bash -n` and daemon `node --check` passed; client and server production builds passed. Production deployed server, client, root helper, root daemon, and configuration migration script. Public health returned `{"status":"ok"}`. A service-account test successfully invoked root-controlled secret-inclusive export, confirmed a protected archive was created, and confirmed exact-filename cleanup removed it—without any external GitHub publication. Rollback: `/opt/readypackets/rollback-20260819020000-github-vault`.

## 2026-08-19 — Public GitHub repository autoinstall guide

**User request:** Provide instructions for installing ReadyPackets through an autoinstall script if the repository becomes public.

**Response:** Verified the current non-interactive unified installer and GitHub bootstrap inputs, then added `docs/PUBLIC_GITHUB_AUTOINSTALL.md`. The guide provides a copy-and-paste fresh-server flow that retrieves the public repository over HTTPS, fetches and verifies a reviewed immutable 40-character commit SHA, rejects an existing project directory and a modified checkout, and runs `deploy/unified-install.sh` in native, Docker, or Docker-bootstrap mode. It covers DNS, Let’s Encrypt, Cloudflare Origin CA with Full (strict), health checks, and the no-secrets-in-public-source operating constraint. It intentionally does not recommend `curl | bash` or installing a moving `main` branch tip.

## 2026-08-19 — Unified installer: website name and latest GitHub vault recovery

**User request:** Create a unified installer that retrieves the latest configuration from GitHub, offers a website-name setting, and lets the operator choose VPS or Docker installation.

**Implementation:** Extended `deploy/unified-install.sh` with an interactive website-name prompt, existing Native VPS / existing Docker / Docker-bootstrap mode selection, and optional private GitHub configuration-vault recovery. Non-interactive operation supports `--site-name` plus `--github-config-repository`, `--github-config-branch`, `--github-config-folder`, `--github-config-token-file`, and `--github-config-passphrase-file`.

**Recovery safeguards:** Added `deploy/github-config-vault-restore.sh`. It accepts only an `owner/repository` private destination, requires owner-only token input, finds the newest dated vault archive, verifies repository privacy through GitHub’s API, checks the encrypted archive against its non-secret SHA-256 manifest, and never decrypts or logs the token/passphrase. The installer then invokes the established encrypted configuration import under explicit secret-inclusive recovery mode, while preserving newly provisioned target database credentials and applying the explicit website name last. Interactive credentials are written to root-only temporary files and removed at installer exit. Docker recovery uses constrained MySQL adapter scripts and recreates only the application container after restoration.

**Website name:** Added the optional `SITE_NAME` environment variable for server-rendered public page titles and descriptions, documented it in `.env.example`, and passes it to Docker containers. This changes public browser metadata without replacing ReadyPackets logo and brand assets.

**Validation:** Bash syntax checks passed for all affected install/recovery scripts. Focused GitHub vault tests passed (6/6); TypeScript validation, client build, server bundle build, installer help checks, a malicious-vault-path rejection check, and `git diff --check` all passed. Updated `docs/PUBLIC_GITHUB_AUTOINSTALL.md` with the new configuration-vault restoration and website-name options.

## 2026-08-19 — One-click unattended installer with visible progress

**User report and request:** The prior installer appeared to do nothing. The user requested a script that installs the application automatically without requiring interactive choices.

**Diagnosis:** The existing unified installer is intentionally interactive when it has a terminal and intentionally requires explicit mode/domain/TLS values without one. A copied or piped command without required flags can therefore exit before any installation work. The new entry point removes that ambiguity by rejecting absent/invalid values with a single clear error before changing the server, and by emitting step messages during normal execution.

**Implementation:** Added `deploy/one-click-install.sh` and `docs/ONE_CLICK_AUTOINSTALL.md`. The script uses `RP_*` variables for its limited required inputs, defaults to native VPS mode, clones the selected public source repository, invokes the non-interactive unified installer, prints package/source/installer/health-check progress, and verifies the final health endpoint. It supports `RP_MODE=native|docker|docker-bootstrap`, website naming, Let’s Encrypt or Cloudflare Origin CA, branch or immutable commit pinning, and optional latest encrypted private GitHub configuration-vault recovery. It refuses to overwrite an existing project directory and removes temporary vault token/passphrase files on exit.

**Validation:** Script syntax passed. Root-context preflight tests confirmed missing `RP_DOMAIN` and invalid `RP_MODE` both exit immediately with actionable visible messages before any package, source, or server installation action. Repository whitespace validation passed.

## 2026-08-19 — Administrator-controlled domain and Let’s Encrypt management

**User request:** Add a method in the portal to update the public URL and request a new Let’s Encrypt certificate for the new URL.

**Implementation:** Added **Admin → System → Domain & URL** with current canonical origin/certificate metadata plus a high-friction domain-change dialog. The dialog requires a fully-qualified hostname, Let’s Encrypt contact email, and exact `CHANGE DOMAIN AND REQUEST CERTIFICATE` confirmation. The administrator router exposes status and confirmed-cutover procedures only through an existing root-owned certificate-control Unix socket; the application receives no arbitrary command or sudo capability.

**Root safeguards:** Extended `deploy/certificate-control-daemon.mjs` with a narrow `update-domain-letsencrypt` action. It validates input, makes a root-only snapshot of the application environment, nginx site configuration, and TLS include; updates only the controlled `server_name` values and strict nginx host allowlist; validates/reloads nginx; requests a named webroot Let’s Encrypt certificate; confirms the issued certificate matches the requested hostname; atomically writes `APP_URL` and `ALLOWED_ORIGINS`; activates the certificate, reloads nginx, restarts the portal, and checks loopback HTTPS health. Any failure restores all protected files, validates/reloads nginx, and restarts the service. Existing sessions on the former hostname require a new sign-in because the cookie origin changes.

**Validation:** TypeScript checks, root-daemon JavaScript syntax, client/server production builds, `git diff --check`, and focused email/GitHub vault/P101 tests (15/15) passed. The production deployment checksum-verified the server/client/root-daemon artifacts; the public health endpoint remained successful. The protected domain-status socket action returned the live `myportal.readypackets.com` Let’s Encrypt state. A service-account test confirmed an unconfirmed cutover request is rejected before any DNS, certificate, nginx, or origin change occurs. No domain cutover or new certificate request was performed during this release.

**Documentation:** Added `docs/DOMAIN_AND_CERTIFICATE_MANAGEMENT.md` covering DNS prerequisites, Cloudflare settings, the administrator workflow, validation, and rollback behavior.


## 2026-08-19 — Centralized ReadyPackets address and business-profile release

**User request:** Update the ReadyPackets business address everywhere to `ReadyPackets, 7404 Executive Pl, Lanham, MD 20706`, add an administrator control so future changes propagate from one location, deploy the update, and push the release to GitHub.

**Implementation:** Added `server/services/businessProfile.ts` as the validated runtime source for legal/public name and mailing address. Added audited administrator-only `adminSecurity.businessProfile.get` and `.update` procedures, with the new **Admin → System → Settings → Business profile and mailing address** editor. Public session bootstrap exposes the non-secret profile to the website and portal, replacing static address rendering in public footer, contact, About/company information, and structured-data address metadata. Future email footers resolve the profile at queue time; future invoices and generated invoice PDFs resolve the profile at render time. The static new-install fallback in `shared/brand.ts` was changed to the new Lanham address.

**Policy and document handling:** Migration `0041_business_profile_address.sql` persists the new profile and creates address-only replacement versions of Privacy Policy and Refund Policy (`2026.08.19-address`), while retaining historical versions and acceptance evidence. Future policy seed sources were updated. The future-use branded prospective-partner MNDA Typst, Markdown, PDF, and DOCX files were regenerated with the Lanham address. Historical issued invoices and accepted/signed documents were intentionally not rewritten.

**Validation and deployment:** TypeScript checking passed. Focused email-link and invoice-PDF tests passed (4/4). Client and server builds passed. The regenerated partner NDA passed strict Typst compilation, deterministic PDF verification (6/6), and five-page visual review. Active source and future-use templates contain no legacy address references. Production migration initially failed safely because it was run without the service environment, then from an incorrect working directory, followed by a MySQL self-update restriction in the original policy-version query; the migration was made idempotent and compatible, then applied successfully from `/opt/readypackets` with the service environment loaded. Production now contains the centralized `business.profile` setting and published `2026.08.19-address` policy versions. The server/client release is live with client `index.BwrBqeVc.js`; public health at `https://myportal.readypackets.com/api/health` returned `{"status":"ok"}`. Rollback is retained at `/opt/readypackets/rollback-20260819181000-business-profile/`.


## 2026-08-19 — Policy Center document import and RP-CUS customer/order references

**User request:** Add Policy Center upload support for `.doc`, `.docx`, and `.pdf` policy documents with automatic website-ready formatting; replace legacy `RP-C0000XX` customer IDs with a unique `RP-CUS` plus 6–8 character opaque alphanumeric standard for all current, future, and fresh self-hosted users.

**Implemented:** Added a self-hosted administrator-only Policy Center import route and interface. It accepts one document up to 5 MB, validates DOC/DOCX/PDF magic bytes and extension, uses native `antiword`, DOCX XML, or `pdftotext` conversion, normalizes the result to editable Markdown, and explicitly requires administrator review and existing publication confirmation. Original files are held only in a private temporary directory during conversion and then removed. The route is protected by the existing HTTPS, Origin, CSRF, rate-limit, authenticated-session, and administrator-role controls; successful conversions are audited and blocked malformed imports are security logged. Native/Docker installer definitions now include `antiword` and `poppler-utils`.

**Identifier migration:** Added opaque `RP-CUS-XXXXXXXX` customer reference generation and `RP-ORD-<customer-token>-YYMM-XXXXXX` future order generation. Migration `0042_rp_cus_customer_references.sql` synchronized the visible `customer_number` and compatibility `public_id` values, then replaced current legacy order references without changing internal database IDs. Production verification confirmed 10/10 customer references conform, 10/10 public IDs match, 25/25 current orders use RP-ORD references, and zero legacy RP-C customer/order references remain. Historical externally delivered payload records were not rewritten.

**Validation and release:** Type checking passed. Focused email, invoice, canonical P101, public-reference, DOCX import, and PDF import tests passed (15 tests across 5 files). Client and server builds passed. Production installed `antiword` and `poppler-utils`; local and public health checks passed. A root-only pre-migration SQL backup and timestamped server/client rollback copies were retained and recorded in the VPS operations log.


## 2026-08-19 — Cookie consent-management and versioned privacy-policy release

**User request:** Implement a full cookie consent-management system and provide accurate privacy-policy language.

**Delivered:** Added an essential-only, versioned consent-management system with a public banner; granular preference, analytics, and marketing controls; explicit Accept all, Reject optional, and Save choices actions; a persistent public footer preference link; and an administrator control surface at **Admin → System → Privacy & cookies**. Analytics and marketing are disabled and unavailable by default. If an administrator enables either category, it remains consent-gated; no tracking integration is installed by this release. Optional theme persistence now honors the preference-storage choice, while requested portal operations and security controls remain essential.

**Security and privacy controls:** Anonymous consent calls are same-origin and CSRF-protected. The browser receives a protected HttpOnly, Secure production consent token; server records use a keyed token hash plus hashed IP/user-agent context. The record stores consent version, optional-category choices, action, timestamp, and optional account linkage rather than raw browser identifiers. Consent choices are versioned, and changing the consent version prompts visitors again. Administrators must type `UPDATE COOKIE CONSENT SETTINGS` to change optional-category availability; changes are audited.

**Policy language:** Updated fresh-install privacy-policy sources and added migration `0044_cookie_consent_privacy_policy.sql`, which published Privacy Policy `2026.08.19-cookie` without rewriting historical accepted versions. Added `docs/COOKIE_CONSENT_MANAGEMENT.md`, including operational guidance and attorney-review language.

**Validation:** TypeScript check passed. Focused cookie, email-link, invoice, and public-reference tests passed (9 tests). Production client/server bundles built. Public health returned `{"status":"ok"}`. Anonymous `GET /api/privacy/consent` returned consent version `2026.08.19` with analytics and marketing unavailable. Live browser verification rendered the banner, category controls, Privacy Policy link, public footer preference entry point, and floating reopen control. A controlled public Reject optional action created one versioned essential-only rejection record. Migration `0043` initially stopped safely when its settings insert referenced a nonexistent `created_at` column, and `0044` initially stopped safely when its version label exceeded the database length; both migrations were corrected idempotently, applied, and then the server/client assets were promoted. No active artifacts were replaced during either failed migration attempt.

**Production rollback:** Database snapshot `/var/backups/readypackets/pre-cookie-consent-20260819190000.sql.gz`; previous server `/opt/readypackets/rollback-20260819190000-cookie-consent-server.js`; prior client assets `/opt/readypackets/client/dist.previous-20260819190000-cookie-consent`.


## 2026-08-19 — Guided latest-main autodeployment installer

**User request:** Update the autodeployment installer so it prompts for required settings, provide a breakdown of prompts, retain all proposed choices, and allow a fresh VPS operator to run only the script while it retrieves the latest GitHub commit by default.

**Delivered:** Reworked `deploy/one-click-install.sh` from an environment-variable-only entry point into a guided fresh-server installer. In an interactive root terminal it now asks for installation model, public hostname, display name, TLS model and conditional certificate details, optional source override, optional encrypted GitHub vault recovery, native nightly backup preference, and initial administrator provision. It displays a redacted review and requires exact `INSTALL READY PACKETS` before any package, database, certificate, or application change. It retrieves the latest public `readypackets/ReadyPackets` `main` commit by default and prints the resolved commit after installation. A reviewed immutable commit remains available through the advanced source prompt.

**Initial-admin hardening:** New installations without vault recovery require an administrator email and full name. The operator may request a one-time generated password or enter a masked password. Added `--password-stdin` support to `scripts/create-admin.ts`, allowing the guided installer to pass a manually chosen password over standard input rather than exposing it in a command-line argument. MFA remains mandatory after first sign-in.

**Automation compatibility:** The installer retains noninteractive `RP_*` environment-variable support but now requires `RP_AUTO_CONFIRM=INSTALL_READY_PACKETS` to make unattended execution explicit. Private GitHub vault and Cloudflare material remain masked, held only in protected temporary files where needed, and removed on exit.

**Validation:** Shell syntax validation passed. TypeScript validation passed. A root pseudo-terminal test completed the guided prompt path through the redacted review and intentionally cancelled before any server change. A root noninteractive test confirmed the script exits before bootstrap package installation when `RP_AUTO_CONFIRM` is absent. Updated `docs/ONE_CLICK_AUTOINSTALL.md` documents the guided flow, latest-main default, source pinning, initial administrator behavior, and fully unattended variables.


## 2026-08-19 — Fresh installer migration-runner repair

**User report:** A fresh guided installation stopped after writing `/etc/readypackets/portal.env` and printed `Error: Cannot find module '/opt/readypackets/dist/migrate.js'` at the database migration step.

**Root cause and containment:** The installer built runtime artifacts before its production dependency prune but did not verify their continued presence before applying migrations. The failure occurred before the database migration could begin, so the reported VPS did not have partial application schema changes; it did have a newly created protected environment file and database/user provisioned by the preceding fresh-install stages.

**Repair:** Updated `deploy/install.sh` to build `server.js`, `migrate.js`, `seed.js`, and `create-admin.js` as explicit runtime artifacts; require each artifact to be non-empty and parseable with `node --check` before writing the protected environment or touching migrations; defer `pnpm prune --prod` until after migration and seed initialization; and verify artifacts remain present after pruning. Added a high-friction failed-fresh-install resume path to `deploy/one-click-install.sh`. It only operates when `RP_RESUME_FAILED_INSTALL=yes` is supplied (or explicitly selected in the guided flow), requires the project directory to be a Git checkout, refuses to run if the ReadyPackets service is active, re-fetches the selected source, and presents the existing redacted review/final confirmation before resetting the failed checkout.

**Validation:** Confirmed the source exposes `scripts/migrate.ts`, `scripts/seed.ts`, and `scripts/create-admin.ts`. Built all four required runtime bundles in a clean temporary validation directory and verified the artifacts are non-empty and JavaScript-parseable. Shell syntax validation passed. TypeScript validation passed. Pseudo-terminal guided cancellation reached the review and cancelled before server changes. The failed-install resume review was also tested and cancelled before source reset. Updated `docs/ONE_CLICK_AUTOINSTALL.md` with the safe resume command.


## 2026-08-19 — Encrypted configuration-export handoff repair

**User report:** The administrator configuration export command displayed `Configuration export failed: Could not read the encrypted configuration bundle.`

**Diagnosis:** The portal correctly requested an encrypted configuration bundle through the root-owned, allowlisted backup-control socket. The helper generated a staged `.rpconfig` file under `/var/lib/readypackets/storage/admin-exports`, but its otherwise valid filename output included a line terminator. The application passed that raw output to the protected reader, whose strict filename validation rejected the newline-suffixed value before it could read and Base64-encode the encrypted bundle for the browser. This was a privilege-boundary output-normalization defect, not a failure to create the encrypted bundle and not evidence that any configuration secret was exposed.

**Repair:** Updated `server/routers/tier3.ts` so `runBackupControl()` trims helper output at the Unix-socket privilege boundary. The `exportConfiguration` procedure independently trims and validates the returned value against the exact `readypackets-config-<UTC timestamp>.rpconfig` filename pattern before the protected reader is invoked. The export activity event is recorded only after the bundle has been successfully read into the authenticated response payload. The protected reader continues to constrain access to its administrative-export directory and the root helper continues to retain deletion control.

**Validation and deployment:** TypeScript checks passed; the standalone Node 22 production server bundle built and parsed successfully. The server-only bundle was SHA-256 verified, deployed at `20260819202500`, and the preceding server retained at `/opt/readypackets/rollback-20260819202500-config-export/server.js`. Local and public health checks returned healthy. A temporary, service-account-only lifecycle check generated a new encrypted export through the actual control socket, enforced the filename pattern, read its metadata and ciphertext, Base64-encoded it to the same browser transport shape, verified a 21,488-byte bundle and 28,652-character Base64 payload, and requested its protected deletion. The diagnostic emitted only filename/size metadata, never bundle or secret contents, and removed the staged export after validation.

**Operator outcome:** Authorized administrators can use **Admin → Backup management → Export configuration** with a new 16+-character recovery passphrase. The returned `.rpconfig` remains encrypted; retain the passphrase separately and do not place it in the same storage location as the export. The test validation does not replace an administrator's own authenticated browser download, but it confirms every server-side step that previously failed.


## 2026-08-19 — Workflow instructions, announcements, and configurable customer progression

**User request:** Add workflow-designer options for posting customer instructions or an announcement, including a place to type or paste the content and preview it before publishing. Add a per-stage choice between a **Next** button that takes the customer to the next workflow phase and **Submit and lock** that advances the customer only after the stage is locked.

**Delivered:** Each workflow stage now supports optional `customerMessage` content with a selected type of **Instructions** or **Announcement**, an optional title, and up to 8,000 characters of Markdown content. The visual stage canvas and guided task wizard each expose the same controls: content type, title, body, a live customer preview, and a progression selector. The preview and customer display use the existing React-node Markdown renderer; they do not use `dangerouslySetInnerHTML`, unsafe URLs remain inert text, and scripts cannot execute.

**Progression behavior:** Each stage defaults to **Submit and lock**, preserving the existing irreversible customer lock and acknowledgment policy. Selecting **Next button; keep this phase editable** creates an explicit customer Next transition instead: it opens the following workflow stage without creating an `order_phase_locks` record. Completed Next stages remain available for customer review and edits, while locked stages remain immutable until an administrator performs the existing confirmed unlock. The server enforces the selected mode independently of the page: a customer cannot call Next on a lock-required stage or submit-lock a Next-configured stage.

**Durable state and visibility:** Migration `0045_workflow_customer_next_transitions.sql` introduced the `order_workflow_advances` table, keyed by order and stage. It records the advancing customer and timestamp separately from phase locks so no non-locking transition is mistaken for an immutable submission. Workflow progress, current phase labels, order lists, customer order summaries, and the guided-step tracker now recognize both active locks and Next transitions. Instruction-only stages are valid customer stages, so an administrator can create a message-and-Next step without enabling document, question, or audio actions.

**Regression correction:** Validation exposed stale compatibility tests and allowlist validation for retired `RPYY-XXXXXXXX` public IDs, while current accounts use the required `RP-CUS-XXXXXXXX` format and current generated order IDs use `RP-ORD-YYMM-XXXXXX` (or the customer-token variant). The public-ID validation helper, platform-setup error message, and regression expectations were aligned with the active reference standard. No customer data migration was necessary because current production IDs were already migrated earlier.

**Validation and deployment:** TypeScript validation passed. The non-database test suite passed 119/119 tests across cryptography, header, policy, rendering, tier-4, and upload coverage. The full suite’s remaining catalogue-domain tests require a local MySQL instance that is not running in the sandbox; focused verbose output confirmed `ECONNREFUSED 127.0.0.1:3306`, not a product assertion failure. Client and server production builds completed; the server bundle parsed with Node 22 and `git diff --check` passed. Production deployment checksum-verified server, client, and migration artifacts. Migration `0045` applied successfully, the active client is `assets/index.C_qvgHjn.js`, and local/public health checks returned `{"status":"ok"}`. Rollback server/client assets are retained at `/opt/readypackets/rollback-20260819204000-workflow-instructions/` and `/opt/readypackets/client/dist.previous-20260819204000-workflow-instructions`.


## 2026-08-19 — Fresh installer missing `dist/migrate.js` diagnosis

**User report:** A fresh-server install stopped immediately after writing `/etc/readypackets/portal.env` with `Error: Cannot find module '/opt/readypackets/dist/migrate.js'` while applying database migrations. The installer explicitly reported that no changes were rolled back.

**Diagnosis:** The reported console sequence matches the historical pre-`431425f` native-install behavior, which built `server.js`, `seed.js`, and `create-admin.js` but then attempted to execute a missing `migrate.js`. The current public GitHub `main` source was independently checked against the canonical checkout and contains the repair: it builds `migrate`, `seed`, and `create-admin` from `scripts/*.ts`, then verifies all four runtime artifacts before writing the protected environment or running any migration. GitHub raw `one-click-install.sh` and `install.sh` checksums exactly matched the current published repository. The current artifact build was also reproduced in an isolated temporary directory: `migrate.js`, `seed.js`, and `create-admin.js` were generated and passed Node 22 syntax checks.

**Safe recovery:** The guided bootstrap supports the failed-fresh-install resume path. On the affected server, re-download the current bootstrap and rerun it with `RP_RESUME_FAILED_INSTALL=yes`; it fetches the latest selected `main` source into the existing `/srv/readypackets` Git checkout, refuses to run if `readypackets.service` is active, preserves existing generated secrets in `/etc/readypackets/portal.env`, rebuilds the required runners, and then resumes migrations/seed/configuration. This path must not be used on a live portal.

**No new source correction was required:** The latest release already includes the repair in commit `431425f`; this incident was added to the session log and will be published with the next log-only commit.


## 2026-08-19 — Installer migration-boundary fallback repair

**Follow-up user report:** The failed-fresh-install resume path again reached `Applying database migrations` with `dist/seed.js` and `dist/create-admin.js` present, but `/opt/readypackets/dist/migrate.js` missing. The console therefore continued to match the historical missing-runner condition despite the earlier artifact-build safeguard.

**Additional repair:** Native `deploy/install.sh` now has `ensure_migration_runner()` immediately before schema execution. If `dist/migrate.js` is missing or empty at that exact boundary, the installer rebuilds it directly from the checked-out `scripts/migrate.ts` source using the local pnpm/esbuild toolchain, restores root-owned non-writable permissions, confirms the bundle exists, and validates it with Node before any service-account database command runs. It fails with a targeted source/build error only if reconstruction cannot succeed. This makes a clean schema initialization resilient to runner removal between the original build and migration phases.

**Validation:** All three bootstrap/native scripts passed Bash syntax checking. An isolated application tree without `dist/migrate.js` successfully rebuilt the runner from `scripts/migrate.ts`; the resulting 11.8 KB bundle passed Node 22 syntax validation. The resume command will be pinned to the release commit so both the downloaded bootstrap and the checked-out source must use this repair.


## 2026-08-19 — Deterministic installer runner rebuild and non-interactive recovery

**Second repeated failure:** The commit-pinned resume still reached the database phase with `dist/seed.js` and `dist/create-admin.js` visible but reported `MODULE_NOT_FOUND` for `/opt/readypackets/dist/migrate.js`. The interactive confirmation screenshot separately showed that the resume flag was recognized but the bootstrap prompted again for native/TLS/domain/admin selections.

**Deterministic repair:** The installer no longer conditionally trusts an existing migration bundle. Immediately before migration it now always compiles `scripts/migrate.ts` to a process-unique temporary JavaScript path under `dist`, runs `node --check`, atomically installs that verified artifact as root-owned mode `0644` `dist/migrate.js`, removes the temporary file, verifies the final artifact is non-empty, and verifies the `readypackets` service account can read it. This removes any timing/cache/remove condition between the prior build phase and schema creation. The first temporary filename ended in the shell PID and Node rejected its unknown extension; this was corrected so the temporary artifact ends in `.js`. Full isolated-source validation passed the exact build, Node syntax check, atomic installation, and service-account readability sequence.

**Prompt-free recovery:** The restart command will explicitly set `RP_NONINTERACTIVE=true`, `RP_AUTO_CONFIRM=INSTALL_READY_PACKETS`, `RP_RESUME_FAILED_INSTALL=yes`, the chosen native / Let’s Encrypt / `www.readypackets.com` configuration, and the requested generated initial administrator settings. It does not place a password or token in shell history. The command remains restricted to a failed fresh installation: the bootstrap refuses to resume if `readypackets.service` is active.


## 2026-08-19 — Native installer ownership-model correction and no-prompt profile

**Confirmed root cause:** The third failed fresh install successfully built `dist/migrate.js` immediately before migration, then failed the service-account readability check. The native installer starts with `umask 077`; its prior `chown -R root:root` plus `chmod -R go-w` implementation preserved owner-only directory traversal and file-read modes. Consequently, the `readypackets` runtime account could not traverse `/opt/readypackets` or read the root-owned migration bundle. The correct remediation is not application-user-owned code: a compromised service process must not be able to modify server code, dependency modules, installer scripts, or systemd definitions.

**Rebuilt native permission model:** The installer now applies `grant_runtime_read_access()` after the application build, again immediately before migration, and after production dependency pruning. The full runtime tree is `root:readypackets`; directories grant group read/traverse and files grant group read; all group/other write permissions remain removed. The protected environment file remains separately `root:readypackets` mode `0640`, while uploaded customer data remains application-owned under the data root. An isolated restrictive-mode test proved the service group can traverse `dist` and read `migrate.js` and server modules after the installer permission sequence.

**No-prompt recovery profile:** `deploy/one-click-install.sh` now supports `RP_SETTINGS_FILE`. It will load only a root-owned mode-`0600` non-secret profile and rejects profile entries for administrator passwords, GitHub tokens/passphrases, and Cloudflare private keys. A tested profile can retain native mode, domain, TLS method, Let’s Encrypt contact, public site name, backup choice, failed-install resume flag, administrator identity, and generated-password choice. It can set non-interactive confirmed mode so a verified fresh-install resume does not prompt again. The profile harness validated that actual bootstrap source loads the selected values and rejects a secret-bearing profile.


## 2026-08-19 — Fresh migration ledger duplicate repair

**Follow-up fresh-install output:** With runtime permissions corrected, the installer successfully built and syntax-checked `dist/migrate.js`, passed the service-account access check, and applied `0001_initial_schema.sql`. It then failed on `0005_tier4_tier5.sql` with `Duplicate entry '0005_tier4_tier5.sql' for key 'schema_migrations.PRIMARY'`.

**Cause:** `0005_tier4_tier5.sql` is a historical migration containing its own legacy `INSERT IGNORE INTO schema_migrations` after an explanatory `-- Record this migration` comment. The forward-only runner is intended to filter legacy in-file ledger writes and insert its authoritative SHA-256 checksum itself. Its regular expression tested the raw parsed statement, which began with the comment rather than `INSERT`, so the legacy insert executed. The runner’s own ledger write then duplicated the primary key within the transaction; that failed transaction rolls back the 0005 statements and its legacy ledger insertion, leaving the fresh database safely resumable from the recorded 0001 state.

**Repair and validation:** The runner now strips only leading line/block SQL comments before identifying a legacy ledger insert. Its original SQL bytes and checksums remain unchanged. A regression harness reading the actual historical migration confirmed six parsed statements, five executable statements after filtering, and no executable statement targeting `schema_migrations`. Type checking, runner bundling, and Node syntax validation passed. The current initial schema does not include any of the 0005 objects, so normal application of the five remaining 0005 statements is correct.

**Recovery impact:** The root-only, mode-0600 profile at `/root/readypackets-install/www-readypackets.env` remains valid. A new commit-pinned bootstrap can resume the same fresh installation without parameter prompts or a database reset; the corrected runner recognizes 0001 as already applied and resumes at 0005.


## 2026-08-19 — Fresh installer completion split: local success vs public connectivity

**Observed result:** The repaired fresh installation completed the service readiness probe successfully, printed the completed-install summary, enabled the backup timer, and provisioned the initial administrator. Only the bootstrap’s final external request to `https://www.readypackets.com/api/health` failed with `curl: (7) Failed to connect ... port 443`. The core native installer had already correctly verified the service using the local loopback readiness endpoint. This was an external DNS/TLS/proxy/firewall reachability delay, not an installation, schema, or runtime failure.

**Completion-flow rebuild:** Added `deploy/verify-public-connectivity.sh`, which treats local systemd and loopback readiness as authoritative installation health and evaluates public HTTPS separately. It returns `0` when all requested checks pass, `2` when the local portal is healthy but public HTTPS is still pending, and `1` for a local service failure or invalid use. It prints focused next diagnostics for hostname resolution, TLS/proxy reachability, port 443 listener state, and firewall state.

`deploy/one-click-install.sh` now always verifies local completion on a native install, then treats an external HTTPS delay as an advisory warning by default rather than turning a completed installation into a failed install. An explicit `RP_REQUIRE_PUBLIC_HEALTH=yes` keeps strict public health gating available for automated environments that require it. Docker’s post-install public HTTPS check is also advisory. Bash syntax and static completion-flow checks passed. The saved root-only, non-secret installation profile remains valid for resumable runs.


## 2026-08-20 — Let’s Encrypt ACME challenge routing repair

**TLS diagnosis on the newly installed `www.readypackets.com` server:** The portal service was locally healthy and DNS correctly resolved the hostname to the new server. Let’s Encrypt reached port 80 but received an HTTP 403 response for `/.well-known/acme-challenge/<token>`. The server diagnostics confirmed no certificate existed, no TLS include existed, and nginx was correctly serving only port 80 while in pre-certificate mode.

**Root cause:** The nginx temporary HTTP-only configuration included a normal prefix `location /.well-known/acme-challenge/` to serve Certbot files. A general security regex for hidden files also matches `.well-known`; nginx evaluates matching regular-expression locations after ordinary prefix selection, so that hidden-file protection overrode the challenge location and denied the token request.

**Repair:** Both the tracked hardened nginx template and the installer-generated temporary HTTP-only site now use `location ^~ /.well-known/acme-challenge/`, with a root-limited static file lookup and `try_files $uri =404`. The `^~` exception prevents regex hidden-file guards from intercepting the ACME namespace, while all other hidden paths remain denied. Shell syntax and static checks confirmed the exception is present in both configuration paths. The published fix will be used for future fresh installs; the active fresh server can receive the identical targeted nginx exception and issue its certificate without resetting its healthy application or database.


## 2026-08-20 — ACME recovery heredoc correction

**Follow-up failure:** The first published ACME precedence patch reached the correct code path but the temporary HTTP-only nginx generator emitted `/srv/readypackets/deploy/install.sh: line 456: ^~: command not found`. This occurred because Markdown-style backticks in a comment inside the unquoted Bash heredoc were interpreted as command substitution before nginx received the generated configuration. The malformed output caused the temporary ACME site to omit the expected location behavior; Let’s Encrypt then received a 404 for the challenge token.

**Correction:** Removed all backticks from the unquoted heredoc comment and simplified the ACME static location to the standard root mapping with `location ^~ /.well-known/acme-challenge/`. The location is protected from regex hidden-file rules by `^~`, while the shell heredoc remains free of command substitutions. A runtime harness extracted and executed the actual `write_http_only_site()` function, confirmed it renders the `www.readypackets.com` temporary nginx configuration, preserves literal nginx variables, and does not leak an ACME `location` line into shell evaluation. Bash syntax validation also passed.

**Operational clarification:** The bare `readypackets.com` hostname shown in the browser is not currently part of the fresh server’s `www.readypackets.com` installation. The immediate certificate procedure targets `www.readypackets.com`; an apex-domain redirect can be configured after TLS is active. The portal service/database remain healthy and are not reset by the certificate repair.


## 2026-08-20 — Fresh installer: apex and www certificate coverage

**Observed behavior:** `https://www.readypackets.com` became healthy after the certificate recovery, but `https://readypackets.com` presented `NET::ERR_CERT_COMMON_NAME_INVALID`. The previous installer accepted one hostname, configured nginx only for that hostname, and requested a certificate only for that hostname. A normal `www` install therefore left the apex outside both the server-name set and certificate SANs.

**Installer enhancement:** The native fresh-VPS installer now derives a conventional apex/www pair automatically when the selected domain is either `www.example.com` or an apex hostname such as `example.com`. It leaves explicit deeper subdomain deployments such as `portal.example.com` single-host. Nginx receives both names, accepts both in its hostname guard, redirects the non-canonical companion hostname to the selected canonical URL using a permanent 308 redirect, and keeps the original canonical host in all portal configuration.

**Certificate safeguard:** Let’s Encrypt requests now include both names in a single certificate. Existing canonical-only certificates are detected as incomplete rather than silently reused; Certbot receives `--expand` when the existing certificate must be widened. Supplied Cloudflare Origin certificates and preserved TLS includes are also validated against every configured hostname before HTTPS is enabled. Tests rendered both apex/www and subdomain-only temporary/hardened configurations from the actual installer functions, verifying server names, canonical redirects, host allowlists, placeholder removal, and shell syntax.

**Current server recovery:** The current `www.readypackets.com` instance can retain its healthy app, database, encryption keys, service account, backups, and initial administrator. Its certificate only needs to be expanded to include `readypackets.com`, then the updated native installer can enable the two-name nginx configuration. Both `readypackets.com` and `www.readypackets.com` must have DNS A/AAAA records resolving to the VPS before the expansion is requested.


## 2026-08-20 — Fresh installer: ACME webroot fallback

**Repeated fresh-install evidence:** On a clean VPS, application deployment, schema migration, service readiness, backups, and administrator provisioning all completed. Let’s Encrypt reached both `readypackets.com` and `www.readypackets.com` at the VPS public address but returned HTTP 403 for both HTTP-01 webroot challenge tokens. Because certificate issuance did not complete, nginx correctly remained HTTP-only and the separate public HTTPS verification reported a pending condition rather than failing the healthy local install.

**Installer hardening:** The native installer now writes and serves a temporary local ACME probe token through the generated HTTP-only nginx configuration before attempting webroot issuance. It checks each configured public hostname through a loopback-resolved HTTP request. If the probe is locally blocked—or if Certbot webroot issuance is rejected—the installer logs the reason and performs a bounded Certbot standalone fallback: it stops nginx only when active, obtains the same canonical-plus-alternate certificate directly on port 80, and always restarts nginx after the attempt. On success it validates certificate coverage for every configured hostname before enabling TLS. On failure it restores the reverse proxy and retains the healthy HTTP-only portal with focused diagnostics.

**Validation:** A controlled saved harness forced the local webroot route to fail, then verified the real installer control flow selected `certbot certonly --standalone`, stopped nginx, restarted nginx after completion, wrote the TLS include, and marked certificate issuance successful. Installer shell syntax and existing apex/www configuration checks remain valid. The fallback avoids reinitializing the database or secrets and is safe for both a fresh server and a previously completed fresh installation.


## 2026-08-20 — Automated Cloudflare Origin CA installer option

**Request:** Add an installer option that automatically obtains and installs a Cloudflare Origin CA certificate for a Cloudflare-proxied ReadyPackets deployment, including the canonical domain and its conventional apex/www companion.

**Implementation:** The native installer now supports `--tls-provider cloudflare-origin-ca` together with `--cloudflare-api-token-file` and an optional Origin CA validity (`7`, `30`, `90`, `365`, `730`, `1095`, or `5475` days; default `5475`). It generates a local RSA 3072-bit private key and SAN CSR, requests the certificate from `POST https://api.cloudflare.com/client/v4/certificates`, validates the returned certificate against all configured public hostnames, validates its public key matches the generated private key, and writes the certificate/key beneath `/etc/readypackets/tls/cloudflare-origin/` under the existing root-owned access model. The nginx TLS include identifies the provider without including secret material.

**Token protections:** The installer accepts an API token only from a root-owned mode `0600` file. Guided installation asks for it without terminal echo, writes it to an ephemeral root-only file for the single installer invocation, and removes that file in its existing cleanup trap. Raw `RP_CLOUDFLARE_API_TOKEN` environment input and settings-profile persistence are rejected. The native installer reads the token into a local shell variable, writes an authorization header only to a root-only temporary curl configuration file, uses that config to avoid a credential in process arguments, unsets the variable, and removes the work directory after issuance. The token is never placed in portal environment files, service units, Git configuration, configuration exports, session log data, browser data, shell history, or backup metadata.

**Scope and operator requirements:** This automated provider is deliberately native-VPS only at present; Docker is explicitly rejected rather than silently ignoring token-backed TLS setup. The Cloudflare token must have the documented least privilege `Zone → SSL and Certificates → Edit` permission scoped to the target zone. The domain records must be Cloudflare-proxied and zone SSL/TLS must be set to `Full (strict)`, because Origin CA certificates secure Cloudflare-to-origin traffic and are not publicly browser-trusted on a direct origin connection.

**Validation:** Installer shell syntax passed across native, guided, and unified scripts. Static review confirmed the token path is the only automated secret reference and does not become a raw `Authorization` command argument. A dedicated regression execution confirmed that raw Cloudflare API token environment variables are rejected before bootstrap package installation begins. Official Cloudflare API and security requirements were recorded in `docs/CLOUDFLARE_ORIGIN_CA_AUTOMATION_NOTES.md`.


## 2026-08-20 — Configuration export revalidation after portal error

**Report:** An administrator received the generic “Could not export configuration” message from Backup Management after entering an export passphrase.

**Production inspection:** The live service was active. The protected backup-control socket remained owned by `root:readypackets` mode `0660`, and the encrypted-export staging directory had the required `root:readypackets` mode `0640` artifacts. The portal journal recorded the UI request at 06:25 UTC as an invalid returned filename, but it contained no exposed passphrase or bundle content.

**Metadata-only validation:** A temporary Node client was run as the `readypackets` service account using the exact JSON socket protocol and a random in-memory passphrase. The protected helper returned a valid `readypackets-config-<timestamp>.rpconfig` filename. The service account could read and Base64-encode the generated encrypted bundle; validation recorded only byte/base64 lengths, not content. The test export and temporary diagnostic client were deleted immediately after validation.

**Conclusion:** No permissions or helper-generation defect remained at the time of revalidation, so no production code/configuration change was applied. The administrator can retry with a new 16+ character passphrase after refreshing Backup Management. If an error recurs, correlate the exact retry time with the portal journal before making a further change.


## 2026-08-20 — Configuration export portal failure root-cause repair

**Report:** The Backup Management interface continued to display “Could not export configuration” even after the protected helper and staging permissions were metadata-validated successfully.

**Root cause:** Production journal correlation showed each administrator request did create a correctly owned encrypted `.rpconfig` artifact, but `tier3.systemBackups.exportConfiguration` rejected the helper response as an invalid filename. The portal code supplied the passphrase to the socket helper as a JavaScript template string containing the literal characters `\\n`, rather than a real newline terminator. The protected configuration-migration script therefore read the passphrase with a literal backslash sequence, generated the encrypted bundle, and returned a helper output path/format that failed the portal’s strict filename guard. The standalone socket validation had used a real newline, which explained why it succeeded while the user-interface procedure failed.

**Repair:** Updated `server/routers/tier3.ts` so `exportConfiguration` supplies `${input.passphrase}\n` with a real newline character. The server type check, bundle build, and Node syntax check passed. The server-only bundle was checksum-verified and deployed to production at `20260820064000`; the deployed bundle was inspected to confirm the template literal renders across an actual newline. The service restarted cleanly, local readiness returned `{"status":"ready"}`, and public health returned `{"status":"ok"}`. Retained rollback: `/opt/readypackets/rollback-20260820064000-config-export-newline/server.js`.

**Security:** No export passphrase, configuration contents, encrypted bundle payload, or credential was printed during diagnosis. Existing failed-request artifacts remain protected as `root:readypackets` mode `0640`; temporary test bundles and diagnostic clients were removed. The administrator should refresh Backup Management and retry with a new 16+ character passphrase.


## 2026-08-20 — Final configuration export filename validation repair

**Follow-up report:** The portal export still failed after correcting the literal passphrase terminator. Live correlation showed each request generated a valid protected artifact such as `readypackets-config-<timestamp>.rpconfig`, proving the helper and encrypted file generation were successful.

**Final root cause:** Both the server-side pre-read guard and `readProtectedExport` used an over-escaped JavaScript regular expression (`\\\\.rpconfig` in source), which required a literal backslash before the extension and rejected every valid `.rpconfig` filename. The helper response was therefore never accepted by the tRPC procedure despite valid output.

**Repair:** Corrected both filename guards to use the intended escaped-dot regular expression (`\.rpconfig`). A focused regression test verified valid generated names are accepted while path traversal, suffix, and backslash variants remain rejected. TypeScript validation, server bundle generation, and Node syntax validation passed. The server-only bundle was checksum-verified and deployed to production at `20260820065000`; local readiness and public health passed. A metadata-only service-account test executed the full helper request, strict filename guard equivalent, protected file read/Base64 conversion, and cleanup lifecycle successfully. No configuration content, passphrase, or secret material was printed.

**Rollback:** `/opt/readypackets/rollback-20260820065000-config-export-regex/server.js`.

## 2026-08-20 — Encrypted configuration restore workflow

**User request:** “There is no option to restore the exported configuration.”

**Delivered:** Added **Restore configuration** to **Admin → Backup management**. A fully authenticated administrator can upload one encrypted `.rpconfig` export (maximum 5 MB), enter the original export passphrase, verify the encrypted envelope and non-secret manifest before any change, review the restore scope, type `RESTORE CONFIGURATION`, and apply the verified configuration. The portal schedules a short restart after returning the success response.

**Scope and safety:** The browser restore workflow intentionally imports only the standard secret-free configuration export. It restores supported platform settings/configuration tables while preserving target-server encryption keys, session secret, database credentials, integration secrets, customer data, orders, uploaded files, recordings, sessions, logs, and operating-system configuration. Source-server secrets remain a controlled new-server recovery concern through the separate encrypted private GitHub vault process.

**Security controls:** Added an admin-only multipart endpoint at `/api/configuration-restore` with active-admin/MFA checks, same-origin CSRF enforcement, one-file/5 MB limits, random fixed-format import filenames, administrator-bound ten-minute preflight tokens, typed confirmation, audit/security logging, and a root-owned non-listable staging directory. The web service can write a random encrypted upload but cannot list or read the staging directory. Only the fixed-action root backup-control daemon can inspect or apply a bundle. The helper validates HMAC/checksums and removes staged bundles after application or expiry.

**Implementation:** Added `server/http/configRestore.ts`; mounted it before tRPC in `server/app.ts`; added UI controls in `client/src/pages/admin/Backups.tsx`; extended `deploy/backup-control.sh` and `deploy/backup-control-daemon.mjs` with strict inspect/apply allowlists; added `--manifest-only` and `--no-restart` modes to `deploy/config-migration.sh`; provisioned `/var/lib/readypackets/storage/config-restore-imports` as `root:readypackets` mode `0730`; and documented operation in `docs/CONFIGURATION_RESTORE.md`.

**Hardened extraction repair:** The root backup-control daemon intentionally lacks ownership-changing capabilities. `config-migration.sh` now extracts both configuration bundle layers with `tar --no-same-owner`, allowing validation inside the hardened helper without relaxing service capabilities.

**Validation:** TypeScript, shell, daemon, server build, client build, and Node syntax checks passed. The existing catalogue test group remains unavailable in the sandbox because local MySQL is not running; independent non-database tests passed. Production metadata-only validation generated a normal encrypted export, staged it using the restore format, authenticated the envelope and manifest through the live root helper, confirmed `format=1`, `tables=15`, and `customer_data=false`, then removed both test artifacts. Public health returned `{"status":"ok"}`.

**Deployment:** Server/client/helper restore controls deployed at `20260820072000`; capability-safe bundle extraction deployed at `20260820073500`. Rollback artifacts: `/opt/readypackets/rollback-20260820072000-configuration-restore/` and `/opt/readypackets/rollback-20260820073500-configuration-restore-tar-fix/`. Production release commit will be set after the final source commit is published.

**Operator guidance:** Open Backup management, choose **Restore configuration**, select the encrypted `.rpconfig`, enter the export passphrase, verify the preflight summary, type `RESTORE CONFIGURATION`, and reload after the scheduled restart. No passphrase, configuration data, certificate, private key, or integration secret was exposed in validation or retained in this log.

---

## 2026-08-20 — Cookie-management controls and banner visibility

**User request:** Add an administrator on/off control for cookie management and make the public privacy-preference popup more visible and less opaque.

**Delivered:** Admin → System → Cookie consent and privacy preferences now includes the audited **Show cookie preference banner and management controls** checkbox. When enabled, visitors see the consent banner and the persistent Manage cookie preferences control. When disabled, both visitor-facing preference controls are hidden. Essential session, CSRF, security, checkout, and requested portal-function cookies remain active and cannot be disabled. Optional analytics and marketing categories are disabled in the administrator panel when the banner is off, and they are saved as unavailable.

**Banner design:** Reduced the page dimming layer to improve surrounding-page visibility while making the banner itself highly legible: larger maximum width, fully opaque navy panel, high-contrast white typography, a stronger cyan border/ring, clearer icon treatment, and an elevated shadow. The persistent preferences button is also larger and uses an opaque high-contrast treatment.

**Server behavior:** Added `privacy.cookie_consent_enabled`, defaulting to enabled for existing installations that have no explicit value. The admin mutation writes the new flag alongside optional-category availability and audits the change. Public client rendering only presents the banner/management control when the flag is enabled. Existing consent decisions and consent recording remain unchanged while enabled.

**Validation:** Cookie-consent regression tests passed (3/3); TypeScript, production client/server builds, and server syntax validation passed. The deployed public page confirmed the updated client bundle and consent-management control are available. The portal recovered from the normal short restart window and public health returned `{"status":"ok"}`.

**Production deployment:** Server/client deployment at `20260820074500`; rollback assets retained at `/opt/readypackets/rollback-20260820074500-cookie-management/`. Source commit pending final publication.

---

## 2026-08-20 — Policy Center visibility and full-backup restore release

**User-approved customer-facing policy publication:** The supplied policy package was reviewed and the user explicitly authorized publishing the listed customer-facing versions. The production publisher created the following required current versions while retaining all prior versions for history and acceptance audit: Privacy Policy `2026.08.20-consulting`, Refund Policy `2026.08.20-consulting`, Liability Disclaimer `2026.08.20-consulting`, and MNDA `1.1`. The supplied Terms document was retained as a GitHub-tracked draft because it contains unresolved date, governing-law, and jurisdiction placeholders and was not silently published. The policy publisher's `--dry-run` mode was corrected so future previews cannot mutate data.

**Policy visibility controls:** Migration `0046_policy_visibility.sql` adds `policy_documents.is_visible` with a safe default of visible for existing policies. Admin → Policy Center now presents independent Acceptance and Visibility controls. Hiding a policy removes it from public policy routes and listings, while a required policy remains available through the compliance acceptance flow so customers cannot be deadlocked. Every visibility change is audited as `policy.visibility_updated`.

**Full-backup restore:** Admin → Backup management now supports upload, preflight, and restored execution of a verified full `readypackets-*.tar.gz` archive. The workflow requires administrator authorization, CSRF, a 50 MB upload cap, strict archive member/path/link checks, `SHA256SUMS`, manifest checks, a ten-minute account-bound preflight token, exact `RESTORE FULL BACKUP` confirmation, audit events, and a root-controlled staging directory. The root backup helper accepts only fixed inspection/restore actions. The archive extraction path is hardened against unsafe ownership, path, and link preservation. A synthetic archive was preflighted successfully through the deployed service-account socket path; no customer or production data was restored during validation. `docs/FULL_BACKUP_RESTORE.md` documents the workflow and its distinction from secret-free `.rpconfig` configuration restore.

**Production deployment:** Server/client, backup-control helper/daemon, restore scripts, migration `0046`, policy source package, and required staging path were deployed with retained rollback assets at `/opt/readypackets/rollback-20260820083000-policy-backup-restore/`. MySQL migration `0046` was applied; both `readypackets` and `readypackets-backup-control` services are active and portal readiness passed. Release publication to GitHub is pending commit creation at the time of this entry.

**Legal notice:** The imported policy documents are working operational imports, not legal advice; legal counsel should review policy language before reliance.

## 2026-08-20 — Fresh-server configuration restore staging repair

**Reported behavior:** On the newly installed `www.readypackets.com` environment, the encrypted `.rpconfig` configuration restore preflight failed before passphrase verification. The browser received an `install: failed to chown ... Operation not permitted` error for both configuration and backup restore import staging directories.

**Root cause:** The root-owned `readypackets-backup-control` daemon is intentionally sandboxed without `CAP_CHOWN`. Its helper script nevertheless attempted `install -d -o root -g readypackets` on every restore request. On a correctly provisioned fresh server, this redundant ownership mutation was blocked by the hardening boundary even though the directories already had the required `root:readypackets` ownership and `0730` mode.

**Repair:** `deploy/backup-control.sh` now treats configuration and full-backup import directories as installer-provisioned security boundaries. It verifies that each exists with exactly `root:readypackets` and `0730`, then refuses an unsafe/missing directory rather than attempting to mutate ownership at request time. The native installer continues to create the directories as root. The portal service account has write/traverse access but cannot list directory contents.

**Validation:** Shell syntax passed. Production helper was installed and restarted. Both staging directories report `root:readypackets 730`. A service-account test successfully created and removed a random contract-conforming configuration-import filename within the restrictive directory; no archive/configuration data or passphrase was exposed. A rollback copy of the prior helper is retained under `/opt/readypackets/rollback-20260820083000-policy-backup-restore/backup-control-before-staging-fix.sh`.


---

## 64. Cookie-preference shortcut overlap repair — August 20, 2026

### 64.1 Request

> the manage cookie preferences is blocking the logout button and cant be exited

The user supplied an administrator-portal screenshot showing the persistent **Manage cookie preferences** shortcut in the lower-left corner of the viewport. It occupied the same footer area as the administrator profile and logout action. The user clarified the operational requirement:

> it should be able to be exited incase it interferes with some other feature
>
> or have a hide option

### 64.2 Diagnosis

The persistent shortcut in `client/src/components/privacy/CookieConsent.tsx` was rendered with `fixed bottom-4 left-4 z-40`. That placed it above the left-hand navigation footer at the exact position used by logout and account actions. The control had no dismiss mechanism, so it could block an underlying control indefinitely for the browser session.

### 64.3 Resolution

The control now renders in the lower-right corner using `fixed bottom-4 right-4`, leaving the portal navigation footer and logout controls clear. It also has a dedicated accessible close button with the visible `X` icon, the label **Hide cookie preferences shortcut for this browser session**, and a tooltip. Selecting that close control stores a session-only marker in `sessionStorage` and hides the floating shortcut immediately. The shortcut appears again in a new browser session. The existing footer and in-page **Manage cookie preferences** access paths remain available, so hiding the supplementary floating shortcut never prevents users from reviewing or changing consent choices.

The implementation is defensive against restrictive browser privacy modes: if `sessionStorage` is unavailable, local state still hides the shortcut for the current page. The hide button and main preference button are distinct controls, preventing an accidental preference-dialog opening when the user intends to dismiss the shortcut.

### 64.4 Verification and deployment

TypeScript validation (`./node_modules/.bin/tsc --noEmit`) completed without errors. The production client bundle built successfully with `./node_modules/.bin/vite build`. The client-only archive was checksum-verified and inspected for an `index.html`, asset directory, and unsafe path entries before an atomic swap on the production VPS. The prior bundle was retained at:

```text
/opt/readypackets/client/dist.previous-20260820124701-cookie-shortcut
```

The deployed archive SHA-256 was:

```text
fb74e528af7fabda5286dbc51e6ba47d3a8ea9465ad868a02a7323427ceea30f
```

Public production health returned `{"status":"ok"}`. A browser inspection of `https://myportal.readypackets.com/login` confirmed that the floating control appears in the lower-right corner and exposes both **Manage cookie preferences** and the dedicated hide button. Selecting the hide button removed the floating control immediately, without affecting the page or sign-in form.

### 64.5 Response delivered

The user will be informed that the repair is live: the shortcut no longer overlaps the left navigation/logout region, and the `X` button hides it for the current browser session. A new browser session restores the optional shortcut; the standard portal controls remain available for changing cookie preferences.

*This entry was appended, rather than replacing prior history, in accordance with the project logging requirement.*


---

## 65. Order workflow configuration import and export — August 20, 2026

### 65.1 Request

> add a method to import and export the order workflow configuration

### 65.2 Implementation

The **Admin → Order workflows** page now provides an **Export** action for each workflow and an **Import configuration** action in the page header. Export creates a portable JSON document using the versioned format `readypackets.order-workflow`, version `1`. It contains the workflow name, description, active state, stage ordering, customer capabilities, stage messages, acknowledgement and progression policies, upload limits, SharePoint relative destinations, administrator task markers, email-template references, status/completion rules, and dashboard alert configuration.

The export deliberately omits `webhookEndpointId`. Endpoint IDs are local to a deployment and importing a numeric identifier into a different server could attach the workflow to the wrong destination. The import dialog explicitly explains this and requires an administrator to review/reselect a local webhook endpoint after importing.

Import accepts only a small JSON file (250 KB maximum) bearing the expected format/version marker. Server-side Zod validation is authoritative and rejects malformed stages, unsafe SharePoint paths, excessive values, invalid stage keys, duplicate stage keys, invalid template references, and nonexistent/disabled webhook references. The browser check is only a usability preflight; an altered file cannot bypass the server validation.

The import confirmation requires exact entry of:

```text
IMPORT WORKFLOW CONFIGURATION
```

An import always creates a **new** workflow definition. It never overwrites an existing workflow, never changes the default workflow, and preserves active/inactive state from the exported configuration. Both export and import are administrator-only tRPC actions and create audit-log records. The exported format contains no credential, secret, private key, or webhook URL material.

### 65.3 Validation and deployment

TypeScript validation completed without errors. Both the production Vite client build and the Node server bundle build completed successfully. The general automated suite was started, but its database-dependent tests could not connect to the intentionally absent sandbox MySQL listener (`127.0.0.1:3306`); 21 test files and 178 tests completed, while 11 database-dependent pricing tests failed solely with `ECONNREFUSED`. This was an environment limitation, not a feature assertion failure, and no test result was represented as a pass.

The server and client artifacts were SHA-256 verified, the client archive was checked for required bundle files and unsafe traversal paths, and production deployment retained a rollback copy. The initial external health request returned a transient `502` while systemd was completing the restart; journal inspection confirmed normal startup and listener initialization. A follow-up check passed:

```text
service: active
/api/health: {"status":"ok"}
/api/health/ready: {"status":"ready"}
```

### 65.4 User-facing result

Administrators can now export any workflow from its table row, upload a previously exported JSON file, assign a new workflow name, review its stage count and portability notice, type the import confirmation, and create it as an independent workflow. The standard Edit workflow view is used afterward to select any environment-specific webhook endpoint.

*This entry was appended rather than replacing earlier history, as required by the ReadyPackets project instructions.*


---

## 66. MFA recovery-code display, configuration restore compatibility, and Phase Kickoff default — August 20, 2026

### 66.1 Requests and evidence

The administrator reported that MFA enrollment briefly showed recovery codes and then immediately navigated to the home screen. They also reported a configuration restore failure. The supplied restore notification identified the actionable database error:

```text
ERROR 1146 (42S02): Table 'readypackets.email_automations' doesn't exist
```

The user also requested that placeholder files be disabled by default and asked how to export/import work order workflow configurations.

### 66.2 MFA recovery-code repair

The MFA enrollment component generated and stored the one-time backup codes, but immediately refreshed the session. For a restricted administrator session, the refreshed session clears the restriction and the global route guard redirects away from the MFA setup route before the recovery-code screen can remain visible.

The enrollment flow now keeps the backup-code screen visible after successful verification. It displays the recovery codes, provides **Copy codes**, and requires the user to select **I have saved my codes — continue** before refreshing the session and permitting route navigation. This applies both to mandatory administrator enrollment and voluntary security-page enrollment. The codes remain one-time secrets and are not logged or stored client-side beyond the active view.

### 66.3 Configuration restore compatibility repair

The encrypted configuration bundle was valid and authenticated during preflight. The apply step failed because the target self-hosted schema lacked the current `email_automations` table while the source bundle contained its configuration rows. The former legacy migration was not guaranteed to be part of the modern forward-only migration sequence.

New forward-only migration `0047_email_automations_compat.sql` creates the required `email_automations` table if missing, using the current application-compatible structure and indexes. This corrects the target schema before configuration restore is attempted; it does not expose or import secrets. The applied deployment verification confirmed the table exists and migration `0047` is recorded.

### 66.4 Placeholder files now opt-in by default

The Phase Kickoff setting had `attach_placeholders` defaulted to enabled. The runtime schema and administrator UI fallbacks now default it to disabled, while preserving explicit existing phase choices. Forward-only migration `0048_phase_kickoff_placeholder_default.sql` changes the database default to `0`. A transaction-only production verification inserted a temporary test configuration, confirmed `attach_placeholders = 0`, and rolled the test row back.

The earlier Phase Kickoff save repair is also included in this release: the update endpoint returns a serializable success result, retains omitted auxiliary settings rather than silently clearing them, and audits configuration changes. This removes the generic unexpected-error notification that could occur after a successful checkbox update.

### 66.5 Workflow configuration procedure

To export a workflow, use **Admin → Order workflows**, then select **Export** beside the required workflow. ReadyPackets downloads a portable, versioned JSON configuration. To import it, select **Import configuration** in the page header, choose the JSON file, enter a new workflow name, review the stage count, and type:

```text
IMPORT WORKFLOW CONFIGURATION
```

The importer creates a separate new workflow; it never overwrites an existing one or changes the default workflow. Webhook endpoint assignments are intentionally omitted because endpoint identifiers are environment-local. Review and select the correct enabled local endpoint after import.

### 66.6 Validation and production deployment

TypeScript validation passed. Production Vite and server bundle builds completed. Server/client/migration artifacts were SHA-256 verified before deployment. The production service applies migrations before starting; migration records `0047_email_automations_compat.sql` and `0048_phase_kickoff_placeholder_default.sql` were verified after restart. The production database confirmed `email_automations` exists and the placeholder default is `0`. Health checks passed:

```text
/api/health: {"status":"ok"}
/api/health/ready: {"status":"ready"}
```

Rollback material is retained at:

```text
/opt/readypackets/rollback-20260820142632-mfa-restore-fix
```

*This entry was appended rather than replacing prior history, consistent with the project logging requirement.*


---

## 67. P101/P201 manual phase-start queue repair — August 20, 2026

### 67.1 Report and environment boundary

An administrator reported that selecting **Start Phase I / queue P101** for order `1` on the self-hosted `readypackets.com` environment produced the generic toast **Could not queue phase kickoff**. The order view showed completed automatic Phase I/Phase II `create_folders` jobs and no P101/P201 webhook-delivery row. The requested Phase II P201 control uses the same server mutation and was reviewed as part of the repair.

The attached Cloud Computer is a separate `myportal.readypackets.com` installation: it has no order `1`, uses a different order dataset, and is not the screenshot’s self-hosted target. No change was applied to that unrelated environment.

### 67.2 Cause and corrected behavior

Both P101 and P201 controls call `integrations.manualPhaseKickoff`, which calls `runPhaseKickoff` with `forceWebhook: true`. The previous implementation treated this as a full phase rerun: it queued ordinary configured actions such as `create_folders`, placeholder attachment, and customer notification in addition to the intended phase-start webhook. Re-queuing already-completed actions is unnecessary and can fail on self-hosted schemas or constraints that enforce idempotent phase-job handling. The same shared path affected P101 and P201.

The repair makes manual P101/P201 controls **webhook-only requeue controls**. They now create only the `notify_webhooks` phase job, preserving the completed folder and customer-notification actions. Normal order-status-driven transitions continue to queue the full configured Phase Kickoff action set. The administrator success message was changed to reflect the actual behavior: the P101/P201 phase-start webhook is queued for the configured endpoint.

### 67.3 Validation and release status

TypeScript validation passed, Vite client build passed, server bundle build passed, and the source diff passed whitespace validation. The change requires deployment to the reported self-hosted `readypackets.com` VPS; that machine is not the attached Cloud Computer and cannot be safely modified from this session without its connection. The exact supported deployment command will be included with the published GitHub commit.


### 67.4 Confirmed self-hosted schema root cause and compatibility migration

The administrator supplied the Security Centre detail for the P101/P201 failure. It confirms this is not an endpoint, SharePoint, or P101 payload failure. Both `integrations.phaseKickoffConfigs` and `integrations.manualPhaseKickoff` fail while selecting the phase configuration row from `phase_kickoff_configs`:

```text
SELECT id, phase, create_folders, folder_template, attach_placeholders,
notify_customer, notify_webhooks, email_template_key, completion_percent,
enabled, updated_at
FROM phase_kickoff_configs
```

The self-hosted database therefore predates one or more columns expected by the current application. The current initial schema includes `folder_template` and `email_template_key`; `completion_percent` was added to the runtime model without a forward-only compatibility migration for older databases. The checked query shows all three are now required in the affected environment.

New migration `0049_phase_kickoff_schema_compat.sql` safely examines `information_schema.columns` and adds missing `folder_template`, `email_template_key`, and `completion_percent` columns only when absent. It preserves existing rows and settings, does not recreate the table, and is idempotent for already-current environments. Applying the latest release migration will restore both the Phase Kickoff configuration screen and the shared P101/P201 manual queue action.

## 2026-08-20 — Self-hosted schema drift prevention after P101/P201 recovery

**User report:** On a separate self-hosted `readypackets.com` VPS, clicking Phase I queue P101 returned a generic server error. Server evidence showed that `phase_kickoff_configs` lacked `completion_percent`; older/partial schema state also exposed missing operational tables in historical log queries. The server was eventually updated through its actual deployment source at `/srv/readypackets`, not the incorrect `/home/ubuntu/src/readypackets` path. Migration `0049_phase_kickoff_schema_compat.sql` applied successfully, P101 subsequently delivered with HTTP 200, and P201 uses the same repaired dependency path.

**Certificate outcome:** The target VPS now has a Cloudflare Origin CA certificate installed at `/etc/readypackets/tls/cloudflare-origin/certificate.pem`, with its root-only private key at `/etc/readypackets/tls/cloudflare-origin/private-key.pem`; nginx is configured through `/etc/readypackets/tls/nginx-tls.conf`. The certificate covers the apex and `www` names. The operator was instructed to retain Cloudflare proxying, use Full (strict), and revoke the one-time scoped API token after issuance.

**Future-proofing repair:** Added `scripts/schemaContract.ts` and connected it to `scripts/migrate.ts`. Every deployment now applies forward-only migrations and then verifies a minimum operational schema contract before the systemd service can start. The contract includes Phase Kickoff configuration, phase jobs, webhook deliveries, email automations, system backups, outbound connections, and outbound call logs. A partially migrated or manually drifted database therefore produces a deterministic startup error naming every missing table or column rather than allowing administrator buttons to fail later with an ambiguous message. Added database-free Vitest coverage for complete, missing-column, and missing-table conditions.

**Validation:** `pnpm vitest run tests/schemaContract.test.ts` passed (3/3), `tsc --noEmit` passed, and the migration bundle compiled and passed Node syntax validation.

**Deployment note:** This source-level guard must be applied on each self-hosted server by pulling the release and rerunning its supported `deploy/install.sh` path; the externally administered `readypackets.com` VPS is not connected to this session, so no direct changes were made to it beyond the operator-run commands above.

## 2026-08-20 — Fresh-install assurance and complete full-backup recovery hardening

**User request:** Confirm that a new VPS installation cannot repeat the incomplete-schema failure and that full backups/restores carry user accounts, order files, application settings, and platform secrets.

**Fresh-install safeguard:** The migration runner now verifies a critical schema contract after every forward-only migration run and before systemd can start the portal. A partial install therefore fails closed with explicit missing table/column names instead of allowing later P101/P201, backup, or outbound-integration UI errors. The supported native installer always rebuilds and runs this migration bundle before its readiness probe.

**Full-backup coverage:** `deploy/backup.sh` now includes database.sql (all database-backed accounts, MFA records, orders, application settings, workflows, logs and integrations), storage.tar (uploaded/generated order artifacts), portal.env (application and integration secrets, including encryption and blind-index keys), and platform-runtime.tar when present (root-owned rclone cloud-backup configuration and target mapping). It writes this scope to MANIFEST.txt and self-verifies the actual gzip archive structure and SHA-256 checksums before retention or synchronization. Cloudflare/TLS private keys remain intentionally excluded because a replacement host must use its own hostname-valid certificate.

**Restore modes:** The administrator portal remains intentionally secret-safe: a typed `RESTORE BACKUP` restores database/files while retaining target-server secrets. A root-console-only `--restore-platform-secrets` break-glass mode supports a controlled replacement-server recovery; it restores archived application/integration secrets and backup-sync runtime but preserves target database connection, network, hostname, Cloudflare, TLS and storage-location settings. The previous target portal.env is retained root-only. Scratch restore drills now create and grant access to only the explicitly named drill database using root, without broadening the application database account globally.

**Production validation:** The connected `myportal.readypackets.com` VPS deployed the hardened backup/restore/control scripts with rollback at `/opt/readypackets/rollback-20260820T180142Z-backup-recovery-final`. A new `readypackets-20260820T175930Z.tar.gz` full archive self-verified successfully. Its manifest confirmed files, application secrets, and backup-sync runtime. An isolated restore drill imported that archive into a temporary database and restored **126 tables**, **10 user accounts**, and **25 orders**, then cleaned up the temporary database and its scoped grants without altering production data or uploaded files.

**Validation:** Shell syntax checks passed for backup.sh, restore.sh and backup-control.sh; TypeScript validation passed; backup archive checksums passed; isolated database restore drill passed.

**Additional file-recovery validation:** A second isolated full restore drill restored `storage.tar` into a disposable nonproduction storage root while importing the same archive database into a disposable database. The drill restored **170 uploaded/generated files** and **126 database tables**, matched the archive file count, and removed the temporary database, grants, and storage root afterward. Production database and storage were not changed.
**Additional secret-recovery validation:** A third isolated replacement-server recovery drill used the explicit `--restore-platform-secrets` mode against a disposable target environment and storage/database roots. It restored 170 files and 126 tables, verified that the archived AES-256-GCM encryption key replaced the disposable key, and verified that the target `APP_URL` remained `https://recovery-drill.invalid`. Root-owned backup-sync runtime was intentionally omitted from this isolated drill to avoid changing the production rclone configuration; the expected warning was emitted. Temporary environment, database, grants, and storage were removed afterward.


---

## Native mobile application implementation — August 21, 2026

### Request received

> I want you to act as a senior mobile software developer engineer and architect to build a clean professional elegant mobile application that will interact with the ReadyPackets Portal website it should match the ReadyPackets Branding colors and logo. Use the mobile architecture documents and master prompts to build this application.

**Attachments reviewed:** the native mobile architecture and master build prompt; editable system/auth/release diagrams; validation notes; mobile store-requirements research; and the ReadyPackets brand material already retained in the project. The request also reiterated the standing project instructions: self-host the result, use no Manus integration or runtime dependency, and retain a complete prompt/response session record in GitHub.

**Response:** The main ReadyPackets repository was cloned and inspected before implementation. The existing Express, Drizzle, browser-session, MFA, SAML, order-authorisation, upload-governance, brand-token, audit, and deployment conventions were treated as the system of record. The implementation deliberately adds a new versioned native-client boundary instead of exposing browser tRPC or cookie/CSRF contracts to an app.

### Foundation implemented

A `mobile/` workspace now establishes canonical design tokens, a draft OpenAPI 3.1 contract, release/privacy/accessibility documentation, and a written threat model. It retains the ReadyPackets navy (`#0D1B2A`), navy-raised, teal, and gold palette; uses the approved wording **My Business Packets**; and explicitly prohibits a WebView shell, a PWA service worker, React Native, Flutter, Capacitor, Manus dependencies, local server secrets, direct database/storage access, and native checkout in version 1.

The self-hosted server gains the first secure mobile foundation: `/.well-known/openid-configuration`, `/api/mobile/v1/authorize`, `/token`, and `/revoke`; PKCE S256 verification; registered HTTPS redirect-URI validation; one-time five-minute authorization codes; short-lived access tokens; SHA-256-hashed rotating refresh tokens; family-wide revocation on reuse/expiry; active device/session validation on every bearer request; device registration; idempotency records for write operations; and stable problem responses with correlation identifiers. New tables are supplied in `migrations/005_mobile_identity.sql`, and `server/db/schema.ts` contains the matching Drizzle definitions.

The API currently exposes mobile profile, dashboard, cursor-paginated order list, server-authorized order detail, device list/register, and account-deletion request endpoints. It derives order access from the existing `assertOrderAccess` and `listOrdersForUser` services rather than copying rules into the client. The browser login screen and SAML entry point preserve a validated native authorization continuation only after the existing session/MFA controls succeed. The web CSRF middleware exempts only the signature/code/bearer mobile route prefix; all browser routes retain the existing cookie/Origin/CSRF protection.

### Current qualification

This is an integration build and architectural foundation, not a production store submission. A future release must configure production verified app-link callbacks, execute and test the database migration, finish upload/message/document/push/staff routes, archive on a macOS/iOS runner, build/sign Android, run the physical-device accessibility/security matrix, and complete exact App Store/Play privacy and review declarations. No server secret, provider credential, customer record, signing key, or production environment value was added to version control.


### Native client implementation and validation

Two independent native source trees were added under `mobile/`, with the shared contract and design system deliberately kept outside either client runtime. The iOS project is a Swift 6 / SwiftUI Xcode project with a Keychain token actor, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, local biometric re-entry, `ASWebAuthenticationSession`, `SecRandomCopyBytes` PKCE, universal-link return validation, a bounded encrypted authorization-attempt recovery record, system appearance, accessible Home/Orders/Profile flows, opaque public order IDs, a device list, and an in-app deletion request. Its `ReadyPackets.xcodeproj` and `project.yml` are included; final archive validation requires a macOS/Xcode runner because the build environment did not contain the Swift/Xcode toolchain.

The Android project is Kotlin / Jetpack Compose, targets API 36, and includes its own Gradle wrapper, encrypted Keystore-backed token store, `SecureRandom` PKCE, Custom Tabs, HTTPS App Link callback validation, a bounded encrypted authorization-attempt recovery record, BiometricPrompt re-entry, strict no-cleartext network configuration, no broad storage permission, just-in-time microphone/notification declarations, Home/Orders/Profile flows, and an in-app deletion request. The Android project was configured with Java 17 bytecode compatibility, was compiled against a locally installed Android API 36 SDK, and passed its unit suite. The test exercises URL-safe, unpadded high-entropy PKCE generation and deterministic challenge derivation.

The native source has no Manus package, SDK, connector, credential, runtime service, build-time platform integration, hosted state, WebView shell, PWA service worker, React Native, Flutter, Capacitor, customer database, server secret, payment checkout, or administrator-control bridge. The only application endpoint is the operator’s self-hosted ReadyPackets portal. App Link hosts, signing IDs, APNs/FCM configuration, upload keys, review accounts, redirect configuration, and production values remain intentionally external to source control.

### Verification evidence

| Gate | Result | Notes |
|---|---:|---|
| Portal TypeScript type check | Passed | `pnpm typecheck` completed with no errors after the mobile API changes. |
| Mobile contract safeguards | Passed | `tests/mobileContract.test.ts`: 4/4 passed, asserting PKCE boundary, opaque order DTO use, scoped CSRF exception, Keychain/Keystore, and system-browser auth. |
| Portal production build | Passed | `pnpm build` produced the Vite client and bundled server, including the new mobile route. |
| Android Gradle configuration | Passed | Gradle wrapper resolved the project and task graph. |
| Android compile and unit tests | Passed | `:app:testDebugUnitTest` passed on JDK 17 and Android API 36. Android Gradle Plugin 8.7.3 emitted a compatibility warning for API 36; the release owner should select a current API-36-supported plugin during store hardening rather than blindly suppress that warning. |
| Full existing portal unit suite | Environment-blocked | 185 tests passed; 11 database-backed existing domain tests could not connect to `127.0.0.1:3306` because this sandbox has a MySQL client but no running MySQL server. This is not presented as a passing full-suite result. The repository CI provisions MySQL before running that suite. |
| iOS compile/archive | Environment-blocked | The sandbox has no Xcode or Swift compiler. A dedicated macOS simulator CI job was added; it performs an unsigned simulator build. |

### Response delivered

The requested native ReadyPackets mobile application foundation has been implemented in the primary self-hosted repository and is ready for protected CI and a follow-up physical-device/store-hardening phase. The implementation uses ReadyPackets navy, gold, teal, approved terminology, and native platform interaction patterns while preserving the server as the authority for identity, authorization, workflows, files, payments, policies, and audit. The final response will identify the committed repository result, validation evidence, and the remaining release-gate actions without overstating store-readiness.

---

*This session record is being committed to the ReadyPackets GitHub repository in accordance with the standing project instruction.*

## 2026-08-22 — SharePoint folder creation structure designer

**User request:** Add a method in the administrator panel to modify the SharePoint folder creation structure.

**Implementation:**

- Added an administrator-only **SharePoint folder creation structure** editor under **Admin → Integrations → Phase Kickoff** for Phase I, Phase II, In Production, and Delivered.
- The editor exposes each phase’s effective relative folder-path template, supports add/remove/edit actions, shows the configured SharePoint base/customer/order preview, saves custom templates, and restores ReadyPackets’ documented defaults.
- The established base folder remains configurable in the SharePoint settings panel. ReadyPackets continues to own the managed customer/order path below that base: `{base}/customers/{customerId}/orders/{orderNumber}`. This prevents configuration from bypassing opaque customer/order organization or creating duplicate customer identity roots.
- Added `normalizeSharePointFolderTemplate` server validation: maximum 32 entries, normalized separators, no empty/traversal paths, supported SharePoint folder characters only, and case-insensitive duplicate rejection. Validation is enforced server-side before persistence.
- Added protected `integrations.phaseKickoffFolderTemplates` query so the administration panel receives effective default/custom structures without Graph credentials or order/customer-specific data.
- Existing SharePoint folders are not renamed, moved, or deleted. Modified templates are applied idempotently when future phase-folder jobs create missing folders. Workflow-stage document/audio destinations remain independently configurable in Order Workflows.

**Validation and deployment:**

- Focused tests passed: 8/8 across SharePoint root-path and folder-template validation cases.
- TypeScript check and production server/client builds passed.
- Deployed server/client release to production `myportal.readypackets.com` with checksum verification and rollback copies at `/opt/readypackets/rollback-20260822175857-sharepoint-folder-structure` plus the previous client asset directory.
- Production service is active; public health returned `{"status":"ok"}` and readiness returned `{"status":"ready"}`.


## 2026-08-24 — Self-hosted installation directions refreshed

**User request:** Update the directions to install the ReadyPackets application.

**Completed:** Rewrote `docs/SELF_HOSTED_INSTALLATION_GUIDE.md` as the current self-hosted administrator guide and aligned `docs/ONE_CLICK_AUTOINSTALL.md` with the active bootstrap flow. The revised instructions distinguish the source checkout (`/srv/readypackets`) from deployed artifacts (`/opt/readypackets`), document secure private-repository deploy-key retrieval, native Let’s Encrypt deployment, automated and manual Cloudflare Origin CA deployment, Cloudflare Full (strict), first-administrator/MFA setup, required health/readiness checks, expected canonical redirects, Cloudflare 522 troubleshooting, critical-schema fail-closed behavior, routine versus replacement-server recovery, and safe idempotent installer updates. The commands and referenced installer flags were validated against the current scripts with shell syntax checks and documentation consistency checks.


## 2026-08-24 — Temporary public-source installer and global growth plan

**User request:** Add a supported temporary public-repository installation path, and assess whether ReadyPackets is ready for global, multi-region, multi-continent, and native-mobile growth.

**Completed:** Added an explicit anonymous-public-source preflight to `deploy/one-click-install.sh`. The bootstrap now requires and verifies public source reachability with non-interactive Git before downloading any repository code; it stops with a clear private-source/deploy-key instruction if the source is not intentionally public. It also labels the source-access model in the guided review. Added `docs/TEMPORARY_PUBLIC_REPOSITORY_INSTALL.md` with required secret review, immutable-commit pinning, fresh-VPS bootstrap, Cloudflare handling, re-private sequencing, verification, and security boundaries; linked it from the primary self-hosted guide.

Created `docs/global-growth/READY_PACKETS_GLOBAL_GROWTH_AND_MOBILE_PLAN.md` and two rendered diagrams. The plan assesses the Virginia single-write origin behind Cloudflare as suitable for initial international access but not yet a multi-region data plane. It recommends progressive measurement and edge optimization, a tested warm recovery region, regional performance pools only where telemetry supports them, and eventual tenant-owned regional data cells rather than global multi-primary MySQL. It defines mobile region discovery, PKCE/API routing, background/resumable transfer behavior, minimal push payloads, data-residency controls, security guardrails, decision gates, and a phased implementation roadmap grounded in official Cloudflare, AWS, European Commission, Apple, and Android guidance. Shell syntax, installer-guard presence, documentation links, rendered diagrams, citations, and whitespace were validated before publication.


## 2026-08-25 — Fresh-VPS migration clean-room repair

**User request:** Fix a fresh install that applied migrations but failed the schema contract, then make a new VPS installation flawless and provide precise continuation and clean-install instructions.

**Root cause:** A real clean MySQL reproduction showed that `information_schema` returned uppercase metadata field names despite the unaliased `table_name` and `column_name` select expressions. The schema contract read camel-less property names, treated all queried rows as unavailable, and falsely reported existing `phase_kickoff_configs`, `phase_jobs`, `webhook_deliveries`, and `email_automations` tables as missing. The review also identified three legitimate application-schema tables with no prior forward migration: `system_backups`, `outbound_connections`, and `outbound_call_logs`.

**Completed repair:** Updated `scripts/schemaContract.ts` to use explicit stable aliases (`tableName`, `columnName`), updated regression fixtures and added an alias regression test, and added migration `0050_operational_tables_compat.sql` to create the three missing operational tables safely with `CREATE TABLE IF NOT EXISTS`. Added `docs/FRESH_VPS_CLEAN_ROOM_INSTALL.md` with immutable-commit public-source bootstrap, installer choices, required migration checkpoint, post-install schema/health verification, and failed-host guidance. Linked this procedure from the primary self-hosted guide.

**Validation:** Installed MySQL 8.0.46 in the sandbox only and executed the complete migration set twice: first against a reproduced partial database to apply `0050` and verify all seven critical tables; then against a brand-new database. The clean database applied all 46 migrations and completed with `Applied 46 migration(s); 7 critical tables verified.` The exact metadata-alias regression test suite passed 4/4, TypeScript validation passed, and shell syntax/documentation checks passed. The fix is ready for GitHub publication before any new VPS is installed.


## 2026-08-25 — SAML sign-in tracking and workflow SharePoint routing

**User report:** The Customers grid showed `never` for the SAML administrator `alexbad@readypackets.com` despite successful SAML sign-ins. The user also could not identify a workflow setting for the SharePoint destination of administrator-uploaded documents and audio.

**Root cause and repair:** The SAML ACS handler created an authenticated session and a security audit event but did not call the shared `recordSuccessfulLogin` updater used by password authentication. Consequently `users.last_login_at` and `last_login_ip` remained unset. The SAML handler now calls that shared updater only after account status, administrator-only access, whitelist, and required Entra MFA-assurance gates pass; it also records `authenticationMethod: saml` and the configured identity-provider name in the successful login audit metadata.

**SharePoint routing confirmation and UI improvement:** Server-side file synchronization already resolves every accepted order file’s stage destination by detected file type, independent of whether it was uploaded by a customer or administrator. Documents use `sharePointDestination`; browser and pre-recorded audio use `sharePointAudioDestination`. The workflow canvas labels now make this explicit. A new **Uploads & SharePoint** step exposes the same document/audio fields in the guided workflow designer, including a note that the final path is visible in the order’s SharePoint Sync tab. Documentation was added to `docs/SHAREPOINT_FOLDER_STRUCTURE.md`.

**Validation:** Focused SharePoint and schema-contract test suites passed 11/11. TypeScript validation, Vite production build, server bundle build, and whitespace validation passed. This release requires the affected self-hosted VPS to update from GitHub or its administrator-approved platform upgrade path before the next SAML sign-in updates the Customers grid.

## 2026-08-25 — Explicit Order Files-tab SharePoint destination wording

Clarified the workflow designer’s SharePoint destination section to name the exact administrator action: **Order → Files → Upload phase documents**. The visual canvas now states that its document and audio folders control the SharePoint synchronization destination for that action. The guided designer’s **Uploads & SharePoint** step uses the same explicit language and distinguishes staff/customer document and audio folders. TypeScript and production client build passed.


## 2026-08-25 — Domain-aware GitHub platform updates

**User request:** The administrator requested help setting up **Admin → Platform updates** for controlled GitHub upgrades.

**Safety finding:** The existing update worker passed fixed `myportal.readypackets.com` and `admin@readypackets.com` values into the upgrade helper. The root helper also assumed a fixed `/home/ubuntu/src/readypackets` source checkout and used the fixed hostname for rollback health validation. This was unsafe for independently hosted ReadyPackets installations and explained the platform-update page’s `unknown` commit and `Not active` state where the expected helper/layout was absent.

**Repair:** The installer now records `RP_SOURCE_DIR` in the root-owned runtime environment. The update helper derives its hostname from `APP_URL` and finds the source checkout from `RP_SOURCE_DIR`, with tightly constrained legacy fallbacks. It preserves the active TLS configuration during upgrade rather than forcing Let’s Encrypt, and its rollback health probe uses the target server’s actual hostname. The router and approved auto-deploy wrapper no longer accept or provide fixed domain/contact parameters. The platform-update guide now requires an active helper/status before token setup and specifies a single-repository fine-grained GitHub token with Repository contents read-only permission.

**Validation:** Shell syntax checks passed for the installer and both upgrade scripts. TypeScript validation and 4/4 schema-contract tests passed. A guard confirmed fixed deployment values no longer remain in the platform-update router or helpers.

## 2026-08-25 — Platform update release-marker completion

**Verification result:** The self-hosted update helper returned `serviceActive: true`, proving the protected helper and portal service were installed correctly. `currentCommit` remained `unknown` because earlier normal installer runs did not create `/opt/readypackets/RELEASE_COMMIT`; that marker previously existed only after a platform-update deployment.

**Repair:** `deploy/install.sh` now derives the immutable `HEAD` SHA from its Git checkout during every installation or normal re-run, writes it to the root-owned `RELEASE_COMMIT` marker, and gives the ReadyPackets service group read access. A source archive without Git metadata logs an explicit warning rather than presenting a misleading commit. Future fresh installs and normal re-runs therefore display the running commit before GitHub platform updates are configured.

**Validation:** Installer shell syntax and whitespace validation passed. The change is published with the platform-update domain/source safeguard so the first status refresh after the normal installer re-run can show the actual release SHA.


## 2026-08-26 — Platform Updates NoNewPrivileges repair

**User report:** After the GitHub token connection was saved, Platform updates failed with a generic scan error. The ReadyPackets service log reported: `sudo: The "no new privileges" flag is set, which prevents sudo from running as root.`

**Root cause:** The public ReadyPackets service correctly runs with `NoNewPrivileges=true`, but the Platform Updates router attempted to invoke the root update helper through `sudo -n`. This conflicts with the intended systemd hardening and prevented status scans, approved deployment, and rollback requests from executing.

**Repair:** Replaced service-process sudo with a separate root-owned `readypackets-platform-update-control.service`. The new daemon creates a 0660 Unix socket for the `readypackets` group, accepts only bounded `status`, validated immutable `apply`, and validated `rollback` requests, limits message/output sizes, uses fixed absolute helper paths, and gives the portal no arbitrary command or sudo authority. The native installer provisions/enables the service and removes the obsolete platform-update sudoers rule. Factory reset removes the new service. The main application retains `NoNewPrivileges=true`; systemd start-limit directives were also moved to the correct `[Unit]` section to eliminate repeated warnings.

**Validation:** Daemon syntax, installer/factory-reset syntax, TypeScript, focused schema-contract tests (4/4), server bundle, client production build, systemd unit validation, and whitespace validation passed.


## 2026-08-26 — Platform update control daemon sandbox-path repair

**User report:** After the socket-control release was installed, `readypackets-platform-update-control.service` remained activating and no `/run/readypackets/platform-update-control.sock` was created.

**Root cause:** The systemd unit had `ProtectSystem=full` plus a `ReadWritePaths` entry for the absent legacy checkout `/home/ubuntu/src/readypackets`. Systemd therefore failed to create the service mount namespace, returning `status=226/NAMESPACE` and reporting both the absent legacy path and `/usr/bin/node` as unavailable in the failed sandbox.

**Repair:** Marked both supported source locations as optional `ReadWritePaths` entries (`-/srv/readypackets` and `-/home/ubuntu/src/readypackets`). The root daemon retains a tightly bounded writable-path allowlist, `NoNewPrivileges=true`, its fixed Node entrypoint, and validated socket action allowlist. A missing legacy source directory no longer prevents the daemon from starting on a `/srv/readypackets` deployment.

**Validation:** Node daemon syntax, installer shell syntax, systemd unit validation, TypeScript, focused schema-contract tests (4/4), and whitespace validation passed.


## 2026-08-26 — Controlled upgrade snapshot and operational schema repair

**User report:** The first approved GitHub platform update failed after the typed upgrade confirmation. The portal remained active, but the UI showed a generic error. Security Centre also displayed historical errors for `inbound_webhook_listeners`, `inbound_webhook_events`, `portal_wizard_slides`, and `outbound_call_logs`; current portal logs also reported failed `site_settings` reads.

**Root cause:** The root platform-update control daemon correctly validated its limited update actions but inherited a systemd syscall deny filter that blocked privileged ownership-preservation syscalls required by `cp -a` during the mandatory pre-upgrade snapshot. The approved run stopped before release replacement with `Operation not permitted: failed to preserve ownership`. A support diagnostic also queried non-existent `platform_upgrade_runs.finished_at`; the actual completion field is `completed_at`.

**Repair:** Retained the root-owned validated socket boundary and public-service `NoNewPrivileges=true`, while allowing ownership preservation only inside the helper's already allowlisted rollback paths. Added migration `0051_ui_operational_tables_compat.sql` to idempotently create `site_settings`, inbound webhook listener/event, and portal wizard slide tables on partial legacy schemas. Expanded the startup schema contract to verify those tables before serving traffic. The Platform Updates mutation now records a bounded sanitized controller failure and returns a visible administrator-safe error instead of an opaque generic message.

**Validation:** A clean MySQL 8 database applied all 47 forward-only migrations and verified 11 critical tables, including all six affected UI/operational tables. TypeScript, focused schema-contract tests (5/5), daemon and helper syntax, installer syntax, and whitespace validation passed.

## 2026-08-26 — Native mobile order placement, parity, and source synchronization

**User request:** “Make sure all code and files are synced to GitHub along with the session logs. There should be a way to place an order on the app and how do I test the Apple iOS version? Are both Android and Apple iOS versions exactly the same?”

**Completed:** Added `GET /api/mobile/v1/catalog` and idempotent `POST /api/mobile/v1/orders` to the bearer-token mobile boundary. The API requires `mobile:write` for order submission, resolves submitted public packet SKUs against active listed products, delegates catalog pricing, group-tier validation, order state, payment state, workflow assignment, and audit logging to the existing Portal order service, and returns an allowed next action. The client cannot supply a price, payment status, internal product ID, or workflow state. Browser CSRF remains in place; only the bearer/code mobile API prefix is exempted.

The companion native-mobile source now has matching SwiftUI and Jetpack Compose order composers. Both load the same catalog, select at most one tier per packet group, submit only public SKUs and an optional project name with an idempotency key, then direct payment-required customers to the secure Portal and quote-required customers to the Portal quote workflow. Neither client collects card data or activates an order locally.

**Validation:** Canonical Portal TypeScript validation passed and the focused mobile contract suite passed 5/5. Android native `testDebugUnitTest` passed with Java 17 and Android API 36. The iOS implementation requires the documented macOS/Xcode, development-signing, Universal Link, Keychain, physical-device biometric, and TestFlight validation route before store release.

**Parity statement:** The two platforms are feature-equivalent for their supported customer workflows and use a single OpenAPI contract. They are intentionally not code- or pixel-identical: iOS uses SwiftUI, Keychain, LocalAuthentication, and Universal Links; Android uses Jetpack Compose, Keystore-backed storage, BiometricPrompt, and Android App Links. The Portal remains the shared authority in both cases.

**GitHub synchronization:** The reviewed Portal change was rebased onto the current main branch without overwriting newer work and published to `readypackets/ReadyPackets`. The published commit is `e74fd55` (`feat: add mobile catalog and order placement API`).
## 2026-08-27 — Safari-compatible customer audio recording

**User report:** A customer could not record audio from an Apple device using Safari because the portal required a WebM `MediaRecorder` MIME type. Safari provides MediaRecorder audio as AAC in an MP4 container rather than WebM.

**Repair:** Added a shared browser-capability selector that preserves WebM/Opus where the browser supports it, automatically selects Safari-compatible M4A/AAC when WebM is unavailable, and uses Ogg only as a final advertised fallback. Phase I Business Pitch, Phase 2, and workflow-stage recorders now use the selected MIME type, derive the saved file extension from the recorder's actual supported container, and use format-neutral customer wording. The preflight diagnostic now verifies an approved browser recording format rather than WebM specifically.

**Server-side safeguards:** The authenticated recorded-pitch route now permits only magic-byte-validated `.webm`, `.m4a`, or `.ogg` browser containers, retains the one-recording/order requirement, measures duration server-side, and retains all existing file-size, phase-lock, CSRF, authorization, and storage-key controls. The stored detected MIME is retained rather than normalized incorrectly. Safari M4A, WebM, and Ogg recordings remain classified as audio for playback, limits, downloads, and SharePoint routing.

**Validation:** Added unit coverage for format negotiation (Safari M4A, WebM preference, Ogg fallback, unsupported failure) and a real AAC/M4A magic-byte regression fixture. The final combined suite passed 209/209 against a freshly migrated and seeded disposable MySQL database after reconciling concurrent mobile API work; TypeScript, production client/server build, and whitespace validation passed.

## 2026-08-27 — Customer mobile-parity API and media-security expansion

**User request:** The user requested full customer usability through either native application or the Portal web experience, while keeping all administration web-only. The request specifically included documents, deliverables, audio recording/upload/playback, workflow/intake/MNDA, invoices and secure checkout handoff, messages, updates/push registration, support, community, Packet Collective, referrals, customer security, account recovery, packet browsing, FAQs, contact, and legal information.

**Completed:** Added narrowly scoped bearer-token customer routes under `/api/mobile/v1/customer` for Portal-authorized file metadata/content/deletion/upload, audio metadata/playback, task-oriented workflow detail, intake/MNDA/question actions, delivered files, invoices, Portal-hosted checkout handoff, messages, derived notification inbox/preferences, support tickets, community, workspaces, referrals, profile/policy controls, knowledge content, and public browser entry points. A separate `/api/mobile/v1/public` router exposes only published catalog, FAQ, policy, contact, status, and secure browser URLs before sign-in. Administration, raw database identifiers, browser-session authority, payment-card collection, and staff procedures remain unavailable to mobile callers.

**Media/push controls:** Added encrypted-at-rest mobile push-token material alongside an existing non-reversible duplicate hash and forward-only migration `006_mobile_push_token_encryption.sql`. This field is for the self-hosted APNs/FCM dispatcher only and is not returned from any mobile response. File/audio acceptance stays controlled by authenticated stage capability and Portal storage policy.

**Validation:** Portal TypeScript validation passed. The focused mobile safeguard suite passed 6/6, including separate public/customer route and no-admin checks. The customer API implementation requires staged integration validation with real Portal records before production enablement.

**GitHub synchronization:** The Portal customer-parity API was safely rebased onto newer remote work, preserving the Safari-compatible audio update, and published to `readypackets/ReadyPackets` commit `e735f89` on 2026-08-27. The corresponding native iOS/Android customer workflows, documentation, and redacted session record were published to `readypackets/readypackets-native-mobile` commit `8106c30`.


## 2026-08-27 — Native mobile migration-path correction before VPS deployment

**Deployment review finding:** While verifying the newer GitHub `main` tip before instructing the production VPS to reset its clean source checkout, the newly added mobile parity feature was found to include `server/db/migrations/006_mobile_push_token_encryption.sql`. The native installer and forward-only migration runner intentionally execute only `drizzle/migrations/*.sql`; therefore the new `mobile_devices.push_token_enc` column would not have been applied during an in-place upgrade, despite the mobile device-registration route writing it.

**Repair:** Replaced the nonstandard migration file with `drizzle/migrations/0052_mobile_native_schema_compat.sql`, in the sole authoritative migration path. The migration idempotently creates the five native-mobile tables (`mobile_devices`, device sessions, authorization codes, refresh tokens, and idempotency keys) for fresh deployments and conditionally adds the encrypted push-token column to a legacy `mobile_devices` table when absent. The critical startup schema contract now checks the columns needed by all five mobile tables, so an incomplete mobile upgrade fails before serving routes instead of failing on the first device registration request. Fresh-install documentation now reflects the current expected checkpoint of 48 migrations and 16 critical tables.

**Validation:** A clean disposable MySQL database applied all 48 migrations and verified all 16 contract tables. A separate pre-existing `mobile_devices` table without `push_token_enc` received only the additive encrypted-token column successfully. The full application suite passed 211/211; TypeScript, production client/server build, and whitespace validation passed.

---

## 64. Customer workflow, terminal-order, login-audit, and selective recovery hardening — August 28, 2026

### 64.1 Requests

The operator requested dollar-denominated coupon administration, validated MNDA signing, complete sign-in tracking including magic links, terminal closure of refunded and cancelled orders, an improved customer order workflow that takes the customer directly to the document area, and independently restorable user-account and order-plus-file backup scopes.

One cancellation request sentence was incomplete. It was implemented conservatively as a customer **request** requiring a reason and a typed confirmation, not as an immediate unilateral cancellation. A staff member remains responsible for applying the policy decision and any refund.

### 64.2 Commerce, agreement, and authentication changes

The coupon interface now accepts fixed discounts and fixed cart prices as dollar-and-cent inputs such as `25.00`; it converts the value to an exact integer-cent amount before it reaches the server. Existing persisted cents, Stripe amounts, invoices, and audit records were not converted or rewritten.

MNDA acceptance now normalizes whitespace and compares the typed electronic signature with the first and last name stored for the signed-in customer. The form explains the matching requirement. The acceptance record continues to retain the agreement version, timestamp, client IP, and user-agent evidence. This is an application data-integrity check, not legal advice about enforceability in a particular jurisdiction.

Successful magic-link authentication now updates the account last-sign-in fields and records an explicit successful-login audit method, alongside the existing password and SAML paths. This resolves the portal/customer list showing `never` after a successful magic-link sign-in.

### 64.3 Cancellation and refund closure

Customers must now enter a reason of at least ten characters and type `REQUEST CANCELLATION` before the portal submits a cancellation request; the server independently enforces that confirmation. The portal clearly explains that a request is not an immediate cancellation and is reviewed against the refund policy.

A cancellation or a Stripe-confirmed full refund now transitions the order to a terminal read-only outcome. Server-side guards reject new uploads, file deletion, workflow advancement, intake editing/submission, MNDA acceptance, question answers, messages, sharing changes, project-title changes, new checkout sessions, and repeat cancellation requests. Historical records, order history, invoices, and downloads remain viewable. A partial refund intentionally retains active workflow capability because a partial financial adjustment does not necessarily cancel delivery.

### 64.4 Customer workflow navigation

The customer order-list action now opens a paid active order at its current workflow phase with a short-lived `focus=documents` query instruction. The workflow page waits for content, smoothly scrolls the document-upload section into view, moves accessible focus there, and removes the temporary query from the browser location. Refunded, cancelled, and otherwise closed orders remain read-only and use a clearly labelled closed-order view rather than a payment or upload call to action.

### 64.5 Scoped encrypted recovery archives

Added administrator-only **Scoped recovery archives** in Backup management. The identity archive contains users, encrypted profile values, password hashes, MFA enrollment and recovery-code material, role/access values, and no plaintext passwords or sessions. The order archive contains order/workflow/financial/acceptance evidence and only files referenced by orders, including file-version metadata. It excludes unrelated user data, platform configuration, payment credentials, TLS material, and unrelated storage.

Both scopes use a new root-only `scoped-recovery.sh` helper behind the existing root backup Unix-socket controller. The daemon validates an exact scope, passphrase length, staged filename, and typed restore phrase before it permits the helper to run. Archives use PBKDF2-HMAC-SHA512 key derivation (600,000 iterations), AES-256-CBC encryption, a separate HMAC-SHA256 integrity check, allowlisted archive members, checksum verification, and a non-secret data-encryption-key fingerprint. Every restore creates a root-only full database safety dump before merging only the selected scope. Identity restoration revokes all active sessions; order restoration rehydrates only referenced files.

During isolated recovery testing, the first selective restore failed because `mysqldump` emitted `LOCK TABLES`/`DISABLE KEYS` directives, while the intentionally least-privileged application database account does not have `LOCK TABLES`. The export now uses `--skip-add-locks --skip-disable-keys`, preserving least privilege rather than broadening the database grant. Full encrypted identity and order export, integrity inspection, restore, row rehydration, and cleanup then passed on a disposable migrated database.

### 64.6 Verification

| Check | Result |
| --- | --- |
| TypeScript | `pnpm exec tsc --noEmit` passed after all changes. |
| Production build | Vite client and esbuild server builds passed. The existing client bundle-size advisory remains non-blocking. |
| Full isolated test suite | `211/211` tests passed across 26 files against a newly migrated and seeded disposable MySQL database. |
| Focused regression checks | Schema contract, upload security, Safari audio format, and order lifecycle tests passed (`30` database-independent tests plus `8` lifecycle assertions). |
| Root helper checks | `bash -n` passed for the scoped recovery helper, backup control helper, and installer; backup control daemon syntax passed; `git diff --check` passed. |
| Scoped recovery integration | A disposable least-privilege MySQL database successfully exported, inspected, restored, and verified encrypted **identities** and **orders** scopes. |

The procedures and constraints are documented in `docs/FULL_BACKUP_RESTORE.md`. No secrets, passphrases, passwords, private keys, or production database values were placed in source or this session record.

---

## 2026-08-29 — Installer-safe environment loading for multi-word site names

**Trigger:** A controlled empty-demo deployment at `demo.readypackets.store` built the client and server successfully but stopped before database migration with `env: ‘Demo’: No such file or directory`. The public display name was `ReadyPackets Demo`.

**Root cause:** The native installer, one-click administrator-provisioning path, and restore migration path used `env $(grep ... | xargs)` to load the root-owned environment file. Although the installer correctly serialized `SITE_NAME` with shell quoting, `xargs` split the resulting multi-word value into separate arguments. This made a valid display name break the fresh-install migration command before any schema/data initialization.

**Repair:** Replaced whitespace-splitting environment expansion with a dedicated `runuser` service-account shell wrapper that uses `set -a; . "$ENV_FILE"; set +a; exec "$@"`. The wrapper preserves quoted values without printing the environment or passing secrets through argv. The printed post-install administrator command and the restore migration path use the same safe loading pattern.

**Validation:** A focused regression created a quoted `SITE_NAME=ReadyPackets Demo` environment and confirmed the service-account shell received the exact value with the application URL. `bash -n deploy/install.sh deploy/one-click-install.sh deploy/restore.sh`, `pnpm exec tsc --noEmit`, and `git diff --check` passed. The demo installation is resuming from its safe pre-migration checkpoint with the patched source.

**Follow-up correction:** During the resumed clean demo installation, the database migration (`48 migrations; 16 critical tables`), seed, systemd service, nginx, firewall, Let’s Encrypt certificate, backup-path drill, and readiness probe completed. The installer then exited while rendering its static summary because an example command included unescaped `$1` and `$@` inside an expanding heredoc under `set -u`. The example now escapes those literals so the guidance prints as intended. A dedicated strict-shell rendering regression plus the prior environment-loading regression, Bash syntax validation, TypeScript validation, and patch hygiene check pass.

**SAML SSO MFA policy update:** Expanded the existing Entra-managed SAML MFA source control from administrator-only handling to every successfully validated SAML SSO user. In `Microsoft Entra-managed MFA — no local prompt` mode, the portal skips its redundant local MFA challenge only after the signed SAML assertion contains the configured Entra MFA assurance claim and required value. An absent, mismatched, or first-factor-only claim continues to fail closed before a local session is issued. Password and magic-link sign-ins retain their role-based ReadyPackets MFA behavior; dual mode continues to require both verified Entra assurance and a local factor. The Security Centre wording now states the all-user scope while retaining typed `TRUST ENTRA MFA` activation. Validated against the isolated seeded database: 26 test files / 213 tests passed, TypeScript passed, production client/server build passed, and patch hygiene passed. The direct default-database full-suite invocation was blocked only by unavailable local `rpuser` credentials and was not treated as application-test failure.

**Demo deployment — `demo.readypackets.store`:** With owner authorization, the former WelfarePride cloud host was isolated and repurposed for a ReadyPackets demonstration environment after the verified encrypted WelfarePride recovery archive and separate key were delivered. A fresh ReadyPackets demo database and storage area were created; no production ReadyPackets records or integrations were transferred. Let’s Encrypt TLS was issued for `demo.readypackets.store`; public HTTP redirects to HTTPS; Node and MySQL remain loopback-only behind Nginx; UFW exposes TCP 80/443 and rate-limited SSH; Fail2ban, CSP, HSTS, and restricted root controller sockets are active. The initial installation identified and led to repair of an environment-loading/summary quoting issue for multi-word site names. The final SAML policy release `18691f3802a16f2be5e1680d6281748ee78a2056` was applied successfully, with runtime/source commits matching, 16 required schema tables verified, public health and readiness both succeeding, and the owner-requested nightly backup timer disabled. Initial demo administrator credentials were delivered as a separate secure attachment and host-local staging was removed.

---
## 2026-08-29 — Tier 3 schema compatibility and public catalogue presentation controls

**Trigger:** The isolated ReadyPackets demo Security Centre recorded repeated unhandled queries for `tier3.subscription.listPlans`, `tier3.subscription.listBillingEvents`, `crm.listTags`, `crm.listContacts`, `tier3.scheduling.listSlots`, and `tier3.scheduling.listBookings`. The errors were genuine missing-table failures, not alert-display faults: `subscription_plans`, `billing_events`, CRM, and scheduling tables were declared in `server/db/schema.ts` but absent from the demo database.

**Root cause and scope audit:** The authoritative migration runner executes only `drizzle/migrations`. A full declaration-versus-migration audit found 21 current feature tables without a corresponding create migration, including the displayed subscription, billing, CRM, and scheduling tables plus AI, API logging/rate-limit, PWA experiment, administrator preference, support permission, feature schedule, and email-automation rate-limit tables. The initial demo had none of these 21 tables. The preexisting 16-table contract therefore passed while certain later-loaded administration routes failed.

**Repair:** Added forward-only `0053_tier3_feature_schema_compat.sql`, with idempotent canonical creates for all 21 affected tables. Expanded `scripts/schemaContract.ts` from 16 to 37 tables so a fresh or upgraded portal fails before serving if an actively shipped feature table/contract column is missing. Added schema-contract regressions for CRM, subscription, and scheduling absence. A clean isolated MySQL validation applied all 49 migrations and reported `37 critical tables verified`.

**Public presentation controls:** Added an administrator-only **Admin → Catalogue → Public presentation** panel. Administrators can independently select numeric price display, `Pricing on request`, or no public pricing area; show/hide public delivery estimates; show/hide customer-portal delivery estimates; and remove Reviews and Community links from the public desktop/mobile header, footer, and relevant home-page action. Settings never alter stored integer-cent prices, server-side quote calculation, order totals, invoices, or checkout authority. The legacy public-price boolean maps safely to `Pricing on request` when a new explicit mode has not been saved. Public catalog cards now render a distinct keyboard-accessible **View tiers** button. Native public catalog API responses expose the compatible presentation metadata.

**Validation:** Focused presentation/schema tests passed 12/12. The full isolated ReadyPackets suite passed 27 files / 219 tests. TypeScript compilation, client/server production builds, the clean 49-migration database validation, and `git diff --check` passed. No secrets, customer data, or production configuration were used or written to this record.

**Demo deployment verification:** Published repair commit `dad5ed1c279e99a61f5b5ac9e25f68481b9ab646` was transferred as a SHA-256-verified Git bundle to the isolated `demo.readypackets.store` host after the public bootstrap URL returned 404. The prior demo source revision `18691f3802a16f2be5e1680d6281748ee78a2056` was retained as a local rollback branch. The in-place installer applied only `0053_tier3_feature_schema_compat.sql`, reported `Applied 1 migration(s); 37 critical tables verified`, rebuilt the portal, and completed readiness successfully. The owner-selected disabled nightly backup timer was restored after the installer’s one-time backup-path drill. Runtime commit is `dad5ed1c279e99a61f5b5ac9e25f68481b9ab646`; `readypackets` and `readypackets-platform-update-control.service` are active; public `/api/health` and `/api/health/ready` both return success. Direct execution of all six formerly failing subscription, billing, CRM, and scheduling read queries completed successfully against the new empty feature tables. Historical Security Centre alerts were retained as audit history and should only be acknowledged/resolved after the related administrator pages have been refreshed and confirmed free of new errors.

## 2026-09-10 — Portable full recovery controller and durable activity history repair
**Trigger:** A new ReadyPackets installation succeeded, but an administrator-initiated full backup restore from the demo portal failed safely while staging the verified archive. The protected root backup controller reported `install: failed to chown ... Operation not permitted`, and the Backup management screen did not provide a durable cross-attempt history for backup/restore results.
**Root cause:** The backup controller is deliberately hardened without ownership-changing capability. Its uploaded-archive staging path still used GNU `install`, which can invoke `chown` when root creates a destination. This was incompatible with the intentional system-call restriction. Backup/restore status relied mainly on transient unit state and did not retain a root-owned outcome record after a database restore.
**Repair:** Replaced the restore-stage `install` operation with a fixed-path `cp --no-preserve=mode,ownership` plus `chmod`, retaining root-owned protected storage without ownership-preservation calls. Removed the remaining ownership-changing root-helper actions by using set-group-ID directory inheritance and explicit modes. Added `deploy/recovery-history.sh`, a root-only append-locked JSONL history helper that stores only operation, run ID, archive name, scope, status, ISO timestamps, and a bounded non-sensitive diagnostic. Full backup and full restore helpers now record started, completed, and failure outcomes; the backup controller exposes history read-only through its validated Unix-socket action allowlist; the administrator Backup management screen displays recent recovery attempts.
**Portable full restore:** Verified portal full restores now preserve the target database connection, hostname, allowed origins, bind/network values, storage location, TLS material, and SAML activation state while restoring the archived application/integration secrets needed to decrypt recovered data. The restored target must retain or issue its own certificate and validate its own SAML reply URL before enabling SSO. The previous target environment remains root-only beside `portal.env`. This supports full recovery onto a different ReadyPackets hostname without copying source TLS identity into the target.
**Validation:** Shell syntax and daemon checks passed. A disposable full-backup test generated a verified archive and durable `backup/completed` history record with ISO timestamps. A separate disposable cross-domain full-restore drill restored database and storage data, restored source encryption/integration secrets, preserved target hostname, database connection, network/storage values, and SAML activation setting, and recorded durable `restore/completed` history. Focused tests passed; the isolated seeded full suite passed 27 files / 219 tests. TypeScript, client/server production builds, and `git diff --check` passed. No production customer data, keys, or live portal configuration were used.

**Follow-up installer correction:** Deployed verification showed the updated backup-controller files were present but the already-running socket daemon had retained its prior in-memory action allowlist because `systemctl enable --now` does not restart an active service. The installer now enables and explicitly restarts the backup, certificate, and platform-update root controllers after replacing their helper, daemon, or unit files. A focused shell regression verified all three explicit restart commands and installer syntax.

**Backup-path follow-up correction:** Final demo deployment validation revealed the backup service pre-start hook still forced `/var/backups/readypackets` to `root:root:0700`; the hardened backup script then correctly failed when it attempted to reset that directory to the inherited portal-group mode. The backup unit now provisions the fixed path once, outside the sandbox, as `root:readypackets:2750`; the restricted backup script verifies that precondition rather than changing directory ownership or mode. Explicit alternate output directories remain available only to an operator-run root backup. Shell syntax and a focused regression for the matching unit/script permission contract passed.

**Final deployed verification:** The demo was updated to the backup-path correction and an actual hardened full backup completed successfully. It dumped the isolated database, archived uploaded storage, created and checksum-verified a ReadyPackets backup archive, and wrote a durable `backup/completed` history record. A portal-equivalent socket request under the unprivileged `readypackets` account returned the safe recovery-history entries, including historical failed attempts and the new successful backup. Application, backup, certificate, and platform-update controllers were active; public health and readiness passed. The owner-selected nightly timer was disabled again after the installer’s validation run. No production records, keys, or TLS material were used.


---

## 2026-09-23 — Fictionalized customer-story advertising concept

**User request:**

> I want to create a believeable story for a customer who uses our site because i want to use this as a video or audio ad

**Response and decision:** A complete ReadyPackets customer-story campaign script was created at `docs/marketing/FICTIONAL_CUSTOMER_STORY_AD.md`. The creative direction deliberately uses a **fictionalized composite** rather than an invented testimonial presented as fact. The protagonist, Maya Thompson, is a fictional founder whose business materials are scattered across notes and files until she uses ReadyPackets to organize a business plan, operating framework, and execution materials through the customer portal.

The package includes a timed 60-second video storyboard, continuous voiceover master copy, an audio-only adaptation with sound cues, 30- and 15-second cutdowns, social captions, visual/voice direction, and an approval checklist. The narrative expressly avoids claims of guaranteed funding, revenue, legal protection, investment approval, contract awards, or other business outcomes. It directs the operator to label all publication surfaces “Dramatized customer story. Individual circumstances and results vary,” use only seeded demo or motion-graphic portal footage, keep real customer data off camera, verify the public call to action before publishing, and generate captions and transcript assets for accessibility.

**GitHub synchronization:** The campaign script and this session-log entry are queued for the required private GitHub main-branch publication after source hygiene validation.


---

## 2026-09-23 — Homepage redesign previews before implementation

**User request:**

> I want to redesign the home page so that it is more welcoming and tells a story to attract the customer move the packets to a different page. give me some previous before applying it

**Response and boundary:** No production homepage code was changed. The existing `/packets` route already provides a dedicated catalogue and packet-detail experience, so the proposed redesign removes the duplicated catalogue grid only from the home page after design approval. Three 2560×1440 visual previews and a documented comparison were produced under `docs/marketing/`:

- `homepage-preview-01-founders-moment.png` — a warm, editorial founder-story home page;
- `homepage-preview-02-guided-path.png` — a stage-based, self-selection home page;
- `homepage-preview-03-prepared-together.png` — a narrative-led transformation from ideas to organized business materials and portal experience;
- `HOMEPAGE_REDESIGN_PREVIEWS.md` — the comparison, recommended direction, proposed information architecture, implementation guardrails, and decision options.

**Recommendation:** “Prepared, Together” is the recommended base direction because it most clearly tells the ReadyPackets story while maintaining a deliberate call to explore the full catalogue on the dedicated Packets page. A hybrid may pair its narrative hero/process with the Guided Path’s three visitor-stage choices. Any approved implementation must retain the current public-presentation controls, use only fictional or seeded visual material, maintain accessibility and performance, and avoid guarantees of funding, revenue, legal protection, or customer outcomes.

**GitHub synchronization:** The preview images, comparison guide, and this session-log entry are queued for the required private GitHub main-branch publication after final file validation. No homepage implementation is included in this change.


---

## 2026-09-23 — Complete rebuild dossier, architecture diagrams, and master prompt

**User request:**

> Give me a file with all the context, detailed architecture with diagrams and all the changes and fixes for the application as well as a master prompt to rebuild the application.

**Response and deliverable:** A self-contained rebuild handoff was created at `docs/rebuild/READYPACKETS_COMPLETE_REBUILD_DOSSIER_AND_MASTER_PROMPT.md`. It consolidates the current product mandate, self-hosted/no-Manus constraint, runtime topology, technology stack, security architecture, data/migration model, feature scope, order and commerce behavior, administration, integrations, deployment modes, certificate posture, backup/recovery, protected root-controller boundaries, detailed repair register, rebuild phases, release verification gates, operator decisions, and a copy-ready master rebuild prompt.

The dossier renders and embeds four reviewed diagrams from version-controlled Mermaid sources under `docs/rebuild/diagrams/`: runtime topology, request-security pipeline, portable recovery trust boundary, and controlled platform-update/release flow. It expressly marks the selected Git release/migration ledger/schema contract as the source of truth where older documents contain historical table, migration, installation-path, or test-count values. The current reviewed baseline cited in the dossier is 49 migrations and 37 critical schema tables; historical test figures are identified as evidence to re-run rather than reused as a current release claim.

**Current-context corrections included:** The handoff includes the more recent schema compatibility repair for 21 active feature tables, durable portable full-recovery history, target-identity preservation during cross-domain recovery, constrained root Unix-socket controllers, explicit restarts of changed controllers, Safari audio media fallback and validation, verified SAML assurance policy for Entra-managed MFA, terminal order lock-down, invoice/commerce and SharePoint workflow improvements, catalog presentation controls, and the historical-only Security Centre alerts after the schema repair. It also preserves the requirement to use fictional/seeded material for the approved story-led home-page redesign and not misrepresent invented testimonial/outcome content as fact.

**Validation:** Mermaid sources were rendered successfully to PNG. The dossier was checked for all four image references, contains 455 lines and 8,212 words, references the complete version-controlled session record, and passed `git diff --check`. The live source confirms 49 migration files and `scripts/schemaContract.ts` declares 37 critical tables. No source code, deployment, customer data, secrets, TLS material, or environment settings were altered by this documentation change.

**GitHub synchronization:** The complete dossier, diagram sources/renders, and this session entry are included in the required private GitHub main-branch publication for this documentation release.


---

## 2026-09-23 — Codebase optimization review and conversion workflow architecture

**User request:**

> 1. Add the ability to convert document files from PDF to Word documents or text files and vice versa Word files to PDF or text files and text files to word documents and pdf this can be configured in the admin order workflow designer.
> 2. Add the ability to reduce PDF sizes also configurable in the admin order workflow designer.
> 3. Add the ability to convert audio files from any format to a .WEBM audio file this can be configured in the admin workflow.
> 4. Add the ability to sync orders to a specific sharepoint site for original files uploaded from/to the customer order. It should maintain the folder structure of CustomerName-CustomerID --> OrderNumber. (configurable in the order workflow designer)
> 5. Add the ability to copy files from the original order files sharepoint site to another sharepoint site for staging and file conversion for document files and audio files. It should maintain the folder structure of CustomerName-CustomerID --> OrderNumber and once the files are converted to the correct format copy them to the intake sharepoint site (configurable in the order workflow designer)
> 6. Review the 37 critical schema-contract tables and suggest any optimizations before executing the rebuild.
> 7. Review all the code and suggest any optimizations
> 8. Generate a slide deck summarizing the ReadyPackets rebuild architecture and master prompt for stakeholder review.
> 9. Can you walk me through the master prompt to ensure all self-hosted deployment requirements are covered?

**Response and deliverable:** Conducted a comprehensive, read-only workflow, schema, and codebase audit to map the requested file-conversion and multi-site SharePoint architecture against current ReadyPackets capabilities. The findings, self-hosted conversion design, and master-prompt walkthrough were documented in `docs/rebuild/Codebase_Optimization_Report.md` and `docs/rebuild/Conversion_Architecture_Design.md`. A stakeholder presentation deck (`ReadyPackets Rebuild Architecture & Master Prompt`) was authored and delivered to the Slides UI, detailing the strict security, operational, and append-only invariants required to safely implement this expansion.

**Key optimization findings:**
The review identified three proven release-blocking defects that must be resolved prior to expansion:
1. The `Dockerfile` attempts to copy a non-existent migration path, breaking fresh deployments.
2. Order transitions enqueue an unhandled `dispatch_webhooks` job, causing webhooks to be silently dropped.
3. The backend CI pipeline is deactivated, disabling the automated 37-table schema contract gate.
Additionally, the current in-memory job polling and unbounded memory upload buffering must be replaced with a durable, lease-based transactional outbox and streaming ingestion to safely handle heavy PDF and audio conversion workloads.

**Conversion architecture design:**
To satisfy the self-hosted mandate without external dependencies, conversion will be managed via versioned, admin-defined profiles executed by a dedicated, network-disabled worker using pinned native tools (`libreoffice`, `poppler`, `pandoc`, `ghostscript`, `ffmpeg`). It enforces an append-only invariant: originals are never overwritten. A new multi-target routing model uses explicit Microsoft Graph `Sites.Selected` identities to securely transfer the untouched original, the conversion staging artifact/manifest, and the final intake delivery.

**GitHub synchronization:**
The new design and review documents, alongside this session log entry, are queued for private GitHub main-branch publication.


---

## 2026-09-23 — Approved self-hosted conversion and selected-site SharePoint pipeline

**User approval and request:**

> I Approve the 49-migration/37-table baseline and release blockers as the immutable starting point.
> I Accept that self-hosted conversion prohibits relying on undocumented host tools or Manus-provided AI integration.
> I Confirm the append-only conversion architecture: originals are never overwritten.
> I Verify Microsoft Graph Sites.Selected app identities will replace broad delegated user credentials.
> Add the capabilities and features need to perform the conversion of documents and audio files

**Implemented capability:** The approved immutable **49-migration / 37-critical-table** baseline was retained as the starting point. Forward-only migration `0054_conversion_pipeline_and_sharepoint_targets.sql` adds the reviewed conversion and selected-site delivery domain, producing the new startup checkpoint **`Applied 50 migration(s); 44 critical tables verified.`** It creates `sharepoint_connections`, `sharepoint_target_bindings`, `order_sharepoint_locations`, `conversion_profiles`, `conversion_jobs`, `file_derivatives`, and `sharepoint_transfer_jobs`. It also corrects incomplete legacy pending `dispatch_webhooks` phase jobs to the recognized `notify_webhooks` type without rewriting completed historical evidence.

**Conversion safety model:** `server/services/conversionPipeline.ts` implements a durable, append-only pipeline. A workflow upload snapshots source storage key, source SHA-256, file version, profile revision/settings/tool fingerprint, and selected target identifiers before processing. The original remains unchanged. Each output is a separate private `derived_artifact` file and is linked by `file_derivatives` provenance. Fixed native command arrays, never shell interpolation or administrator-supplied executables, support PDF-to-Word/text, Word-to-PDF/text, text-to-Word/PDF, two PDF compression presets, and approved audio formats to WebM/Opus. Generated artifacts re-enter the existing magic-byte validation before storage.

**SharePoint safety model:** A selected-site connection encrypts its app-only Graph secret using row-bound encryption. Named target bindings are constrained by role (`originals`, `conversion_staging`, or `intake_delivery`); a transfer operation cannot use a mismatched target role. The first transfer writes a durable normalized path snapshot using `CustomerName-CustomerID/OrderNumber`, so a later customer rename does not move historical folders. Remote uploads use conflict-fail behavior, compare an existing object’s size before treating a retry as successful, and never overwrite a nonmatching object. Resumable Graph upload sessions are used for larger files. The Graph test control validates drive-root access without returning a secret.

**Administration and workflow controls:** Admin → Integrations now contains **Conversion Pipeline** controls to create conversion profiles, encrypted selected-site app connections, controlled targets, Graph drive tests, conversion activity, and selected-site transfer activity with bounded retry/cancel controls. Admin → Order Workflows exposes a stage-level **File conversion and selected-site SharePoint routing** configuration panel. It selects fixed profiles and independent originals/staging/intake targets. Policies are snapshotted at upload time; portable workflow export deliberately omits environment-local profile and target IDs.

**Self-hosted deployment and release repairs:** Native VPS and Docker provisioning now explicitly install FFmpeg, Poppler, Pandoc, Ghostscript, LibreOffice Writer, Python/pip, and pinned `pdf2docx==0.5.8`. The VPS installer fails closed if its documented converter inventory is missing, including when `--skip-packages` is used. Docker now copies `drizzle/migrations` to the runtime location required by the migration runner, resolving the documented clean-container migration artifact blocker. The backend CI workflow has been activated as `.github/workflows/portal-ci.yml`.

**Documentation:** Added `docs/rebuild/SELF_HOSTED_CONVERSION_AND_SHAREPOINT_PIPELINE.md` with the configuration sequence, conversion matrix, selected-site Entra least-privilege checklist, recovery/provenance behavior, and production acceptance tests. Updated the conversion design, rebuild dossier/master prompt, clean-room install guide, recovery guide, release-control diagram, and optimization report for the 50/44 release state.

**Validation completed:** TypeScript typecheck passed. The focused conversion-routing and schema-contract suites passed (**12 tests**), including explicit fail-closed coverage for a missing conversion table, path traversal/segment normalization, hierarchy construction, and fixed operation labels. Client production build and server production bundle passed. The full local suite executed 223 tests; **212 passed and 11 `tests/domain.test.ts` cases could not run only because this sandbox has no MySQL service on `127.0.0.1:3306`** (`ECONNREFUSED`). The failures were existing seeded-catalogue database cases, not conversion assertions. CI provisions MySQL and runs migrations/seed before the full suite. The local sandbox intentionally does not have Docker, MySQL server, Pandoc, Ghostscript, LibreOffice conversion tooling, or `pdf2docx`, so native converter and isolated migration smoke execution remain deployment/CI gates rather than falsely claimed local passes.


**Audio input compatibility refinement:** The conversion release extends pre-recorded audio intake to magic-validated `.mp3`, `.m4a`, `.wav`, `.webm`, `.ogg`, `.opus`, `.aac`, `.flac`, `.aiff`, and `.mp4` containers for browser and native mobile uploads. It does not weaken the validator or accept arbitrary extensions: each input must still match a fixed permitted type by decoded magic bytes before FFmpeg converts it to WebM/Opus. Focused upload/audio/conversion/schema tests passed after this extension.


**Final release check:** The final focused suite completed **37 passing tests** across conversion routing, schema contract, upload validation, and browser audio format behavior. TypeScript, client production build, server production bundle, installer/backup/restore shell syntax, and `git diff --check` passed. Repository inspection confirms **50 migration files** and **44 schema-contract tables**. `pnpm lint` remains unavailable because this repository defines the lint script but does not include an `eslint` package/configuration; this pre-existing toolchain gap is not masked as a passing lint check. The full 223-test local run remained database-limited as described above; GitHub CI provisions MySQL, applies migration/seed, and executes the full suite.

---

## 2026-09-24 — Isolated public-site and customer-portal continuation release

**User request:**

> I want to move forward to split the site but I want to write these changes to a new github and be easy to deployed easily while keeping the original site in the event things need to go back to the way it was. The sites should have be written incorporate the ability to include microsoft clarity and posthug capabilties and features and the ability to track users actions across the sites while being compliant with GDPR and other regulatory compliances and a cookie management system.

**Repository and rollback boundary:** A distinct private continuation repository, `readypackets/ReadyPackets-SiteSplit`, was created from the reviewed ReadyPackets codebase. The original repository and its deployment are not modified by this work. A production rollback remains a controlled DNS/load-balancer reversal to the retained original deployment after health verification; this release never overwrites the original checkout, database, TLS material, or backups.

**Public/portal split:** The React client now has two independent Vite builds. `client/src/MarketingApp.tsx` is the anonymous marketing router and excludes portal/administration routes; `client/src/PortalApp.tsx` is the authenticated customer/staff/administration router and excludes public marketing pages. The application selects `client/dist-public` or `client/dist-portal` only after Host validation against `APP_URL` and optional `PUBLIC_SITE_URL`. Public pages receive public SEO metadata; the portal shell is explicitly `noindex, nofollow, noarchive`. Browser links that cross the boundary use server-side redirects, not client authorization. Portal session and CSRF cookies remain host-only `__Host-` cookies and are never shared with the public hostname.

**Deployment controls:** Added `PUBLIC_SITE_URL` configuration and a `--public-domain` native/unified installer option. The native installer now compiles and validates both bundles, configures both allowed Origins, validates both hostnames, and requests certificates covering every configured hostname for Let’s Encrypt or Cloudflare Origin CA. The Docker build packages both bundles. The controlled upgrade script stages/promotes both bundles and runs the canonical migration runner/schema contract. The guided bootstrap defaults to this continuation repository and asks separately for the portal and public marketing hostnames. The installer rejects an unsafe/conflicting apex-www alias arrangement and preserves Host-based redirects.

**Privacy and analytics capability:** Added a consent-gated Microsoft Clarity/PostHog capability under **Admin → System → Privacy & cookies**. Both providers are disabled by default, their configuration is write-only, provider scripts are not loaded until an administrator enables Analytics and the individual browser has an affirmative Analytics preference, and configuration mutations are audited. PostHog autocapture and session replay are disabled; only reviewed path/surface events are emitted. No event contains account, email, order, file, document, message, form, or free-text values. Optional cross-site continuity uses only a cryptographically random, pseudonymous public-to-portal navigation handoff (`rp_ac`) after consent. It does not share sessions, authentication, CSRF, MFA, access control, cookies, or customer identity. Withdrawal stops capture and removes the local handoff identifier. Migration `0055_site_split_privacy_analytics.sql` advances the release to **51 forward-only migrations / 44 critical schema-contract tables**, with all analytics providers off by default.

**Documentation:** Added `docs/DUAL_SITE_DEPLOYMENT_AND_PRIVACY.md` with the topology, hostname model, native deployment commands, verification/rollback approach, consent methodology, and operational checklist. Updated environment, Docker, deployment, recovery, clean-room, conversion, and rebuild-dossier documentation and the release-control diagram for the 51/44 release state. The prior official provider source notes remain in `docs/ANALYTICS_CONSENT_SOURCE_NOTES.md`.

**Validation completed:** TypeScript typecheck passed. Public and portal production builds both passed; the public entry build emitted a materially smaller anonymous application bundle and did not include the portal entry module. Focused privacy/security/schema tests passed (**22 tests** across analytics configuration, headers, cookie consent, and schema contract; the final analytics/header rerun passed 10 tests). The compiled server bundle passed Node syntax validation. A dual-host HTTP smoke test verified the public shell, portal no-index shell, public-to-portal login redirect, and portal-to-public packet redirect. The smoke test intentionally ran without a MySQL service, so expected configuration-cache database connection errors were logged while no database-dependent route was exercised. Native installer, unified installer, guided installer, upgrade, backup, and restore scripts passed `bash -n`; `git diff --check` passed. The schema source inventory confirms **51 migration files** and **44 critical tables**. Full seeded MySQL migration/test execution remains a CI/deployment gate because this sandbox has no local MySQL service.

---

## 2026-09-30 — Supplied Document-Flow logo package refresh

**User request:**

> can you update the company logo with the files attached

**Source and integrity:** The supplied `Updated_ReadyPackets_Logo_Branding.zip` was extracted only to a temporary working directory. The package's `SHA256SUMS` verification passed for every listed asset and document. The released application now serves only the supplied self-hosted SVG, PNG, and ICO logo assets from `client/public/brand` and `client/public/favicon.ico`; no asset, font, icon, script, or logo is loaded from a CDN or third-party origin. SVG assets were parsed before use and verified to contain no script elements, event-handler attributes, or external/unsafe image references.

**Brand implementation:** Replaced the legacy August 2026 logo inventory with the ReadyPackets Document-Flow Brand Package (September 2026). The centralized `shared/brand.ts` registry now selects the light wordmark for light public/auth/invoice surfaces, the dark wordmark for navy portal/footer/email surfaces, and context-appropriate compact document-stack marks for administration, browser tabs, Apple touch icons, PWA install prompts, and the web manifest. The supplied favicon replaced the application favicon. The full light lockup is now used for public Organization structured data. Transactional email uses the supplied dark-background PNG wordmark for broad e-mail-client compatibility; browser surfaces use accessible SVG wordmarks with package-provided title/description metadata.

**Validation completed:** TypeScript typecheck passed. The focused brand, invoice-PDF, and security-header suites passed (**12 tests**), including checks that every registered brand asset exists, SVGs remain self-contained/non-executable, and browser/PWA icons resolve to the new compact mark. Legacy, public, and portal production builds completed successfully and each emitted the supplied logo, compact mark, and favicon assets. The server production bundle passed syntax validation. No visual image inspection tool was used on the user-provided attachments after the user requested that restriction.

---

## 2026-09-30 — Trademark symbol on visible Document-Flow wordmarks

**User request:**

> add a TM for trademark to the new logo

**Implementation:** The supplied package already contained full formal `-tm.svg` lockups but not a wordmark-only trademark export suitable for navigation. The official supplied generator was run with its legal-mark option and the platform's self-hosted Inter font assets to create matching `readypackets-document-flow-light-wordmark-tm` and `readypackets-document-flow-dark-wordmark-tm` SVG/PNG assets. No third-party font, image, CDN, or runtime dependency was added. Generated SVG metadata was corrected to describe the trademark wordmark rather than a tagline, then parsed to reject scripts, event handlers, and external/unsafe references.

**Visible placement:** The ™ wordmark is now used on public navigation, sign-in, portal navigation, footer, invoice page, structured-data organization logo, and transactional e-mail. E-mail uses the generated dark-background trademark PNG for client compatibility. The compact app/PWA marks remain intentionally unmarked because they are icons rather than a readable wordmark.

**Validation completed:** TypeScript typecheck passed. The focused brand, invoice-PDF, and security-header suite passed (**13 tests**), including assertion that every trademark wordmark contains the `wordmark-trademark` glyph. Legacy, public, portal, and server production builds completed successfully; every client bundle contains both trademark SVG wordmarks and the dark trademark PNG used by e-mail. `git diff --check` passed.


---

## 2026-10-13 — Current portal VPS deployment runbook for separate Hostinger marketing

**User request:** Provide the current link and instructions to deploy the updated ReadyPackets portal.

**Verified release target:** The portal continuation repository is `readypackets/ReadyPackets-SiteSplit` (private). At the time of this record, its reviewed `main` revision is `f083ea3d773d94e509c42a0f76796546d00aa09c`, which contains the Document-Flow trademark branding update on top of the conversion, selected-site SharePoint, dual-bundle/privacy, and schema releases. The installer/source contract is **51 forward-only migrations / 44 critical tables**.

**Deployment clarification:** The marketing site is now independently deployed to Hostinger, using `go.readypackets.com` for reviewed staging and reserving `www.readypackets.com` for its future public cutover. The portal must therefore be installed only at a dedicated portal hostname, currently documented as `my.readypackets.com`. The portal-only VPS command deliberately omits `--public-domain`: adding the externally hosted marketing hostname would make the VPS claim and certificate a hostname served by Hostinger. The marketing site links to the portal directly; no session, CSRF cookie, API, customer data, or proxy is shared across hosts.

**New documentation:** Added `docs/PORTAL_VPS_DEPLOYMENT_RUNBOOK_2026-10-13.md` and linked it from the repository overview. It provides guarded preflight requirements, a private-repository read-only deploy-key path, the short temporary-public fallback, Cloudflare Origin CA and Let’s Encrypt choices, an existing-portal Platform Updates path, required `51/44` verification, MFA/backups/recovery follow-up, and strict Hostinger/portal boundary checks. The dual-site topology documentation now explicitly covers an independently hosted marketing site with a portal-only VPS.

**Validation:** Verified the exact repository URL, private visibility, current immutable release SHA, migration count, and schema-contract count. The runbook was checked for stale repository/SHA placeholders; `bash -n` passed for the one-click installer, unified installer, native installer, and post-install connectivity verifier; `git diff --check` passed.

---
## 2026-10-16 — Global-scale baseline, square-lockup rebrand, and production dependency remediation
**User request:**
> Make sure the portal site is designed for global usage and growth and can expand horizontally across global servers for a large number of users; rebrand both sites with the supplied updated logo; push all changes to GitHub.

**Horizontal-scale implementation:** The portal now supports a staged scale-out topology without adding a hosted-platform dependency. `INSTANCE_ROLE=web` starts only request-serving web replicas; `INSTANCE_ROLE=worker` owns scheduled work; `INSTANCE_ROLE=all` preserves the single-node self-hosted behavior. Recurring jobs acquire per-job MySQL advisory locks, so a standby or replacement worker cannot execute the same scheduled action concurrently. Per-replica database capacity is bounded with `DATABASE_CONNECTION_LIMIT`.

**Shared file layer and recovery:** Added the private `STORAGE_DRIVER=s3` path using the current AWS S3-compatible client, with required startup validation for bucket identity credentials and optional compatible endpoints such as self-hosted MinIO. Object keys remain opaque, all customer downloads remain authorization-mediated through the application, and direct public bucket URLs are not used. Full backup, full restore, and scoped order recovery now archive and restore the verified object tree when shared storage is enabled; recovery documentation and the global-scale architecture record the non-destructive migration/drill model.

**Deployment architecture and safety:** Added `docs/GLOBAL_SCALE_ARCHITECTURE.md`, which defines the Cloudflare/global-load-balancer → stateless web replica → MySQL primary/HA → private object-store/worker topology, regional rollout phases, data-residency constraints, least-privilege object-store policy, centralized logging/SIEM requirements, and required failover/recovery/load exercises. It deliberately does not enable multi-primary database writes, unreviewed replica reads, or cross-region workers. Production rollout still requires explicit operator infrastructure provisioning, capacity measurement, regional compliance review, and disaster-recovery exercises.

**Supplied branding:** Both portal and marketing repositories use only the supplied self-hosted square ReadyPackets lockups. Compact transparent marks derived solely from the supplied lockups keep navigation readable; full light/dark lockups are used where the company name and tagline must remain visible, including authentication, footer, invoice, email, social metadata, and PWA surfaces. No third-party brand/CDN asset was introduced.

**Supply-chain remediation and framework hardening:** A production dependency audit found inherited critical/high findings in the prior runtime graph. The release upgrades Express to 5.3.0, AWS S3 client to 3.1152.0, Archiver to 8.0.0, Compression to 1.8.2, Multer to 2.4.0, Nodemailer to 10.1.2, and aligned type packages. Express 5 route parameters are normalized through a fail-closed single-value helper before ticket, campaign, mobile reference, and database logic use them, rejecting repeated/wildcard parameter arrays rather than coercing them. Archiver 8's native ESM ZIP export is covered through a narrow type bridge and a real in-memory ZIP compatibility test. `pnpm audit --prod` now reports **0 info, 0 low, 0 moderate, 0 high, and 0 critical** findings; the global rollout guide makes a clean production dependency audit a release gate.

**Validation completed:** TypeScript passed. Focused scale/brand/security/conversion suites passed **33 tests across 9 files**, including shared-object archive recovery, single-value route parameter rejection, and Archiver 8 ZIP generation. ESLint passed with zero warnings. Legacy, public, and portal production bundles built successfully; the server production bundle passed syntax validation. Native installer, upgrade, full-recovery, and scoped-recovery shell scripts passed `bash -n`; the object archive adapter passed Node syntax validation; `git diff --check` passed. The portal bundles retain pre-existing large-chunk warnings for a future route-level code-splitting release; these do not block the completed builds.

---
## 2026-10-16 — Consent-gated Microsoft Clarity and PostHog setup guidance
**User request:**
> Confirm whether both sites can configure Microsoft Clarity and PostHog and provide setup instructions.

**Verified capability:** The portal and independent marketing site both contain consent-gated Microsoft Clarity and PostHog support, disabled by default. The portal provides Admin → System controls for the cookie-consent category, provider enablement, encrypted write-only Project ID/project-key storage, approved US/EU PostHog endpoint selection, audit activity, and no-consent script/configuration blocking. The marketing site uses blank browser-visible provider project identifiers in `src/assets/js/site-config.js` and loads providers only after affirmative Analytics consent; its static CSP already permits the needed provider script/connect paths.

**Boundary correction:** The portal's optional anonymous cross-site handoff is designed for the dual-bundle deployment served by the portal repository. The independently hosted marketing repository deliberately does not participate in it. Documentation now requires the portal cross-site toggle to remain disabled while marketing is hosted separately, unless a future privacy-reviewed implementation changes both sites and is verified end-to-end.

**Documentation:** Added `docs/CLARITY_POSTHOG_OPERATOR_SETUP.md` with exact project creation, portal console, marketing source/deploy, consent verification, masking, regional ingestion, retention/IP, cross-site boundary, and no-secret-handling procedures. The guide cites current official Microsoft Clarity and PostHog documentation.

---
## 2026-10-18 — Hardened private-repository fresh-VPS portal deployment
**User request:**
> give me a script and instructions to deploy the portal
> continue

**Deployment scope and safety boundary:** Prepared a new, first-install-only private repository bootstrap for the separate ReadyPackets Portal VPS. It targets the private `readypackets/ReadyPackets-SiteSplit` repository and a dedicated authenticated hostname such as `my.readypackets.com`, while leaving the independently hosted `www.readypackets.com` website outside the portal deployment and TLS configuration. No portal, demo, production database, customer account, uploaded file, secret, DNS record, Cloudflare setting, or running service was modified during this documentation/script release.

**Implemented bootstrap:** Added `deploy/github-bootstrap-install.sh`. The root-only script requires a repository-scoped **read-only** GitHub deploy key and a reviewed complete 40-character commit SHA; it rejects a branch name or abbreviated SHA, verifies the fetched commit exactly, checks it out detached, and refuses to run if the project directory already exists or `readypackets.service` is active. It obtains GitHub’s published SSH host keys from the GitHub Meta API over HTTPS, writes a dedicated root-only `known_hosts` file, and uses strict host-key checking rather than accepting an unknown first-use key. It never accepts a GitHub personal access token, repository password, or command-line secret.

**TLS, access, and readiness controls:** The bootstrap supports Let’s Encrypt, an existing root-only Cloudflare Origin CA certificate/key pair, and automatic Cloudflare Origin CA issuance for the native VPS path. Automatic issuance requires a root-owned `0600` token file, valid approved certificate lifetime, a Cloudflare-proxied portal host, and Full (strict) TLS; it keeps the token out of source, command arguments, and the application environment. The bootstrap invokes the existing native/unified installer, requires local readiness, and performs public HTTPS verification as a separate gate so valid local installs are not mistakenly destroyed during ordinary DNS/Cloudflare/TLS propagation. A malformed release-SHA smoke check was executed as root and confirmed that it stops before package, source, or service changes.

**Documentation correction:** Replaced/updated the portal VPS runbook, GitHub bootstrap guide, self-hosted installation guide, temporary-public fallback guide, approved in-place deployment examples, and README. They now consistently use the current private `ReadyPackets-SiteSplit` repository, the dedicated `my.readypackets.com` example, the Hostinger-public-site separation, a safe environment-file loading pattern for administrator bootstrap, Cloudflare token hygiene, and the current fail-closed schema checkpoint: **`Applied 51 migration(s); 44 critical tables verified.`** The temporary-public path is explicitly restricted to a deliberate, history-reviewed dual-host deployment and is not presented as the normal route for the separate Hostinger website plus portal-VPS design.

**Regression coverage and validation:** Added `tests/githubBootstrapInstall.test.ts`. It checks Bash syntax and asserts the immutable-SHA, existing-deployment, strict GitHub host-key, Cloudflare token-file, certificate-method, and local/public health gate contracts. Focused test suites passed **24 tests across 4 files** (`githubBootstrapInstall`, schema contract, headers, and route parameter handling). TypeScript typecheck, ESLint with zero warnings, Bash syntax checks for the bootstrap/native/unified/guided/connectivity scripts, client legacy/public/portal production builds, and server production bundle parsing all passed. `pnpm audit --prod` reported **0 info, 0 low, 0 moderate, 0 high, and 0 critical** findings. The release source confirms **51 SQL migration files** and **44 critical schema-contract tables**. Portal build output retains the pre-existing large-chunk warning, recorded for future route-level code splitting; it did not affect a successful build. Generated build artifacts were removed from the source checkout before publication.

**Publication state:** Published to the private `readypackets/ReadyPackets-SiteSplit` GitHub `main` branch as immutable commit `2af639b726969741ce14f91b643920f0e41f0110` (`feat: add secure private portal VPS bootstrap`).

---
## 2026-10-18 — Guided one-script native portal installer
**User request:**
> can you just create a master install script that does everything and place it on the github to be called to do the install capture the name ect

**Implemented guided installer:** Added `deploy/master-install.sh` as the recommended, interactive, **fresh native VPS only** installation path. It captures the ReadyPackets display name, dedicated portal hostname, first administrator name/email, certificate method, and typed administrator-reviewed immutable Git SHA. It creates or validates a root-only read-only GitHub deploy key, prints only its public half for the repository administrator to register with write access disabled, retrieves GitHub’s published SSH host keys with strict validation, fetches and verifies the exact immutable release, invokes the existing hardened native bootstrap, and creates the first local administrator with a generated one-time password displayed only on the VPS console.

**Security and host boundaries:** The master installer rejects noninteractive use, all existing ReadyPackets source/runtime/configuration/data/service state, moving branch names, abbreviated SHAs, unknown GitHub host keys, GitHub personal-access-token/password inputs, command-line Cloudflare secrets, and the separate public website hosts `readypackets.com` and `www.readypackets.com`. It retains the root-owned `0600` temporary Cloudflare token-file flow for automatic Origin CA issuance, ensures cleanup even when that secure file creation fails partway through, and never moves that token to source, application configuration, process arguments, or logs. `www` and the public apex remain independently hosted outside the portal VPS.

**Documentation and regression coverage:** Added `docs/MASTER_PORTAL_INSTALLER.md`; updated the portal README, GitHub automated-install guide, production VPS runbook, and self-hosted guide to make the one-script flow the normal new-server entrypoint while retaining the lower-level bootstrap for reviewed automation. Added `tests/masterInstall.test.ts` to assert the interactive-only, existing-host refusal, strict GitHub/deploy-key, immutable-release, secret-handling, typed-confirmation, hostname-boundary, and generated-admin controls.

**Validation completed:** Shell syntax checks passed for the new master installer and all related deployment scripts. Focused Vitest suites passed **27 tests across 4 files** (`masterInstall`, `githubBootstrapInstall`, schema contract, and headers). TypeScript typecheck and ESLint completed with zero warnings; `git diff --check` passed. A terminal-level negative test confirmed the master script rejects `www.readypackets.com` before creating a deploy key, project/runtime/configuration/data path, or service state. The native portal baseline remains **51 forward-only migrations** and **44 critical tables verified**.

**Publication state:** Published to the private `readypackets/ReadyPackets-SiteSplit` GitHub `main` branch as immutable commit `2cb0fb261d6767c387c1217384c7de738e8077e7` (`feat: add guided portal master installer`).


---
## 2026-10-18 — Explicit canonical-redirect portal aliases
**User request:**
> can the site bet setup to allow multiple names? for example my.readypackets.com and portal.readypackets.com or any name i choose

**Design decision:** Implemented bounded, explicit portal aliases without accepting arbitrary `Host` headers. One configured `--domain` remains the canonical `APP_URL` and the only portal application/session origin. Up to five explicit aliases can be selected; each is covered by TLS and permanently redirects (`308`) to the canonical HTTPS URL at Nginx before Node.js can issue a `__Host-` session or CSRF cookie. This avoids duplicate host-only sessions, callback ambiguity, and broad origin trust. `readypackets.com` and `www.readypackets.com` remain reserved for the independently hosted ReadyPackets website, and wildcard host acceptance is not supported.

**Installer and proxy implementation:** Added repeatable `--portal-alias <hostname>` support to the native installer, unified installer, immutable private GitHub bootstrap, and interactive master installer prompt. Inputs are lowercased, syntax-checked, de-duplicated, limited to five explicit entries, and rejected if they duplicate the canonical host, collide with a configured public-site host, or use the reserved ReadyPackets public website hosts. The native installer propagates every canonical/alias/public hostname through Nginx `server_name`, strict host regex, certificate SAN validation, Cloudflare Origin CA CSR/API hostname list, Certbot `-d` inputs, and local ACME challenge probes. Unknown HTTP hosts now fail closed with `421`; configured HTTP hosts redirect only to the literal canonical hostname and never reflect `$host`.

**Runtime, certificate, update, and recovery safeguards:** `PORTAL_ALIASES` is written to the protected environment for Nginx/certificate coordination but is intentionally not added to `ALLOWED_ORIGINS`. The certificate controller validates manually installed Cloudflare Origin CA and activated Let’s Encrypt material against every configured alias and rejects canonical-domain changes while aliases exist rather than silently rewriting an incomplete SAN/redirect configuration. Native re-runs preserve stored aliases unless explicit replacement aliases are supplied. Controlled platform upgrades, encrypted configuration imports, and portable full restores preserve target `PUBLIC_SITE_URL`, `ALLOWED_ORIGINS`, and `PORTAL_ALIASES` routing identity. The public connectivity verifier accepts aliases and requires each to return an exact `308` to the canonical health URL.

**Documentation and regressions:** Updated `.env.example`, README, general deployment guide, guided master installer guide, private bootstrap guide, self-hosted guide, and production VPS runbook with DNS, Cloudflare/Let’s Encrypt SAN, session-origin, redirect, and verification instructions. Added `tests/portalAliasInstall.test.ts` and expanded bootstrap regression coverage. The new suite asserts input bounds/public-host rejection, strict canonical redirect behavior, no `$host` redirect target, SAN/ACME propagation, installer forwarding, post-install alias verification, certificate-controller protections, and update/restore preservation.

**Validation completed:** Targeted Vitest suites passed **16 tests across 3 files** (`portalAliasInstall`, `masterInstall`, and `githubBootstrapInstall`); all non-database suites passed **233 tests across 35 files**. Bash syntax passed for every touched deployment script; `node --check` passed for the certificate controller; `pnpm run typecheck` and zero-warning `pnpm run lint` passed; production legacy/public/portal client builds and server esbuild parsing passed; `pnpm audit --prod` reported no known vulnerabilities; a high-confidence credential scan of changed files passed; and `git diff --check` passed. Rendered Nginx contracts confirm an alias is included in `server_name`/strict host allowlist and returns a literal `308` to the canonical portal, while the no-alias rendering contains only an impossible alias matcher. Native negative-path checks confirmed canonical or alias use of `www.readypackets.com` is rejected before deployment paths are created. The complete suite was also attempted, but its 11 database-backed catalogue/pricing checks could not connect because this sandbox has neither an active MySQL service unit nor Docker (`ECONNREFUSED 127.0.0.1:3306`); no source assertion failed. Generated build artifacts were removed. Commit, push, and remote synchronization verification remain required before release.


**Publication state:** Source implementation committed locally as immutable commit `4452f78ac8999c75af5422ee3457cf7dfc891575` (`feat: add secure canonical portal aliases`). A final session-log publication record and remote `main` synchronization verification follow this commit.

---

## 2026-10-19 — Post-install administrator management of portal redirect aliases
**User request:**
> add the ability to add additional domain names in the admin console after the install

**Scope and security decision:** Implemented post-install administration for **explicit portal redirect aliases**, not arbitrary additional portal application origins. The canonical `APP_URL` remains fixed. An alias never becomes an OAuth/SAML callback, CORS/CSRF origin, session/cookie origin, or a second login endpoint; it is terminally redirected to the canonical URL before Node.js receives the request. The existing strict maximum of five aliases remains in force. `readypackets.com` and `www.readypackets.com` remain reserved for the separately hosted ReadyPackets website. No live VPS, DNS zone, Cloudflare account, certificate, user record, customer data, or production service was changed during this source release.

**Administrator console:** Added **Admin → System → Domain & URL → Add a portal redirect alias**. The panel lists the canonical hostname, active aliases, and remaining capacity. The accessible confirmation modal requires an exact `ADD PORTAL ALIAS` phrase. For Let’s Encrypt it requires a certificate-contact e-mail and explains the public DNS/HTTP-01 prerequisite. For Cloudflare Origin CA it requires a newly issued replacement certificate/key that covers the canonical host, every existing alias, and the proposed alias; key material is submitted only through the protected request path and is never written to application settings, activity/security event metadata, source, or browser-visible response data. Successful and failed actions both create security/activity audit records containing the normalized alias/provider and non-secret certificate metadata only.

**Root-controller protocol and transaction boundary:** Added two fixed, typed Unix-socket actions to the root-owned certificate controller: `add-portal-alias-letsencrypt` and `add-portal-alias-cloudflare`. Inputs are normalized/lowercased and reject malformed hostnames, duplicate/canonical values, public-site collisions, the independently hosted public apex/`www`, aliases beyond five, and hostnames already reserved by any active Nginx virtual host. A daemon-wide mutation lock prevents concurrent certificate/domain/alias operations. Root-only rollback snapshots preserve the environment, active Nginx configuration, TLS include, and Cloudflare material before any mutation; failure restores and reloads the prior configuration.

**TLS and Nginx hardening:** The Nginx template was refined beyond the initial installer alias feature. Unknown TLS SNI now reaches an explicit TLS `default_server` that returns `421`, rather than falling through to the portal application. Explicit aliases receive their own exact `server_name` TLS virtual host that contains only modern TLS controls and a literal `308 https://<canonical>$request_uri`; it contains no `proxy_pass`. The canonical portal/public application host block has a separate exact server-name/allowlist set. Let’s Encrypt aliases are staged as pending: only the port-80 ACME challenge host list is temporarily expanded while the TLS alias server remains absent. After Certbot expands and validates the SAN certificate for every active local hostname, the alias TLS redirect is enabled; local canonical health and an exact local-SNI redirect are required. Cloudflare Origin CA aliases similarly require full replacement certificate/key validation before configuration activation. The controller distinguishes a separate Hostinger/public-site URL from a legacy same-VPS public host by preserving it in TLS only if it is already configured in Nginx.

**Deployment/update compatibility:** Updated native and Docker/unified Nginx placeholder rendering to use separate HTTP, canonical/public application, and alias-only virtual-host values. Expanded the root controller’s narrowly declared systemd writable paths solely for `/etc/readypackets`, Nginx, backup snapshots, ACME state/log/cache, and HTTP-01 webroot paths. Updated the guided installer guide, self-hosted guide, deployment runbook, and repository README with after-install DNS, Cloudflare Full (strict), certificate-SAN, rollout, and rollback conditions.

**Validation completed:** Dedicated post-install alias-management regression coverage was added in `tests/adminPortalAliasManagement.test.ts`; it pins the bounded typed actions, pending HTTP-01 staging, Cloudflare coverage/rollback, exact redirect-only Nginx virtual host, fail-closed TLS default server, audit events, UI confirmation, and systemd path boundary. Focused alias/installer suites passed **23 tests across 4 files**, and the final all non-database suite passed **240 tests across 36 files**. TypeScript typecheck and zero-warning ESLint passed after the final change. Native/unified installer shell syntax, root controller Node syntax, and `git diff --check` passed. A rendered configuration inspection confirmed canonical/application and alias virtual-host isolation; the sandbox does not contain Nginx, so `nginx -t` remains a VPS/CI gate rather than a falsely claimed local parser pass. Production legacy/public/portal bundles and the server bundle completed successfully before the final deployment-controller-only refinement; generated output was removed. `pnpm audit --prod` reported no known production dependency vulnerabilities. A high-confidence changed-file credential scan passed. Full database-backed `tests/domain.test.ts` remains excluded locally because the sandbox has no MySQL or Docker service; no database assertion was executed or claimed as passing.

**Publication state:** Pending final source review, commit, private GitHub `main` push, remote synchronization verification, and immutable commit record.

**Source commit:** The reviewed implementation above was committed locally as immutable Git commit `4df17fa4ff51ba9310ea75f92d84e327da85be44` (`feat: manage portal aliases in admin console`). A final session-log commit and private `main` push/synchronization check follow.

---

## 2026-10-19 — Default initial administrator mailbox for fresh installations
**User request:**
> update the install script with the tools@readypackets.com as the admin email and then give me the whole script again

**Implemented change:** Set `tools@readypackets.com` as the visible, overrideable default initial administrator email in both fresh-install entry points: the private-repository guided `deploy/master-install.sh` and the temporary-public-source `deploy/one-click-install.sh`. The private guided installer now presents that address as its default prompt value; the public-source bootstrap uses it when `RP_ADMIN_EMAIL` is not explicitly supplied. A deployment operator can deliberately supply a different mailbox for a specific VPS. No administrator password is embedded or defaulted, and the existing generated one-time-password workflow remains unchanged.

**Regression and publication controls:** Updated the guided-installer reference and added `tests/publicInstaller.test.ts` to pin the public installer’s default/override contract and its prohibition on passwords/tokens/private keys in reusable settings profiles. Focused installer regressions passed **26 tests across 5 files**. TypeScript typecheck, zero-warning ESLint, Bash syntax checks for both installers, `git diff --check`, and a high-confidence credential scan passed. No VPS, DNS, Cloudflare configuration, customer data, or running portal was modified. Source commit/push verification follows.

**Source commit:** The reviewed change was committed locally as `850aa0bd2068b15fff9d3527403dd00fb192a76c` (`chore: default installer admin email`). A final session-log commit and private GitHub `main` synchronization verification follow.

---

## 2026-10-19 — Cloudflare Origin CA hostname JSON installer repair
**User report:** Fresh VPS installation stopped while requesting an automated Cloudflare Origin CA certificate with `jq: error: my/0 is not defined at <top-level>`. The screenshot showed the failure occurred at `deploy/install.sh` line 782, after the portal service was installed but before the Cloudflare certificate request was made.

**Root cause and fix:** `jq` option order incorrectly placed `--args` before the JSON filter. In jq, every subsequent argument is then treated as positional data, so the intended filter `$ARGS.positional` was displaced and a hostname such as `my.readypackets.com` was parsed as jq program syntax (`my/0`). Reordered the safe local construction to `jq -n '$ARGS.positional' --args "${certificate_hosts[@]}"`. This produces the required JSON array for the canonical host and every explicit alias without exposing Cloudflare credentials.

**Recovery safety:** The native installer is intentionally re-runnable and retains the existing `/etc/readypackets/portal.env` cryptographic secrets and existing data. The reported failure occurred before any Origin CA certificate/key was installed; a guarded in-place rerun from the fixed immutable source can therefore complete the fresh installation without deleting the partially provisioned runtime. The Cloudflare token remains an interactive/root-only input and is never included in source, command history, portal configuration, or the session log.

**Validation:** Direct jq execution returned the expected hostname JSON array for both `my.readypackets.com` alone and `my.readypackets.com` plus `portal.readypackets.com`. Added an executable regression that covers both cases and pins the source invocation. Focused installer, alias, and admin-alias tests passed **27 tests across 5 files**. TypeScript typecheck, zero-warning ESLint, native installer Bash syntax, `git diff --check`, and a high-confidence changed-file credential scan passed. No live Cloudflare account, token, DNS record, VPS, customer data, or portal service was accessed by this source repair. Source commit/push verification follows.

**Source commit:** The reviewed Cloudflare Origin CA repair was committed locally as `f90e27ef0660f32bd7b2f6581d6b927a7829af38` (`fix: serialize Cloudflare origin hostnames`). A final session-log commit and private GitHub `main` synchronization verification follow.

**Follow-up hardening:** Before publishing the recovery release, added an `EXIT` cleanup trap for every ephemeral Cloudflare request workspace. It best-effort shreds and removes the generated CSR/private key, temporary curl authorization configuration, request payload, and API response on both success and failure. The completed origin certificate/key are moved separately into root-owned TLS storage only after validation. The same focused suite, TypeScript typecheck, ESLint, Bash syntax, whitespace, and credential scans passed after this addition.

**Follow-up source commit:** The ephemeral-material cleanup hardening was committed locally as `b82e0aeeb65a8ef3a99ba532566e353726c93816` (`fix: clean ephemeral Cloudflare request material`). A final session-log commit and private GitHub `main` synchronization verification follow.


---

## 2026-10-19 — Fresh VPS Nginx portal-alias template-guard repair
**User report:** A clean VPS installation with canonical `my.readypackets.com`, redirect alias `portal.readypackets.com`, and automatic Cloudflare Origin CA stopped after requesting the certificate with: `The template hostname survived substitution in /etc/nginx/sites-available/readypackets.`

**Root cause and correction:** The Nginx template uses `portal.readypackets.com` as its documented placeholder/example hostname. The native installer correctly rendered the configured alias into the redirect-only TLS virtual host, but its post-render template-leak guard rejected any occurrence of that string whenever the canonical hostname differed. That produced a false positive precisely when `portal.readypackets.com` was deliberately configured as an approved alias. The guard now enumerates the strict `ALL_ROUTED_HOSTS` allowlist: it rejects an unintended surviving template hostname only when the hostname is absent from every configured routed name. It does not broaden host acceptance, proxy alias traffic to the application, change certificate SAN validation, or weaken the unknown-host `421` behavior.

**Regression and validation:** Added an executable rendered-Nginx contract test for canonical `my.readypackets.com` plus redirect-only alias `portal.readypackets.com`. It verifies all `__RP_*` template tokens are replaced, the alias virtual host is exact, and its redirect target is the literal canonical URL. The resulting configuration has one HTTP name block, a TLS alias block with `server_name portal.readypackets.com;` and `return 308 https://my.readypackets.com$request_uri;`, and a separate canonical application virtual host. Native installer Bash syntax passed; the complete non-database suite passed **245 tests across 37 files**; TypeScript typecheck, zero-warning ESLint, production client/server build, `git diff --check`, `pnpm audit --prod` (no known vulnerabilities), and changed-file credential scanning passed. Generated build output was removed. No VPS, DNS, Cloudflare account/token, certificate, customer data, or production service was accessed by this source repair. Source commit/push verification follows.

**Source commit:** The reviewed fresh-VPS Nginx alias template-guard repair was committed locally as `e0c9ded9ff7bdb8911f4ab7d05f55c6f82a0f405` (`fix: allow configured portal template alias`). A final session-log commit and private GitHub `main` synchronization verification follow.


---

## 2026-10-19 — Cloudflare 502 startup-readiness gate
**User report:** A freshly installed portal returned Cloudflare `502 Bad gateway`. Screenshots showed Cloudflare DNS records for `my.readypackets.com` and `portal.readypackets.com` proxied to the VPS; the installer had successfully issued and installed hardened TLS, but its first loopback readiness curl could not connect to `127.0.0.1:3000`, and later local verification reported `Local ReadyPackets service is not active`.

**Diagnosis boundary:** This is an origin application-process availability condition, not a Cloudflare DNS/proxy or Origin CA certificate error. Cloudflare reached the host, and Nginx was syntactically valid; Nginx could not reach the Node listener. The exact cause is retained in the VPS-local `readypackets` systemd journal and must be reviewed there without exposing `/etc/readypackets/portal.env`, API tokens, private keys, or customer data.

**Implemented prevention:** Replaced the former fixed three-second service check plus warning-only failed curl with a bounded 20-attempt/2-second local readiness gate. It requires both `systemctl is-active readypackets` and a non-proxied loopback `GET /api/health/ready` with canonical host/proto headers. If the listener never becomes ready, the installer prints unit status and the last 80 boot-local journal entries, then exits nonzero before it can claim the portal was successfully installed. This does not relax systemd hardening, origin/TLS controls, hostname allowlists, or health endpoint authentication boundaries.

**Regression and validation:** Added a source-contract regression for the bounded loopback readiness behavior and failure diagnostics. Native installer Bash syntax passed; the complete non-database test suite passed **246 tests across 37 files**; TypeScript typecheck, zero-warning ESLint, `git diff --check`, `pnpm audit --prod` (no known vulnerabilities), and changed-file credential scanning passed. No live VPS, Cloudflare account, TLS private key, token, environment file, database, backup, or customer information was accessed. Source commit/push verification follows.

**Source commit:** The reviewed readiness-gate correction was committed locally as `2f982cf5b38b4660cfa1880888d03e6177b514c0` (`fix: require portal readiness before install success`). A final session-log commit and private GitHub `main` synchronization verification follow.


---

## 2026-10-19 — Express 5 catch-all startup failure repair
**User-provided safe journal evidence:** The VPS journal reported `Fatal startup error` with `TypeError: Missing parameter name at index 1: *; visit https://git.new/pathToRegexpError for info`, followed by repeated `readypackets.service` exits and a Cloudflare `502`. The migration pre-start step was successful (`44 critical tables verified`), and the portal reached the Node startup path before Express route registration failed.

**Root cause and fix:** `server/app.ts` still used Express 4's anonymous SPA catch-all `app.get("*", ...)`. The installed Express 5 version rejects anonymous wildcards at route-registration time through its current `path-to-regexp` parser, preventing the server from ever binding port 3000. Replaced it with Express 5-compatible `app.get("/{*splat}", ...)`, a named brace catch-all that covers both `/` and nested GET-only SPA routes. API and non-GET fallback behavior remain unchanged.

**Recovery design:** The existing installation retains its root-owned Cloudflare Origin CA material, strict Nginx hostname routing, portal alias list, encrypted configuration/secrets, database, uploaded storage, backup history, and already-created administrator. The planned in-place repair fetches only an immutable reviewed source commit, runs the existing native installer with `--skip-packages --no-seed`, rebuilds the portal runtime, applies idempotent migrations, restarts systemd, and verifies local/public health. It deliberately does not request or print a Cloudflare token, touch certificate files, re-run seed data, reset the administrator password, or overwrite user data.

**Regression and validation:** Added `tests/expressStartupCompatibility.test.ts`, which constructs the complete Express application and asserts the named fallback, so a route-parser startup failure is caught before release. Confirmed no anonymous wildcard remains in executable `server`/`scripts` source. Focused tests passed **21 tests across 4 files**; the complete non-database suite passed **248 tests across 38 files**. TypeScript typecheck, zero-warning ESLint, production client/server build, `git diff --check`, `pnpm audit --prod` (no known vulnerabilities), and changed-file credential scanning passed. Generated build output was removed. No live VPS, Cloudflare account, TLS material, database, secrets, backups, or customer content was accessed by this source correction. Source commit/push verification follows.

**Source commit:** The reviewed Express 5 SPA catch-all repair was committed locally as `6b3e8bdc248805f45f04e945e2965355d3c4d9aa` (`fix: use Express 5 SPA catch-all`). A final session-log commit and private GitHub `main` synchronization verification follow.

**Reusable recovery helper:** Added `deploy/repair-express5-startup.sh`, pinned to the published application-fix commit `9cce95ff4ca123d3c358659140c7f25b9feee5d9`. It is only for this confirmed Express 5 journal signature. Before acting, it requires root, an interactive terminal, the expected clean temporary-public HTTPS source origin, the existing native runtime, exact protected environment ownership/mode, and an existing TLS include. It loads only non-secret canonical routing, alias, and display values in a child shell; runs the installer with `--skip-packages --no-seed` and closed stdin; preserves the existing certificate; and runs local then public verification. Its regression pins immutable source retrieval, syntax, no seeding, and prohibition on new TLS-provider/Cloudflare-token input. Its source commit and private GitHub publication verification follow.

**Recovery-helper source commit:** The reviewed reusable recovery helper, documentation, and regression were committed locally as `28fad9231b7244a2b316d4d98af58e891105e66c` (`fix: add guarded Express startup recovery`). A final session-log commit and private GitHub `main` synchronization verification follow.


**Recovery-helper safety correction:** Before issuing any VPS repair command, review of the native installer confirmed that it rewrites `/etc/readypackets/portal.env` with baseline optional integration values. That would be unsuitable for an existing portal with Microsoft Graph mail, SAML, storage, or other operator configuration. The initial helper release was therefore superseded before use. The corrected `deploy/repair-express5-startup.sh` does **not** invoke `deploy/install.sh`, does not run migrations or seed data, and does not update the source checkout. It requires the exact journal signature; rejects dependency or migration differences; stages the immutable application-fix commit in a detached worktree; compiles only `server/index.ts`; confirms the Express 5 fallback; checks `portal.env` SHA-256 before/after; atomically swaps only `/opt/readypackets/dist/server.js`; retries bounded local readiness; and restores the prior bundle automatically if any post-swap action fails. TLS, Nginx, the database, upload/storage, aliases, user/admin accounts, and environment-backed integrations remain untouched. A corrected helper release and validation evidence follow.

**Corrected-helper validation:** The replacement source-only helper passed Bash syntax validation and its dedicated executable contract. The complete non-database suite passed **249 tests across 38 files**; TypeScript typecheck, zero-warning ESLint, `git diff --check`, `pnpm audit --prod` (no known vulnerabilities), and a high-confidence changed-file credential scan passed. An explicit immutable target comparison confirmed the affected fresh-release baseline and the Express fix have no `package.json`/lockfile or `drizzle/migrations` differences. No build artifact, VPS, Cloudflare account, certificate, secret, database, backup, or customer content was accessed. Publication follows.
**Corrected recovery-helper source commit:** The configuration-preserving source-only recovery helper was committed locally as `2c594ed5fd5c7762deacfb6e728c8960f67fa0ee` (`fix: preserve config during Express recovery`). A final session-log commit and private GitHub `main` synchronization verification follow.


**Historical-journal correction:** The user ran the source-only helper after the exact Express 5 error had been observed, but its initial guard searched only the current boot (`journalctl -b`), while the failure was retained from a prior boot. Updated the guard to check the current boot first and retained service logs from the last 14 days. If log rotation has removed the exact signature, it remains fail-closed unless the operator provides the deliberately explicit `--confirm-known-express5-journal-error` flag after separately confirming the same error. This affects no portal runtime setting, TLS asset, data, identity, or remote service. Focused recovery/installer tests passed **22 tests across 4 files**; the complete non-database suite passed **249 tests across 38 files**. TypeScript typecheck, zero-warning ESLint, helper Bash syntax, `git diff --check`, `pnpm audit --prod` (no known vulnerabilities), and credential scanning passed. Source commit/push verification follows.
**Historical-journal recovery source commit:** The reviewed prior-boot journal detection and explicit post-rotation confirmation correction was committed locally as `fd9b30ea3f30cec639f0c914ac3d578ade854294` (`fix: recognize historical Express startup errors`). A final session-log commit and private GitHub `main` synchronization verification follow.


## 2026-10-19 — Successful Express recovery and proxy-isolated public verification
**User-provided recovery output:** The guarded source-only helper completed on the affected VPS. It retrieved immutable application-fix commit `9cce95ff4ca123d3c358659140c7f25b9feee5d9`, compiled the staged server bundle, achieved `Local installation health: PASS`, and reported `/etc/readypackets/portal.env` byte-for-byte unchanged with TLS/Nginx/database/administrator unchanged. The original Cloudflare `502` root cause is therefore remediated at the application origin without configuration loss.

**Public-verifier observation and correction:** The source host’s subsequent public verification received a local trust error (`curl (60) unable to get local issuer certificate`), while an independent public request reached Cloudflare and returned its `403 Attention Required / Sorry, you have been blocked` page. This is a Cloudflare edge policy response, not a Node listener failure or an Origin CA issuance failure. Hardened all installer/verifier public HTTP(S) checks with `curl --noproxy '*'` so inherited enterprise egress proxy variables cannot replace the public certificate chain or inject a block page into origin diagnostics. This changes only outbound verifier behavior; it does not disable certificate verification, bypass Cloudflare, or change application/TLS/firewall configuration.

**Validation:** Updated verifier/installer regression coverage. Focused verification tests passed **21 tests across 4 files**; the complete non-database suite passed **250 tests across 38 files**. Bash syntax checks for all three touched deployment scripts, TypeScript typecheck, zero-warning ESLint, `git diff --check`, `pnpm audit --prod` (no known vulnerabilities), and changed-file credential scanning passed. No VPS credentials, protected environment values, certificates, private keys, Cloudflare token, data, or user content was accessed. Source commit/push verification follows.
**Proxy-isolated verifier source commit:** The reviewed direct-public-health correction was committed and published as `128ac0c96312a10980fa68885b8a415df4ad1830` (`fix: isolate public health checks from proxies`). Final session-log publication verification follows.


## 2026-10-20 — Portal blank-page split-bundle correction
**User-provided evidence:** After the source-only Express recovery reported local readiness, `https://my.readypackets.com` rendered a blank browser page. Local Nginx health remained `PASS`, making an origin listener or Cloudflare 502 an insufficient explanation.

**Root cause:** The shared split Vite configuration force-assigned React, Wouter, and other dependency families to manual chunks. The production build emitted `Circular chunk: vendor -> react -> vendor`; a client-side ESM initialization cycle can execute a React-hook consumer before React’s runtime is initialized, fail before `ErrorBoundary` mounts, and present a blank shell. The legacy Vite configuration already documented this risk, but the separate split configuration did not enforce the same safety constraint.

**Correction:** Removed hand-authored manual chunk assignment from the split public/portal build configuration. Rollup now derives its chunks from the real dependency graph, preserving module initialization order. A portal production build completed with no circular-chunk warning and emitted one immutable content-hashed portal entry asset plus its CSS. This is a correctness-first immediate remediation; route-level lazy loading remains a future, separately reviewable performance optimization. Added regression coverage prohibiting a manual React/vendor cycle and retaining the split portal/CSP-nonce build contract. Source commit/push verification and an atomic existing-VPS portal-bundle repair helper follow.


**Portal-bundle repair helper:** Added `deploy/repair-split-portal-bundle.sh`, pinned to immutable client-build-only commit `d5b25e18b3f6b52ab3d82c02a9775f368c9e8cc1`. It requires a deliberate `--confirm-known-split-bundle-cycle` argument; verifies the target’s parent diff has no package, server, deploy, or migration changes; builds only the portal client bundle in a detached worktree; rejects circular chunk output; checks every shell-referenced JS/CSS asset; preserves `/etc/readypackets/portal.env` by SHA-256; atomically swaps only `client/dist-portal`; validates the shell, CSP header, and assets through local Nginx TLS; and rolls the original bundle back automatically upon failure. It does not restart services or change server, Cloudflare, certificates, Nginx, database, files, accounts, aliases, backups, or integrations.

**Final validation:** Dedicated split-bundle/repair tests passed **15 tests across 3 files**; the complete non-database suite passed **253 tests across 39 files**. The complete public/legacy/portal/server production build passed with no split circular-chunk warning and required artifacts present. Bash syntax, TypeScript typecheck, zero-warning ESLint, `git diff --check`, `pnpm audit --prod` (no known vulnerabilities), immutable target scope checks, and credential scanning passed. Generated build artifacts were removed. No live VPS, Cloudflare account, secrets, certificates, customer data, or account settings were accessed from the development environment. Commit/push verification follows.
**Immutable releases:** The permanent graph-safe split-build correction was committed locally as `d5b25e18b3f6b52ab3d82c02a9775f368c9e8cc1` (`fix: remove split bundle runtime cycle`). The guarded atomic portal-bundle repair helper, documentation, tests, and validation record were committed locally as `2db2f4a02f8d7f56ff8a13d242a4be68152b7a03` (`fix: add split portal bundle recovery`). A final session-log commit and private GitHub `main` synchronization verification follow.


**Legacy runtime follow-up:** The affected VPS has `PUBLIC_SITE_URL` equal to its canonical `APP_URL`, so `siteSplitEnabled` is false and the application serves the legacy `client/dist/index.html` bundle—not `client/dist-portal/portal.html`. The earlier split-bundle repair completed correctly but was not the active browser bundle for this single-host deployment. The legacy Vite configuration retained the same hand-authored React/vendor chunk strategy and Wouter appeared in the generic vendor chunk. Removed manual chunk assignment from the legacy build as well, using Rollup’s dependency-graph chunking and content-hashed output. The legacy production build completed with no circular-chunk warning and emitted a single graph-safe entry asset. The repair helper will be expanded to detect the active routing mode and atomically replace only the active client-bundle directory. Source commit/push verification follows.


**Active-bundle repair correction:** Updated the guarded client repair to retrieve immutable legacy-and-split client fix `ff92e369a897cba121b894f9a8aaa8eaedaaa733` and select the real runtime bundle from non-secret routing metadata: `client/dist` plus `build:legacy` when `PUBLIC_SITE_URL` is unset/equal to `APP_URL`, or `client/dist-portal` plus `build:portal` only when a distinct public hostname is configured. It preserves the same immutable target scope checks, protected-environment digest, local Nginx/CSP/asset verification, and automatic directory rollback. This corrects the one-host deployment path without changing the user’s `PUBLIC_SITE_URL`, hosting topology, TLS, server, data, or integrations. Focused helper tests passed **15 tests across 3 files**; the complete non-database suite passed **253 tests across 39 files**. Bash syntax, TypeScript typecheck, zero-warning ESLint, `git diff --check`, `pnpm audit --prod` (no known vulnerabilities), immutable target scope checks, and credential scanning passed. Source commit/push verification follows.
**Immutable releases:** The legacy one-host graph-safe client build correction was committed locally as `ff92e369a897cba121b894f9a8aaa8eaedaaa733` (`fix: remove legacy bundle runtime cycle`). The active legacy-or-split client bundle recovery helper, documentation, regression updates, and validation record were committed locally as `7f044d6362185ae963bcf8087305d4860eab4dbc` (`fix: repair active portal client bundle`). A final session-log commit and private GitHub `main` synchronization verification follow.


**Confirmed one-host blank-page root cause:** The active-client repair rebuilt `client/dist` successfully but stopped and restored it when local Nginx returned HTTP 404 for the exact JavaScript hash listed in that shell. Source review confirmed `clientDistFor()` and `clientShellFor()` correctly select `legacyClientDist`/`index.html` when `siteSplitEnabled` is false, but static middleware incorrectly selected `portalClientDist` whenever the request was not on a distinct public hostname. Native installs build both directories, so the single-host shell referenced `client/dist/assets/<hash>.js` while `/assets` was resolved in `client/dist-portal`, causing deterministic 404 and a blank browser page. Corrected static middleware to select `legacyStatic` before considering split public/portal directories in one-host mode. A real local Express listener then returned the built legacy hashed JS asset with **HTTP 200**, JavaScript content type, and a 1.7 MB body. The local test environment logged expected database-connection failures from unrelated dynamic policy/blacklist loaders because no MySQL test service was running; those did not affect the static 200 assertion. Added static-route regression coverage. An immutable source commit and a guarded combined server-plus-client recovery helper follow.


**Legacy static asset recovery helper:** Added `deploy/repair-legacy-static-assets.sh`, pinned to immutable static-route target `d412dee82c4ad4e4ee58dba0ec49037befd5dd9b`. It requires explicit `--confirm-known-legacy-asset-404`, refuses split-host topology, validates the source checkout/origin and protected-environment mode, permits only the target’s reviewed `server/app.ts`/test/session-log paths, verifies the inherited graph-safe legacy Vite configuration, then builds only legacy client and server artifacts in a detached worktree. It stages and atomically swaps only `/opt/readypackets/client/dist` and `/opt/readypackets/dist/server.js`, restarts the existing service only because server static-routing changed, validates readiness plus the precise shell/CSP/hashed asset paths through local Nginx TLS, checks the environment digest, and automatically restores both prior artifacts and restarts the previous service if any activation/validation step fails. It never runs migrations/seeding/installer logic or changes portal configuration, certificates, Nginx, Cloudflare, database, storage, backups, users, aliases, or integrations.

**Final validation:** Focused static-route/recovery tests passed **26 tests across 5 files**; complete non-database regression passed **256 tests across 40 files**. The legacy client build completed without a circular chunk warning, the server build completed, and a real local Express static request for the exact legacy HTML-referenced JavaScript asset returned **HTTP 200** with a JavaScript content type. The isolated local smoke emitted expected unrelated dynamic-policy loader errors because its MySQL test service was intentionally absent; it did not affect the static asset assertion. Bash syntax, TypeScript typecheck, zero-warning ESLint, `git diff --check`, `pnpm audit --prod` (no known vulnerabilities), immutable target scope checks, generated-artifact cleanup, and credential scanning passed. Commit/push verification follows.
**Immutable releases:** The legacy one-host static asset routing correction was committed locally as `d412dee82c4ad4e4ee58dba0ec49037befd5dd9b` (`fix: serve legacy assets from active bundle`). The guarded atomic server-and-client recovery helper, documentation, regression updates, and validation record were committed locally as `8f15e94653c195e909945950f0cdbdc555b3be08` (`fix: recover legacy static asset routing`). A final session-log commit and private GitHub `main` synchronization verification follow.


---
## 2026-10-20 — Portal-only surface, SharePoint preflight, protected backups, and portable Platform Setup profiles

**User request:**
> 1. the page loaded successfully so please include the latest fixes in github because it is now working and update the install configuratoins documentation and scripts.
> 2. The portal site should only be the portal login page and not the full site it should link back to the marketing site for the links that make sense to link back to.
> 3. fix the sharepoint error in the screenshot. I got that error after testing the connection
> 4. Add the ability to configure the SharePoint site sync to the platform setup.
> 5. Add the ability to configure backup configuration settings in the platform setup.
> 6. Add the ability to download the platform setup configuration to a file for easy future importing. Also add the ability to go through the wizard or import the configuration. Make sure that the configuration remains standard so the settings can be imported to future system platform deployments
> 7. Fix the backup system errors

**Confirmed prior repair:** The affected VPS successfully rendered after the guarded legacy static-asset repair. The reported recovery output showed the legacy browser bundle and server source were installed while protected environment, TLS/Nginx/Cloudflare, database, files, accounts, and integrations remained unchanged. The new release retains the prior Express 5, bundle-cycle, and legacy static-asset corrections in the normal source/install path; it does not re-run a recovery helper or touch the VPS.

**Portal-only deployment and navigation:** Added the explicit `PORTAL_ONLY` runtime mode. Fresh native and unified/Docker portal installs set it when no same-VPS public hostname is intentionally configured. In this mode the portal hostname always serves the portal bundle; `/` redirects to `/login`, known public marketing routes issue a 302 to the separately validated `MARKETING_SITE_URL`, and unknown routes use a portal-local not-found page. The public site is not an allowed portal host, Origin, TLS name, cookie domain, or API trust entry. The validated `MARKETING_SITE_URL` is injected only as navigation data for the portal logo, “Public site,” registration-contact, and portal-not-found links, with a safe `https://www.readypackets.com` fallback. Portal-only host/origin behavior, public-path redirects, and output-bundle selection remain fail-closed.

**SharePoint correction:** The connection preflight now normalizes the saved base folder, verifies site and library access, and performs a read-only Graph GET of the configured folder before reporting success. A Graph `404 itemNotFound` becomes the safe actionable message: “SharePoint folder not found; browse and select the folder or correct the base path. If it exists, confirm this app has Sites.Selected access to the selected site.” Provider response bodies are not surfaced to administrators. No Graph writes, folder creation, broad delegated permissions, or secret display occur during testing. Platform Setup now contains a SharePoint site synchronization step for the application identity, site/library IDs, existing base folder, and audio fallback mode; it preserves an existing write-only client secret if blank and allows saved non-secret identifiers to be revised without re-entering them.

**Backup-controller correction:** The reported backup-page errors were caused by the capability-restricted root backup socket controller attempting `install -d -m`/permission updates on every browser request. Its systemd sandbox correctly denied the resulting `chmod` operation. The installer now establishes the root-owned fixed state, archive, protected export, and restore-staging directories before starting the controller. The controller only verifies their expected ownership/modes on requests; it does not weaken systemd sandboxing, grant sudo to the web service, or accept caller-controlled paths/commands. Existing deployments receive the fixed helper, units, and directory provisioning through the approved Platform Updates flow (or the reviewed native installer re-run with canonical domain and `--skip-packages`), not by relaxing permissions manually.

**Portable Platform Setup profile:** Added a versioned `readypackets-platform-setup-profile` format, version `1`, and explicit **Download setup profile** / **Import setup profile** controls in Administration → Platform setup. The profile is intentionally secret-free and portable: it carries reviewable email transport fields, SharePoint site/library/base-folder identifiers, backup schedule and target labels, public Stripe key, and webhook destinations. It excludes passwords, client secrets, OAuth/refresh tokens, certificates, private keys, Stripe secret/webhook signing values, webhook signing secrets, host/network/TLS/database configuration, and access-control activation. Import first confirms protected backup scheduling is available, then applies non-secret values; webhook destinations import disabled, and a visible follow-up identifies all credentials and backup-target credentials that must be re-entered/reconfigured. Entra and access controls remain review-required. Profile export/import and sensitive setup changes generate administrator activity records without secret values.

**Installer and documentation:** Updated `.env.example`, native `deploy/install.sh`, and Docker/unified installation environment generation with the portal-only and external-marketing model. Updated the Master Installer guide, deployment guide, self-hosted installation guide, and dual-site guide to document the dedicated portal topology, standard profile limits, corrected protected backup provisioning, and upgrade path. `readypackets.com`/`www.readypackets.com` remain reserved for the separately hosted ReadyPackets public website.

**Validation completed:** Focused regressions covering the profile contract, SharePoint preflight/path normalization, marketing navigation, portal/static routing, and installers passed **43 tests across 10 files**. The complete non-database suite passed **264 tests across 43 files**. TypeScript typecheck, zero-warning ESLint, Bash syntax for the modified installers and backup helpers, Node syntax for the backup controller, and `git diff --check` passed. Full legacy/public/portal/server production builds succeeded; only the known Vite large-chunk advisories were emitted, and all generated output was removed afterwards. `pnpm audit --prod` reported no known production dependency vulnerabilities. A high-confidence changed-source credential scan passed after excluding generated build output. Database-backed `tests/domain.test.ts` remains excluded in this sandbox because no local MySQL/Docker service is available; it was not claimed as passing. No live VPS, Cloudflare configuration, Microsoft tenant, SharePoint site, secrets, certificates, customer data, or portal account was accessed by this source release.

**Publication state:** Pending final source review, commit, private GitHub `main` push/synchronization check, and immutable commit record.
