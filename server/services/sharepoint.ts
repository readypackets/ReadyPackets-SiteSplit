/**
 * Microsoft Graph / SharePoint integration service.
 *
 * Handles:
 *   - Folder structure creation for each order phase
 *   - Placeholder file attachment (stub documents for each deliverable)
 *   - Webhook notification dispatch on phase transitions
 *   - Phase job queue processing (retry with back-off)
 *
 * All Graph calls are gated behind env.graph.enabled so the application is
 * fully functional without Azure credentials configured. When disabled, phase
 * kickoffs still run but skip the Graph steps.
 *
 * Authentication uses the client-credentials flow (app-only), which is the
 * correct model for a server-side service acting on behalf of the organisation
 * rather than on behalf of an individual user.
 */
import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  files,
  orders,
  orderWorkflows,
  phaseJobs,
  phaseKickoffConfigs,
  webhookDeliveries,
  webhookEndpoints,
  sharepointSyncLog,
} from "../db/schema.js";
import { env } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { recordActivity } from "../observability/audit.js";
import { insertedId } from "../db/result.js";
import { decryptField } from "../security/crypto.js";
import { getSetting } from "./settings.js";
import { getUserById, displayNameOf } from "../db/users.js";
import { buildOrderFileName } from "./fileNaming.js";
import { getObjectBuffer } from "./storage.js";
import { transcodeWebmToMp3ForSharePoint } from "./audioTranscode.js";
import { getDelegatedSharePointStatus, getDelegatedSharePointRestToken, recordDelegatedSharePointError } from "./sharepointDelegatedAuth.js";
import { backfillCanonicalP101Scope, buildCanonicalP101Payload } from "./orderScope.js";
import type { OrderStatus } from "../../shared/domain.js";

// ---------------------------------------------------------------------------
// Graph client (lazy-initialised)
// ---------------------------------------------------------------------------

interface GraphTokenCache {
  token: string;
  expiresAt: number;
}

let _tokenCache: GraphTokenCache | null = null;

interface GraphRuntimeConfig {
  tenantId: string | null;
  clientId: string | null;
  clientSecret: string | null;
  siteId: string | null;
  driveId: string | null;
  siteUrl: string | null;
  rootFolderPath: string;
  audioFallbackMode: "none" | "mp3";
  enabled: boolean;
}

/**
 * ReadyPackets owns the customer/order hierarchy below the configured root.
 * Administrators may browse into an existing `customers` folder; normalize that
 * selection back to its base so a future sync does not create `customers/customers`.
 */
export function normalizeSharePointRootFolderPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.length > 240 || normalized.includes("..")) {
    throw new Error("Select a valid SharePoint base folder without dot segments.");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || !/^[A-Za-z0-9 _().-]{1,96}$/.test(segment))) {
    throw new Error("The SharePoint root folder contains unsupported characters.");
  }
  const managedCustomersIndex = segments.findIndex((segment) => segment.toLowerCase() === "customers");
  const baseSegments = managedCustomersIndex >= 0 ? segments.slice(0, managedCustomersIndex) : segments;
  if (baseSegments.length === 0) {
    throw new Error("Select a base folder above the ReadyPackets customers folder.");
  }
  return baseSegments.join("/");
}

function buildOrderRootFolderPath(rootFolderPath: string, customerFolder: string, orderNumber: string): string {
  return `${rootFolderPath}/customers/${customerFolder}/orders/${orderNumber}`;
}

async function getGraphRuntimeConfig(): Promise<GraphRuntimeConfig> {
  const tenantId = (await getSetting("sharepoint.tenant_id")) || env.graph.tenantId || null;
  const clientId = (await getSetting("sharepoint.client_id")) || env.graph.clientId || null;
  const secretStored = await getSetting("sharepoint.client_secret_enc");
  const clientSecret = secretStored
    ? decryptField(secretStored, "sharepoint.client_secret")
    : env.graph.clientSecret || null;
  const siteId = (await getSetting("sharepoint.site_id")) || env.graph.siteId || null;
  const driveId = (await getSetting("sharepoint.drive_id")) || env.graph.driveId || null;
  const siteUrl = (await getSetting("sharepoint.site_url")) || null;
  const configuredRootFolderPath = (await getSetting("sharepoint.root_folder_path")) || env.graph.rootFolderPath;
  const rootFolderPath = normalizeSharePointRootFolderPath(configuredRootFolderPath);
  const audioFallbackMode = (await getSetting("sharepoint.audio_fallback_mode")) === "none" ? "none" : "mp3";
  return {
    tenantId,
    clientId,
    clientSecret,
    siteId,
    driveId,
    siteUrl,
    rootFolderPath,
    audioFallbackMode,
    enabled: Boolean(tenantId && clientId && clientSecret && siteId && driveId),
  };
}

export function resetGraphTokenCache(): void {
  _tokenCache = null;
}

function encodeDrivePath(path: string): string {
  return path.split("/").filter(Boolean).map((segment) => encodeURIComponent(segment)).join("/");
}

export interface SharePointFolderChoice { id: string; name: string; path: string }

/** List existing folders beneath a configured drive path without creating or altering anything. */
export async function browseSharePointFolders(path = ""): Promise<{ currentPath: string; parentPath: string | null; folders: SharePointFolderChoice[] }> {
  const config = await getGraphRuntimeConfig();
  if (!config.enabled || !config.driveId) throw new Error("Save valid Microsoft Graph and SharePoint settings before browsing folders.");
  const normalized = path.trim() ? normalizeSharePointRelativePath(path) : "";
  const currentId = normalized
    ? ((await graphRequest("GET", `/drives/${config.driveId}/root:/${encodeDrivePath(normalized)}`)) as { id?: string }).id
    : "root";
  if (!currentId) throw new Error("The selected SharePoint folder could not be found.");
  const childrenPath = normalized
    ? `/drives/${config.driveId}/items/${currentId}/children?$select=id,name,folder&$top=200`
    : `/drives/${config.driveId}/root/children?$select=id,name,folder&$top=200`;
  const children = (await graphRequest("GET", childrenPath)) as { value?: Array<{ id?: string; name?: string; folder?: unknown }> };
  const folders = (children.value ?? []).flatMap((item) => item.id && item.name && item.folder !== undefined ? [{ id: item.id, name: item.name, path: normalized ? `${normalized}/${item.name}` : item.name }] : []);
  const parts = normalized.split("/").filter(Boolean);
  return { currentPath: normalized, parentPath: parts.length > 1 ? parts.slice(0, -1).join("/") : parts.length === 1 ? "" : null, folders };
}

/** Verify credentials, selected site, drive, and existing root path without writing any SharePoint content. */
export async function testSharePointConnection(): Promise<{ siteName: string; driveName: string; rootFolderPath: string; folderCount: number }> {
  const config = await getGraphRuntimeConfig();
  if (!config.enabled || !config.siteId || !config.driveId) throw new Error("Complete and save tenant, client, secret, site, and document-library settings before testing the connection.");
  const [site, drive, root] = await Promise.all([
    graphRequest("GET", `/sites/${encodeURIComponent(config.siteId)}?$select=id,displayName,name`) as Promise<{ displayName?: string; name?: string }>,
    graphRequest("GET", `/drives/${encodeURIComponent(config.driveId)}?$select=id,name`) as Promise<{ name?: string }>,
    browseSharePointFolders(config.rootFolderPath),
  ]);
  return { siteName: site.displayName ?? site.name ?? "SharePoint site", driveName: drive.name ?? "Document library", rootFolderPath: root.currentPath, folderCount: root.folders.length };
}

interface GraphCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

async function requestGraphToken(credentials: GraphCredentials): Promise<GraphTokenCache> {
  const url = `https://login.microsoftonline.com/${encodeURIComponent(credentials.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    let code = "unavailable";
    try {
      const payload = await response.json() as { error?: unknown };
      if (typeof payload.error === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(payload.error)) code = payload.error;
    } catch {
      /* The identity service did not return a parseable error payload. */
    }
    throw new Error(`Microsoft Graph authentication failed (${code}, HTTP ${response.status}). Check the tenant ID, client ID, client secret, and application permissions.`);
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };
  return { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
}

async function getGraphToken(): Promise<string> {
  if (_tokenCache && Date.now() < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.token;
  }

  const { tenantId, clientId, clientSecret } = await getGraphRuntimeConfig();
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("Microsoft Graph credentials are not fully configured.");
  }

  _tokenCache = await requestGraphToken({ tenantId, clientId, clientSecret });
  return _tokenCache.token;
}

async function graphRequestWithToken(
  token: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<unknown> {
  const url = path.startsWith("https://") ? path : `https://graph.microsoft.com/v1.0${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph API ${method} ${path} failed (${response.status}): ${text.slice(0, 400)}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function graphRequest(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<unknown> {
  return graphRequestWithToken(await getGraphToken(), method, path, body);
}

export interface SharePointDiscoveryInput {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  siteUrl: string;
}

export interface SharePointDiscoveryResult {
  siteId: string;
  driveId: string;
  siteUrl: string;
  siteName: string;
  drives: Array<{ id: string; name: string; webUrl: string | null; isDefault: boolean }>;
}

interface NormalizedSharePointSiteUrl {
  hostname: string;
  sitePath: string;
  canonicalUrl: string;
}

/**
 * Canonicalise a copied SharePoint site URL before it is passed to Graph. The
 * browser field may contain invisible copy/paste characters or a sharing query;
 * neither changes the site identity and both should not block discovery.
 */
export function normalizeSharePointSiteUrl(value: string): NormalizedSharePointSiteUrl {
  const normalized = value.trim().replace(/[\u200B-\u200D\uFEFF]/g, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("Enter a valid HTTPS SharePoint site URL.");
  }

  const hostname = parsed.hostname.toLowerCase();
  const isSharePointTenant = hostname.endsWith(".sharepoint.com") && hostname.length > ".sharepoint.com".length;
  if (parsed.protocol !== "https:" || !isSharePointTenant || parsed.username || parsed.password || parsed.port) {
    throw new Error("The SharePoint site URL must be an HTTPS *.sharepoint.com address.");
  }

  const sitePath = parsed.pathname.replace(/\/+$/, "") || "/";
  return {
    hostname,
    sitePath,
    canonicalUrl: `https://${hostname}${sitePath}`,
  };
}

/**
 * Discover the Graph site ID and document-library drive IDs from a SharePoint URL.
 * Credentials are used only for this server-side request and are never returned or logged.
 */
export async function discoverSharePointConfig(input: SharePointDiscoveryInput): Promise<SharePointDiscoveryResult> {
  const { hostname, sitePath, canonicalUrl } = normalizeSharePointSiteUrl(input.siteUrl);

  const token = (await requestGraphToken({
    tenantId: input.tenantId,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
  })).token;
  // Microsoft Graph uses `/sites/{hostname}` for a tenant root and the
  // hostname-plus-relative-path form only for a non-root site.
  const siteLookupPath = sitePath === "/"
    ? `/sites/${encodeURIComponent(hostname)}`
    : `/sites/${encodeURIComponent(hostname)}:${encodeURI(sitePath)}`;
  const site = (await graphRequestWithToken(
    token,
    "GET",
    siteLookupPath,
  )) as { id?: string; displayName?: string; name?: string };
  if (!site.id) throw new Error("Microsoft Graph did not return a SharePoint site ID for this URL.");

  const [defaultDrive, driveList] = await Promise.all([
    graphRequestWithToken(token, "GET", `/sites/${encodeURIComponent(site.id)}/drive`) as Promise<{ id?: string; name?: string; webUrl?: string }>,
    graphRequestWithToken(token, "GET", `/sites/${encodeURIComponent(site.id)}/drives`) as Promise<{ value?: Array<{ id?: string; name?: string; webUrl?: string }> }>,
  ]);
  if (!defaultDrive.id) throw new Error("Microsoft Graph did not return a default document library for this site.");

  const drives = (driveList.value ?? []).flatMap((drive) => drive.id ? [{
    id: drive.id,
    name: drive.name ?? "Document library",
    webUrl: drive.webUrl ?? null,
    isDefault: drive.id === defaultDrive.id,
  }] : []);
  if (!drives.some((drive) => drive.id === defaultDrive.id)) {
    drives.unshift({ id: defaultDrive.id, name: defaultDrive.name ?? "Documents", webUrl: defaultDrive.webUrl ?? null, isDefault: true });
  }

  return {
    siteId: site.id,
    driveId: defaultDrive.id,
    siteUrl: canonicalUrl,
    siteName: site.displayName ?? site.name ?? "SharePoint site",
    drives,
  };
}

// ---------------------------------------------------------------------------
// Folder operations
// ---------------------------------------------------------------------------

/**
 * Ensure a folder exists at the given path under the configured drive root.
 * Creates all intermediate folders if they do not exist.
 * Returns the folder's item ID.
 */
async function ensureFolder(folderPath: string): Promise<string> {
  const { siteId, driveId } = await getGraphRuntimeConfig();
  if (!siteId || !driveId) {
    throw new Error("GRAPH_SHAREPOINT_SITE_ID and GRAPH_SHAREPOINT_DRIVE_ID must be set.");
  }

  const segments = folderPath.split("/").filter(Boolean);
  let parentId = "root";

  for (const segment of segments) {
    // Try to get the folder first.
    try {
      const existing = (await graphRequest(
        "GET",
        `/drives/${driveId}/items/${parentId}:/${encodeURIComponent(segment)}`
      )) as { id: string };
      parentId = existing.id;
    } catch {
      // Folder does not exist — create it.
      const created = (await graphRequest(
        "POST",
        `/drives/${driveId}/items/${parentId}/children`,
        {
          name: segment,
          folder: {},
          "@microsoft.graph.conflictBehavior": "fail",
        }
      )) as { id: string };
      parentId = created.id;
    }
  }

  return parentId;
}

/**
 * Upload a small placeholder file to a SharePoint folder.
 * Returns the uploaded file's item ID.
 */
async function uploadTextFile(
  folderId: string,
  fileName: string,
  content: string,
  contentType = "text/plain"
): Promise<string> {
  const { driveId } = await getGraphRuntimeConfig();
  if (!driveId) throw new Error("GRAPH_SHAREPOINT_DRIVE_ID must be set.");

  const token = await getGraphToken();
  const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${folderId}:/${encodeURIComponent(fileName)}:/content`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType,
    },
    body: content,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SharePoint file upload failed (${response.status}): ${text.slice(0, 300)}`);
  }

  const data = (await response.json()) as { id: string };
  return data.id;
}

async function uploadPlaceholder(folderId: string, fileName: string, content: string): Promise<string> {
  return uploadTextFile(folderId, fileName, content);
}

type GraphUploadSession = { uploadUrl?: string };
type GraphUploadResult = { id?: string };

/**
 * Send Graph binary file content through Node's native HTTPS client. This gives
 * the Microsoft endpoint a fixed Content-Length and a single raw byte stream,
 * avoiding any runtime-specific fetch body framing. It is used only for binary
 * file-content PUT requests; Graph JSON and discovery requests continue using
 * the regular fetch client.
 */
async function putGraphBinaryContent(url: string, token: string, content: Buffer, contentType: string, method: "PUT" | "POST" = "PUT"): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(target, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": contentType,
        "Content-Length": String(content.byteLength),
      },
    }, (response) => {
      const parts: Buffer[] = [];
      response.on("data", (chunk: Buffer | Uint8Array | string) => parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(parts).toString("utf8") }));
    });
    request.once("error", reject);
    request.end(content);
  });
}

async function uploadBinaryViaSession(folderId: string, fileName: string, content: Buffer, contentType: string, accessToken?: string): Promise<string> {
  const { driveId } = await getGraphRuntimeConfig();
  if (!driveId) throw new Error("GRAPH_SHAREPOINT_DRIVE_ID must be set.");
  if (content.byteLength === 0) throw new Error("The audio recording is empty and cannot be synchronized.");

  const token = accessToken ?? await getGraphToken();
  const sessionUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${folderId}:/${encodeURIComponent(fileName)}:/createUploadSession`;
  const sessionResponse = await fetch(sessionUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "rename", name: fileName } }),
  });
  if (!sessionResponse.ok) {
    const text = await sessionResponse.text();
    const policyHint = sessionResponse.status === 400 ? ` The selected SharePoint library rejected the ${fileName.split(".").pop()?.toLowerCase() || "file"} filename or extension before bytes were transferred; review its file-type, retention-label, and Purview/DLP policies.` : "";
    throw new Error(`SharePoint audio upload-session creation failed (${sessionResponse.status}): ${text.slice(0, 500)}${policyHint}`);
  }
  const session = (await sessionResponse.json()) as GraphUploadSession;
  if (!session.uploadUrl || !session.uploadUrl.startsWith("https://")) throw new Error("Microsoft Graph did not return a valid SharePoint upload-session URL.");

  // Microsoft requires non-final upload-session fragments to be multiples of 320 KiB.
  const chunkSize = 10 * 1024 * 1024;
  let offset = 0;
  let finalResult: GraphUploadResult | undefined;
  while (offset < content.byteLength) {
    const end = Math.min(offset + chunkSize, content.byteLength) - 1;
    const chunk = content.subarray(offset, end + 1);
    const uploadResponse = await fetch(session.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(chunk.byteLength),
        "Content-Range": `bytes ${offset}-${end}/${content.byteLength}`,
        "Content-Type": contentType,
      },
      body: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer,
    });
    if (!uploadResponse.ok) {
      const text = await uploadResponse.text();
      const policyHint = uploadResponse.status === 400 ? ` The upload session was accepted but SharePoint rejected the ${fileName.split(".").pop()?.toLowerCase() || "file"} payload; review its file-type, retention-label, and Purview/DLP policies.` : "";
      throw new Error(`SharePoint audio upload-session transfer failed (${uploadResponse.status}): ${text.slice(0, 500)}${policyHint}`);
    }
    if (end === content.byteLength - 1) finalResult = (await uploadResponse.json()) as GraphUploadResult;
    offset = end + 1;
  }
  if (!finalResult?.id) throw new Error("Microsoft Graph completed the audio upload without returning a SharePoint item ID.");
  return finalResult.id;
}

async function renameSharePointFileItem(driveId: string, itemId: string, fileName: string, token: string): Promise<string> {
  const response = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: fileName }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SharePoint WebM final rename failed (${response.status}): ${text.slice(0, 500)}`);
  }
  const renamed = (await response.json()) as GraphUploadResult;
  if (!renamed.id) throw new Error("Microsoft Graph renamed the WebM file without returning its item ID.");
  return renamed.id;
}

async function deleteSharePointFileItem(driveId: string, itemId: string, token: string): Promise<void> {
  try {
    await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // A failed cleanup must not obscure the primary upload or rename diagnostic.
  }
}

/**
 * Upload a delegated audio copy through the SharePoint REST audience. This is
 * deliberately isolated from the existing Graph app-only transport so documents,
 * folder management, and current Graph controls are not changed.
 */
async function resolveDocumentLibraryRootServerPath(driveId: string): Promise<string> {
  const drive = await graphRequest("GET", `/drives/${encodeURIComponent(driveId)}?$select=id,webUrl`) as { webUrl?: string };
  if (!drive.webUrl) throw new Error("Microsoft Graph did not return a web URL for the selected SharePoint document library.");
  let driveWebUrl: URL;
  try {
    driveWebUrl = new URL(drive.webUrl);
  } catch {
    throw new Error("Microsoft Graph returned an invalid web URL for the selected SharePoint document library.");
  }
  const rootPath = decodeURIComponent(driveWebUrl.pathname).replace(/\/+$/, "");
  if (!rootPath || rootPath.includes("..") || /['\r\n]/.test(rootPath)) {
    throw new Error("The selected SharePoint document-library path is invalid for delegated audio synchronization.");
  }
  return rootPath;
}

async function uploadAudioViaSharePointRest(folderPath: string, fileName: string, content: Buffer): Promise<void> {
  const { siteUrl, driveId } = await getGraphRuntimeConfig();
  if (!siteUrl || !driveId) throw new Error("Save the SharePoint site URL and selected document library before synchronizing delegated audio.");
  let site: URL;
  try {
    site = new URL(siteUrl);
  } catch {
    throw new Error("The saved SharePoint site URL is invalid for delegated audio synchronization.");
  }
  const hostname = site.hostname.toLowerCase();
  if (site.protocol !== "https:" || !hostname.endsWith(".sharepoint.com") || site.username || site.password || site.port) {
    throw new Error("The saved SharePoint site URL must be a secure *.sharepoint.com address.");
  }
  const normalizedSitePath = site.pathname.replace(/\/+$/, "");
  const documentLibraryRoot = await resolveDocumentLibraryRootServerPath(driveId);
  if (!documentLibraryRoot.startsWith(`${normalizedSitePath}/`) && documentLibraryRoot !== normalizedSitePath) {
    throw new Error("The selected document library does not belong to the configured SharePoint site.");
  }
  const serverRelativeFolder = `${documentLibraryRoot}/${folderPath}`.replace(/\/+/g, "/");
  if (serverRelativeFolder.includes("..") || /['\r\n]/.test(serverRelativeFolder) || /['\r\n]/.test(fileName)) {
    throw new Error("The resolved SharePoint audio destination contains unsupported path characters.");
  }
  const escapedFolder = serverRelativeFolder.replace(/'/g, "''");
  const escapedName = fileName.replace(/'/g, "''");
  const endpoint = `${site.origin}${normalizedSitePath}/_api/web/GetFolderByServerRelativeUrl('${escapedFolder}')/Files/add(url='${escapedName}',overwrite=true)`;
  const token = await getDelegatedSharePointRestToken();
  const response = await putGraphBinaryContent(endpoint, token, content, "application/octet-stream", "POST");
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`SharePoint REST audio upload failed (${response.status}): ${response.body.slice(0, 500)}`);
  }
}

async function uploadBinaryFile(folderId: string, fileName: string, content: Buffer, contentType: string, accessToken?: string): Promise<string> {
  // The app-only Graph library accepts direct content uploads for documents but
  // rejects a direct `.webm` name. Upload the exact bytes through the accepted
  // direct route under a random neutral name, then rename to the original WebM.
  const resolvedContentType = contentType || "application/octet-stream";
  const simpleUploadLimit = 4 * 1024 * 1024;
  if (content.byteLength > simpleUploadLimit) return uploadBinaryViaSession(folderId, fileName, content, resolvedContentType, accessToken);

  const { driveId } = await getGraphRuntimeConfig();
  if (!driveId) throw new Error("GRAPH_SHAREPOINT_DRIVE_ID must be set.");
  const token = accessToken ?? await getGraphToken();
  const stageWebm = /\.webm$/i.test(fileName);
  const uploadName = stageWebm ? `rp-upload-${randomUUID()}.bin` : fileName;
  // The intermediate item is intentionally a neutral binary object. The portal
  // retains the source WebM metadata and the final SharePoint rename restores
  // the exact .webm filename after Graph accepts the byte stream.
  const uploadContentType = stageWebm ? "application/octet-stream" : resolvedContentType;
  const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${folderId}:/${encodeURIComponent(uploadName)}:/content`;
  let uploadedId: string | null = null;
  try {
    const response = await putGraphBinaryContent(url, token, content, uploadContentType);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`SharePoint file-content upload failed (${response.status}): ${response.body.slice(0, 500)}`);
    }
    let uploaded: GraphUploadResult;
    try {
      uploaded = JSON.parse(response.body) as GraphUploadResult;
    } catch {
      throw new Error("Microsoft Graph completed the binary upload without a valid item response.");
    }
    if (!uploaded.id) throw new Error("Microsoft Graph did not return a SharePoint item ID after upload.");
    uploadedId = uploaded.id;
    return stageWebm ? await renameSharePointFileItem(driveId, uploadedId, fileName, token) : uploadedId;
  } catch (error) {
    if (stageWebm && uploadedId) await deleteSharePointFileItem(driveId, uploadedId, token);
    throw error;
  }
}

type WorkflowSharePointStage = { key?: unknown; sharePointDestination?: unknown; sharePointAudioDestination?: unknown };
type SharePointFileKind = "document" | "audio";

function workflowStageKeyForPhase(phase: string): string {
  return phase === "phase_1" ? "phase_1_intake" : phase === "phase_2" ? "phase_2_synthesis" : phase;
}

export function normalizeSharePointRelativePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.length > 240 || normalized.includes("..")) throw new Error("The SharePoint folder path must be relative and cannot contain dot segments.");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || !/^[A-Za-z0-9 _().-]{1,96}$/.test(segment))) throw new Error("The SharePoint folder path contains unsupported characters.");
  return segments.join("/");
}

/**
 * Folder templates are phase-relative paths below the managed customer/order
 * hierarchy. They deliberately do not permit absolute paths, traversal, or
 * interpolation tokens so an administrator cannot escape the configured
 * SharePoint base folder or create a second customer/order identity scheme.
 */
export function normalizeSharePointFolderTemplate(value: readonly string[]): string[] {
  if (value.length === 0) throw new Error("Add at least one relative folder path, or restore the default template.");
  if (value.length > 32) throw new Error("A phase folder template may contain at most 32 paths.");
  const normalized = value.map((path) => normalizeSharePointRelativePath(path));
  const seen = new Set<string>();
  for (const path of normalized) {
    const key = path.toLowerCase();
    if (seen.has(key)) throw new Error(`The SharePoint folder template contains the duplicate path: ${path}`);
    seen.add(key);
  }
  return normalized;
}

function resolveSharePointFileKind(file: { detectedMime?: string | null; extension?: string | null }): SharePointFileKind {
  const mime = file.detectedMime?.toLowerCase() ?? "";
  const extension = file.extension?.toLowerCase() ?? "";
  return mime.startsWith("audio/") || mime === "video/webm" || mime === "video/ogg" || ["webm", "wav", "mp3", "m4a", "ogg", "aac", "flac"].includes(extension) ? "audio" : "document";
}

async function resolveOrderStageFolder(orderId: number, phase: string, graphConfig: GraphRuntimeConfig, fileKind: SharePointFileKind = "document"): Promise<{ folderPath: string; orderNumber: string }> {
  const rows = await db.select({ orderNumber: orders.orderNumber, userId: orders.userId, workflowId: orders.workflowId }).from(orders).where(eq(orders.id, orderId)).limit(1);
  const order = rows[0];
  if (!order) throw new Error("Order not found for SharePoint synchronization.");
  const customer = await getUserById(order.userId);
  const customerFolder = customer?.customerNumber ?? "RP-CUS-UNKNOWN0";
  const stageRows = order.workflowId ? await db.select({ stages: orderWorkflows.stages }).from(orderWorkflows).where(eq(orderWorkflows.id, order.workflowId)).limit(1) : [];
  const stages = Array.isArray(stageRows[0]?.stages) ? stageRows[0]!.stages as WorkflowSharePointStage[] : [];
  const stageKey = workflowStageKeyForPhase(phase);
  const stage = stages.find((item) => item.key === stageKey);
  const configuredDestination = fileKind === "audio" ? stage?.sharePointAudioDestination : stage?.sharePointDestination;
  const templates = DEFAULT_FOLDER_TEMPLATES[stageKey] ?? [];
  const fallback = fileKind === "audio"
    ? templates.find((path) => /\/audio$/i.test(path)) ?? `Workflow/${stageKey}/Audio`
    : templates.find((path) => /\/(Docs|Client_Facing|Context)$/i.test(path)) ?? `Workflow/${stageKey}/Docs`;
  const destination = normalizeSharePointRelativePath(typeof configuredDestination === "string" && configuredDestination.trim() ? configuredDestination : fallback);
  return { folderPath: `${buildOrderRootFolderPath(graphConfig.rootFolderPath, customerFolder, order.orderNumber)}/${destination}`, orderNumber: order.orderNumber };
}

/** Queue an accepted local order file for asynchronous Graph synchronization when SharePoint is configured. */
export async function queueOrderFileSharePointSync(fileId: number): Promise<void> {
  const graphConfig = await getGraphRuntimeConfig();
  if (!graphConfig.enabled) return;
  const rows = await db.select({ id: files.id, orderId: files.orderId, phase: files.phase, originalName: files.originalName, detectedMime: files.detectedMime, extension: files.extension, isPlaceholder: files.isPlaceholder }).from(files).where(eq(files.id, fileId)).limit(1);
  const file = rows[0];
  if (!file?.orderId || file.isPlaceholder) return;
  const { folderPath } = await resolveOrderStageFolder(file.orderId, file.phase, graphConfig, resolveSharePointFileKind(file));
  await db.insert(sharepointSyncLog).values({ orderId: file.orderId, fileId: file.id, operationType: "file_sync", status: "pending", sharepointPath: `${folderPath}/${file.originalName}`, attempts: 0 });
}

/** Process bounded pending file uploads so customer requests never wait on Microsoft Graph. */
export async function processPendingFileSyncs(): Promise<void> {
  const graphConfig = await getGraphRuntimeConfig();
  if (!graphConfig.enabled) return;
  const pending = await db.select().from(sharepointSyncLog).where(and(eq(sharepointSyncLog.operationType, "file_sync"), eq(sharepointSyncLog.status, "pending"), sql`${sharepointSyncLog.fileId} IS NOT NULL`, sql`${sharepointSyncLog.attempts} < 5`)).limit(10);
  for (const log of pending) {
    await db.update(sharepointSyncLog).set({ status: "running", attempts: log.attempts + 1 }).where(eq(sharepointSyncLog.id, log.id));
    try {
      const fileRows = await db.select({ id: files.id, orderId: files.orderId, phase: files.phase, originalName: files.originalName, storageKey: files.storageKey, detectedMime: files.detectedMime, deletedAt: files.deletedAt }).from(files).where(eq(files.id, log.fileId!)).limit(1);
      const file = fileRows[0];
      if (!file?.orderId || file.deletedAt) throw new Error("The queued order file is no longer available for synchronization.");
      const fileKind = resolveSharePointFileKind(file);
      const { folderPath, orderNumber } = await resolveOrderStageFolder(file.orderId, file.phase, graphConfig, fileKind);
      const folderId = await ensureFolder(folderPath);
      const source = await getObjectBuffer(file.storageKey);
      const delegatedStatus = fileKind === "audio" ? await getDelegatedSharePointStatus() : null;
      const useDelegatedSharePointRest = fileKind === "audio" && Boolean(delegatedStatus?.connected);
      // The MP3 fallback remains only for legacy deployments that have not yet
      // connected a delegated Microsoft 365 account.
      const useMp3Fallback = !useDelegatedSharePointRest && graphConfig.audioFallbackMode === "mp3" && fileKind === "audio" && /\.webm$/i.test(file.originalName);
      const transferName = useMp3Fallback ? file.originalName.replace(/\.webm$/i, ".mp3") : file.originalName;
      const transferContent = useMp3Fallback ? await transcodeWebmToMp3ForSharePoint(source) : source;
      const transferMime = useMp3Fallback ? "audio/mpeg" : file.detectedMime;
      if (useDelegatedSharePointRest) {
        await uploadAudioViaSharePointRest(folderPath, transferName, transferContent);
      } else {
        await uploadBinaryFile(folderId, transferName, transferContent, transferMime);
      }
      await db.update(sharepointSyncLog).set({ status: "succeeded", sharepointPath: `${folderPath}/${transferName}`, errorMessage: null }).where(eq(sharepointSyncLog.id, log.id));
      void recordActivity({
        actorUserId: null,
        action: useDelegatedSharePointRest ? "sharepoint.audio_delegated_rest_synced" : useMp3Fallback ? "sharepoint.audio_mp3_fallback_synced" : "sharepoint.file_synced",
        entityType: "file",
        entityId: file.id,
        summary: useDelegatedSharePointRest
          ? `Synchronized original audio ${file.originalName} to SharePoint using the dedicated Microsoft 365 sync identity for ${orderNumber}.`
          : useMp3Fallback
            ? `Synchronized a SharePoint-only MP3 copy of ${file.originalName} for ${orderNumber}; the original WebM remains in ReadyPackets.`
            : `Synchronized ${file.originalName} to SharePoint for ${orderNumber}`,
      });
    } catch (error) {
      if (error instanceof Error && /delegated Microsoft 365 sync identity|Microsoft delegated SharePoint authorization/i.test(error.message)) {
        await recordDelegatedSharePointError(error.message);
      }
      const attempts = log.attempts + 1;
      await db.update(sharepointSyncLog).set({ status: attempts >= 5 ? "failed" : "pending", errorMessage: error instanceof Error ? error.message.slice(0, 800) : String(error).slice(0, 800) }).where(eq(sharepointSyncLog.id, log.id));
      logger.warn("sharepoint.file_sync.failed", { logId: log.id, fileId: log.fileId, attempt: attempts, error });
    }
  }
}

// ---------------------------------------------------------------------------
// Phase kickoff automation
// ---------------------------------------------------------------------------

/**
 * Default folder templates for each phase.
 * Operators can override these via the admin panel (phaseKickoffConfigs.folderTemplate).
 */
export const DEFAULT_FOLDER_TEMPLATES: Record<string, string[]> = {
  phase_1_intake: ["Phase I/audio", "Phase I/Docs", "Phase I/Final_Merge", "Phase I/Results"],
  phase_2_synthesis: ["Phase II/Audio", "Phase II/Docs", "Phase II/Final_Merge", "Phase II/Results"],
  in_production: ["Phase III/Branches", "Phase III/Context", "Phase III/Final_Internal", "Phase III/Run_Logs"],
  delivered: ["Phase IV/Client_Facing", "Phase IV/Final_Delivery", "Phase IV/Internal_Audit", "Phase IV/Results"],
};

const DEFAULT_PLACEHOLDERS: Record<string, string[]> = {
  phase_1_intake: ["INTAKE_CHECKLIST.txt", "DOCUMENTS_REQUIRED.txt"],
  phase_2_synthesis: ["SYNTHESIS_NOTES.txt", "ANALYSIS_TEMPLATE.txt"],
  in_production: ["PRODUCTION_BRIEF.txt"],
  delivered: ["DELIVERY_RECEIPT.txt"],
};

export async function exportIntakeMarkdownToPhaseTwo(orderId: number, markdown: string): Promise<void> {
  const graphConfig = await getGraphRuntimeConfig();
  if (!graphConfig.enabled) {
    logger.info("sharepoint.intake_markdown.skipped", { orderId, reason: "Graph not configured" });
    return;
  }

  const orderRows = await db
    .select({ orderNumber: orders.orderNumber, userId: orders.userId })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!orderRows[0]) throw new Error("Order not found for intake export.");

  const order = orderRows[0];
  const customer = await getUserById(order.userId);
  const customerFolder = customer?.customerNumber ?? "RP-CUS-UNKNOWN0";
  const customerPublicId = customer?.publicId ?? customerFolder;
  const intakeFileName = buildOrderFileName({ customerPublicId, orderNumber: order.orderNumber, sourceName: "INTAKE_ANSWERS.md" });
  const { folderPath } = await resolveOrderStageFolder(orderId, "phase_2_synthesis", graphConfig, "document");
  const logInsert = await db.insert(sharepointSyncLog).values({
    orderId,
    operationType: "intake_markdown",
    status: "pending",
    sharepointPath: `${folderPath}/${intakeFileName}`,
    attempts: 1,
  });
  const logId = insertedId(logInsert);

  try {
    const folderId = await ensureFolder(folderPath);
    await uploadTextFile(folderId, intakeFileName, markdown, "text/markdown; charset=utf-8");
    await db.update(sharepointSyncLog).set({ status: "succeeded" }).where(eq(sharepointSyncLog.id, logId));
    await recordActivity({
      actorUserId: null,
      action: "sharepoint.intake_markdown_exported",
      entityType: "order",
      entityId: orderId,
      summary: `Intake answers exported to Phase II Docs for ${order.orderNumber}`,
    });
  } catch (error) {
    await db.update(sharepointSyncLog).set({ status: "failed", errorMessage: error instanceof Error ? error.message.slice(0, 800) : String(error).slice(0, 800) }).where(eq(sharepointSyncLog.id, logId));
    throw error;
  }
}

export async function queueFullOrderFolderProvisioning(orderId: number): Promise<void> {
  // Every order receives the full Phase I-IV hierarchy. The jobs are idempotent:
  // Graph folder creation first checks for an existing segment before creating it.
  const phases: OrderStatus[] = ["phase_1_intake", "phase_2_synthesis", "in_production", "delivered"];
  for (const phase of phases) {
    await db.insert(phaseJobs).values({
      orderId,
      phase,
      jobType: "create_folders",
      status: "pending",
      attempts: 0,
    });
  }
  logger.info("sharepoint.full_order_provisioning.queued", { orderId, phases: phases.length });
}

export async function runPhaseKickoff(
  orderId: number,
  phase: OrderStatus,
  options: { forceWebhook?: boolean } = {},
): Promise<void> {
  // Load the kickoff config for this phase.
  const configRows = await db
    .select()
    .from(phaseKickoffConfigs)
    .where(and(eq(phaseKickoffConfigs.phase, phase), eq(phaseKickoffConfigs.enabled, true)))
    .limit(1);

  const config = configRows[0] ?? null;
  if (!config && !options.forceWebhook) {
    logger.debug("sharepoint.kickoff.no_config", { orderId, phase });
    return;
  }

  // Auto-set order completion % if configured.
  if (config && config.completionPercent > 0) {
    await db
      .update(orders)
      .set({ completionPercent: config.completionPercent })
      .where(eq(orders.id, orderId));
    logger.info("sharepoint.kickoff.completion_set", { orderId, phase, completionPercent: config.completionPercent });
  }

  // The P101/P201 buttons are explicit webhook requeue controls. They must not
  // rerun ordinary phase automation such as folder provisioning or customer
  // notification, which may already have completed and can be constrained as
  // unique jobs on older self-hosted schemas. Normal status-driven kickoff
  // continues to queue the configured phase actions below.
  const jobs: { jobType: string }[] = [];
  if (options.forceWebhook) {
    jobs.push({ jobType: "notify_webhooks" });
  } else {
    if (config?.createFolders) jobs.push({ jobType: "create_folders" });
    if (config?.attachPlaceholders) jobs.push({ jobType: "attach_placeholders" });
    if (config?.notifyWebhooks) jobs.push({ jobType: "notify_webhooks" });
    if (config?.notifyCustomer) jobs.push({ jobType: "notify_customer" });
  }

  for (const job of jobs) {
    await db.insert(phaseJobs).values({
      orderId,
      phase,
      jobType: job.jobType,
      status: "pending",
      attempts: 0,
    });
  }

  logger.info("sharepoint.kickoff.queued", { orderId, phase, jobCount: jobs.length, forceWebhook: Boolean(options.forceWebhook) });
}

// ---------------------------------------------------------------------------
// Job processor (called by the scheduler)
// ---------------------------------------------------------------------------

export async function processPhaseJobs(): Promise<void> {
  const now = new Date();
  const pendingJobs = await db
    .select()
    .from(phaseJobs)
    .where(
      and(
        eq(phaseJobs.status, "pending"),
        lte(phaseJobs.runAfter, now),
        sql`${phaseJobs.attempts} < 5`
      )
    )
    .limit(20);

  for (const job of pendingJobs) {
    await processJob(job);
  }
}

async function processJob(job: {
  id: number;
  orderId: number;
  phase: string;
  jobType: string;
  attempts: number;
}): Promise<void> {
  // Mark as running.
  await db
    .update(phaseJobs)
    .set({ status: "running", attempts: job.attempts + 1 })
    .where(eq(phaseJobs.id, job.id));

  try {
    switch (job.jobType) {
      case "create_folders":
        await jobCreateFolders(job.orderId, job.phase);
        break;
      case "attach_placeholders":
        await jobAttachPlaceholders(job.orderId, job.phase);
        break;
      case "notify_webhooks":
        await jobNotifyWebhooks(job.orderId, job.phase);
        break;
      case "notify_customer":
        // Email notification is handled by the email service; just mark done.
        break;
      default:
        logger.warn("sharepoint.job.unknown_type", { jobType: job.jobType });
    }

    await db
      .update(phaseJobs)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(phaseJobs.id, job.id));

    logger.info("sharepoint.job.completed", {
      jobId: job.id,
      orderId: job.orderId,
      jobType: job.jobType,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const nextAttempt = job.attempts + 1;
    // Exponential back-off: 1 min, 5 min, 15 min, 1 hr, 4 hr.
    const backoffMinutes = [1, 5, 15, 60, 240][Math.min(nextAttempt - 1, 4)] ?? 240;
    const runAfter = new Date(Date.now() + backoffMinutes * 60_000);

    await db
      .update(phaseJobs)
      .set({
        status: nextAttempt >= 5 ? "failed" : "pending",
        lastError: errorMsg.slice(0, 500),
        runAfter,
      })
      .where(eq(phaseJobs.id, job.id));

    logger.warn("sharepoint.job.failed", {
      jobId: job.id,
      orderId: job.orderId,
      jobType: job.jobType,
      attempt: nextAttempt,
      error: errorMsg,
    });
  }
}

async function jobCreateFolders(orderId: number, phase: string): Promise<void> {
  const graphConfig = await getGraphRuntimeConfig();
  if (!graphConfig.enabled) {
    logger.debug("sharepoint.create_folders.skipped", { reason: "Graph not configured" });
    return;
  }

  const orderRows = await db
    .select({ orderNumber: orders.orderNumber, userId: orders.userId })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

  if (orderRows.length === 0) return;
  const orderNumber = orderRows[0]!.orderNumber;
  const userId = orderRows[0]!.userId;
  
  const customer = await getUserById(userId);
  
  let customerFolder = customer?.customerNumber;
  if (!customerFolder) {
    const rawName = customer ? displayNameOf(customer) : `user_${userId}`;
    customerFolder = rawName.replace(/["*:<>?/\\|#]/g, "_").substring(0, 128);
  }

  // Load the folder template from the config or fall back to defaults.
  const configRows = await db
    .select({ folderTemplate: phaseKickoffConfigs.folderTemplate })
    .from(phaseKickoffConfigs)
    .where(eq(phaseKickoffConfigs.phase, phase))
    .limit(1);

  const folderTemplate =
    (configRows[0]?.folderTemplate as string[] | null) ??
    DEFAULT_FOLDER_TEMPLATES[phase] ??
    [];

  const orderRoot = buildOrderRootFolderPath(graphConfig.rootFolderPath, customerFolder, orderNumber);
  const { folderPath: configuredStageFolder } = await resolveOrderStageFolder(orderId, phase, graphConfig);
  const folderPaths = new Set([...folderTemplate.map((subFolder) => `${orderRoot}/${subFolder}`), configuredStageFolder]);

  for (const folderPath of folderPaths) {
    await ensureFolder(folderPath);
    
    // Log to the sharepoint_sync_log table
    await db.insert(sharepointSyncLog).values({
      orderId,
      operationType: "create_folder",
      status: "success",
      sharepointPath: folderPath,
    });
    logger.debug("sharepoint.folder_created", { orderId, folderPath });
  }

  await recordActivity({
    actorUserId: null,
    action: "sharepoint.folders_created",
    entityType: "order",
    entityId: orderId,
    summary: `SharePoint folders created for order ${orderNumber} phase ${phase}`,
  });
}

async function jobAttachPlaceholders(orderId: number, phase: string): Promise<void> {
  const graphConfig = await getGraphRuntimeConfig();
  if (!graphConfig.enabled) {
    logger.debug("sharepoint.attach_placeholders.skipped", { reason: "Graph not configured" });
    return;
  }

  const orderRows = await db
    .select({ orderNumber: orders.orderNumber, userId: orders.userId })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

  if (orderRows.length === 0) return;
  const orderNumber = orderRows[0]!.orderNumber;
  const customer = await getUserById(orderRows[0]!.userId);
  const customerFolder = customer?.customerNumber ?? "RP-CUS-UNKNOWN0";
  const customerPublicId = customer?.publicId ?? customerFolder;

  const placeholders = DEFAULT_PLACEHOLDERS[phase] ?? [];
  const { folderPath } = await resolveOrderStageFolder(orderId, phase, graphConfig);

  let folderId: string;
  try {
    folderId = await ensureFolder(folderPath);
  } catch {
    // Folder may not exist yet if create_folders job hasn't run.
    folderId = await ensureFolder(buildOrderRootFolderPath(graphConfig.rootFolderPath, customerFolder, orderNumber));
  }

  for (const sourceFileName of placeholders) {
    const fileName = buildOrderFileName({ customerPublicId, orderNumber, sourceName: sourceFileName });
    const content = `ReadyPackets Portal — Placeholder\nOrder: ${orderNumber}\nPhase: ${phase}\nFile: ${fileName}\n\nThis file was automatically created as a placeholder.\nReplace with actual content when ready.\n`;
    const itemId = await uploadPlaceholder(folderId, fileName, content);

    // Record in the files table as a hidden placeholder.
    // storageKey encodes the SharePoint item ID so it can be resolved later.
    const { generateStorageKey } = await import("../security/crypto.js");
    const storageKey = generateStorageKey(`sp-${itemId}-${fileName}`);
    await db.insert(files).values({
      orderId,
      uploadedByUserId: 0, // system-created
      originalName: fileName,
      storageKey,
      detectedMime: "text/plain",
      extension: "txt",
      sizeBytes: Buffer.byteLength(content),
      sha256: "", // placeholder — no local file
      category: "deliverable",
      visibleToCustomer: false,
      isPlaceholder: true,
    });
  }

  logger.info("sharepoint.placeholders_attached", {
    orderId,
    phase,
    count: placeholders.length,
  });
}

// ---------------------------------------------------------------------------
// Webhook notifications
// ---------------------------------------------------------------------------

function normalizePhaseStartPayload(payload: unknown): Record<string, string> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Phase-start webhook payload must be a JSON object.");
  }
  const serialized = JSON.stringify(payload);
  if (!serialized || serialized === "null") {
    throw new Error("Phase-start webhook payload serialized to null.");
  }
  const normalized = JSON.parse(serialized) as unknown;
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new Error("Phase-start webhook payload normalization did not produce a JSON object.");
  }
  return normalized as Record<string, string>;
}

export async function jobNotifyWebhooks(orderId: number, phase: string): Promise<void> {
  const orderRows = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

  if (orderRows.length === 0) return;
  const order = orderRows[0]!;

  const customer = await getUserById(order.userId);
  const customerId = customer?.customerNumber ?? "RP-CUS-UNKNOWN0";

  const isP101 = phase === "phase_1_intake";
  const isP201 = phase === "phase_2_synthesis";
  if (!isP101 && !isP201) return;

  const phaseCode = isP101 ? "P101" : "P201";
  const minimalPhasePayload = {
    customer_id: customerId,
    order_id: order.orderNumber,
    run_mode: order.runMode ?? "production",
  };

  // P101 is the canonical metadata writer. Derive packet, tier, and manifest
  // from immutable purchased items before delivery so no downstream phase can
  // receive contradictory routing data. The receiving master state has no
  // order_scope_mode column; scope is inferred from these canonical fields.
  // P201 remains deliberately minimal and reads P101 state downstream.
  const payload = isP101
    ? backfillCanonicalP101Scope(order.id).then((scope) => buildCanonicalP101Payload({
        customerId,
        orderId: order.orderNumber,
        scope,
        canonVersion: order.canonVersion ?? "ReadyPackets_Production_v2.0",
        runMode: order.runMode ?? "production",
        clientName: customer ? displayNameOf(customer) : "",
        clientEmail: customer?.email ?? "",
        releaseStatus: order.releaseStatus ?? "",
      }))
    : Promise.resolve(minimalPhasePayload);
  const resolvedPayload = normalizePhaseStartPayload(await payload);

  const endpoints = await db
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.enabled, true));

  for (const endpoint of endpoints) {
    const events = endpoint.events as string[] | null;
    if (events && !events.includes("phase.start") && !events.includes(phaseCode) && !events.includes("*")) {
      continue;
    }

    const insert = await db.insert(webhookDeliveries).values({
      endpointId: endpoint.id,
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerName: customer ? displayNameOf(customer) : null,
      eventType: phaseCode,
      payload: resolvedPayload,
      // Do not make this eligible for the delivery scheduler until the JSON
      // payload has been read back from MySQL and verified as a real object.
      status: "preparing",
      attempts: 0,
    });
    const deliveryId = insertedId(insert);
    const [saved] = await db
      .select({ payload: webhookDeliveries.payload })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId))
      .limit(1);
    if (!saved || saved.payload === null || saved.payload === undefined || typeof saved.payload !== "object" || Array.isArray(saved.payload)) {
      await db
        .update(webhookDeliveries)
        .set({ status: "failed", lastError: "Phase-start webhook payload did not persist as a JSON object; delivery blocked before dispatch." })
        .where(eq(webhookDeliveries.id, deliveryId));
      throw new Error(`Phase-start webhook delivery ${deliveryId} payload did not persist as JSON.`);
    }
    await db.update(webhookDeliveries).set({ status: "pending" }).where(eq(webhookDeliveries.id, deliveryId));
  }
}

/**
 * Deliver pending webhook notifications (called by the scheduler).
 */
export async function deliverWebhooks(): Promise<void> {
  const now = new Date();
  const pending = await db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.status, "pending"),
        lte(webhookDeliveries.runAfter, now),
        sql`${webhookDeliveries.attempts} < 5`
      )
    )
    .limit(20);

  for (const delivery of pending) {
    await deliverWebhook(delivery);
  }
}

async function rebuildPhaseStartPayload(orderId: number, eventType: "P101" | "P201"): Promise<Record<string, string>> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new Error("Order no longer exists for this phase-start webhook delivery.");
  const customer = await getUserById(order.userId);
  const customerId = customer?.customerNumber ?? "RP-CUS-UNKNOWN0";
  const minimalPayload = {
    customer_id: customerId,
    order_id: order.orderNumber,
    run_mode: order.runMode ?? "production",
  };
  if (eventType === "P201") return minimalPayload;

  const scope = await backfillCanonicalP101Scope(order.id);
  return buildCanonicalP101Payload({
    customerId,
    orderId: order.orderNumber,
    scope,
    canonVersion: order.canonVersion ?? "ReadyPackets_Production_v2.0",
    runMode: order.runMode ?? "production",
    clientName: customer ? displayNameOf(customer) : "",
    clientEmail: customer?.email ?? "",
    releaseStatus: order.releaseStatus ?? "",
  });
}

async function deliverWebhook(delivery: {
  id: number;
  endpointId: number;
  orderId: number | null;
  eventType: string;
  payload: unknown;
  attempts: number;
}): Promise<void> {
  const endpointRows = await db
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.id, delivery.endpointId))
    .limit(1);

  if (endpointRows.length === 0) {
    await db
      .update(webhookDeliveries)
      .set({ status: "failed", lastError: "Endpoint not found" })
      .where(eq(webhookDeliveries.id, delivery.id));
    return;
  }

  const endpoint = endpointRows[0]!;
  const phaseStartEventType = delivery.eventType === "P101" || delivery.eventType === "P201" ? delivery.eventType : null;
  const isPhaseStart = phaseStartEventType !== null;
  if (delivery.payload === null || delivery.payload === undefined) {
    if (!phaseStartEventType || !delivery.orderId) {
      await db
        .update(webhookDeliveries)
        .set({ status: "failed", lastError: "Webhook payload is missing; delivery blocked before sending a literal null body." })
        .where(eq(webhookDeliveries.id, delivery.id));
      logger.error("webhook.delivery.payload_missing", { deliveryId: delivery.id, eventType: delivery.eventType, orderId: delivery.orderId });
      return;
    }
    try {
      delivery.payload = await rebuildPhaseStartPayload(delivery.orderId, phaseStartEventType);
      await db.update(webhookDeliveries).set({ payload: delivery.payload }).where(eq(webhookDeliveries.id, delivery.id));
      logger.warn("webhook.phase_start_payload_rebuilt", { deliveryId: delivery.id, eventType: delivery.eventType, orderId: delivery.orderId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(webhookDeliveries)
        .set({ status: "failed", lastError: `Webhook payload recovery failed: ${message}`.slice(0, 500) })
        .where(eq(webhookDeliveries.id, delivery.id));
      logger.error("webhook.phase_start_payload_rebuild_failed", { deliveryId: delivery.id, eventType: delivery.eventType, orderId: delivery.orderId, error: message });
      return;
    }
  }

  const secret = endpoint.secretEnc
    ? decryptField(endpoint.secretEnc, `webhook:${endpoint.id}`)
    : null;

  const body = JSON.stringify(delivery.payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-ReadyPackets-Event": isPhaseStart ? "phase.start" : delivery.eventType,
    "X-ReadyPackets-Delivery": String(delivery.id),
  };
  if (isPhaseStart) {
    headers["X-ReadyPackets-Phase"] = delivery.eventType;
    headers["X-ReadyPackets-Order"] = typeof delivery.payload === "object" && delivery.payload !== null && "order_id" in delivery.payload
      ? String((delivery.payload as { order_id?: unknown }).order_id ?? "")
      : "";
    headers["X-ReadyPackets-Timestamp"] = new Date().toISOString();
  }

  if (secret) {
    // HMAC-SHA256 signature for the receiver to verify.
    const { createHmac } = await import("node:crypto");
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    headers["X-ReadyPackets-Signature"] = `sha256=${sig}`;
  }

  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });

    const responseDetail = (await response.text().catch(() => "")).slice(0, 1000) || response.statusText || null;
    if (response.ok) {
      await db
        .update(webhookDeliveries)
        .set({
          status: "delivered",
          responseCode: response.status,
          responseDetail,
          attempts: delivery.attempts + 1,
          lastError: null,
          deliveredAt: new Date(),
        })
        .where(eq(webhookDeliveries.id, delivery.id));
    } else {
      const detail = responseDetail ? `HTTP ${response.status}: ${responseDetail}` : `HTTP ${response.status}`;
      const error = new Error(detail);
      (error as Error & { responseCode?: number; responseDetail?: string | null }).responseCode = response.status;
      (error as Error & { responseCode?: number; responseDetail?: string | null }).responseDetail = responseDetail;
      throw error;
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const responseCode = err && typeof err === "object" && "responseCode" in err ? Number((err as { responseCode?: unknown }).responseCode) || null : null;
    const responseDetail = err && typeof err === "object" && "responseDetail" in err ? String((err as { responseDetail?: unknown }).responseDetail ?? "").slice(0, 1000) || null : null;
    const nextAttempt = delivery.attempts + 1;
    const backoffMinutes = [1, 5, 15, 60, 240][Math.min(nextAttempt - 1, 4)] ?? 240;
    const runAfter = new Date(Date.now() + backoffMinutes * 60_000);

    await db
      .update(webhookDeliveries)
      .set({
        status: nextAttempt >= 5 ? "failed" : "pending",
        responseCode,
        responseDetail,
        attempts: nextAttempt,
        lastError: errorMsg.slice(0, 500),
        runAfter,
      })
      .where(eq(webhookDeliveries.id, delivery.id));
  }
}
