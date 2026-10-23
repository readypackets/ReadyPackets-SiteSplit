# Native Mobile Rebuild — Split Platform Context

**Date:** 2026-10-23
**Portal source:** https://github.com/readypackets/ReadyPackets-SiteSplit
**Marketing source:** https://github.com/readypackets/ReadyPackets-Marketing-Site
**Native source:** `readypackets-native-mobile` repository

## Platform boundary

ReadyPackets now operates as two deliberate web surfaces:

| Surface | Canonical origin | Responsibility |
| --- | --- | --- |
| Authenticated Portal / mobile API | `https://my.readypackets.com` | Login, MFA, OAuth 2.1 PKCE, customer account, orders, uploads, API, audit, device sessions |
| Public marketing website | `https://www.readypackets.com` | Public solutions, privacy, terms, refunds, accessibility, contact, SEO/AEO/GEO content |

`portal.readypackets.com` is an alternate portal address only where operations deliberately configure it. It must not be silently mixed with the canonical mobile API origin. The public site, apex redirect, and `go` staging hostname must never be used as an OAuth callback origin.

## Implemented integration changes

- Added distinct `MARKETING_SITE_URL` browser-entrypoint output for public website routes while retaining secure account lifecycle links on `APP_URL`.
- Published one OpenAPI source from `server/http/mobile/openapi.yaml` and synchronized both Portal-owned and standalone native copies.
- Added exact-origin native device revocation, scope persistence, device/session revocation on password/MFA/deletion trust changes, rotating token families, strict mobile access-token signing configuration, correlated audit events, secure TLS syslog forwarding, and mobile route rate-limit classification.
- Removed APNs/FCM/provider token persistence from the self-hosted baseline. Authenticated in-app updates remain the notification model.
- Added migration `0059_mobile_identity_hardening.sql`; it is forward-only and idempotently adds mobile session scopes before removing retired provider-token columns.
- Normalized upload replies to explicit `UploadReply.files` DTOs so iOS and Android decode accepted file responses reliably.

## Required release configuration

Portal production needs `APP_URL=https://my.readypackets.com`, matching `MOBILE_OAUTH_ISSUER`, an independently generated `MOBILE_ACCESS_TOKEN_SECRET`, exact `MOBILE_OAUTH_REDIRECT_URIS`, and optionally a validated `SYSLOG_TARGET=tls://host:6514`.

Native protected release environments need `PORTAL_BASE_URL`, `MARKETING_BASE_URL`, `OAUTH_REDIRECT_URI`, and `MOBILE_APP_LINK_HOST`. Production public browser links should use `https://www.readypackets.com`; they are not trusted as Portal links.

## Remaining release gates

1. Publish signed `apple-app-site-association` and `assetlinks.json` at a dedicated callback host matching `OAUTH_REDIRECT_URI`.
2. Verify the canonical Portal hostname with deployed OAuth, browser MFA, magic-link/SAML continuation, storage, email, and checkout flows on physical devices.
3. Publish a reviewed public account-deletion information route on the marketing site before using a deletion URL in store metadata.
4. Apply database migration `0059` and validate the schema contract before starting the Portal.
5. Configure secure SIEM certificate trust and monitoring if `SYSLOG_TARGET` is enabled.


## Functional Android test APK follow-up

The selected authenticated test topology is `https://my.readypackets.com` for Portal/API and verified Android App Link callback, and `https://www.readypackets.com` for public website navigation. The Portal source now serves `/.well-known/assetlinks.json` from the public, validated `ANDROID_APP_LINK_SHA256_CERT_FINGERPRINTS` setting. The deployment must publish the current Portal source, configure the exact callback in `MOBILE_OAUTH_REDIRECT_URIS`, and ensure Cloudflare does not challenge or block the association document. A protected GitHub environment holds the matching test signing key; its private material must never enter the Portal repository or server environment.
