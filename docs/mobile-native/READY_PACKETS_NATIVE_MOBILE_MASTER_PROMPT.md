# ReadyPackets Native Mobile Applications — Master Build Prompt

**Use this document as the controlling build brief for the native iOS and native Android projects.** It is written for a senior mobile/platform engineering team or an autonomous development workflow. Apply every requirement unless an explicit written ReadyPackets decision supersedes it.

---

## 1. Product mission

Build and maintain two store-ready native mobile applications that act as secure mobile frontends for the self-hosted ReadyPackets Portal:

- **iOS:** Swift 6, SwiftUI, Swift Concurrency, Xcode project, native Apple frameworks.
- **Android:** Kotlin, Jetpack Compose, Coroutines/Flow, Gradle project, native Android Jetpack components.

The applications serve customers first, then narrowly scoped staff and administrator experiences. They must connect to the existing ReadyPackets self-hosted platform without introducing Manus dependencies, cloud-hosted application state, a second customer database, a PWA service worker, a WebView shell, React Native, Flutter, Capacitor, or any public statement that the product uses AI.

The backend remains the authoritative system for identity, authorization, MFA, business rules, payment state, workflow stages, phase locks, files, document access, encrypted PII, audit logs, notifications, policies, rate limits, and integrations. A mobile client is an untrusted client and must never substitute its own decision for a server authorization decision.

> **Do not build a desktop website inside a native wrapper.** Build native, accessible, task-focused applications that honor Apple Human Interface Guidelines and Android Material/Jetpack conventions while using the ReadyPackets visual identity.

## 2. Non-negotiable constraints

| Constraint | Required implementation |
|---|---|
| Native code | Separate SwiftUI and Kotlin/Compose applications. Do not use a cross-platform runtime. Share only API schemas, design tokens, copy, contract tests, and security requirements. |
| Hosting | ReadyPackets remains self-hosted behind Cloudflare, nginx, Node/Express, MySQL, and local/S3-compatible storage. No Manus SDK, API, connector, hosting, auth, database, or storage dependency. |
| Identity | Add OAuth 2.1/OIDC authorization code with PKCE for mobile. Retain existing web cookie/CSRF sessions only for web. |
| MFA and SSO | Preserve existing ReadyPackets MFA policy and Microsoft Entra SAML behavior through the system browser. Never embed SAML or identity-provider sign-in in a WebView. |
| Secrets | Never ship server environment values, encryption keys, payment secrets, Cloudflare tokens, SharePoint credentials, SAML signing material, database credentials, or root-helper credentials in either app. |
| Customer data | Encrypt and minimize local state. Use Keychain/Keystore only for mobile refresh token material. Keep access tokens in memory. |
| Files | File/audio upload/download authorization, limits, workflow locks, malware/content validation, and phase rules remain server-enforced. |
| Public language | Do not refer to AI or use of AI anywhere in public mobile UI, app-store metadata, help text, release notes, screenshots, privacy copy, or notification content. |
| Naming | Use **My Business Packets** for final customer deliverables. Do not relabel workflow upload areas as deliverables. |
| Payments | Version 1 does not implement in-app checkout. It may show server-confirmed payment status. Any later purchase implementation must receive fresh Apple/Google payment-policy review before development. |
| Security | Preserve and extend the existing posture: MFA, strong password policy, server-side RBAC, encrypted fields, blind indexing, audit logging, rate limits, Cloudflare protection, strict TLS, and secure file controls. |

## 3. Required repository layout

Create a repository structure similar to the following. Keep native project configuration, signing references, and secret values out of version control.

```text
readypackets/
├── mobile/
│   ├── api-contract/                   # OpenAPI schemas, generated DTOs, contract fixtures
│   ├── design-tokens/                  # Versioned colors, typography, spacing, icon mapping, copy keys
│   ├── ios/ReadyPackets/
│   │   ├── ReadyPacketsApp/             # SwiftUI application
│   │   ├── ReadyPacketsCore/            # Auth, networking, secure store, telemetry
│   │   ├── ReadyPacketsFeatures/        # Orders, files/audio, messages, profile
│   │   ├── ReadyPacketsUITests/
│   │   └── fastlane/ or ci/             # Store automation without credentials
│   ├── android/
│   │   ├── app/
│   │   ├── core/                        # design, auth, network, security, testing
│   │   ├── feature/                     # orders, files-audio, messages, profile, staff
│   │   ├── build-logic/
│   │   └── fastlane/ or ci/
│   └── docs/
│       ├── API_COMPATIBILITY.md
│       ├── THREAT_MODEL.md
│       ├── DATA_DISCLOSURE_MAP.md
│       ├── STORE_RELEASE_RUNBOOK.md
│       └── ACCESSIBILITY_TEST_PLAN.md
├── server/
│   ├── http/mobile/                     # Versioned `/api/mobile/v1` resources
│   ├── auth/mobileOidc.ts                # Authorization, PKCE, token rotation, device/session control
│   └── services/                         # Existing domain services reused; do not duplicate rules
└── docs/mobile-native/
```

## 4. Backend foundation to build before the apps

Implement the mobile backend foundation before screen development. Do not expose existing raw tRPC procedures directly to a native app. Create a versioned REST/JSON mobile boundary under `/api/mobile/v1` backed by the existing ReadyPackets domain services and database helpers.

### 4.1 Authorization server

Implement OAuth 2.1/OIDC using authorization code with PKCE.

| Requirement | Acceptance condition |
|---|---|
| Discovery | Publish `/.well-known/openid-configuration` with current authorization, token, revocation, JWKS, issuer, scopes, and supported PKCE metadata. |
| Authorization | Use a ReadyPackets-hosted authorization page in the system browser. Validate registered redirect URI, `state`, nonce, code challenge and challenge method. |
| Token exchange | Accept only authorization code + PKCE verifier; issue short-lived audience-bound access tokens and rotating refresh tokens. |
| Refresh rotation | Store a server-side token family/device session. Reuse of a rotated refresh token must revoke the family and require login. |
| Device sessions | Register platform, app version, device installation ID, push-token metadata, and last seen. Let users view/revoke mobile devices. |
| MFA | Enforce existing local/Entra/both MFA policy before authorization code issuance. Biometric re-entry never counts as server MFA. |
| Revocation | Support logout, device revoke, password reset, account disablement, administrator-only access, policy change, and security-event revocation. |
| Audit | Log issued, refreshed, reused, revoked, blocked, and failed tokens without logging raw credentials/tokens. |

Use claimed universal links on iOS and verified Android App Links. Do not use a custom URI scheme unless a documented fallback is required, and do not permit redirect hosts controlled by a user.

### 4.2 Mobile resource contract

Create OpenAPI 3.1 schemas, input/output validation, DTO mapping, generated Swift/Kotlin client models, error-code documentation, and contract tests. No endpoint may expose internal integer IDs if an opaque public ID exists. All collections must be cursor-paginated. Every response should include a correlation ID.

Implement these resource groups:

```text
/me, /me/profile, /me/security, /me/devices, /me/notifications,
/me/data-deletion-request, /dashboard, /announcements,
/orders, /orders/{publicOrderId}, /orders/{id}/history,
/orders/{id}/stages, /orders/{id}/messages,
/upload-sessions, /files/{publicFileId}/download,
/business-packets, /invoices, /policies,
/conversations, /support-tickets,
/devices, /push-tokens, /notification-preferences,
/staff/work-queue, /staff/orders/{id}/review, /admin/overview
```

Use a dedicated server-side permission map for mobile. Never add a generic “call any administrator procedure” bridge. Dangerous operations must stay web-only in Version 1: restore, backups, encryption/keys, user purge, platform upgrade, refund, global settings, certificate/domain control, cloud integration credential changes, and security policy changes.

### 4.3 Mutations, concurrency, and uploads

Require an `Idempotency-Key` for upload completion, stage submission, message send, device registration, deletion request, support ticket creation, and any payment-adjacent state transition. Enforce idempotency server-side with TTL, subject binding, request hash, response replay, and a conflict response for key reuse with different payloads.

For document/audio uploads, create an authorized upload session with user, order, stage, capability, byte limit, MIME/extension constraints, expiration, expected hash, and permitted part size. Finalization must re-check the active session, phase status, policy requirements, order membership, file content/magic-byte classification, size/count limits, antivirus/content pipeline hooks, filename rules, and storage result. Create a hash/addressable audit event. No client-side result should be treated as final until the server finalizes it.

## 5. Native application requirements

### 5.1 Shared feature scope

Implement the following customer experience first.

| Screen or flow | Required behavior |
|---|---|
| Welcome and sign-in | ReadyPackets branding; system-browser OAuth/PKCE; local and SAML pathways; accessible MFA continuation. |
| Home | Account-aware dashboard, order attention items, announcements, unread message summary, current progress, notification prompt only after user value is clear. |
| Orders | Cursor-paginated My Orders list; status, percent, current phase, awaiting-action state, payment state, search/filter; use opaque order identifiers. |
| Order detail | Native hierarchy for status/progress, current stage instruction, acknowledgement, questions, upload/audio action, phase files, messages, history, invoice, and My Business Packets. |
| Files and audio | Native picker/recorder, preflight, permission denial handling, visible recording state, duration/count/size limits, playback, user deletion until server confirms the phase lock. |
| Messages | Conversations, order-linked threads, notifications, safe attachment flow, report/block path where user-generated interactions apply. |
| Documents | View/download approved items, invoices, policies, and final My Business Packets only after server authorization. Use app-private cache and native share sheet. |
| Notifications | In-app inbox and APNs/FCM routing. Push payloads are generic and all deep links reauthorize server-side. |
| Profile/security | Profile, device list/revocation, password/MFA handoff, legal/policy center, privacy choices and account-deletion request. |
| Support/referrals | Existing authorized support and referral capability where enabled. |

Build staff capability as a server-allowlisted feature module after customer core: work queue, permitted order review, messages, document review, and alerts. Build administrator capability as a **minimal, read-only or low-risk** module only after a threat-model review.

### 5.2 iOS implementation rules

Use SwiftUI with unidirectional feature state, Swift Concurrency, `URLSession`, Keychain Services, LocalAuthentication, `ASWebAuthenticationSession`, `AVFoundation`, and native document/photo pickers. Store a refresh token using a `ThisDeviceOnly` Keychain accessibility class appropriate to the post-unlock user experience. Keep access tokens only in memory. Implement VoiceOver, Dynamic Type, Reduce Motion, Increase Contrast, keyboard navigation where applicable, and minimum 44-point touch targets.

Use APNs through a backend-controlled provider path. Do not place APNs private credentials or third-party provider keys in the application. Use the system browser for SAML/Entra and approval flows; do not use an embedded browser to capture credentials.

### 5.3 Android implementation rules

Use Kotlin, Jetpack Compose, Coroutines/Flow, Retrofit/OkHttp, Android Keystore, BiometricPrompt, Custom Tabs, WorkManager, Media3, and Firebase Cloud Messaging. Target Android 16/API 36 or higher for a new public Play submission as required beginning August 31, 2026. [4]

Use Photo Picker and Storage Access Framework rather than broad media/storage access. Request microphone and notifications at runtime only when the user invokes a dependent feature. If permission is denied, show a safe alternative or Settings path; never crash, loop permission prompts, or block unrelated work. Use WorkManager for resumable upload work within platform limits and cancel work securely at logout/device revocation.

## 6. Security architecture

Implement a written threat model before production code. Include attacker goals, trust boundaries, assets, abuse cases, mitigations, verification evidence, and residual-risk owner for: stolen device, rooted/jailbroken device, access-token theft, refresh-token reuse, deep-link interception, OAuth mix-up, session fixation, replayed mutation, insecure local cache, malicious upload, broken object authorization, notification leakage, compromised CI, dependency compromise, and staff/admin privilege escalation.

| Security control | Required design |
|---|---|
| Transport | HTTPS only; strict hostname validation; no cleartext exception; API served through Cloudflare/nginx origin architecture. |
| Token storage | Keychain/Keystore only; access token in memory; no token in logs, analytics, crash reports, screenshots, clipboard, or notification body. |
| Biometrics | Local convenience gate only. It wraps access to a locally retained refresh token but never replaces server MFA. |
| Client trust | Treat root/jailbreak signals as risk telemetry and optional step-up input, not as a sole block that harms legitimate users. |
| Logging | Structured client logs redact tokens, authorization headers, PII, file paths, message bodies, pitch content, and secrets. |
| Authorization | Enforce server-side BOLA/BFLA/property authorization for every resource and nested resource. |
| Downloads | Use authenticated stream or short-lived user/order/file-bound link; no long-lived public URL. |
| Caches | Encrypt/minimize; purge on logout/revocation; do not retain decrypted files by default. |
| CI | Protected branches, signed/tagged releases, dependency/SBOM scans, secret scanning, restricted signing access, two-person release approval. |
| Privacy | No ad SDKs, tracking identifiers, or undeclared telemetry. Update store declarations whenever data/SDK behavior changes. |

## 7. Brand, design, accessibility, and copy

Use the ReadyPackets brand kit and approved logo assets. Apply a navy foundation with gold/cyan accents, semantic contrast tokens, Inter/Poppins where licensed and technically appropriate, system fallback fonts, and System/Light/Dark appearance with **System** as default. Do not use color alone to communicate status. Retain clear disabled/loading/error states and support screen readers, dynamic/large font scale, reduced motion, keyboard/focus navigation, and larger screens/foldables.

Use public/customer wording exactly as follows:

| Use | Approved wording |
|---|---|
| Final deliverables | **My Business Packets** |
| Customer identifier | Opaque ReadyPackets customer public ID; never show database integer IDs |
| Work stages | Order stage or phase, according to server-supplied workflow wording |
| Payment | Use server-confirmed status only; do not promise a payment action that is not available in the app |

Never expose internal names such as tRPC, Drizzle, database table names, root helpers, Cloudflare, encryption-key variables, or unsupported feature flags in public UI.

## 8. Store policy and release requirements

Maintain a release-owned `DATA_DISCLOSURE_MAP.md` listing each datum, its source, reason, server destination, retention, sharing, user control, and store declaration. Apple requires current App Store Connect privacy answers for app and third-party SDK collection and a public privacy-policy URL. [2] Google Play requires an accurate Data Safety declaration; for account-creating apps it also requires an in-app deletion path and a web data-deletion request resource. [3]

Do not submit until the following are complete:

1. A fully functional production-like backend, test/review accounts, and App Review/Play review instructions are available. Apple requires functioning services, accurate metadata, and review access for account-based apps. [1]
2. The app includes an accessible account/data deletion request experience that respects ReadyPackets retention/legal obligations and explains those exceptions.
3. App Store privacy details, Google Data Safety, privacy policy, support URL, terms/policy URLs, screenshots, age rating, release notes, contact information, and reviewer credentials are complete and accurate.
4. Screenshots show real in-app use, not a title/splash/login-only set. [1]
5. All community/message functions have report, block, moderation, support-contact, and audit paths where relevant. Apple’s user-generated-content requirements include filtering, reporting, blocking, and published contact information. [1]
6. Build and target SDK requirements are current at submission time. Recheck Apple and Google rules immediately before store submission because policies change.

## 9. Testing and quality gates

Create automated and manual test suites for the following gates.

| Test family | Minimum evidence |
|---|---|
| API contracts | OpenAPI validation, generated-client compilation, schema compatibility, pagination, errors, idempotency and deprecation tests. |
| Authorization | Customer/staff/admin role matrix, cross-account orders/files/messages, deleted/disabled users, expired tokens, revoked devices, MFA pending/restricted sessions. |
| Uploads/audio | Size/count/time/mime limits, interruption/retry, corrupted input, cancellation, locked stage, user delete before submit, staff download authorization, playback. |
| Security | PKCE state/nonce, refresh reuse, deep-link validation, log redaction, storage purge, TLS failure, local device revocation, insecure backup prevention. |
| Accessibility | VoiceOver/TalkBack labels, dynamic type/font scale, contrast, keyboard/focus, screen rotation, large screens, reduced motion. |
| Resilience | Offline/online transitions, DNS/API failure, 429 rate limit, 401 refresh, 403 policy denial, 409 idempotency conflict, 5xx retry limits. |
| Store readiness | Privacy/deletion flow, review account, metadata, screenshots, policy links, no hidden/dormant functionality. |

Block production release on a critical security defect, authorization failure, unhandled crash in core flow, missing disclosure, inaccessible core path, failed restore/backup health, or unresolved backend schema contract failure.

## 10. Delivery sequence

Deliver in the following order and show evidence at each gate.

1. Write and approve API/mobile threat model, data map, OpenAPI contract, server migrations, OAuth/PKCE design, and feature authorization matrix.
2. Implement server authorization/token/device services with contract tests and audit logging.
3. Create iOS and Android foundations, secure storage, browser login, token refresh, design system, and CI build lanes.
4. Deliver customer dashboard, orders, messages, document viewing, workflow state, and profile/security.
5. Deliver upload/audio and resumable background work with extensive validation.
6. Deliver push, notification inbox, deep links, staff capability, then optionally admin-lite after a separate approval.
7. Complete deletion/privacy/accessibility/store artifacts and beta test through TestFlight and Play Console internal/closed tracks.
8. Run a limited production rollout using backend feature gates and monitored thresholds. Halt rollout automatically/manual on elevated crash, authorization, API, upload, or notification failures.

## 11. Required deliverables

Deliver all of the following as source-controlled artifacts:

- Native iOS Xcode project and Android Gradle project.
- Backend mobile OIDC/PKCE, device/session, versioned API, schemas, migrations, DTOs, and contract tests.
- OpenAPI 3.1 specification and generated Swift/Kotlin client code or reproducible generation pipeline.
- Threat model, API authorization matrix, data disclosure map, retention/deletion flow, SDK inventory/SBOM, and operational runbook.
- Native design-system source, accessibility test plan, screen inventory, UX copy, app icon/screenshot source, and store metadata checklist.
- TestFlight and Play Console release workflows, protected signing/secrets procedure, rollback/halt-runbook, and nonproduction reviewer account procedure.
- Updated self-hosted deployment documentation describing mobile server configuration, universal links/App Links, APNs/FCM server credentials, token-key rotation, and monitoring.

## 12. Final acceptance checklist

Do not declare the project complete unless all conditions below are true.

```text
[ ] iOS app is native Swift/SwiftUI and Android app is native Kotlin/Compose.
[ ] No mobile client contains application/integration/server secret material.
[ ] Mobile authentication uses authorization code + PKCE with rotating refresh tokens.
[ ] All APIs enforce object/function/property authorization server-side.
[ ] File/audio workflows preserve ReadyPackets governance and phase locks.
[ ] Push notifications expose no sensitive business content and reauthorize on open.
[ ] Account/data deletion has compliant in-app and web paths.
[ ] Privacy/Data Safety disclosures map to the exact implemented data/SDK behavior.
[ ] Accessibility tests pass for all critical customer flows.
[ ] iOS and Android builds pass security, unit, UI, contract, and device tests.
[ ] TestFlight and Play internal/closed beta are completed with reviewer access.
[ ] Store metadata and screenshots reflect real, production-ready app behavior.
[ ] Production rollout has monitoring, feature gates, halt criteria, and a rollback procedure.
[ ] The public mobile experience never mentions AI or exposes internal platform implementation details.
```

## References

[1]: https://developer.apple.com/app-store/review/guidelines/ "Apple App Review Guidelines"
[2]: https://developer.apple.com/app-store/app-privacy-details/ "Apple App privacy details"
[3]: https://support.google.com/googleplay/android-developer/answer/13327111?hl=en "Google Play account deletion requirements"
[4]: https://developer.android.com/google/play/requirements/target-sdk "Google Play target SDK requirement"
