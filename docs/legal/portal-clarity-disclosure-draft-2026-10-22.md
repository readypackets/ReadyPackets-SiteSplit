# Portal Microsoft Clarity disclosure — draft for legal review

**Status:** Draft only. Do not publish this text as a ReadyPackets Privacy Policy version or require customer acceptance until qualified privacy counsel has reviewed the operator's actual Clarity configuration, legal basis, retention, data-processing terms, transfers, user rights process, and applicable jurisdictions.

## Proposed Section 7.3 replacement — Analytics Technologies

ReadyPackets does not activate analytics cookies or analytics tags unless ReadyPackets enables the applicable Analytics category and you provide affirmative consent through the ReadyPackets preference center. If ReadyPackets activates Microsoft Clarity for the customer Portal, it is used only on the Portal's anonymous sign-in, registration, verification, and password-recovery screens to understand aggregate entry-screen use, improve performance, and diagnose usability issues. Customer and administrator workspaces, orders, workflow/intake phases, uploaded files, messages, tickets, checkout, invoices, profiles, security pages, and administrative pages are excluded from the Portal analytics-loader scope.

The Portal applies a source-controlled full-DOM content mask to its customer-facing and administrative application surface. ReadyPackets does not intentionally send account identifiers, names, email addresses, order identifiers, customer identifiers, document names, messages, form values, payment information, or portal session, CSRF, authentication, or MFA identifiers as custom Clarity identifiers or events. Microsoft Clarity may process limited device, browser, and interaction information after consent in accordance with its applicable service terms and ReadyPackets' project-level masking, retention, regional-transfer, access-control, deletion/export, and data-processing settings. ReadyPackets maintains a separate Clarity project for the public website and does not use portal account or order identifiers to join analytics across the website and Portal.

You may decline or withdraw Analytics consent at any time through Manage cookie preferences without affecting essential Portal services. Withdrawal applies to future collection; it does not automatically erase information previously processed where processing was lawful. For privacy requests, contact ReadyPackets using the Privacy Rights Request process in this policy.

## Required publication controls

1. Create a new immutable Privacy Policy version through Policy Center. Do not edit or overwrite prior accepted versions.
2. Set the effective date only after counsel and the ReadyPackets operator approve the final text.
3. If the policy requires acceptance, use the Policy Center's normal required-acceptance workflow and verify the resulting customer prompt on a non-production account.
4. Retain the provider project configuration evidence separately: Strict masking, no Portal unmask rules, consent mode, least-privilege project roles, retention, data region/transfer terms, IP-treatment setting, deletion/export process, and an internal-test exclusion as applicable.
5. Do not enable the Portal provider setting until the above review and a staging consent/masking verification have completed.

## Technical evidence

- The Portal records cookie-consent evidence using a versioned, protected cookie token and hashes limited security evidence; the public provider configuration is withheld unless an affirmative Analytics preference is recorded.
- The Portal accepts Microsoft Clarity only through its MFA-protected administrator configuration and limits provider loading to the five anonymous entry routes named above.
- Microsoft documents that `data-clarity-mask="true"` masks an element and its children and that masked content is not uploaded.

## References

[1]: https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-masking "Microsoft Clarity Masking Content"
[2]: https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-consent-api-v2 "Microsoft Clarity Cookie Consent API ConsentV2"
