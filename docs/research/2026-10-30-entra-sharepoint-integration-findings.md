# Microsoft Entra and SharePoint integration findings — 2026-10-30

Microsoft’s Entra SAML protocol guidance specifies SP-initiated HTTP Redirect binding for an `AuthnRequest`, followed by HTTP POST binding for the response at the assertion consumer service. Its `AADSTS750054` guidance says Entra could not find a SAML request in the query string and directs operators to verify application-side SSO enablement, SP-initiated support, and the configured sign-on URL. ReadyPackets must keep its `/api/saml/login` entry point as the sign-on URL and ensure the generated IdP redirect contains `SAMLRequest`; its ACS remains `/api/saml/acs`.

For SharePoint, Microsoft Graph’s Selected-permissions documentation confirms that `Sites.Selected` requires both Entra tenant consent and an explicit site-level grant before an app-only token can access the selected site. A test/discovery action must therefore report authorization failures without saving partial configuration or exposing credentials. Microsoft Graph supports enumerating document-library contents through drive item children endpoints; ReadyPackets should use a bounded, server-side, read-only browser to let an administrator choose an existing root folder, then require a separate deliberate save.

## Sources

- https://learn.microsoft.com/en-us/troubleshoot/entra/entra-id/app-integration/error-code-aadsts750054-saml-request-not-present
- https://learn.microsoft.com/en-us/entra/identity-platform/single-sign-on-saml-protocol
- https://learn.microsoft.com/en-us/graph/permissions-selected-overview
- https://learn.microsoft.com/en-us/graph/api/driveitem-list-children?view=graph-rest-1.0
