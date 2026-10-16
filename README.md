# ReadyPackets Portal

A self-hosted customer website and customer portal for ReadyPackets, built as a single deployable application with no external service dependencies. The system covers the public marketing site, the authenticated customer portal through which clients configure orders and receive deliverables, and the administrative back office through which the business runs.

The application is designed for a small VPS or a Docker host. It requires nothing beyond Node.js, MySQL, and a reverse proxy. There are no third-party analytics scripts, no CDN dependencies, no external font hosts, no software-as-a-service integrations, and no platform-specific runtime hooks of any kind. Payment capture through Stripe and outbound email through SMTP are both optional and disabled until credentials are supplied.

> **Deployed instance.** This application is running in production at
> <https://myportal.readypackets.com>, installed with `deploy/install.sh` on a
> two-core Ubuntu 22.04 VPS behind nginx with a Let's Encrypt certificate. That
> deployment is the reference for the instructions below: every step here has been
> executed on a clean host rather than described from intention. See section 11 of
> `SESSION_LOG.md` for what a first real installation exposed.

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
| API | Express 4, tRPC 11, Zod | Every input validated by schema at the boundary; types shared with the client |
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

```bash
sudo ./deploy/install.sh --domain portal.readypackets.com --email ops@readypackets.com --tls
```

The installer provisions the service account, database, build, systemd unit, nginx site, firewall, and nightly backup timer. It generates all cryptographic secrets locally and is safe to re-run: existing secrets are preserved so that encrypted data is never orphaned.

Complete instructions, including SMTP, Stripe, SAML, and backup verification, are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

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
| [docs/GLOBAL_SCALE_ARCHITECTURE.md](docs/GLOBAL_SCALE_ARCHITECTURE.md) | Horizontal web replicas, worker coordination, shared storage, global routing, and regional compliance controls |
| [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md) | Running the business in the portal, day to day |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | Customer-facing walkthrough from registration to delivery |
| [docs/GAP_ANALYSIS_RESPONSE.md](docs/GAP_ANALYSIS_RESPONSE.md) | Point-by-point response to the Batch 39 gap analysis |
| [SESSION_LOG.md](SESSION_LOG.md) | Full development log for this build |

## Licence and ownership

Proprietary. Copyright ReadyPackets. All rights reserved.
