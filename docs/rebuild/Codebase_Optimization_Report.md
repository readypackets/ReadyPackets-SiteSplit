# ReadyPackets Codebase Optimization and Rebuild Review

This report documents priority optimization findings from the pre-conversion ReadyPackets codebase. The Docker migration artifact defect and pending webhook job-name mismatch were corrected in the conversion release; remaining findings are retained as prioritized follow-up work so the historical reasoning is not lost.

## 1. Release and Pipeline Blockers

The following defects were identified before the conversion implementation:

*   **Docker Migration Artifact Defect (P0) — corrected:** The image now copies `drizzle/migrations` to the runtime location expected by `scripts/migrate.ts`.
*   **Webhook Job-Name Mismatch (P0) — corrected:** Migration `0054` normalizes incomplete legacy `dispatch_webhooks` rows to `notify_webhooks`, preserving completed historic records as audit evidence.
*   **Inactive Backend CI (P0) — corrected:** The backend workflow is active as `.github/workflows/portal-ci.yml`, enforcing type checks, migrations, the schema contract, tests, production bundles, and the black-box security probe on main and pull requests.

## 2. Queue Reliability and Idempotency

The current job polling approach is unsafe for horizontal scaling or prolonged network degradation:

*   **Missing Atomic Leases:** The `processPendingFileSyncs` and phase-job processors select pending rows and update their status to `running` using only the row ID. Without a transactional compare-and-set claim (a locked lease) and stale-work recovery, multiple application replicas will race to execute the same job, and a process crash will permanently strand running rows.
*   **Unguarded Schedulers:** The `scheduler.ts` file uses simple `setInterval` loops. If a SharePoint API call hangs or a batch takes longer than 60 seconds, the scheduler overlaps its own execution, duplicating side effects and exhausting connections.
*   **Durable Idempotency Requirement:** As we introduce file conversions and multi-site transfers, every side effect must be bound to a deterministic idempotency key, and Graph uploads must use conflict behavior `fail` rather than `rename` to prevent exponential file duplication.

## 3. Storage and Memory Pressures

Current file ingestion handles bytes in ways that limit scale and risk node stability:

*   **Memory-Buffered Uploads:** The `multer.memoryStorage` configuration accepts up to five 50 MB files simultaneously. This can retain ~250 MiB of request payload in memory before validation, threatening the 512 MiB production heap limit of the Node container.
*   **Storage Atomicity:** File bytes are written to local storage before the database record is inserted (`server/http/uploads.ts`). If the database transaction fails, the opaque storage blob becomes an unreferenced orphan. This requires a staged-upload and commit pattern to guarantee consistency.

## 4. Microsoft Graph and Audio Compatibility

The SharePoint integration must be hardened to support the new staging and conversion flow:

*   **Lack of Network Resilience:** Current Graph and upload-session calls lack `AbortSignal` timeouts, explicit retry classification, `Retry-After` handling (HTTP 429), or upload-session resume logic. Transient network failures currently consume the fixed five-attempt budget rapidly.
*   **Inconsistent Audio Detection:** The upload router permits browser WebM/Ogg files detected generally as `video/webm`, but the download route’s protected playback requires the MIME type to strictly start with `audio/`. Valid voice recordings can currently be stored but fail to play back.
*   **Broad Delegated Credentials:** The audio synchronization path relies on a delegated human account with broad `Files.ReadWrite.All` or `AllSites.Write` access. The new multi-site delivery architecture must replace this with app-only Microsoft Entra identities constrained by `Sites.Selected`, granting access exclusively to the necessary libraries.

## 5. Summary of Actions for Rebuild

The master prompt requires resolving these defects as a precondition for building new features. The sequence of actions is:

1.  Repair the `Dockerfile` migration path and `dispatch_webhooks` job name, and activate the backend CI pipeline.
2.  Refactor the in-memory timer processors into a durable, lease-based transactional outbox.
3.  Migrate file ingestion to streaming or chunked temp-file buffering.
4.  Implement the self-hosted conversion worker (PDF, DOCX, WebM) strictly enforcing append-only derivations.
5.  Deploy the multi-site SharePoint transfer engine using explicit target identities.
