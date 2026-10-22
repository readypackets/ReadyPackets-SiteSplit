# Microsoft Clarity and PostHog Operator Setup

**Applies to:**

- **Marketing site:** `https://www.readypackets.com` (independent static repository: `readypackets/ReadyPackets-Marketing-Site`)
- **Portal:** use exactly one canonical hostname: `https://my.readypackets.com` **or** `https://portal.readypackets.com` (portal repository: `readypackets/ReadyPackets-SiteSplit`)

ReadyPackets supplies **consent-gated integration capability** for Microsoft Clarity and PostHog. Neither provider is active by default. The Portal repository contains the supplied Portal Clarity project identifier as an inert, write-only setting so an operator does not need to paste a raw provider snippet into the HTML. It remains disabled until the administrator completes the explicit steps below and a visitor makes a new affirmative Analytics choice. Do not activate either service until the privacy notice, cookie notice, internal access roles, retention settings, and data-processing review are complete.

> **Do not use the same provider project for the marketing site and portal.** Create one Clarity project and one PostHog project for each site. This keeps public-site measurement separate from authenticated workspace activity and permits different masking and retention controls.

## What the code already enforces

Both sites load a provider only after a visitor has affirmatively selected **Analytics**. Before consent, no provider script, provider request, provider key, or provider configuration is delivered by the Portal. The independent marketing website has its own separately configured, consent-gated Clarity project; it does not share configuration, identities, or consent state with the Portal.

The portal and marketing integration use a narrow data-minimization profile:

- Clarity is loaded only after analytics consent and receives `ConsentV2` with `analytics_Storage: "granted"` and `ad_Storage: "denied"`.
- The Portal loader is limited to anonymous entry routes (`/login`, `/register`, `/verify-email`, `/forgot-password`, and `/reset-password`). It never loads on customer workspaces, orders, intake/workflow phases, files, messages, tickets, checkout, invoices, profile/security, staff, or administrator routes. `portal.html` applies `data-clarity-mask="true"` to the entire Portal DOM; ReadyPackets must never add `data-clarity-unmask` to Portal UI.
- PostHog starts opt-out-by-default. Autocapture, automatic page views, session recording, and person profiles are disabled.
- ReadyPackets emits only reviewed page/path/surface events. It does not send account IDs, e-mail addresses, order IDs, customer IDs, document names, message content, upload metadata, form values, query parameters, or fragments.
- Consent withdrawal calls the provider opt-out controls. The portal records consent evidence and provider-configuration changes in its audit trail.

Microsoft Clarity requires a valid consent signal for full functionality for traffic from the EEA, United Kingdom, and Switzerland. `consentv2` is Microsoft's recommended API.[1]

## 1. Create provider projects

### Microsoft Clarity

1. Sign in at [Microsoft Clarity](https://clarity.microsoft.com/).
2. Create a project named **ReadyPackets Marketing — www** with website URL `https://www.readypackets.com`.
3. Create another project named **ReadyPackets Portal — my** or **ReadyPackets Portal — portal**, using the exact production portal hostname.
4. In each project, go to **Settings → Overview** and copy the **Project ID**. The Project ID is browser-visible and is not a management secret, but it should still be changed only through the approved ReadyPackets configuration path.
5. In each project, configure **Settings → Masking** before collecting production recordings:
   - Marketing: start with **Balanced**, then test all visible content.
   - Portal: start with **Strict**. Keep sensitive workspace, order, message, identity, payment, upload, and administrative interfaces masked. Only selectively unmask content after privacy review.
6. Configure consent-required operation for applicable jurisdictions, restrict project administration to the minimum team, and add an exclusion for internal testing traffic if appropriate.

Clarity documents that strict masking masks all content, while balanced masking masks sensitive content such as numbers and e-mail addresses. Inputs and dropdowns remain masked in all modes. Changes apply only to new recordings.[2]

### PostHog

1. Sign in to PostHog and create separate projects for **Marketing** and **Portal**.
2. Choose the approved ingestion region for each project:
   - **European Union:** `https://eu.i.posthog.com` if EU data residency is required.
   - **United States:** `https://us.i.posthog.com` only when this is approved for the audience and transfer model.
3. In each project, open **Project Settings** and copy the **Project API key** (normally beginning `phc_`). This is a browser project identifier, not a server-management key. Never enter a personal API key, organization API key, or management token into ReadyPackets.
4. In organization and project settings, discard IP capture unless there is a documented, approved need to retain it. Set a proportionate retention period, least-privilege roles, and a documented deletion/export response process.
5. Keep provider-side autocapture and session replay disabled unless a separate privacy, security, and product decision changes the ReadyPackets defaults. Do not enable automatic identity association for portal users.

PostHog documents `opt_out_capturing_by_default`, `opt_in_capturing()`, and `opt_out_capturing()` as consent controls. It also recommends handling consent, data minimization, regional data handling, IP capture, retention, and deletion controls as part of a GDPR-oriented deployment.[3] [4]

## 2. Configure the portal

Use a local-MFA-protected administrator account on the Portal. Never paste provider management credentials, API secrets, or tokens into chat, tickets, public issue trackers, or Git commits. Clarity project identifiers are browser-visible, but must still be scoped to the correct site and changed only through the approved configuration path.

1. Open **Admin → System**.
2. In **Cookie consent and privacy preferences**:
   - Turn on **Show cookie preference banner and management controls**.
   - Turn on **Make analytics consent available**.
   - Leave marketing consent off unless a separate marketing/advertising technology needs it.
   - Type `UPDATE COOKIE CONSENT SETTINGS`, then save.
3. In **Consent-gated analytics providers**:
   - Enable **Microsoft Clarity after analytics opt-in**. The approved Portal project is already stored as a write-only configuration value after this release; leave the ID blank to retain it. Do not paste a provider snippet into Portal HTML or replace the stored value with a marketing-site project.
   - Enable **PostHog after analytics opt-in**, enter the portal PostHog Project API key, and select the approved US or EU ingestion region.
   - **Leave “Allow consented analytics continuity between the public site and portal” off.** The independent static marketing site deliberately does not create or consume the portal’s anonymous navigation handoff. Enabling this portal-only option would not create compliant end-to-end tracking.
   - Type `SAVE ANALYTICS CONFIGURATION`, then save.
4. Confirm the status display shows both providers as configured. The values are write-only after storage; this is expected.

The Portal validates project identifiers, treats the stored Portal Clarity identifier as write-only in its administration UI, restricts PostHog hosts to the approved US/EU endpoints, and allows the necessary provider domains in its nonce-based CSP. The Clarity project identifier is browser-visible and is not a management secret; it is not described as encrypted at rest. Saving analytics settings creates an audit record without recording provider values themselves.

## 3. Configure the marketing site

The marketing site uses browser-visible provider project identifiers in its version-controlled static configuration. It never needs a provider management token.

1. Clone or open the `readypackets/ReadyPackets-Marketing-Site` repository.
2. Its reviewed static configuration already contains the approved **marketing** Microsoft Clarity project identifier and keeps PostHog disabled. If a future reviewed change is required, edit only the **marketing** provider project identifiers in `src/assets/js/site-config.js`:

```js
analytics: Object.freeze({
  clarityProjectId: "YOUR_MARKETING_CLARITY_PROJECT_ID",
  posthogProjectKey: "YOUR_MARKETING_POSTHOG_PROJECT_KEY",
  posthogHost: "https://us.i.posthog.com", // or https://eu.i.posthog.com
}),
```

3. Use an empty string to keep either provider disabled. Do not add an API secret, management token, portal environment value, database credential, session key, or Cloudflare credential to this file. Never place the Portal Clarity project identifier in this marketing repository.
4. Build and validate locally:

```bash
npm run package
```

5. Commit and push the reviewed change to `main`. The repository’s GitHub Action builds the static artifact and refreshes the `hostinger-static` deployment branch used by Hostinger. Verify the Hostinger deployment has completed before testing production.
6. Keep the temporary Hostinger review hostname (`go.readypackets.com`) no-indexed. Configure analytics for the production `www` site only unless you deliberately created separate staging projects.

The static host policy already permits the necessary Clarity and PostHog script/connect origins. No CSP weakening or third-party tag manager is required.

## 4. Verify consent and collection on both sites

Perform this check separately on the marketing host and portal host, using a private/incognito browser profile each time.

1. Open browser developer tools, clear site storage, and load the site.
2. Before choosing a preference, confirm Network contains **no** request to `clarity.ms` or `*.posthog.com`.
3. Choose **Essential only**. Reload and confirm the same result.
4. Open **Manage cookie preferences**, select **Analytics**, save, and reload.
5. Confirm only then that provider requests appear **on an anonymous Portal entry route only**:
   - Clarity: `https://www.clarity.ms/tag/<project-id>`
   - PostHog: the approved `us.i.posthog.com` or `eu.i.posthog.com` host
6. Confirm the PostHog event payload is limited to the reviewed page/path/surface schema and does not include query strings, fragments, names, e-mail addresses, customer/order references, files, or free text.
7. Withdraw Analytics consent. Reload, verify future provider requests stop, and confirm the site remains fully functional.
8. Navigate from the consented anonymous entry route to a protected Portal, checkout, staff, or administrator route and confirm no new provider configuration is requested, the previously loaded provider receives denied consent/cookie erasure, and no portal UI content is available in the provider. In the provider dashboard, verify the first production data belongs to the correct project and hostname, then confirm the root mask is effective before allowing broad team access.

## Cross-site tracking decision

The independent marketing site and portal have separate consent state and separate provider projects. This is intentional. The marketing source contains **no** cross-site handoff, shared cookie, account identifier, or portal identity association.

If leadership later approves cross-site analytics, treat it as a separate implementation and privacy-review project. It must define the lawful basis, notice language, consent state on both hosts, approved data fields, retention, opt-out behavior, deletion workflow, provider project architecture, and tests that prove no account, authentication, order, document, message, or file identifier crosses the boundary. Do not use a customer e-mail address or ReadyPackets ID to join analytics data.

## References

[1]: https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-consent-api-v2 "Microsoft Clarity Cookie Consent API - ConsentV2"
[2]: https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-masking "Microsoft Clarity Masking Content"
[3]: https://posthog.com/docs/privacy/data-collection "PostHog Controlling data collection"
[4]: https://posthog.com/docs/privacy/gdpr-compliance "PostHog GDPR compliance"
[5]: https://learn.microsoft.com/en-us/clarity/setup-and-installation/getting-started "Microsoft Clarity Getting Started"
[6]: https://posthog.com/docs/libraries/js "PostHog JavaScript web library"
