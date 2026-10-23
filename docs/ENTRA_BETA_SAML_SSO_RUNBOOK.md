# Beta Portal Microsoft Entra SAML SSO Runbook

**Scope:** Repair Microsoft Entra SAML SSO for `https://beta.readypackets.com` without weakening certificate validation, MFA policy, or tenant isolation.

## Diagnosed failure

On 2026-10-23, the beta Portal initiated SAML SSO to Entra tenant `33b787b2-14ee-4c2e-a9ad-e5b8a3c8f8f6`. The live service-provider metadata and signed AuthnRequest both sent this exact issuer/entity ID:

```text
https://beta.readypackets.com/api/saml/metadata
```

Microsoft Entra returned `AADSTS700016`, which means no enterprise application in the selected tenant has a matching **Identifier (Entity ID)**. This is an IdP application-registration mismatch, not a password, browser, MFA, Android, or Portal user-session failure.

## Required Microsoft Entra configuration

A Cloud Application Administrator or higher must sign in to the Microsoft Entra admin center **in tenant `33b787b2-14ee-4c2e-a9ad-e5b8a3c8f8f6`**. Under **Enterprise applications**, select the intended ReadyPackets beta SAML application, or create a non-gallery, single-tenant enterprise application if it does not exist.

In **Single sign-on > SAML > Basic SAML Configuration**, enter these values exactly. Do not add a trailing slash.

```text
Identifier (Entity ID)
https://beta.readypackets.com/api/saml/metadata

Reply URL (Assertion Consumer Service URL)
https://beta.readypackets.com/api/saml/acs

Sign on URL
https://beta.readypackets.com/api/saml/login

Logout URL
https://beta.readypackets.com/api/saml/logout
```

Save the configuration. Then, in **Users and groups**, assign the intended beta test users or test group. Avoid assigning broad production groups to the beta application.

In the **SAML Certificates** section, download the current **Certificate (Base64)** / raw signing certificate. In **Set up [application name]**, record the **Login URL**, **Microsoft Entra Identifier**, and **Logout URL**.

## Portal SAML configuration

Configure the active beta SAML configuration with the recorded Entra values:

```text
Entry point:             Entra Login URL
IdP signing certificate: current downloaded Entra certificate
Signature algorithm:     sha256
Default role:            customer (or a deliberately restricted beta role)
Auto-provision:          off until beta assignment and mapping are verified
```

Use an explicit email mapping that matches the claim emitted by Entra, normally `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` or `user.userprincipalname`, rather than assuming a display-name claim. Enable auto-provisioning only after a restricted test group, role mapping, and administrator-only policy have been tested.

## Test and verify

1. In Entra, use **Test this application**. The test account must be assigned to the enterprise application.
2. Start a fresh private browser session and open `https://beta.readypackets.com/api/saml/login`.
3. Complete Entra sign-in and verify the browser posts back to `https://beta.readypackets.com/api/saml/acs`.
4. Verify that the user lands on the beta Portal and that the intended MFA policy is satisfied.
5. Test a denied user assignment, an expired or replaced IdP certificate, incorrect audience, and duplicate/replayed response behavior before admitting more users.

## Audit and operational verification

Search the Portal security log center after each attempt using the time range, severity, outcome, and authentication event filters. The expected records are `login.success` after a completed assertion, and `login.failure` for assertion validation, unassigned/unprovisioned user, account-status, whitelist, or MFA-policy denial. Search the structured application logs and configured SIEM/syslog stream for `saml.` fields and preserve the Entra correlation/request identifiers separately in the Entra sign-in logs.

Do not record raw SAML assertions, authorization codes, certificates’ private keys, access tokens, or users’ full profile attributes in application or SIEM logs. Use the Portal’s existing hash/minimisation controls for identifiers and retain only event context necessary for correlation, troubleshooting, and audit.

## Change control and rollback

Record the Entra enterprise application object ID, application display name, tenant ID, assignment group, entity ID, ACS URL, certificate expiration, approver, and test result in the beta change record. If the repair needs to be rolled back, remove beta-user assignment or disable the beta SAML configuration; do not delete production SSO configuration or reuse beta certificates for production.

## Evidence

The Microsoft guidance for this error states that the SAML request issuer must match the Entra application Identifier exactly, including a trailing slash if one exists. [Microsoft AADSTS70001 troubleshooting](https://learn.microsoft.com/en-us/troubleshoot/entra/entra-id/app-integration/error-code-aadsts70001-app-not-found-in-directory)

Microsoft’s SAML enterprise-application setup guidance covers the Identifier, Reply URL, Sign on URL, certificate, and test flow. [Microsoft Entra SAML setup](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/add-application-portal-setup-sso)
