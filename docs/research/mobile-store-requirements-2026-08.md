# Mobile Store Requirements — Research Notes

Retrieved 2026-08-21 for ReadyPackets native mobile architecture planning.

## Apple App Store

- App Review requires a complete, working submission, accurate metadata, functional URLs, and review access through either an active demo account or a fully featured demo mode. Source: [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/).
- Apps with user-generated content need objectionable-content filtering, reporting, blocking, and published contact information. This applies to ReadyPackets messaging, knowledge/community content, and any future user-generated workflow content. Source: [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/).
- Apple requires current App Store Connect privacy disclosures for app and third-party SDK data collection. The ReadyPackets app will need to disclose account/profile/contact information, user content and audio files, identifiers, purchase history where applicable, diagnostics, and any use of IP/device information according to actual implementation. Source: [App privacy details](https://developer.apple.com/app-store/app-privacy-details/).
- Apple requires a publicly accessible Privacy Policy URL in App Store Connect. Source: [App privacy details](https://developer.apple.com/app-store/app-privacy-details/).
- Apps that support account creation must offer in-app account deletion consistent with App Review Guideline 5.1.1. Source: [Offering account deletion in your app](https://developer.apple.com/support/offering-account-deletion-in-your-app/).
- Payments must be reviewed in the context of App Review Guideline 3.1.1 and applicable exceptions. The mobile product should initially use account/order viewing, document delivery, support, intake, and workflow completion. Any native checkout must undergo an Apple payment-rule review before release because ReadyPackets sells digital deliverables and consulting services. Source: [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/).

## Google Play

- Apps that allow account creation must provide an in-app account-deletion path and a web resource for account/data-deletion requests, and must complete Data deletion questions in the Play Console Data safety form. Source: [Google Play account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en).
- As of 2026-08-31, new Google Play apps and updates must target Android 16 (API level 36) or higher; existing apps must target Android 15 (API 35) or higher to remain available to new users on newer Android releases. Source: [Target SDK requirement](https://developer.android.com/google/play/requirements/target-sdk).
- Android permission requests must occur at runtime where applicable and the app must continue safely when permissions are denied. This is directly relevant to microphone recording, file/media selection, camera scanning, and notifications. Source: [Target SDK requirement](https://developer.android.com/google/play/requirements/target-sdk).

## Architecture implications

- Native applications should use vendor-supported notifications: Apple Push Notification service for iOS and Firebase Cloud Messaging for Android. Neither store platform is a backend of record; ReadyPackets keeps notification preference, delivery, audit, and authorization state in its self-hosted backend.
- Use native secure storage: Keychain with `ThisDeviceOnly` accessibility on iOS; Android Keystore-backed encrypted storage on Android. Never store platform or third-party integration secrets in mobile clients.
- Use an OAuth 2.1/OIDC authorization-code flow with PKCE for mobile applications. The existing cookie/CSRF browser session mechanism remains for web; the mobile API requires dedicated short-lived access tokens plus refresh-token rotation, device/session registration and revocation.
- Publish initially as a non-commerce companion app. Defer native checkout until Apple and Google payment classification has been formally verified, or implement store-compliant purchase architecture where required.
