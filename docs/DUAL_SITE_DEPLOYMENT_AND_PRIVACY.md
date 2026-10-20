# ReadyPackets Dual-Site Deployment and Privacy Controls

## Purpose

This release separates **the public marketing site** from **the authenticated customer and administration portal** while retaining one self-hosted Node/Express service, one MySQL database, and the existing zero-trust authorization boundary. The public site is intended for anonymous discovery, search, accessibility, and conversion; the portal is intended for authenticated work, customer files, messages, orders, and administration.

The separation is implemented as two independently compiled React bundles. The service selects a bundle only after validating the request hostname against its explicit configuration. The public bundle excludes portal and administrative route code. The portal bundle excludes public marketing pages. This improves first-load performance for prospective customers and reduces the amount of authenticated application code shipped to anonymous visitors without weakening server-side authorization.

```mermaid
flowchart LR
  V[Visitor] --> P[www.example.com\nPublic marketing bundle]
  C[Customer or staff] --> A[portal.example.com\nAuthenticated portal bundle]
  P --> G[Same self-hosted ReadyPackets service]
  A --> G
  G --> DB[(MySQL)]
  G --> S[Private object storage]\n  G --> O[Audit and security logs]
  G --> M[Optional Microsoft Graph\nselected-site connections]
  P -. consented only .-> X[Optional Clarity / PostHog]
  A -. consented only .-> X
```

## Required hostname model

Use a dedicated portal hostname and a distinct public hostname. The recommended pattern is `portal.example.com` for the authenticated portal and `www.example.com` for marketing. Do not use the apex/www compatibility alias as the portal hostname when that alias is meant to become the public site; the installer rejects that ambiguous arrangement.

| Setting | Example | Purpose |
| --- | --- | --- |
| `APP_URL` | `https://portal.example.com` | Canonical portal/API identity for operational mail, SAML, native clients, and authenticated routes. |
| `PUBLIC_SITE_URL` | `https://www.example.com` | Public marketing hostname that receives the isolated public bundle. |
| `ALLOWED_ORIGINS` | `https://portal.example.com,https://www.example.com` | Explicit Origin allowlist for state-changing browser requests. |
| DNS records | Both hosts resolve to the same origin/load balancer | The service selects a bundle from the validated `Host` header; it does not use a mutable client-supplied routing field. |

The portal keeps host-only `__Host-` session and CSRF cookies. The public site never receives portal session cookies. A user who follows a public sign-in link is redirected by the server to the portal hostname before the portal shell is rendered.

### Independent external marketing host

ReadyPackets may instead run its independently built static marketing website on a separate host, such as Hostinger, while this repository serves only the portal from a VPS. This is the current deployment direction for the standalone marketing repository. In that model, the marketing host links directly to a dedicated portal hostname such as `my.readypackets.com`; it does not proxy portal APIs, share portal cookies, or run this repository's anonymous bundle.

For a portal-only VPS installation, omit `--public-domain`. The current installer writes `PORTAL_ONLY=true`, keeps the portal's TLS certificate, Nginx host allowlist, and health checks scoped to its dedicated portal hostname, and selects the portal bundle even if an older public URL remains in configuration. Do **not** include the external marketing hostname in the VPS installer: Let’s Encrypt would otherwise try to validate a hostname that points to the external host, and the portal VPS would claim a hostname it does not serve. The separate marketing host remains responsible for its own TLS, security headers, redirects, consent, and SEO controls.

The installer writes `MARKETING_SITE_URL=https://www.readypackets.com` for navigation from the portal logo, “Public site” links, and registration-contact actions when no same-VPS public hostname is configured. It must be an HTTPS origin with no path, query, fragment, or credentials. The server injects it into `data-rp-marketing-origin` on `portal.html`; the portal client validates it again before use and falls back to `https://www.readypackets.com` if it is absent or invalid. `MARKETING_SITE_URL` is deliberately **not** added to `PUBLIC_SITE_URL`, `ALLOWED_ORIGINS`, the portal host allowlist, TLS configuration, or cookie scope. An operator may change it only to another approved separately hosted marketing origin.

## Native VPS installation

The guided bootstrap defaults to this continuation repository. It is intended for a repository that is temporarily public for the installation, or for a checked-out private repository with a deploy-key procedure. Always pin a reviewed immutable commit for a production install.

```bash
# On a new Ubuntu/Debian VPS, after DNS for both names points to the server:
curl -fsSL https://raw.githubusercontent.com/readypackets/ReadyPackets-SiteSplit/main/deploy/one-click-install.sh -o /tmp/readypackets-install.sh
sudo bash /tmp/readypackets-install.sh
```

The guided flow asks separately for the portal hostname and the public marketing hostname. For unattended deployment from a deliberately public repository, use protected environment values rather than placing secrets in the command line:

```bash
sudo env \
  RP_REPOSITORY=readypackets/ReadyPackets-SiteSplit \
  RP_REF=main \
  RP_COMMIT=REVIEWED_40_CHARACTER_COMMIT_SHA \
  RP_DOMAIN=portal.example.com \
  RP_PUBLIC_DOMAIN=www.example.com \
  RP_EMAIL=ops@example.com \
  RP_MODE=native \
  RP_TLS_PROVIDER=letsencrypt \
  RP_SITE_NAME=ReadyPackets \
  bash /tmp/readypackets-install.sh
```

For a private repository, clone it to a root-owned source directory using a repository-specific deploy key, validate the reviewed commit, and run the native installer from that checkout:

```bash
sudo bash deploy/unified-install.sh \
  --mode native \
  --domain portal.example.com \
  --public-domain www.example.com \
  --email ops@example.com \
  --tls-provider letsencrypt \
  --site-name ReadyPackets
```

The installer requests one certificate covering every configured hostname, writes both `APP_URL` and `PUBLIC_SITE_URL`, compiles `client/dist-public` and `client/dist-portal`, applies every forward-only migration, and fails closed if the schema contract is incomplete. The current expected checkpoint is:

```text
Applied 51 migration(s); 44 critical tables verified.
```

> **Certificate caution.** For Cloudflare Origin CA, use a scoped token or a manually supplied certificate that covers both the portal and public hostnames. Do not store a private key, Cloudflare token, PostHog key, or any other secret in GitHub.

## Verification and rollback

Verify both surfaces after installation. The public root must return the public shell and indexable metadata; the portal root must return a no-index portal shell. Health checks remain same-origin.

```bash
curl -fsSI https://www.example.com/
curl -fsSI https://portal.example.com/api/health/ready
sudo systemctl status readypackets nginx mysql --no-pager
sudo nginx -t
```

The original ReadyPackets repository and deployment are intentionally untouched. This continuation repository was created as a separate private GitHub repository. Before cutover, retain the original service, database, backups, TLS material, and DNS records. A rollback is therefore a controlled DNS/load-balancer reversal to the original deployment after verifying health; do not overwrite the original checkout or database to reverse this user-experience change.

## Consent-gated Microsoft Clarity and PostHog

ReadyPackets ships provider **capability**, not provider activation. Microsoft Clarity and PostHog are disabled by default. A provider is not loaded, configured, or contacted until all of the following are true:

1. An administrator enables the Analytics category in **Admin → System → Privacy & cookies**.
2. An administrator enters the relevant provider configuration in the consent-gated analytics section and explicitly saves it.
3. The visitor uses the preference center to affirmatively select **Analytics** on that hostname.

The browser receives no provider project configuration while its analytics preference is absent or false. The application disables PostHog autocapture and session replay, sends only a reviewed path/surface event vocabulary, and excludes account IDs, e-mail addresses, order IDs, document names, messages, file metadata, form values, and free-text data. The default configuration also uses PostHog’s opt-out-by-default control.

Administrators may separately enable consented cross-site analytics continuity for the dual-bundle deployment served by this repository. On a deliberate public-to-portal navigation, the browser carries only a cryptographically random, per-browser navigation handoff identifier (`rp_ac`) to the configured portal origin; the portal removes it from the visible URL once consented analytics starts. It is never derived from, linked in code to, or replaced with a ReadyPackets account, e-mail, order, document, message, authentication, session, CSRF, MFA, access-control, or file identifier.

> **Independent marketing-host boundary:** The standalone `ReadyPackets-Marketing-Site` repository deliberately does not create or consume this handoff. Keep the portal's cross-site continuity control **off** while marketing is independently hosted on Hostinger/Bluehost unless a separate, privacy-reviewed implementation is released and verified across both repositories. See [the operator setup guide](./CLARITY_POSTHOG_OPERATOR_SETUP.md) for the supported provider configuration paths.

Microsoft Clarity ConsentV2 requires explicit analytics storage signaling for full functionality in the EEA, United Kingdom, and Switzerland. PostHog recommends opt-out-by-default and explicit `opt_in_capturing()` / `opt_out_capturing()` coordination with the consent manager.[1][2] ReadyPackets follows these controls, but an organization must still configure provider-side masking, retention, region, IP capture, data-processing terms, and any legal notices appropriate to its jurisdictions.

## Operational privacy checklist

| Control | ReadyPackets behavior | Operator action before activation |
| --- | --- | --- |
| Lawful basis and notice | Consent banner exposes Essential, Preferences, Analytics, and Marketing categories; Analytics remains off by default. | Publish an accurate privacy notice and identify each activated provider, purpose, retention, and regional transfer basis. |
| Withdrawal | Preference center remains available after choice; provider capture is stopped when consent is withdrawn. | Test accept and withdraw flows on both hostnames. |
| Data minimization | Curated event allowlist; no portal/business payloads; PostHog autocapture/replay disabled in the application; optional cross-site continuity uses only a random navigation handoff. | Keep provider-side masking on; do not add PII to custom event properties. |
| Data residency | Administrator chooses the US or EU PostHog ingestion host. | Select the approved region and configure retention/IP capture in the provider account. |
| Auditability | Administrative changes to analytics provider settings are recorded in the ReadyPackets activity log. Consent decisions have hashed evidence records. | Review the audit center and retain appropriate records under the organization’s policy. |
| Security boundary | Hostname validation, CSP nonce, strict Origin/CSRF validation, host-only cookies, and server-side authorization remain in force. | Maintain TLS, Cloudflare/origin policy, system updates, backups, and least-privilege admin access. |

## References

[1]: https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-consent-api-v2 "Microsoft Clarity Cookie Consent API - ConsentV2"
[2]: https://posthog.com/docs/privacy/data-collection "PostHog Controlling data collection"
[3]: https://posthog.com/docs/libraries/js "PostHog JavaScript web library"
