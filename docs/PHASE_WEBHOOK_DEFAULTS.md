# Phase-Start Webhook Defaults

## Purpose

`deploy/configure-phase-webhook-defaults.sh` stages the **P101** and **P201** phase-start destinations on an already deployed native ReadyPackets VPS. It is a root-console, post-update helper for trusted Make custom-webhook destinations.

The helper is deliberately separate from the installer and the Platform Updates controller. An application upgrade preserves existing runtime and database configuration; it must not silently create outbound destinations or cause customer/order data to leave the platform.

## Security model

A Make custom-webhook URL is a capability value: someone with the full URL may be able to submit data to its scenario. The helper therefore:

- prompts locally with hidden terminal input rather than accepting URLs as arguments, environment variables, or files;
- requires root, a TTY, a root-owned protected environment file, an exclusive root lock, and a typed confirmation;
- accepts only exact HTTPS `hook.us2.make.com` custom-webhook URLs with no credentials, query string, or fragment;
- never prints, syslogs, audits, or writes the raw URL to source control;
- records only phase, action, endpoint ID, Make host, and a short irreversible SHA-256 fingerprint;
- stages every newly created endpoint as **disabled**;
- does not change a phase's `notifyWebhooks` setting; and
- refuses to overwrite, enable, disable, delete, or modify any existing direct P101/P201, `phase.start`, or `*` endpoint. Existing routing always wins.

The endpoint is necessarily stored in the ReadyPackets database so the delivery worker can send it. The normal database backup is therefore sensitive recovery material. Treat it as you would any backup containing application configuration and customer data.

## Prerequisites

1. Deploy the reviewed immutable ReadyPackets release through **Admin → Platform updates**. Do not use `git pull`, a moving branch, a fresh installer, or `deploy/upgrade.sh` on an existing production host.
2. Confirm the update completed and `/api/health/ready` is healthy.
3. Schedule a quiet maintenance window and retain the controlled update's backup and rollback snapshot.
4. Confirm the intended Make scenarios, downstream data handling, retention, and access controls are approved for ReadyPackets phase payloads. P101 can include order-scope details; do not use a customer order merely for a connectivity test.

## Stage defaults

From the VPS root console, after the reviewed release has been deployed:

```bash
sudo bash /opt/readypackets/deploy/configure-phase-webhook-defaults.sh
```

If—and only if—the repository has been deliberately made temporarily public for the documented emergency updater, the same reviewed update can invoke this helper after its readiness gate by adding `--stage-phase-webhook-defaults` to `deploy/temporary-public-existing-vps-upgrade.sh`. The updater still requires its full reviewed immutable commit SHA and typed upgrade confirmation; it prompts for webhook destinations only after the application update has passed. A cancelled or rejected default-staging step does not roll back a healthy application update, because endpoint configuration is a separate, non-overriding change.

Enter the P101 and P201 destinations only at the hidden local prompts. The helper prints only the fixed Make host and a short fingerprint, then requires:

```text
STAGE PHASE WEBHOOK DEFAULTS
```

Expected safe result:

```text
P101: staged disabled default (endpoint <id>).
P201: staged disabled default (endpoint <id>).
```

If an explicit direct or generic route already exists, the helper reports `preserved existing routing` for that phase. That is intentional: use **Admin → Integrations** to review the existing configuration rather than force-replacing it.

## Review, test, and activate deliberately

1. Sign in as an MFA-protected administrator and open **Admin → Integrations → Webhook Endpoints**.
2. Confirm that each staged P101/P201 endpoint is disabled and that there is no unexpected `*` or `phase.start` recipient. Multiple matching endpoints receive separate deliveries.
3. Use an approved non-customer test order or test receiver. Confirm the Make scenario receives the expected phase and headers without storing sensitive payloads in receiver logs.
4. Enable one endpoint only after its test passes.
5. Separately enable the appropriate phase kickoff configuration's **notify webhooks** setting. An enabled endpoint alone does not make automatic phase transitions send; the phase gate is intentional.
6. Confirm exactly one delivery appears in the ReadyPackets delivery log for the test. Monitor delivery status and retries.

To correct a bad destination, disable it in the administrator interface before changing it. Do not roll back the entire application release solely to adjust an integration setting.

## Audit and recovery

The helper writes a bounded `activity_logs` record with an action such as `webhook.phase_default_staged` or `webhook.phase_default_preserved_existing`, and an `authpriv` syslog event with no raw destination. The controlled Platform Updates workflow snapshots the pre-update database, so a release rollback restores the prior database state and can discard data written after that snapshot. Record the integration change separately from the application release and retain an encrypted backup before a recovery operation.
