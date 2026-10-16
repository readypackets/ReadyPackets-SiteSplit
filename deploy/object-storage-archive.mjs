#!/usr/bin/env node
/**
 * ReadyPackets Portal — storage archive adapter
 *
 * Exports the opaque upload-object namespace to a portable, local archive tree,
 * or imports that archive tree into the configured storage backend. This keeps
 * full and scoped recovery compatible whether the application uses local disk
 * or an S3-compatible shared object store.
 *
 * This helper is intentionally invoked only by the root-owned recovery scripts.
 * It accepts no credentials as arguments: storage configuration comes from the
 * protected portal environment inherited by its caller.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const MAX_KEY_LENGTH = 80;
const STORAGE_KEY = /^[a-f0-9]{48}(?:\.[a-z0-9]{1,12})?$/;

function fail(message) {
  process.stderr.write(`[object-storage-archive] ERROR: ${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function usage() {
  fail("Usage: object-storage-archive.mjs export --destination DIRECTORY [--keys-file FILE] | import --source DIRECTORY");
}

function storageDriver() {
  const driver = (process.env.STORAGE_DRIVER ?? "local").trim().toLowerCase();
  if (driver !== "local" && driver !== "s3") fail("STORAGE_DRIVER must be local or s3.");
  return driver;
}

function localRoot() {
  const root = process.env.STORAGE_LOCAL_ROOT?.trim();
  if (!root || !path.isAbsolute(root)) fail("STORAGE_LOCAL_ROOT must be an absolute path.");
  return root;
}

function assertStorageKey(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_KEY_LENGTH || !STORAGE_KEY.test(value)) {
    fail("Encountered an invalid opaque storage key.");
  }
  return value;
}

function localPathFor(root, key) {
  assertStorageKey(key);
  return path.join(root, key.slice(0, 2), key.slice(2, 4), key);
}

function archivePathFor(root, key) {
  const candidate = localPathFor(root, key);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("Archive path escaped its destination.");
  return candidate;
}

function readArguments(argv) {
  const [action, ...rest] = argv;
  if (action !== "export" && action !== "import") usage();
  let destination = null;
  let source = null;
  let keysFile = null;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) usage();
    if (flag === "--destination") destination = value;
    else if (flag === "--source") source = value;
    else if (flag === "--keys-file") keysFile = value;
    else usage();
    index += 1;
  }
  if (action === "export" && (!destination || source)) usage();
  if (action === "import" && (!source || destination || keysFile)) usage();
  const root = action === "export" ? destination : source;
  if (!path.isAbsolute(root)) fail("Archive source and destination paths must be absolute.");
  if (keysFile && !path.isAbsolute(keysFile)) fail("The storage key list path must be absolute.");
  return { action, destination, source, keysFile };
}

async function ensureWritableEmptyDirectory(directory) {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function readKeyList(keysFile) {
  if (!keysFile) return null;
  const source = await (await import("node:fs/promises")).readFile(keysFile, "utf8");
  const keys = new Set();
  for (const raw of source.split(/\r?\n/)) {
    const value = raw.trim();
    if (!value) continue;
    keys.add(assertStorageKey(value));
  }
  return [...keys].sort();
}

function clientFromEnvironment() {
  const bucket = process.env.S3_BUCKET?.trim();
  const region = process.env.S3_REGION?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    fail("S3 storage archive requires S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY.");
  }
  const forcePathStyle = (process.env.S3_FORCE_PATH_STYLE ?? "false").trim().toLowerCase() === "true";
  const endpoint = process.env.S3_ENDPOINT?.trim() || undefined;
  return {
    bucket,
    client: new S3Client({
      region,
      endpoint,
      forcePathStyle,
      credentials: { accessKeyId, secretAccessKey },
    }),
  };
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function copyFileVerified(source, destination, expectedSha256 = null) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    createReadStream(source),
    new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        bytes += chunk.length;
        callback(null, chunk);
      },
    }),
    createWriteStream(destination, { flags: "w", mode: 0o600 }),
  );
  const sha256 = hash.digest("hex");
  if (expectedSha256 && sha256 !== expectedSha256) fail("Object checksum mismatch while creating the recovery archive.");
  return { bytes, sha256 };
}

async function collectArchiveObjects(root, relative = "") {
  const current = path.join(root, relative);
  const entries = await readdir(current, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const childRelative = path.join(relative, entry.name);
    const child = path.join(root, childRelative);
    const metadata = await lstat(child);
    if (metadata.isSymbolicLink()) fail("Storage archive contains a symbolic link.");
    if (metadata.isDirectory()) {
      found.push(...await collectArchiveObjects(root, childRelative));
      continue;
    }
    if (!metadata.isFile()) fail("Storage archive contains an unsupported entry.");
    const segments = childRelative.split(path.sep);
    if (segments.length !== 3 || segments[0].length !== 2 || segments[1].length !== 2) fail("Storage archive contains an invalid object layout.");
    const key = assertStorageKey(segments[2]);
    if (segments[0] !== key.slice(0, 2) || segments[1] !== key.slice(2, 4)) fail("Storage archive object fan-out does not match its key.");
    found.push({ key, filePath: child });
  }
  return found.sort((a, b) => a.key.localeCompare(b.key));
}

async function exportLocal(destination, keys) {
  const root = localRoot();
  const selected = keys ?? [];
  let objectKeys = selected;
  if (!keys) {
    if (!await pathExists(root)) return { count: 0, bytes: 0 };
    objectKeys = (await collectArchiveObjects(root)).map(({ key }) => key);
  }
  let count = 0;
  let bytes = 0;
  for (const key of objectKeys) {
    const source = localPathFor(root, key);
    const details = await stat(source).catch(() => null);
    if (!details?.isFile()) fail("Referenced upload object is missing from local storage.");
    const result = await copyFileVerified(source, archivePathFor(destination, key));
    count += 1;
    bytes += result.bytes;
  }
  return { count, bytes };
}

async function downloadS3Object(client, bucket, key, destination) {
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const expected = head.Metadata?.sha256;
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) fail("S3 object is missing its ReadyPackets SHA-256 metadata.");
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) fail("S3 object has no readable body.");
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    result.Body,
    new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        bytes += chunk.length;
        callback(null, chunk);
      },
    }),
    createWriteStream(destination, { flags: "w", mode: 0o600 }),
  );
  const sha256 = hash.digest("hex");
  if (sha256 !== expected) fail("S3 object checksum did not match ReadyPackets metadata.");
  if (head.ContentLength !== undefined && bytes !== head.ContentLength) fail("S3 object length did not match its metadata.");
  return { bytes, sha256 };
}

async function listS3Keys(client, bucket) {
  const keys = [];
  let continuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }));
    for (const item of page.Contents ?? []) {
      if (!item.Key) continue;
      keys.push(assertStorageKey(item.Key));
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return [...new Set(keys)].sort();
}

async function exportS3(destination, selectedKeys) {
  const { client, bucket } = clientFromEnvironment();
  const keys = selectedKeys ?? await listS3Keys(client, bucket);
  let count = 0;
  let bytes = 0;
  for (const key of keys) {
    const result = await downloadS3Object(client, bucket, key, archivePathFor(destination, key));
    count += 1;
    bytes += result.bytes;
  }
  return { count, bytes };
}

async function importLocal(source) {
  const root = localRoot();
  const objects = await collectArchiveObjects(source);
  await mkdir(root, { recursive: true, mode: 0o700 });
  let bytes = 0;
  for (const object of objects) {
    const result = await copyFileVerified(object.filePath, localPathFor(root, object.key));
    bytes += result.bytes;
  }
  return { count: objects.length, bytes };
}

async function importS3(source) {
  const { client, bucket } = clientFromEnvironment();
  const objects = await collectArchiveObjects(source);
  let bytes = 0;
  for (const object of objects) {
    const details = await stat(object.filePath);
    const sha256 = await hashFile(object.filePath);
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: object.key,
      Body: createReadStream(object.filePath),
      ContentLength: details.size,
      ContentType: "application/octet-stream",
      ServerSideEncryption: "AES256",
      Metadata: { sha256 },
    }));
    bytes += details.size;
  }
  return { count: objects.length, bytes };
}

async function main() {
  const args = readArguments(process.argv.slice(2));
  const driver = storageDriver();
  let result;
  if (args.action === "export") {
    await ensureWritableEmptyDirectory(args.destination);
    const selectedKeys = await readKeyList(args.keysFile);
    result = driver === "s3"
      ? await exportS3(args.destination, selectedKeys)
      : await exportLocal(args.destination, selectedKeys);
  } else {
    const sourceDetails = await stat(args.source).catch(() => null);
    if (!sourceDetails?.isDirectory()) fail("Storage archive source directory is unavailable.");
    result = driver === "s3" ? await importS3(args.source) : await importLocal(args.source);
  }
  process.stdout.write(`storage_driver=${driver}\nobject_count=${result.count}\nobject_bytes=${result.bytes}\n`);
}

main().catch((error) => {
  if (!process.exitCode) {
    process.stderr.write(`[object-storage-archive] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
});
