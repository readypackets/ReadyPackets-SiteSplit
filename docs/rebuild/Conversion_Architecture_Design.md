# Conversion and SharePoint Workflow Implementation Design

This document records the architectural design for configurable document/audio conversion and multi-site SharePoint synchronization. The approved first implementation is delivered by `0054_conversion_pipeline_and_sharepoint_targets.sql`; its operator procedure and exact post-release acceptance criteria are in [Self-Hosted Conversion and Selected-Site SharePoint Pipeline](SELF_HOSTED_CONVERSION_AND_SHAREPOINT_PIPELINE.md).

## 1. Multi-site SharePoint targeting

ReadyPackets decouples the earlier global SharePoint configuration from three named, administratively selectable target roles.

| Target role | Receives | Security boundary |
|---|---|---|
| **Original uploads** | Exact original customer or staff upload | App-only selected-site identity and fixed target binding |
| **Conversion staging** | Newly created conversion artifact | Separate target binding; no source overwrite |
| **Intake delivery** | Newly created conversion artifact intended for intake use | Separate target binding; customer publishing remains a staff action |

### Immutable order locations

For each selected target, the application resolves and stores an immutable location at the first transfer:

```text
{TargetRoot}/{SafeCustomerName}-{CustomerID}/{SafeOrderNumber}/
```

For example, `Acme Corp-RP-CUS-001A/ORD-1042/`. The customer name is normalized into a conservative path segment and combined with the immutable customer identifier. The stored `order_sharepoint_locations` record means that a later rename does not move or fork historical customer folders. Each target uses an app-only Microsoft Entra identity constrained through `Sites.Selected`, replacing broad delegated credentials for this new pipeline.

## 2. Deterministic self-hosted conversion

Conversion is strictly self-hosted. It does not call Office 365 conversion APIs, SaaS conversion services, external AI agents, or Manus capabilities. Fixed command argument arrays invoke the following explicitly installed tools:

| Conversion | Tool |
|---|---|
| DOCX to PDF | LibreOffice headless |
| PDF to TXT | Poppler `pdftotext` |
| PDF to DOCX | Pinned Python `pdf2docx` |
| DOCX to TXT and TXT to DOCX | Pandoc |
| TXT to PDF | Pandoc plus LibreOffice headless |
| PDF compression | Ghostscript safe presets |
| Audio to WebM/Opus | FFmpeg |

The local converter runs in the existing unprivileged service context, creates a `0700` job workspace under private temporary storage, caps source/output size, validates each result with the existing upload magic-byte controls, and invokes no shell interpolation. The converter itself has no SaaS dependency; the separately queued SharePoint transport makes only constrained Microsoft Graph calls using the selected-site app identity. The installer and Docker image explicitly provision these tools and the installer fails closed if `--skip-packages` leaves one absent.

### Conversion profiles

Administrators select a versioned **Conversion Profile** instead of entering a command. A profile has a named fixed operation, constrained settings where applicable, active state, revision, and native-tool fingerprint. The conversion job snapshots the profile revision and settings before execution.

## 3. Append-only artifact derivation

The governing invariant is that **original uploads are never overwritten or deleted** by the conversion pipeline.

1. **Snapshot.** The queue records the source file ID, active version, opaque storage key, SHA-256, source phase, profile revision, and selected target identifiers.
2. **Derivation.** The worker reads the snapshot, creates an output at a new opaque storage key, and creates a separate private file record.
3. **Provenance.** `file_derivatives` links the source snapshot to the artifact, including output hash, output MIME type, profile revision, and tool fingerprint.
4. **Delivery.** `sharepoint_transfer_jobs` carries a separate immutable transfer snapshot. Microsoft Graph transfer uses conflict-fail behavior; an existing remote file is accepted only when its size matches the local immutable snapshot, otherwise the job fails safely.
5. **Idempotency.** Deterministic idempotency keys and bounded leased retry queues prevent duplicate conversion or transfer side effects.

## 4. Rebuild-master-prompt implications

A rebuild following the ReadyPackets master prompt must preserve these boundaries.

1. **Mandatory technical stack:** Use MySQL-backed durable queue state and Node workers rather than managed queues or runtime cloud conversion dependencies.
2. **Security posture as code:** Preserve fixed `execFile` bindings, no shell input, minimum tool inventory, row-bound encryption of selected-site secrets, and the unprivileged service account.
3. **Strict schema validation:** Apply additive migration `0054_conversion_pipeline_and_sharepoint_targets.sql` and pass the updated **44-table** schema contract; the pre-conversion **49-migration / 37-table** baseline remains the immutable starting point.
4. **Release and testing gates:** Preserve the corrected Docker migration path and regression coverage for path normalization and conversion schema tables.
5. **SharePoint least privilege:** Keep each selected-site target constrained to a named app-only Graph identity and never allow a workflow or browser client to supply a free-form remote URL.

This design supplies deterministic enterprise conversion and integration behavior while retaining the ReadyPackets security, auditability, and self-hosted isolation principles.
