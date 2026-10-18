# ReadyPackets Portal

A self-hosted customer portal and administrative workspace for ReadyPackets. Customers configure orders, submit and retrieve protected files, execute required agreements, receive deliverables, and communicate securely; staff use the same platform for governed order operations, customer management, security, recovery, integrations, and audit review.

The independently hosted ReadyPackets website at `www.readypackets.com` is a separate static deployment. The portal belongs only on a dedicated authenticated hostname such as `my.readypackets.com`; up to five explicit aliases such as `portal.readypackets.com` can permanently redirect to that canonical hostname. Aliases do not share or create a second session/CSRF origin, and the public website does not share portal sessions, customer data, uploads, or runtime. The native portal deployment is designed for Ubuntu 24.04 LTS, Node.js 22, MySQL 8, Nginx, systemd, protected backups, and restricted root controllers. It contains no Manus runtime, OAuth, hosting, or platform dependency.

Optional Stripe, SMTP, Microsoft Graph/SharePoint, SAML, SIEM/syslog, Microsoft Clarity, and PostHog capabilities are disabled until deliberately configured. Consent-gated analytics and all third-party integrations remain subject to the portal's access control, privacy, encryption, audit, and administrator-approval boundaries.

## What the system does

The portal implements the ReadyPackets delivery model: a customer selects one or more packets from the product catalogue, completes a structured Phase I intake questionnaire, and receives a synthesised deliverable set through a controlled download channel. Eight packet groups are represented, including the institutional Capital and Valuation packet that is not published on the public catalogue, and the All-In bundle rule that applies a fifteen percent discount once a selection spans six or more distinct packet groups.

| Surface | Audience | Principal capability |
| --- | --- | --- |
| Public site | Anonymous visitors | Catalogue with live pricing, packet detail pages, methodology, reviews, changelog, policy documents, contact intake |
| Customer portal | Authenticated customers | Order configurator with live quoting, four-phase order tracking, mutual NDA execution, Phase I intake with autosave, deliverable library, support tickets, community forum, account and security settings |
| Administration | Staff and administrators | Order operations and phase transitions, customer records, catalogue and content management, moderation queues, file management, security centre, system health and configuration |

## Architecture in brief

A single Node process serves the API and the built client assets. State lives in MySQL, with uploaded files on local disk for a single node or S3-compatible private object storage for horizontally scaled replicas.

```
Internet → nginx (TLS termination, edge rate limiting)
              ↓ 127.0.0.1:3000
           Node 22 / Express / tRPC
              ↓
           MySQL 8 (72 tables)  +  local file storage
```

The client is React 19 with TypeScript and Tailwind CSS, bundled by Vite. The API is tRPC over Express, which gives the browser end-to-end type safety without a code generation step. Database access is through Drizzle ORM, which produces parameterised SQL exclusively. The full design rationale, including the threat model and every security control, is documented in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/SECURITY.md](docs/SECURITY.md).

| Layer | Technology | Why |
| --- | --- | --- |
| Client | React 19, TypeScript, Tailwind CSS 4, Vite | Static output that any web server can host; no runtime framework server required |
| API | Express 5, tRPC 11, Zod | Every input validated by schema at the boundary; types shared with the client |
| Data | MySQL 8, Drizzle ORM | Parameterised queries only; schema defined in TypeScript and migrated by generated SQL |
| Authentication | Local password with Argon2id, TOTP MFA, optional SAML 2.0 | No external identity provider required |
| Storage | Local filesystem, optional S3-compatible object storage | Single host by default; shared private objects for scale-out |

## Security posture

Security is the organising principle of the build rather than a later hardening pass. The measures below are verified by an automated suite that exercises the running application; see [Verification](#verification).

- **Content Security Policy** with a per-request nonce and no `unsafe-inline` or `unsafe-eval` in any directive, which means an injected script cannot execute even if it reaches the DOM.
- **Cross-site request forgery** defence in three independent layers: `Origin` and `Referer` validation, a double-submit cookie token, and binding of that token to the server-side session.
- **Session management** using `__Host-` prefixed, `HttpOnly`, `SameSite=Strict` cookies backed by server-side session records that can be revoked individually or in bulk.
- **Password storage** with Argon2id at 64 MB and three passes, with transparent bcrypt migration, and constant-time verification burn on unknown accounts so that timing cannot enumerate users.
- **Field-level encryption** with AES-256-GCM for personal data, binding each ciphertext to its owning row so a value cannot be relocated, with HMAC-SHA256 blind indexes to keep encrypted columns searchable.
- **Rate limiting** across six request categories with progressive penalties, scoped per category so that abuse of one endpoint cannot lock a shared address out of the whole site, escalating to a persistent block list.
- **Upload validation** by magic bytes rather than declared extension, with double-extension rejection, an explicit deny list of executable and scriptable formats, and forced attachment disposition on every download.
- **Multi-factor authentication** mandatory for administrative accounts, with optional IP allow-listing for the administrative surface.
- **Audit logging** of every security-relevant event and every administrative mutation, with sensitive values redacted from logs.

## Quick start

### Docker

```bash
cp .env.example .env          # then set the secrets it describes
docker compose up -d
docker compose exec app node dist/migrate.js
docker compose exec app node dist/seed.js
docker compose exec app node dist/create-admin.js --email you@example.com
```

The application listens on `127.0.0.1:3000`; put a reverse proxy in front of it, or start the bundled proxy with `docker compose --profile proxy up -d`.

### VPS

For a brand-new native VPS, the recommended interactive installation path is [`deploy/master-install.sh`](deploy/master-install.sh). It captures the canonical portal hostname, up to five optional canonical-redirect aliases, ReadyPackets display name, first administrator identity, TLS choice, and approved immutable release; creates the read-only GitHub deploy key; performs the full native installation; and creates the first local administrator with a generated one-time password. See [Guided Master Installer](docs/MASTER_PORTAL_INSTALLER.md).

After securely transferring the reviewed script from authenticated GitHub to the new VPS, run:

```bash
sudo bash /root/readypackets-master-install.sh
```

For approved non-interactive automation, use the lower-level bootstrap with explicit reviewed values:

```bash
sudo bash /root/github-bootstrap-install.sh \
  --repository readypackets/ReadyPackets-SiteSplit \
  --commit <REVIEWED_40_CHARACTER_SHA> \
  --domain my.readypackets.com \
  --portal-alias portal.readypackets.com \
  --mode native \
  --tls-provider cloudflare-origin-ca \
  --cloudflare-api-token-file /root/readypackets-secrets/cloudflare-origin-ca.token
```

The private-repository bootstrap is for a new VPS only. It requires a repository-scoped read-only deploy key and a reviewed complete commit SHA, and refuses to overwrite an existing source directory or active portal. `--portal-alias` is optional, repeatable up to five times, and requires DNS plus certificate coverage for every name. Nginx redirects aliases to `--domain` before cookies or API requests reach Node; unknown hostnames remain rejected. The installer provisions the service account, private database listener, production build, systemd unit, Nginx site, TLS, restricted helpers, and backup controls. It generates cryptographic secrets locally and preserves them during approved in-place updates so protected data is not orphaned.

Complete, production-safe instructions including deploy-key setup, Cloudflare Origin CA, Let's Encrypt, verification, MFA, backup/recovery drill, and troubleshooting are in [docs/PORTAL_VPS_DEPLOYMENT_RUNBOOK_2026-10-13.md](docs/PORTAL_VPS_DEPLOYMENT_RUNBOOK_2026-10-13.md). Use [docs/AUTO_DEPLOYMENT.md](docs/AUTO_DEPLOYMENT.md) for approved in-place updates, not this fresh-server path.

### Local development

```bash
pnpm install
cp .env.example .env          # defaults work against a local MySQL
pnpm exec tsx scripts/migrate.ts
pnpm exec tsx scripts/seed.ts
pnpm exec tsx scripts/create-admin.ts --email dev@example.com
pnpm dev
```

Because host validation is strict, requests must present the configured hostname. Browse to `http://localhost:8080` rather than to a bare loopback address.

## Verification

Two independent suites run against the code and against the running service.

```bash
pnpm exec vitest run                                   # 112 unit tests
pnpm exec tsx scripts/verify-security.ts               # 46 live security checks
pnpm exec tsc --noEmit                                 # type check
```

The security script is a black-box probe: it drives the actual HTTP surface and asserts that the policy header is present and strict, that a mutation without a valid token is refused, that protected procedures are unreachable without a session, that traversal and dotfile requests are refused, that errors disclose no stack traces, and that the rate limiter both throttles and advertises its state. It is intended to be run after every deployment, and it passes against the production bundle as well as the development server.

## Repository layout

```
client/            React application (public site, portal, administration)
  public/brand/    Brand kit assets, self-hosted
  public/fonts/    Inter, self-hosted; no external font request is ever made
server/
  auth/            Sessions, MFA, password policy
  security/        Headers and CSP, CSRF, rate limiting, IP rules, cryptography
  routers/         tRPC routers, one per domain
  services/        Orders, catalogue, storage, email, settings, scheduler
  db/              Drizzle schema and repositories
  observability/   Structured logging and audit trails
shared/            Types and constants used by both client and server
scripts/           Migration, seed, administrator bootstrap, security verification
tests/             Unit tests
deploy/            nginx, systemd, installer, backup and restore
docs/              Architecture, security, deployment, administration, user guide
```

## Operational notes

The scheduler runs inside the application process for a single-node deployment and handles the outbound email queue, expiry of tokens and sessions, order health checks, and settings cache refresh. At scale, `INSTANCE_ROLE=web` replicas do not start background jobs; a dedicated `INSTANCE_ROLE=worker` performs them under MySQL-backed leases. No external cron entry is required for application logic; the only scheduled item outside the process is the nightly backup timer.

Configuration is environment-driven and validated at startup. The process refuses to start when a required secret is missing, weak, or left at a development default, which prevents an install from silently running with a predictable key. Every setting is documented in `.env.example`.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, data model, request lifecycle, threat model |
| [docs/SECURITY.md](docs/SECURITY.md) | Every control, what it defends against, and how it is verified |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | VPS and Docker deployment, TLS, backups, upgrades, troubleshooting |
| [docs/PORTAL_VPS_DEPLOYMENT_RUNBOOK_2026-10-13.md](docs/PORTAL_VPS_DEPLOYMENT_RUNBOOK_2026-10-13.md) | Current pinned-release deployment for a portal VPS separated from the external Hostinger marketing site |
| [docs/MASTER_PORTAL_INSTALLER.md](docs/MASTER_PORTAL_INSTALLER.md) | Recommended interactive one-script new-VPS portal installation with safe prompts and approval gates |
| [docs/GITHUB_AUTOMATED_INSTALL.md](docs/GITHUB_AUTOMATED_INSTALL.md) | Secure private-GitHub fresh-server bootstrap using an immutable reviewed commit and a read-only deploy key |
| [docs/GLOBAL_SCALE_ARCHITECTURE.md](docs/GLOBAL_SCALE_ARCHITECTURE.md) | Horizontal web replicas, worker coordination, shared storage, global routing, and regional compliance controls |
| [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md) | Running the business in the portal, day to day |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | Customer-facing walkthrough from registration to delivery |
| [docs/GAP_ANALYSIS_RESPONSE.md](docs/GAP_ANALYSIS_RESPONSE.md) | Point-by-point response to the Batch 39 gap analysis |
| [SESSION_LOG.md](SESSION_LOG.md) | Full development log for this build |

## Licence and ownership

Proprietary. Copyright ReadyPackets. All rights reserved.
