# ReadyPackets Mobile Customer-Parity Contract

**Status:** Implementation contract

## Purpose and boundary

The native iOS and Android applications are customer-facing, task-oriented clients for the ReadyPackets Portal. The applications must provide a customer with the same usable customer journeys as the Portal while retaining staff and administrator workflows in the browser Portal. The mobile API is a separate bearer-token contract under `/api/mobile/v1`; it does not accept a browser session as a resource credential and it does not expose a generic tRPC bridge.

> The Portal remains authoritative for identity, role, policy acceptance, order membership, workflow locks, file validation, payment state, encryption, retention, staff visibility, moderation, audit, and storage access.

| Boundary | Native customer application | Web Portal only |
|---|---|---|
| Orders | Browse, create, review, rename, collaborate, answer questions, request cancellation, complete permitted workflow work | Staff assignments, operational overrides, bulk actions, refunds, order purges |
| Files and audio | Pick, record, preview, upload, download, share, and delete customer-owned pre-lock content | Deliverable publication, replacements, retention changes, storage administration |
| Finance | View invoices and payment status; open a verified system-browser checkout URL | Card entry, refunding, coupon administration, payment provider management |
| Communication | Customer messages, notifications, ticket creation and replies, moderated community participation | Internal notes, moderation, support assignment, forum/category/content administration |
| Identity | Browser-hosted registration, verification, recovery, password/MFA and policy-security handoffs; device/push management in-app | SAML/Entra configuration, user role change, access recovery overrides, security administration |

## Resource identity and object authorization

`publicOrderId` is the existing opaque ReadyPackets order number. Every other customer resource exposed through the mobile API is returned as a user-bound, authenticated opaque reference. An opaque mobile reference cannot be used by another user, altered into a neighboring numeric database identifier, or accepted after its authenticated tag fails.

| Resource | Customer mobile route family | Mutation control |
|---|---|---|
| Order and workflow | `/orders/{publicOrderId}`, `/orders/{publicOrderId}/workflow`, `/orders/{publicOrderId}/intake`, `/orders/{publicOrderId}/questions`, `/orders/{publicOrderId}/sharing` | Ownership/share permission, policy gate, workflow capability and phase-lock validation; idempotency for irreversible submit/advance/cancel actions |
| File and audio | `/files`, `/files/{mobileFileRef}/content`, `/uploads` | Customer order membership, category/capability, content inspection, hash, size/duration, lock and retention enforcement; idempotency on upload completion |
| Messages and tickets | `/messages`, `/tickets`, `/tickets/{ticketNumber}` | Customer-owned/shared visibility only; send/reply/close mutations require idempotency and audit logging |
| Community and knowledge | `/community`, `/knowledge`, `/faqs` | Published/feature-enabled content only; moderation and user-generated content controls remain server-side |
| Profile and security | `/me/profile`, `/me/policies`, `/me/notifications`, `/me/push-tokens`, `/me/security-handoff` | Current user only; sensitive account state changes use a system-browser, step-up-authenticated Portal handoff |

## Media and document controls

Native document selection uses the platform document/photo picker. Audio recording is explicitly initiated by the customer and uses platform-native encrypted-at-rest temporary storage. The upload request never grants direct storage access: the Portal accepts a bounded multipart request, validates magic bytes, creates a random storage key, records a digest and duration, applies phase limits, records the action, and initiates configured server-side synchronization.

Mobile-recorded audio uses **AAC-LC in a `.m4a` container**. The existing Portal may continue to accept approved upload formats including WebM, MP3, WAV, OGG, and M4A. The mobile client sends a recorded-audio indication only for an explicit native recording; the server independently validates its actual content type and applies workflow-specific limits.

Downloads and playback stream through an authenticated `/api/mobile/v1` resource route with `Cache-Control: private, no-store`, range-request support for audio, `nosniff`, current object authorization, and a recheck on every request. The app previews only in memory or an app-private cache; user export requires an explicit share/save action.

## Payments and high-friction actions

The mobile client displays invoice, due amount, and payment state from the Portal. It does not collect, transmit, tokenize, or persist payment-card data. A payable order returns a verified same-origin checkout handoff URL that is opened by `ASWebAuthenticationSession` or Android Custom Tabs. On return, the app refreshes server state; a URL callback is never treated as payment confirmation.

MNDA acceptance, policy acknowledgement, irreversible workflow submission, account deletion, password/MFA changes, registration, verification, and recovery remain server-authoritative. Where existing browser session and step-up controls are required, the native app opens the Portal in the system browser with a signed, short-lived continuation; an embedded WebView is prohibited.

## Push and notification safety

The device registration endpoint accepts a platform push token only after bearer authentication and an idempotency key. The server encrypts the token at rest, binds it to the authenticated installation, and retains only the configured platform metadata. Push payloads are generic and never contain an order title, document name, message content, payment amount, signed URL, token, MFA value, or private customer data. Opening a notification always reloads the intended resource from the API and repeats authorization.

## Error, audit, and availability behavior

Every mobile error uses the existing RFC 9457-compatible problem response with a correlation identifier. New write operations require a valid `Idempotency-Key`; retries return the original safe response. The API emits privacy-scrubbed security and activity events with the authenticated customer, device, public order reference where applicable, and outcome. The API never returns SQL errors, stack traces, encryption envelopes, raw session material, provider credentials, or staff/internal data.

## Implementation acceptance criteria

The customer mobile experience is complete when each listed customer journey is accessible from both native applications or through an explicitly labeled secure system-browser handoff, uses this versioned contract, preserves Portal security controls, and has an Android automated verification path plus a documented Xcode/physical-device verification path. Administrative, staff, finance-administration, moderation, and infrastructure operations must never appear in the native navigation graph.
