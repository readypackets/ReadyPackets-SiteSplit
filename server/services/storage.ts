/**
 * File storage and upload validation.
 *
 * Two properties matter for security. First, the declared content type is
 * ignored: the real type is derived from the file's magic bytes, so renaming a
 * script to `.pdf` does not smuggle it past the allowlist. Second, the object
 * key is random and unrelated to the user, order, or original name, so the
 * storage directory cannot be enumerated into meaningful data.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { env } from "../config/env.js";
import { generateStorageKey } from "../security/crypto.js";
import { logger } from "../observability/logger.js";

/**
 * Extension → accepted magic-byte types. Text-like formats have no signature
 * and are validated structurally instead.
 */
const ALLOWED_TYPES: Record<string, { mime: string[]; magicless?: boolean }> = {
  pdf: { mime: ["application/pdf"] },
  png: { mime: ["image/png"] },
  jpg: { mime: ["image/jpeg"] },
  jpeg: { mime: ["image/jpeg"] },
  webp: { mime: ["image/webp"] },
  gif: { mime: ["image/gif"] },
  svg: { mime: ["image/svg+xml"], magicless: true },
  txt: { mime: ["text/plain"], magicless: true },
  md: { mime: ["text/markdown", "text/plain"], magicless: true },
  csv: { mime: ["text/csv", "text/plain"], magicless: true },
  json: { mime: ["application/json", "text/plain"], magicless: true },
  doc: { mime: ["application/msword", "application/x-cfb"] },
  docx: {
    mime: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/zip",
    ],
  },
  xls: { mime: ["application/vnd.ms-excel", "application/x-cfb"] },
  xlsx: {
    mime: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/zip",
    ],
  },
  ppt: { mime: ["application/vnd.ms-powerpoint", "application/x-cfb"] },
  pptx: {
    mime: [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/zip",
    ],
  },
  zip: { mime: ["application/zip"] },
  mp3: { mime: ["audio/mpeg"] },
  aac: { mime: ["audio/aac"] },
  flac: { mime: ["audio/flac"] },
  aiff: { mime: ["audio/aiff"] },
  m4a: { mime: ["audio/x-m4a", "audio/mp4"] },
  wav: { mime: ["audio/wav", "audio/x-wav"] },
  webm: { mime: ["audio/webm", "video/webm"] },
  ogg: { mime: ["audio/ogg", "video/ogg", "application/ogg"] },
  opus: { mime: ["audio/ogg", "audio/ogg; codecs=opus"] },
  mp4: { mime: ["video/mp4"] },
};

/** Formats that must never be accepted regardless of configuration. */
const DENIED_EXTENSIONS = new Set([
  "exe",
  "dll",
  "so",
  "dylib",
  "bat",
  "cmd",
  "com",
  "cpl",
  "msi",
  "scr",
  "ps1",
  "sh",
  "bash",
  "zsh",
  "php",
  "phtml",
  "phar",
  "jsp",
  "asp",
  "aspx",
  "cgi",
  "pl",
  "py",
  "rb",
  "jar",
  "war",
  "html",
  "htm",
  "xhtml",
  "js",
  "mjs",
  "cjs",
  "vbs",
  "hta",
  "lnk",
  "reg",
]);

export interface ValidationResult {
  ok: boolean
  reason?: string;
  extension?: string;
  mime?: string;
}

function extensionOf(filename: string): string {
  const ext = path.extname(filename).replace(/^\./, "").toLowerCase();
  return ext;
}

/** True when a buffer contains only plausible text (no NUL, valid UTF-8). */
function looksLikeText(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  const decoded = buffer.subarray(0, 4096).toString("utf8");
  return !decoded.includes("\uFFFD");
}

export async function validateUpload(
  originalName: string,
  buffer: Buffer,
  options: { maxBytes?: number; allowedExtensions?: string[] } = {},
): Promise<ValidationResult> {
  const maxBytes = options.maxBytes ?? env.storage.maxUploadBytes;
  if (buffer.length === 0) return { ok: false, reason: "The file is empty." };
  if (buffer.length > maxBytes) {
    return {
      ok: false,
      reason: `The file exceeds the ${Math.floor(maxBytes / 1_048_576)} MB limit.`,
    };
  }

  // A double extension such as `report.pdf.exe` must be rejected outright.
  const segments = originalName.toLowerCase().split(".").slice(1);
  for (const segment of segments) {
    if (DENIED_EXTENSIONS.has(segment)) {
      return { ok: false, reason: "That file type is not permitted." };
    }
  }

  const extension = extensionOf(originalName);
  if (!extension) return { ok: false, reason: "The file must have an extension." };
  
  if (options.allowedExtensions && options.allowedExtensions.length > 0) {
    const extWithDot = `.${extension}`;
    if (!options.allowedExtensions.includes(extWithDot)) {
      return { ok: false, reason: `Files of type .${extension} are not permitted for this upload.` };
    }
  }

  const rule = ALLOWED_TYPES[extension];
  if (!rule) return { ok: false, reason: `Files of type .${extension} are not permitted by the system.` };

  const detected = await fileTypeFromBuffer(buffer);

  if (!detected) {
    if (rule.magicless && looksLikeText(buffer)) {
      // SVG can carry script; it is stored but always served as an attachment.
      return { ok: true, extension, mime: rule.mime[0] ?? "application/octet-stream" };
    }
    return {
      ok: false,
      reason: "The file contents do not match a recognised format for this extension.",
    };
  }

  if (!rule.mime.includes(detected.mime)) {
    return {
      ok: false,
      reason: `The file contents (${detected.mime}) do not match the .${extension} extension.`,
    };
  }

  return { ok: true, extension, mime: detected.mime };
}

export interface StoredObject {
  storageKey: string;
  sizeBytes: number;
  sha256: string;
}

function localPathFor(storageKey: string): string {
  // Two-level fan-out keeps directory sizes manageable on ext4.
  const prefixA = storageKey.slice(0, 2);
  const prefixB = storageKey.slice(2, 4);
  return path.join(env.storage.localRoot, prefixA, prefixB, storageKey);
}

export async function putObject(buffer: Buffer, extension: string): Promise<StoredObject> {
  const storageKey = generateStorageKey(extension);
  const sha256 = createHash("sha256").update(buffer).digest("hex");

  if (env.storage.driver === "local") {
    const target = localPathFor(storageKey);
    await mkdir(path.dirname(target), { recursive: true });
    // 0o600: readable only by the service account.
    await writeFile(target, buffer, { mode: 0o600 });
  } else {
    throw new Error(
      "S3 storage is selected but the S3 driver is not configured in this deployment.",
    );
  }

  return { storageKey, sizeBytes: buffer.length, sha256 };
}

export async function getObjectBuffer(storageKey: string): Promise<Buffer> {
  if (env.storage.driver !== "local") {
    throw new Error("S3 storage driver is not configured.");
  }
  return readFile(localPathFor(storageKey));
}

export function getObjectStream(storageKey: string, range?: { start: number; end: number }) {
  if (env.storage.driver !== "local") {
    throw new Error("S3 storage driver is not configured.");
  }
  return range ? createReadStream(localPathFor(storageKey), range) : createReadStream(localPathFor(storageKey));
}

export async function objectExists(storageKey: string): Promise<boolean> {
  try {
    const info = await stat(localPathFor(storageKey));
    return info.isFile();
  } catch {
    return false;
  }
}

export async function deleteObject(storageKey: string): Promise<void> {
  try {
    await rm(localPathFor(storageKey), { force: true });
  } catch (error) {
    logger.warn("Failed to delete stored object", { error, storageKey });
  }
}

export async function ensureStorageRoot(): Promise<void> {
  if (env.storage.driver !== "local") return;
  await mkdir(env.storage.localRoot, { recursive: true, mode: 0o700 });
}

export function allowedExtensions(): string[] {
  return Object.keys(ALLOWED_TYPES).sort();
}

/**
 * A safe value for `Content-Disposition`. Non-ASCII characters are stripped from
 * the plain parameter and preserved in the RFC 5987 form.
 */
export function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
