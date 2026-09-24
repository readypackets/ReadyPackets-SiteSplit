# Conversion and SharePoint Workflow Implementation Design

This document specifies the technical architecture for the configurable document/audio conversion and multi-site SharePoint synchronization expansion, fulfilling the requirement for a deterministic, self-hosted deployment.

## 1. Multi-Site SharePoint Targeting

The system will decouple the single global SharePoint configuration into three distinct, administratively selectable logical targets:

*   **Target 1: Originals.** Receives an exact, byte-for-byte copy of the customer's uploaded file.
*   **Target 2: Conversion Staging.** Receives the converted artifact (e.g., PDF to DOCX) and a provenance manifest detailing the source hash and tool version used.
*   **Target 3: Intake Delivery.** Receives only the final, approved converted artifact.

### Immutable Order Locations
For every selected target, the application resolves an immutable order location path at the time of the first transfer.
*   **Format:** `{TargetRoot}/{SafeCustomerName}-{CustomerID}/{SafeOrderNumber}/` (e.g., `Acme_Corp-RP-CUS-001A/ORD-1042/`).
*   **Normalization:** The `SafeCustomerName` is transliterated, stripped of special characters and traversal dot-segments, and combined with the immutable Customer ID to prevent name-change collisions.
*   **Permissions:** Each target operates using a distinct app-only Microsoft Entra identity constrained by the `Sites.Selected` Graph permission, retiring the broad delegated access previously used.

## 2. Deterministic Self-Hosted Conversion

ReadyPackets remains strictly self-hosted; conversion will not rely on Office 365, SaaS APIs, or external AI agents.

### Toolchain and Sandboxing
The conversions run in a dedicated, low-privilege background worker container loaded with pinned open-source tools:
*   **DOCX to PDF:** `libreoffice --headless`
*   **PDF to TXT:** `pdftotext` (Poppler)
*   **PDF to DOCX:** A pinned Python `pdf2docx` integration.
*   **TXT to DOCX/PDF:** `pandoc`
*   **PDF Compression:** `gs` (Ghostscript) with safe presets.
*   **Audio to WebM:** `ffmpeg` (already used safely in the codebase).

The worker has no network access, operates as an unprivileged user in a `0700` private workspace, and enforces strict file-size, page-count, and CPU/memory limits. Executables are invoked via `execFile` without shell interpolation.

### Conversion Profiles
Administrators configure conversion via versioned **Conversion Profiles** rather than arbitrary shell commands.
A stage might be configured with: "If input is PDF, apply profile `pdf-reflow-docx-v1`".
The database records the profile version and tool digest at the time of execution.

## 3. Append-Only Artifact Derivation

The core invariant of this feature is that **original uploads are never overwritten or deleted**.

1.  **Snapshot:** When a conversion job is queued, the system snapshots the source file ID, its active version, its opaque storage key, and its SHA-256 hash.
2.  **Derivation:** The conversion worker reads the original file, performs the transformation, and writes the output to a *new*, random storage key.
3.  **Linkage:** A new `file_derivatives` (or `artifact_files`) record is created, capturing the output SHA-256 and referencing the source snapshot.
4.  **Idempotency:** The transfer to SharePoint is keyed by a hash of the artifact SHA-256, target folder ID, and operation, ensuring retry logic never duplicates files on the remote server.

## 4. Master Prompt Walkthrough

When applying the Master Prompt to rebuild ReadyPackets, the LLM will encounter these strict boundaries:

1.  **"Mandatory Technical Stack"**: Prevents the LLM from substituting AWS Lambda or managed cloud queues for the background conversion worker. It must implement the queue using MySQL and Node.js.
2.  **"Security Posture as Code"**: Requires the LLM to write the strict `execFile` bindings and AppArmor/seccomp profiles for the conversion tools, preventing shell-injection vulnerabilities.
3.  **"Strict Schema Validation"**: The LLM must supply additive MySQL migrations (e.g., `0054_conversion_profiles.sql`) that define the `file_derivatives` and outbox tables, passing the 37-table `schemaContract.ts` assertion.
4.  **"Release and Testing Gates"**: Forces the LLM to fix the Docker migration artifact blocker and provide unit tests for the path normalizer before the new feature can be considered complete.

This design guarantees that ReadyPackets gains powerful enterprise integration while retaining its fundamental security, auditability, and self-hosted isolation.
