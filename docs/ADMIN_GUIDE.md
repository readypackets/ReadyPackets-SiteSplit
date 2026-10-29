# Administrator Guide

**Applies to:** ReadyPackets Portal, self-hosted build
**Audience:** ReadyPackets staff and administrators

This guide explains how to run the business inside the portal: fulfilling orders, managing customers and the catalogue, moderating community content, and operating the security controls.

## Signing in

Administrative accounts require multi-factor authentication. This is enforced on the server, so an account without an enrolled factor can reach only the enrolment screen; no administrative data or action is available until enrolment completes. On first sign-in you will be taken directly there.

Enrolment uses any standard TOTP application. Store the ten backup codes somewhere safe and offline: each works once, and they are the only route back into an account whose authenticator device is lost. If backup codes are also unavailable, another administrator must reset the factor, which is recorded in the audit trail.

Where `ADMIN_IP_ALLOWLIST` is configured, administration is reachable only from the listed addresses or ranges. If you are locked out after a network change, an operator with shell access can amend the value in the environment file and restart the service.

## The dashboard

The dashboard is the daily starting point. It shows orders by status, revenue and volume for the last thirty days, open support tickets, reviews awaiting moderation, unread contact messages, and a signup trend. Everything on it is a link into the queue it describes, so the intended workflow is to work the dashboard top to bottom and finish with an empty set of counters.

## Orders

### The lifecycle

Every order moves through a fixed state machine. Transitions that are not listed are refused by the server, not merely hidden in the interface, so an order cannot reach an inconsistent state through the API either.

| Status | Meaning | Permitted next |
| --- | --- | --- |
| `new` | Created and awaiting intake | `phase_1_intake`, `cancelled` |
| `phase_1_intake` | Customer is completing the questionnaire | `phase_2_synthesis`, `cancelled` |
| `phase_2_synthesis` | Analysis under way | `in_production`, `cancelled` |
| `in_production` | Deliverables being produced | `delivered`, `cancelled` |
| `delivered` | Deliverables released to the customer | `closed`, `refunded` |
| `closed` | Complete | — |
| `cancelled` | Stopped before delivery | `refunded` |
| `refunded` | Refunded | — |

Cancellation is available only before delivery. Once work is delivered, the remedy is a refund rather than a cancellation, which keeps the commercial record honest: a delivered-then-refunded order is a materially different event from one that never shipped, and reporting depends on that distinction.

### Working an order

The order detail view shows the customer, the priced line items, the discount applied, payment state, the completion percentage, the due date, internal notes, customer-visible notes, clarification questions, attachments, and the submitted intake responses.

Three fields deserve care. **Completion percentage** is visible to the customer and is the single most effective way to reduce "where is my order" enquiries. **Note visibility** distinguishes internal from customer-visible; internal notes are encrypted at rest but are still discoverable in a legal process, so write them as though they may be read aloud. **Due date** drives the overdue alert on the dashboard, so leaving it blank removes the order from that safety net.

Where a response is ambiguous or missing, raise a **clarification question** rather than guessing. The customer sees it on their order page and can answer inline; both the question and the answer are recorded against the order, which keeps the audit trail of assumptions intact.

Archiving an order requires a typed confirmation and a reason. It is a soft delete: the record is retained and recoverable, and the action is logged with the actor.

### Creating a named order

Customers, staff, and administrators may use **Create an order** from the portal. Staff and administrators also have **Create my order** in the Administration navigation, which opens the same self-service order flow rather than a customer-impersonation or elevated-order shortcut. Every new order requires an **Order or project name** before it can be created. The title is the customer-facing label and is snapshotted into the secure SharePoint folder name; choose a clear operational name rather than leaving it generic.

For orders created after the current SharePoint naming release, ReadyPackets creates an immutable friendly folder identity in the form `first-two-first-name-characters-last-name-RP-CUS-…/orders/project-name-RP-ORD-…`; for example, `Al-Example-RP-CUS-…`. This avoids placing the customer's email address in the external folder name. Existing orders retain their existing folders and identifiers. Later customer-ID, user-profile, or display-title changes never move or rename external SharePoint data, preserving the audit trail and avoiding broken links.

### Correcting an order reference

An administrator can select **Change order reference** from an order’s header for a narrowly controlled correction. Enter a current opaque `RP-ORD-…` reference, a meaningful business reason, and the exact phrase `CHANGE ORDER ID`. Retired references are permanently reserved and cannot be reassigned to another order.

This is available only before the order has immutable evidence. The portal refuses the change when an invoice, payment, refund, actual file, SharePoint location/sync, conversion or transfer job, outbound webhook delivery, MNDA acceptance, or intake submission exists. Do not attempt a database edit to bypass this rule: order references in financial and external records must remain reconcilable.

## Customers

The customer list supports search across name, email, and company, and filtering by role and status. Search works against encrypted columns through a keyed blind index, so the address is never stored in plaintext yet lookup behaves normally.

The customer detail view shows the profile, order history, tickets, and lifetime value. From here you can adjust the account status, add internal notes, and create staff accounts.

Suspending an account blocks sign-in but preserves all data, and is the correct response to a payment dispute or a terms violation. Deletion is handled as an erasure request with a workflow and an audit trail rather than an immediate destructive action, because customer records are frequently referenced by orders and financial history.

When creating a staff account, the system generates the password and displays it once. Transmit it out of band, and require enrolment of a factor on first sign-in — which the server will enforce regardless for administrative roles.

### Correcting a customer ID

For a customer account, an administrator can select **Change customer ID** on the customer detail page. The replacement must use the current `RP-CUS-` opaque format; enter a documented reason and type `CHANGE CUSTOMER ID` exactly. The old value is retained in an append-only history ledger and permanently cannot be issued to another account.

Changing a customer ID does not rewrite existing order IDs, invoices, past deliveries, SharePoint paths, or external snapshots. Those records intentionally preserve the identifier in use when they were created. If the optional account-login whitelist contains the old customer ID, the portal atomically replaces it with the new value so the customer is not inadvertently locked out. The action is recorded in both activity and security audit streams.

## Catalogue

Products are organised into packet groups. Each product carries a SKU, name, tier, description, feature list, price in whole cents, and an active flag.

Prices are held as integers throughout, never as floating point, which is why totals always reconcile exactly. Setting a product to **custom pricing** suppresses automated quoting: it appears in the catalogue with an enquiry route instead of a price, and contributes nothing to an automated total. This is how the institutional Capital and Valuation packet is handled.

The **bundle rule** applies a discount once a selection spans at least a configured number of distinct packet groups — by default six groups at fifteen percent. Both values are editable. The discount is calculated on the subtotal and rounded down, so the customer is never charged a fraction of a cent more than the stated percentage implies. Changing the rule affects new quotes only; existing orders retain the pricing they were created with.

Deactivating a product removes it from the catalogue and from new quotes while preserving it on historical orders, which is almost always what you want. Deleting a product that appears on an order is refused.

## Content

The content section manages the public surface without a deployment: home page blocks, changelog entries, policy documents, email templates, and the registration form's custom fields.

Policies are **versioned**. Publishing a new version records its effective date and retains the previous text, so you can demonstrate what a customer agreed to on a given date. This matters for the mutual NDA and the liability disclaimer in particular.

Email templates support variable interpolation, and all interpolated values are escaped. Send a test to yourself after editing: a template that renders correctly in the editor can still fail in a mail client.

## Login page

Open **Administration → Login page** to configure the desktop login slideshow. Administrators can edit the copy, add or remove slides (one to five), and select an approved ReadyPackets visual for each slide. The configuration intentionally does not accept remote image URLs, uploaded code, HTML, script, or custom styles. This preserves a secure, self-hosted login surface and prevents a login-page content edit from becoming a third-party tracking or script-injection channel. The sign-in form remains the accessible mobile-first view, and the slideshow appears only beside it on larger screens.

## Support and moderation

The support desk lists tickets by status, category, and age. Replying notifies the customer; internal notes on a ticket are not sent. Closing a ticket allows the customer to reopen it, which is deliberate — a prematurely closed ticket should not force a customer to start again and lose the history.

Moderation covers three queues. Reviews are held for approval before appearing publicly, so a review can be rejected with a reason rather than silently discarded. Forum posts can be hidden or removed, with the action recorded. Contact messages can be marked read, assigned, or converted into a ticket, which is the right move whenever a reply is expected.

## Files

The file manager lists every stored object with its order, category, visibility, version, and size. Uploading a deliverable against an order makes it available in that customer's library.

Validation is by content inspection rather than by filename, so a file whose extension does not match its actual format is refused. That is not a bug to work around: it is the control that prevents an executable from being stored as a document. Uploading a new version supersedes the previous one while retaining history, so a customer who already downloaded the old version can be told exactly what changed.

Visibility controls whether the customer can see a file at all, which allows a draft to be staged before release. Downloads are recorded with actor, address, and timestamp; the access log is the authoritative answer to whether a deliverable was actually collected.

## Security centre

This is where the protective controls are operated.

**Rate limits.** Six categories, each with an independent budget and window. Loosen the `form_submission` or `api` budgets if legitimate users are being throttled; tighten `auth_high_risk` under credential-stuffing pressure. Penalties are scoped per category, so a limit on login does not lock a customer out of the whole site.

**IP rules.** Block individual addresses or CIDR ranges, permanently or with an expiry. The login-pressure panel lists addresses accumulating failures, which is the usual source of a block-list entry.

**Audit logs.** Two trails: security events (authentication, authorisation failures, CSRF and origin rejections, rate limiting, session lifecycle, configuration changes) and administrative activity (every mutation with actor, target, and before-and-after values). Both are searchable and exportable. Reviewing them weekly is the difference between having evidence and having noticed.

**Sessions.** Every active session across all users, revocable individually or in bulk. Revoke on a suspected compromise; the effect is immediate because sessions are server-side records rather than self-contained tokens.

**Settings and feature flags.** Password policy, session lifetimes, verification requirements, retention periods, and the flags controlling the forum, reviews, changelog, and registration. Flags take effect immediately and are the right tool for turning a surface off during an incident.

**Maintenance mode.** Closes the site to everyone except administrators, who can still sign in to turn it off. Set an explanatory message and an estimated completion time; both are shown to visitors.

**API keys.** Displayed once at creation and stored only as a hash. Revocation is immediate. Rotate on any suspicion, and prefer several narrowly scoped keys to one shared key.

## Routine practices

| Cadence | Task |
| --- | --- |
| Daily | Clear the dashboard queues; update completion percentages on active orders |
| Weekly | Review security and activity logs; check login pressure; confirm the email queue is draining |
| Monthly | Review active sessions and staff accounts; confirm backups are running and copied off host |
| Quarterly | Restore a backup into a scratch database; rotate API keys; re-run the verification suite; review retention settings |

## Incident response

1. **Contain.** Enable maintenance mode if the integrity of the site is in question. Revoke the affected sessions. Block the source addresses.
2. **Assess.** Use the security and activity logs to establish what was accessed and by whom. The file access log answers whether deliverables were collected.
3. **Preserve.** Export the relevant log ranges before retention pruning removes them.
4. **Remediate.** Reset the affected credentials, rotate API keys, and require re-enrolment of factors where an account was compromised.
5. **Recover.** Restore from a backup predating the incident if data integrity is in doubt; the restore script takes a safety dump of current state first, so the decision is reversible.
6. **Review.** Record what happened and what control would have prevented it, and adjust the settings or the code accordingly.

## Getting help

Operational and deployment questions are covered in [DEPLOYMENT.md](DEPLOYMENT.md). The controls themselves, and what each defends against, are documented in [SECURITY.md](SECURITY.md). For system-level diagnosis, `journalctl -u readypackets -f` on the host is the fastest source of truth.
