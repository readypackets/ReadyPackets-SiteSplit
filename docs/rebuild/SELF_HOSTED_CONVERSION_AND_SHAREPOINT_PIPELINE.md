# ReadyPackets Self-Hosted Conversion and Selected-Site SharePoint Pipeline

**Release baseline:** Migration `0054_conversion_pipeline_and_sharepoint_targets.sql` advances the reviewed platform from **49 migrations / 37 critical tables** to **50 migrations / 44 critical tables**. The later site-split privacy configuration migration `0055_site_split_privacy_analytics.sql` brings the reviewed platform to **51 migrations / 44 critical tables** without changing conversion records, original files, file versions, legacy SharePoint sync records, customer folders, or portal settings.

## Purpose and operating model

This capability lets an administrator attach controlled document, PDF-compression, audio-to-WebM, and selected-site SharePoint actions to an **Order Workflow Designer stage**. It is intentionally designed as an **append-only pipeline**. The original upload remains a separate, immutable file object. Every conversion output is created as a new, private artifact that must be deliberately published to the customer through the existing Files controls.

The feature does not use Manus services, cloud conversion APIs, arbitrary shell commands, or free-form external URLs. All conversion runs occur on the ReadyPackets host using a documented, fixed native-tool inventory. SharePoint receives transfers only through configured app-only Microsoft Graph identities and selected named targets.

> **Safety invariant:** A profile, source storage key, source hash, source file version, destination-target identifiers, and tool fingerprint are snapshotted before work begins. Changing a later workflow, profile, customer name, or SharePoint configuration cannot silently change a queued job’s source or destination intent.

## Administrator configuration sequence

The configuration uses two administration locations.

1. In **Admin → Integrations → Conversion Pipeline**, create a selected-site Microsoft Graph connection for each approved SharePoint site. Each connection uses a dedicated app-only Entra identity, which should have `Sites.Selected` and only the explicit Microsoft Graph permissions required by that site. Store the client secret only in the protected form; it is encrypted at rest and is not shown again.
2. In the same page, create named targets with one of three roles: **Original uploads**, **Conversion staging**, or **Intake delivery**. A target points to one selected-site connection and may add an approved relative root folder.
3. Create or keep active conversion profiles. The operation is selected from a fixed allowlist; an administrator cannot supply a command line, script, executable path, or arbitrary conversion service.
4. In **Admin → Order Workflows**, open each stage and use **File conversion and selected-site SharePoint routing** to select profiles and targets. The workflow stage may independently send the original, derived artifact, and intake-delivery artifact to the configured role-specific target.
5. Upload a file in the stage. The accepted upload remains available immediately through the existing portal. The scheduler then creates durable queue records for configured original transfer and conversions.

## Supported conversions

| Profile operation | Accepted source | New artifact | Native self-hosted tool | Notes |
|---|---|---|---|---|
| PDF to Word (reflow) | `.pdf` | `.docx` | `pdf2docx` | A reflow conversion; complex layouts should be reviewed by staff. |
| PDF to text | `.pdf` | `.txt` | Poppler `pdftotext` | Extracted text is a separate artifact, not a replacement PDF. |
| Word to PDF | `.docx` | `.pdf` | LibreOffice headless | Conversion depends on installed local fonts; pre-release acceptance tests should use representative templates. |
| Word to text | `.docx` | `.txt` | Pandoc | Creates plain text only. |
| Text to Word | `.txt` | `.docx` | Pandoc | Creates a new editable Word artifact. |
| Text to PDF | `.txt` | `.pdf` | Pandoc plus LibreOffice headless | Creates an intermediate temporary document only inside the job’s private temporary directory. |
| PDF compression — balanced | `.pdf` | `.pdf` | Ghostscript `/ebook` preset | Creates a separate smaller PDF. |
| PDF compression — small | `.pdf` | `.pdf` | Ghostscript `/screen` preset | Lower fidelity; review is recommended before publishing. |
| Audio to WebM/Opus | `.mp3`, `.m4a`, `.wav`, `.webm`, `.ogg`, `.opus`, `.aac`, `.flac`, `.aiff`, `.mp4` | `.webm` | FFmpeg with `libopus` | Inputs must pass magic-byte validation; output bitrate is limited to 32–128 kbps. |

The portal validates the generated artifact with the same magic-byte and extension controls used for uploads before storing it. A conversion may never output an executable or an unapproved file type.

## SharePoint hierarchy and target behavior

Each target has an immutable, recorded order location. The hierarchy is:

```text
<connection-base>/<optional-target-root>/<CustomerName>-<CustomerID>/<OrderNumber>
```

For example:

```text
ReadyPackets/Phase I/Originals/Alex Example-RP-CUS-4K2D8P/RP-C000008-2608-6D823B
```

The first successful resolution stores the sanitized customer-name snapshot, customer-ID snapshot, order-number snapshot, and resolved path in `order_sharepoint_locations`. A subsequent customer rename does **not** move, rename, or fork a pre-existing SharePoint order folder.

The system will not overwrite a file. Before transferring, it checks the immutable destination path. If an object exists with the same size, the transfer is treated as an idempotent success. If it differs, the job fails safely and records a sanitized diagnostic rather than replacing the remote object. Small uploads use Graph’s fixed-path conflict-fail request; larger uploads use a resumable Graph session with the same conflict-fail behavior.

| Workflow routing selection | What is sent | Destination role |
|---|---|---|
| Original uploads target | The accepted source upload | `originals` |
| Conversion profile(s) | New private artifacts, one per profile snapshot | No transfer unless one of the next targets is set |
| Conversion staging target | Each new conversion artifact | `conversion_staging` |
| Intake delivery target | Each new conversion artifact | `intake_delivery` |

The existing legacy SharePoint integration remains unchanged for backward compatibility. The new selected-site pipeline does not use its delegated audio identity and does not turn on a new destination until a workflow stage explicitly selects a target.

## Data model and recovery properties

| Table | Responsibility | Protection property |
|---|---|---|
| `sharepoint_connections` | Encrypted selected-site Graph identity and fixed site/drive/base root | Secret encrypted with row-bound AAD; never returned by an API. |
| `sharepoint_target_bindings` | Named original, staging, or intake target | Workflow stores an ID, never a destination URL. |
| `order_sharepoint_locations` | Per-order path snapshot | Customer/order identity changes cannot relocate historical files. |
| `conversion_profiles` | Fixed operation, revision, settings, and tool fingerprint | No arbitrary command or interpreter input. |
| `conversion_jobs` | Source snapshot, profile snapshot, target snapshot, durable lease/retry state | Idempotency key and bounded retry prevent duplicate execution. |
| `file_derivatives` | Source-to-artifact provenance link | Original and artifact hashes remain independently auditable. |
| `sharepoint_transfer_jobs` | Transfer snapshot and remote identity/ETag evidence | Conflict-fail upload and remote-item evidence preserve no-overwrite behavior. |

Jobs retry with bounded exponential delays and a maximum of five attempts. Only a pending conversion can be cancelled; failed or cancelled conversions can be manually requeued. All meaningful actions generate an existing ReadyPackets activity record, and technical logs carry a correlation ID without storing a secret or an external upload-session URL.

## Self-hosted installation requirements

The native installer and Docker image explicitly provision these conversion dependencies:

| Dependency | Function |
|---|---|
| FFmpeg | Audio to WebM/Opus |
| Poppler (`pdftotext`) | PDF to text |
| Pandoc | Word/text and text/Word conversions |
| LibreOffice Writer headless | Word/text PDF creation |
| Ghostscript | PDF compression |
| `pdf2docx==0.5.8` | PDF to Word reflow conversion |

The installer fails closed if the tools or Python package are absent, including when `--skip-packages` is used. The service runs under the existing unprivileged `readypackets` account and writes only to its configured storage and private temporary directory; it never receives `sudo` or a root shell.

## Required operational acceptance tests

Before enabling production routing, create a non-production workflow stage and perform these tests with non-sensitive sample files:

1. Upload one representative PDF, DOCX, TXT, and audio file. Confirm the source remains unchanged and each selected profile creates a separate private artifact.
2. Verify PDF compression size reduction and review visual quality before publishing the artifact.
3. Verify audio output plays in the staff workspace and has the `.webm` extension and Opus-compatible playback.
4. Confirm the original appears only in the originals target, while derived artifacts appear in the configured staging and intake targets.
5. Retry a failed test transfer. Confirm the remote object is not overwritten and that the durable job retains its source and correlation records.
6. Rename the test customer after the first transfer. Confirm the next file continues into the originally recorded order path rather than creating a second customer folder.
7. Confirm a customer cannot access an unpublished conversion artifact; publish it using the existing administrator Files controls only after review.

## Entra and SharePoint least-privilege checklist

| Control | Required configuration |
|---|---|
| Identity type | Application identity, not a shared delegated user account. |
| Microsoft Graph scope | `Sites.Selected` plus only required app permissions. |
| Site grant | Grant the app only to the exact original, staging, or intake site. |
| Secret storage | Enter once in the protected admin form; rotate in Entra and replace only through that form. |
| Target paths | Use controlled target binding roots; do not place customer IDs in custom free-form URL fields. |
| Permissions review | Validate site access separately for each app identity and remove obsolete grants. |
| Break-glass | Keep a documented SharePoint/Entra administrator recovery procedure outside the portal. |

## Explicit non-goals

This release does not OCR a scanned PDF, run antivirus scanning, infer document quality with AI, overwrite an uploaded source, move an existing SharePoint folder after a rename, or expose conversion artifacts to a customer automatically. Those capabilities require separately reviewed requirements, data-retention policy, test corpus, and security controls.
