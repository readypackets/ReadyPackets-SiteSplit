# Analytics Consent Source Notes

This implementation uses Microsoft Clarity and PostHog only after the visitor has made an affirmative analytics choice in ReadyPackets’ existing preference center. The configuration defaults to disabled and excludes e-mail addresses, account identifiers, order identifiers, document names, message contents, form values, and replay/autocapture from outbound analytics data. On the Portal host, any provider is further restricted to anonymous sign-in, registration, verification, and password-recovery routes. The Portal HTML root carries `data-clarity-mask="true"`; no Portal UI may unmask any child content.

Microsoft’s current Clarity ConsentV2 documentation states that, for visitors in the EEA, United Kingdom, and Switzerland, Clarity requires a valid consent signal for full functionality. Its ConsentV2 call accepts `ad_Storage` and `analytics_Storage` values of `granted` or `denied`; denied consent prevents Clarity cookies from being set. The integration therefore sends an explicit denied state and cookie-erasure command when consent is withdrawn or a user reaches a protected Portal route, and it sends an affirmative granted state only after ReadyPackets records analytics consent.[1] Microsoft documents that `data-clarity-mask="true"` masks the marked DOM node and every child before upload; the Portal places this attribute on its HTML body as a source-controlled defense in depth.[4]

PostHog’s documentation recommends initializing its client with `opt_out_capturing_by_default: true`, then calling `opt_in_capturing()` only after consent and `opt_out_capturing()` when consent is withdrawn. It also documents that opt-out blocks manual capture, autocapture, and session replay. ReadyPackets applies this model, disables autocapture and session replay in its client configuration, and sends only a limited first-party event vocabulary after consent.[2]

PostHog documents cross-domain cookie capability for marketing/application deployments under one parent domain. ReadyPackets deliberately does **not** use a cross-domain cookie: portal authentication and CSRF cookies remain host-only. Instead, optional continuity remains disabled unless analytics is enabled, the visitor opts in, and an administrator separately enables the cross-site option; a public-to-portal navigation then carries only a random pseudonymous handoff value. It is never an e-mail address or ReadyPackets account/order identifier.[3]

## References

[1]: https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-consent-api-v2 "Microsoft Clarity Cookie Consent API - ConsentV2"
[2]: https://posthog.com/docs/privacy/data-collection "PostHog Controlling data collection"
[3]: https://posthog.com/docs/libraries/js "PostHog JavaScript web library"
[4]: https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-masking "Microsoft Clarity Masking Content"
