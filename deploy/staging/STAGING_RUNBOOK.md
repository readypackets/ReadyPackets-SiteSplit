# ReadyPackets Customer-Mobile Staging Runbook

## Purpose and boundary

This environment exists to validate customer permissions, workflow stages, native device flows, audio/file upload, invoice visibility, and Portal-hosted payment handoff. It must remain **separate from production**: never restore production data, reuse production keys, share a storage volume, or enable live payment credentials.

## Prepare the host

Choose a hostname such as `staging.portal.example.com` that is separate from the production Portal. Point its DNS record to a Linux host, place TLS termination in front of the loopback-only application port, and keep MySQL inaccessible from the public internet. Copy `deploy/staging/.env.staging.example` to a root-owned file, generate unique values for every password and cryptographic key, and use a non-production mail destination.

Use one of the existing self-hosted installation modes. For Docker, preserve the base composition and layer the staging override:

```bash
sudo install -d -m 0700 /etc/readypackets-staging
sudo install -m 0600 deploy/staging/.env.staging.example /etc/readypackets-staging/portal.env
# Edit the protected portal.env; do not commit it.

docker compose -p readypackets-staging \
  --env-file /etc/readypackets-staging/portal.env \
  -f docker-compose.yml \
  -f deploy/staging/docker-compose.staging.yml up -d --build
```

The application is then available only at `127.0.0.1:${STAGING_APP_PORT:-3100}`. Configure the host reverse proxy to forward the staging hostname to that port. Do not point a production proxy upstream at the staging process.

## Initialize and verify

Run all database migrations, including `005_mobile_identity.sql` and `006_mobile_push_token_encryption.sql`, before enrolling any mobile testers. Create a fresh staging administrator, configure test-only email and payment-provider credentials through protected host/admin controls, then create separate customer test accounts. Use clearly marked staging packet products, orders, invoices, messages, tickets, workflows, and workspaces. Do not create testimonial, rating, or review fixtures.

Use customer accounts that differ by role and workflow state: a new account, an active paid customer, a customer awaiting payment, a customer permitted to upload an audio/document response, and a customer whose stage has closed. Confirm that each app displays only the records and actions that the Portal permits.

```bash
curl -fsS https://staging.portal.example.com/api/health
docker compose -p readypackets-staging \
  --env-file /etc/readypackets-staging/portal.env \
  -f docker-compose.yml \
  -f deploy/staging/docker-compose.staging.yml ps
```

## Customer and mobile acceptance sequence

Sign in through the mobile system-browser flow with every staging customer role. Exercise documents, a customer-authorized audio upload, intake/MNDA actions, deliverables, invoice PDF retrieval, test-mode checkout, messages, notification preferences, tickets, community, workspaces, referrals, public help, and browser-account-security handoff. Repeat the document review after explicitly choosing **Keep offline**, then sign out and verify that the cached document is cleared.

Validate checkout by completing a test-mode payment. A return URL is not payment evidence: verify the webhook-delivered payment status, order activation, invoice state, and customer email/log output in the Portal before marking the test complete. Never use a real card or live provider credentials in staging.

## Native links, notifications, and rollback

Publish the staging Apple Universal Link and Android App Link association files before testing OAuth return or checkout handoff. Register only staging APNs/FCM provider credentials on the self-hosted Portal. Capture the device registration event and notification preference in the Portal audit log, then test a non-sensitive staging notification.

Create an encrypted backup before a migration or release-candidate deployment. Roll back with the approved Portal deployment tooling rather than copying files over a running instance. Treat the staging encryption and email-index keys as permanent for the life of that staging dataset; changing them can make prior staging records unreadable.
