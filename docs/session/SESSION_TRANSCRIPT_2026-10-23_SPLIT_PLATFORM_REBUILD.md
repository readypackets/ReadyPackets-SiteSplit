# Redacted Session Transcript — Native Mobile Split-Platform Rebuild

**Date:** 2026-10-23
**Repository:** ReadyPackets-SiteSplit

## User requests

1. “Rebuild the apps based on the updated ReadyPackets Platform. The platform has split into 2.”
2. Portal repository: `https://github.com/readypackets/ReadyPackets-SiteSplit`
3. Marketing repository: `https://github.com/readypackets/ReadyPackets-Marketing-Site`

## Implementation response

The Portal, marketing topology, and standalone native clients were audited together. The canonical authenticated Portal/API origin is treated as a separate trust boundary from the canonical public marketing site. The Portal mobile API was then updated to provide explicit secure Portal versus public marketing browser entrypoints, while preserving system-browser authentication and local MFA.

The implementation ports self-hosted mobile OAuth/session hardening into the current split Portal: distinct mobile access-token signing configuration, PKCE scope persistence, device-session/token-family revocation, self-service device revocation, password/MFA/deletion-triggered revocation, security event taxonomy, correlation IDs, TLS syslog forwarding, and stricter rate-limit classification. A forward-only migration aligns database schema with the self-hosted no-provider-push baseline.

The shared mobile OpenAPI contract was synchronized to the standalone native repository. No production secret, signing key, callback association file, customer record, session token, payment data, or third-party provider credential was stored in this transcript or source control.

## Result and release conditions

iOS and Android now receive separately validated Portal and marketing URLs, and upload response models are aligned. Remaining release conditions are documented in the companion application-context record: database migration, protected release variables, app-link association files, device validation, and a reviewed public deletion-information page for store metadata.
