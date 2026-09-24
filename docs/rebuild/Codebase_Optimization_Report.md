# ReadyPackets Codebase Optimization and Rebuild Review

This report documents priority optimization findings from the current ReadyPackets codebase (commit `4dea2af`). Before extending the application with a complex conversion and multi-site SharePoint architecture, these foundational corrections—several of which are release-blocking defects—must be applied to ensure the system remains resilient and securely self-hosted.

## 1. Release and Pipeline Blockers

The integrity of the deployment pipeline and operational schema is compromised by three proven gaps:

*   **Docker Migration Artifact Defect (P0):** The `Dockerfile` at line 96 attempts to copy `/build/scripts/migrations`, which does not exist in the source tree (migrations live in `drizzle/migrations`). If an image is built, the runtime `migrate.ts` will fail to find its directory and the application will fail to start. This path must be corrected before any deployment.
*   **Webhook Job-Name Mismatch (P0):** Order state transitions enqueue a job named `dispatch_webhooks` (in `server/services/orders.ts`), but the phase processor explicitly listens for `notify_webhooks` (in `server/services/sharepoint.ts`). The unrecognized jobs are warned about and instantly marked completed, meaning configured order-transition webhooks are silently skipped. A canonical job-type registry must be created and the pending legacy rows migrated.
*   **Inactive Backend CI (P0):** The full backend continuous integration definition (`ci/github-actions-ci.yml`) is intentionally parked and inactive. The active `.github/workflows/native-mobile.yml` runs only the mobile contract and typecheck—it does not run the 106 unit tests, build the Docker image, run migrations, or execute the HTTP security probe. This pipeline must be activated to enforce the 37-table schema contract automatically.

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
