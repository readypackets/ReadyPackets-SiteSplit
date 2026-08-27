# ReadyPackets Administrator Guide

**Version:** 2026-08-12  
**Audience:** ReadyPackets administrators and authorized staff

## Secure administration

Administrators must use MFA. The admin shell is separate from the customer portal and displays an explicit role badge. Never share credentials, recovery codes, access tokens, backup archives, encryption keys, or exported configuration bundles.

Use the customer-portal switch only for testing the experience assigned to your own account. Administrative permissions are still enforced server-side.

## Main operational workspaces

| Workspace | Administrator tasks |
|---|---|
| **Orders and Customers** | Create, update, suspend, validate, reset, soft-delete, restore, and manage customer and order records. Use account and order trash only for confirmed recovery work. |
| **Order Question Banks** | Create reusable questions for Phase 1, Phase 2, both phases, or no phase. Apply templates or direct questions to specific orders. |
| **Finance** | Configure Stripe, test the authenticated connection, manage coupons, review payments/refunds, and retain only required inactive coupon records. Stripe payments become ready only after the signed webhook secret is configured. |
| **Email Template Center** | Edit, clone, preview, enable, and review email templates; inspect delivery records; control retries/resends; configure retention and audit BCC. |
| **Order and Email Automations** | Select templated emails, lifecycle conditions, webhook endpoints, and completion actions. Test endpoint configuration before enabling a production rule. |
| **Knowledge Base** | Draft, submit, review, approve, publish, unpublish, or request revision of customer help articles. Only published articles appear in the customer portal. |
| **Public FAQs** | Author, categorize, edit, order, publish, unpublish, and delete public frequently asked questions. Drafts never appear on the public site; confirm accuracy before publication because published answers may be indexed. |
| **Marketing** | Plan campaigns, set audience/message/channel/status/schedule, configure a local or HTTPS destination and UTM tags, copy a controlled promotion link, and record confirmed conversions. Promotion links log aggregate clicks only; they do not record visitor identities. Activate only reviewed campaigns and pause a link immediately if its destination or offer changes. |
| **Announcements** | Publish to all customers, staff, or selected accounts. Review audience selection before publishing. |
| **Changelog** | Maintain release drafts, immutable revision history, and selected public feature updates. Publish only reviewed entries. |
| **Integrations** | Configure Microsoft Graph/SharePoint, outbound webhooks, SAML, and delivery control. For SharePoint, enter the tenant ID, client ID, client secret, and either a tenant-root URL or site URL; select **Discover site & library**; review the discovered library; then save. The Graph site and drive IDs are populated by discovery and are required before saving. Graph secrets are encrypted and never displayed after saving. |
| **Backups** | Run/schedule backup jobs, configure multiple cloud destination names, download protected archives, and create encrypted configuration exports. Regularly perform an authorized restore drill. |
| **Platform updates** | Connect a private GitHub repository using an encrypted fine-grained token, scan a release, review changed paths/risk indicators, approve, upgrade, and roll back. |
| **Security Centre and Activity Replay** | Investigate logs using date, severity, event, account, source, text, action, and entity filters. Review individual event records. Block abusive source addresses or ban compromised accounts only after confirming the evidence. |

## SharePoint connection requirements

The SharePoint application registration needs tenant-admin consent for the appropriate Microsoft Graph application permissions. `Sites.Read.All` is sufficient for site/library discovery; order-folder creation and file synchronization require the least additional write permission appropriate to the deployment, typically `Sites.ReadWrite.All` or a more tightly scoped approved alternative. Do not paste a document-sharing link: use the tenant root, such as `https://contoso.sharepoint.com/`, or the actual site URL, such as `https://contoso.sharepoint.com/sites/Operations`. The discovery flow removes copied query/hash fragments and never returns the client secret to the browser.

## Identity and maintenance controls

SAML auto-provisioning can assign Customer, Staff, or Administrator roles. Assigning Administrator does not bypass MFA: the account must enrol or pass the existing MFA challenge before a privileged session is granted.

Maintenance controls independently gate public access, login, and new-account creation. Use them during scheduled work, with a visible maintenance message and a narrow allowlist only when necessary. Confirm the administrator bypass route before enabling a production-wide login gate.

## Public-site discovery and accessibility operations

The public FAQ page, route-aware metadata, canonical URLs, XML sitemap, crawler policy, Organization/WebSite structured data, and conditional FAQPage structured data are deployed. Verify the public domain in Google Search Console, submit `https://myportal.readypackets.com/sitemap.xml`, and monitor coverage; structured data improves machine understanding but does not guarantee indexing or a search result treatment.

The accessibility statement is available at `/accessibility`. Treat reported accessibility barriers as support issues: capture the page, task, browser, and assistive technology; provide an alternative route to service while the issue is assessed; and include keyboard, zoom/reflow, and screen-reader review in public-page release acceptance.

## Publishing and release governance

Do not publish a change solely because it appears in Git history. Use the Platform updates process to scan it, read changed paths, assess dependencies/migrations/deployment controls, make a separate approval, and then enter the upgrade confirmation. A completed upgrade has a protected pre-upgrade application/database snapshot for rollback; rollback replaces data produced after the snapshot.

Use **Changelog** to communicate approved improvements to the public site. Keep release notes factual, customer-safe, and free of credential or infrastructure details.

## Security incidents

For suspected compromise, immediately preserve relevant logs, revoke sessions or API keys as appropriate, block sources only when evidence supports it, rotate affected external credentials at their provider, and assess whether customer notification is required. Do not delete logs merely to reduce noise. Factory reset is a root-console-only destructive recovery procedure and is never a first response to an incident.

## Platform setup wizard

Open **Admin → Platform setup** when preparing a new installation or reviewing essential integrations. The wizard is restricted to administrators and is a convenience layer over the dedicated Email Settings, Microsoft Entra ID, Finance, Integrations, and Security Centre workspaces. Secret inputs are write-only and use encrypted setting storage; a previously saved secret is never returned to the browser.

| Wizard step | Configuration saved | Operational note |
|---|---|---|
| Email | SMTP or Microsoft Graph connection details | Test delivery from Email Settings after saving. |
| Microsoft Entra ID | SAML sign-on URL, issuer, certificate, provisioning, and role policy | Keep Entra disabled until a local administrator sign-in and an Entra assertion have been tested. |
| Stripe | Secret key, publishable key, and signed webhook secret | A secret key alone is insufficient; verified checkout settlement requires the webhook signing secret. |
| Phase webhooks | HTTPS P101 and P201 destinations and optional HMAC secrets | Configure only trusted automation endpoints. Delivery and redelivery remain auditable in Integrations. |
| Access controls | IP allowlist and optional public customer/user-ID login whitelist | Add the current administrator’s `RP-U-…` public ID before enabling the account whitelist. |

The **account login whitelist** is disabled by default. When enabled, it applies server-side to password login, customer magic-link completion, and Microsoft Entra SSO. Existing sessions remain active; future sign-ins for accounts outside the configured public-ID list are blocked and recorded in the security log. Do not enable it until a recovery administrator is included.

## Paid-order invoices

A confirmed paid or partially refunded order exposes an **Invoice** action in both the customer order workspace and the administrator order detail view. Generating it materializes one retained invoice number for the order and displays a ReadyPackets-branded printable document with the ReadyPackets logo, customer public ID, order number, itemized charges, discounts, total paid, and payment reference. The customer or administrator can use the browser’s **Print / save PDF** option to retain a PDF copy without granting the portal any payment-card data.

## Activity replay public ID search

Activity Replay accepts the opaque public customer/user reference in the form `RP-U-XXXXXXXXXXXX` for **Entity history**, **User timeline**, and **Advanced operational search**. Public ID resolution happens on the administrator-only server procedure before searching internal audit records. Legacy numeric IDs remain accepted for historical operational use, but new support and audit workflows should use public IDs.


## Protected backups, recovery, and cloud destinations

Open **Admin → Backups** to operate the protected backup workflow. The portal communicates with a root-owned local control daemon over a group-restricted Unix socket. The web application receives no backup `sudo` permission, no cloud credentials, and no direct root shell capability.

| Administrative task | Required action |
|---|---|
| Create an archive | Select **Run backup now**. The protected job creates a database dump, uploaded-file archive, manifest, checksums, and required environment keys in root-owned local backup storage. |
| Confirm archive integrity | Select **Verify** next to an unencrypted local archive. The system checks the archive, required database dump, manifest, checksums, and whether uploaded files are included. |
| Download an archive | Select **Download**. The server copies the approved archive into protected export storage and records the administrator action. Browser delivery is limited to 50 MB. |
| Restore production | Select **Restore** only after verification. Enter the exact `RESTORE <archive filename>` phrase. The protected restore job creates a safety dump, stops the service, restores the database and stored files, applies migrations, restarts the service, and reports its status. |
| Configure off-site copies | Select **Configure cloud provider**, enter a dedicated provider remote and destination, save it, then select **Test connection**. Every completed archive copies to each configured destination. |

Use dedicated, least-privilege storage credentials and an isolated folder, bucket prefix, or container for backups. Provider credentials and OAuth token JSON are transferred once over TLS, written only to the root-owned rclone configuration, and are never returned to the portal. The supported provider-specific input profiles are Amazon S3 and Wasabi S3 access keys, Backblaze B2 key ID/application key, Azure Blob Storage account/key, and OAuth-based SharePoint, OneDrive, Google Drive, and Dropbox remotes.

> A production restore is destructive. It replaces data written after the selected archive was created. Run a non-production restore drill from the host periodically and retain independent off-site backup copies according to the organisation’s recovery policy.

The documented setup-configuration export/import bundle remains a future roadmap item. It will produce a Git-tracked, secret-safe template for first-run wizard selections while keeping runtime credentials, encryption keys, customer data, and live OAuth tokens outside Git.

## Workflow audio duration and SharePoint destinations

In **Admin → Order Workflows**, each stage’s **Upload governance** section can set a maximum duration for each browser-recorded audio file and a maximum cumulative duration across the stage’s audio files. Values are entered in seconds. The portal preserves WebM where a browser supports it and automatically uses Safari-compatible M4A/AAC when WebM is unavailable, with Ogg as a final supported fallback. The browser displays the resulting limits and automatically stops a browser recording at the available limit, but the portal also measures accepted audio with the server-side media probe before persisting it. A file that exceeds a configured per-recording or cumulative limit is rejected by the server. Existing active order audio was backfilled with measured durations during the release; newly accepted audio always receives a server-probed duration.

Each workflow stage also has an optional **SharePoint file destination**. Enter a relative folder path such as `Phase I/Docs`; this is resolved under the configured SharePoint root, customer folder, and order number. Future customer and staff files for that stage are queued for background synchronization through Microsoft Graph, with bounded retries and an auditable `sharepoint_sync_log` record. Paths are limited to safe folder characters and cannot escape the order root. Leave the setting blank to use the phase default. SharePoint credentials and file contents are never returned through this configuration screen.

## Workflow deletion, acknowledgement, and guided task design

Open **Administration → Order Workflows** to create, clone, edit, or delete workflow definitions. A workflow can be deleted only when it is not the current default and has no active assigned orders. The administrator must enter `DELETE WORKFLOW`; this keeps existing order history and phase material from being orphaned. When a workflow is still needed for historical orders, deactivate it or reassign the active orders rather than attempting deletion.

Each workflow stage has a customer acknowledgement policy. Select **Required acknowledgement** to require a customer checkbox before phase submission, **Optional acknowledgement** to present the notice without requiring the checkbox, or **No acknowledgement prompt** to submit directly. In every mode, submission locks the customer’s stage materials and only an administrator can unlock the phase. The server validates the configured requirement; browser controls alone cannot bypass it.

The workflow editor provides two complementary design modes. **Visual stage canvas** shows every stage and its detailed controls together. **Guided task wizard** walks an administrator through selecting a stage, customer tasks, administrator tasks, submission policy, and a review step using Previous and Next. Customer tasks can enable documents, questions, browser-recorded audio (WebM where available, Safari-compatible M4A/AAC otherwise), and approved pre-recorded audio. Administrator task documentation can record document upload, question assignment, customer-submission review, and approved automation execution. The existing administrator action controls can also change an order’s configured status, completion percentage, send an email, deliver a webhook, or create an administrator alert when a stage is run.

Use **Manage order statuses** from the Order Workflows page to open the order-status manager. Core lifecycle states retain server-side safeguards, while custom statuses can be added, labelled, ordered, and made inactive. A custom status cannot be removed while it is assigned to an active order.


### Separate document and audio SharePoint destinations

Each workflow stage’s **SharePoint document and audio destinations** control keeps documents and audio in separate folders. Set **Document relative folder** for supporting documents, questions exported as documents, and other non-audio files. Set **Audio relative folder** for browser-recorded WebM, M4A/AAC, or Ogg audio and approved pre-recorded audio uploads. The values are relative to the configured SharePoint root, customer folder, and order number.

If a destination is blank, ReadyPackets uses separate safe defaults: a `Docs` subfolder for non-audio material and an `Audio` subfolder for recorded or uploaded audio. A valid audio file cannot be routed to the document folder, and a document cannot be routed to the audio folder. Destination paths are server-validated and cannot contain `..` segments or escape the assigned order root.


### Customer file-review workflow stages

Enable **Customer file review** in a workflow stage when the stage should be a read-only review area rather than a customer upload task. For each assigned order, staff upload or assign files to the same stage in the Order Files workspace and select **Publish**. Only non-placeholder files uploaded by staff, assigned to that review stage, and published to the customer appear in the customer review workspace.

Customers see the selected file name, size, and publication date, then request a short-lived, single-use authorized download. Files are not previewed inline from the ReadyPackets origin. A staff member can remove a file from the review space at any time by selecting the corresponding Files tab visibility control.


### Customer order status and progress visibility

Customer-facing order surfaces show the live order status and numeric completion percentage. The portal dashboard’s Recent orders list, the My orders table, the individual order workspace, and every guided workflow stage display the current status and completion percentage with a labeled progress bar. Administrators control the underlying status and completion percentage through order transitions, workflow stage actions, and configured order automations. Customer views receive the active administrator-configured status label rather than only a raw internal status key.


### SharePoint connection test, root-folder selection, and audio synchronization

Open **Admin → Integrations → SharePoint & SAML** to configure the Microsoft Graph tenant, application client ID, write-only client secret, SharePoint site URL, and document library. Select **Discover site & library** before saving to populate the Graph site and drive identifiers. After saving valid settings, use **Select existing root folder** to browse existing folders in the selected document library. Browsing is read-only: choosing **Use current folder as root** updates only the form, and selecting **Save SharePoint settings** activates the new root.

Select **Test SharePoint connection** after saving. The test authenticates to Microsoft Graph and verifies read access to the configured site, document library, and selected root folder without creating, changing, or uploading SharePoint content. The portal keeps the client secret encrypted at rest and never returns it to the browser.

If document synchronization succeeds but a browser recording records a SharePoint `invalidRequest`, the Graph credentials, selected site, drive, and folder route are working. The Microsoft 365 tenant or library is then rejecting the particular `.webm`, `.m4a`, or `.ogg` extension or media content through a blocked-file-type, Purview/DLP, retention, or similar library policy. Have a Microsoft 365/SharePoint administrator permit the relevant audio extension for the intended document library if appropriate, then retry the failed file or record a new pitch. Do not weaken the portal's magic-byte validation or replace encrypted Graph credentials as a workaround for a tenant-side policy.


## Finance, coupon audit, and administration navigation

### Protected portal refunds

Administrators initiate Stripe refunds from **Finance → Refunds**. Enter the order ID, amount in cents, and a reason of at least ten characters. The portal loads the latest successful Stripe payment and shows the remaining refundable balance before allowing review. Selecting **Review refund** is the first confirmation. The second screen requires the exact typed phrase `REFUND ORDER` before ReadyPackets requests the refund from Stripe.

Each request is reserved in the local refund ledger before the Stripe call, has an idempotency key, and is then recorded with the Stripe refund reference and final status. Payments, completed refunds, pending payments, and pending refunds are visible in the Finance dashboard. The activity log records the initiating administrator, order, payment, amount, reason, and Stripe reference without storing card data.

### Coupon accountability

The Finance coupon table records the administrator public ID that created each new coupon. Selecting the usage count opens a redemption history with each paid order, customer public ID, discount amount, and redemption date. Coupon creation, update, enablement, disablement, redemption, and permanent deletion are recorded in Activity Replay. Coupons with redemption history remain retained for audit and cannot be deleted; an unused coupon must be disabled before permanent deletion.

### Reorganized administration menu

The administration sidebar is grouped as **Order operations**, **Customers & support**, **Finance & payments**, **Email & marketing**, **Content & policies**, and **Platform, security & administration**. Select any section heading to collapse or expand it. The selected state is retained locally in the administrator's browser.

### Searchable activity history

In **Activity Replay**, both **Entity history** when Entity type is User and **User timeline** provide a searchable account selector. Search by customer name, email, or public `RP-U-…` identifier, select the account, and use **Load history** or **Load timeline** to retrieve its recorded activity.


### Order workspace refunds, history, MNDA, and phase files

Administrators can initiate a Stripe refund either from **Admin → Finance → Refunds** or from a paid order’s **Refund** button and **Refund** workspace tab. Finance provides a customer search, a matching-account selector, and a paid-order selector; the order workspace link opens Finance with the order preselected. Every refund still requires a reason, review step, exact `REFUND ORDER` typed confirmation, remaining-balance validation, and an idempotent Stripe request.

The administrator order workspace now includes **Order history** and **MNDA** tabs beside Automation. Order history presents lifecycle status transitions and order-scoped activity events. MNDA presents order-specific acceptance status, policy version, signer, acceptance date, captured source address, and whether a signed file was attached. The **Files** tab separates order files into their assigned workflow phases, making customer artifacts, staff documents, and customer publication visibility easier to review by phase.

Customer workflow steps map legacy `phase_1` and `phase_2` lock records to the corresponding guided workflow keys, so the current starting step shows **Open** and completed legacy phases show **Review** instead of incorrectly appearing as Upcoming.


### Guided workflow system steps

Some workflow definitions include prerequisite system steps such as **New Order Payment Confirmed**. When the server has opened a later customer phase, the customer stepper marks earlier non-customer prerequisite steps as **Confirmed** rather than incorrectly displaying them as Upcoming. These system steps do not create a customer upload, question, or submission workspace; customer-authored phases remain controlled by their own submitted phase locks.

### Unified Message center and customer notifications
Administrators and staff can use **Customers & support → Message center** to review messages from every order in one place. The center displays the related order number and project, sender role, timestamp, visibility, and recipient-specific read state. Select **Open order** to return to the source order workspace; shared messages can be answered from the order’s Notes tab, while internal notes stay staff-only.

Order message contents remain encrypted in the existing order-note store. The message center stores only recipient-specific read receipts, so it does not create a second plaintext copy of a customer conversation. A shared message creates unread state for active order owners, eligible order delegates, and active staff, excluding the sender. Internal notes create unread state for active staff only.

Customers have a corresponding **Message center** in their portal. The dashboard includes an **Order messages** card, a Message center quick action, and a sidebar unread badge. While the dashboard is open, it checks for unread order messages and displays an actionable popup. The customer can open the exact message in its source order or open Message center; either action marks that message read.
