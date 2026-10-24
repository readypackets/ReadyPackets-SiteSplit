#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = path.join(root, "client");
const portal = path.join(client, "dist-portal");
const workerSource = path.join(client, "src", "pwa", "portal-service-worker.ts");
const portalOnly = process.argv.includes("--portal-only");
const leakedArtifacts = ["manifest.webmanifest", "offline.html", "offline.css", "portal-service-worker.js", "portal-service-worker.mjs"];
const allowedPrecache = /^(?:assets\/[A-Za-z0-9._-]+|brand\/[A-Za-z0-9._-]+|fonts\/[A-Za-z0-9._-]+|favicon\.ico|offline\.(?:html|css))$/;

function fail(message) {
  process.stderr.write(`PWA build verification failed: ${message}\n`);
  process.exit(1);
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function requireFile(target) {
  if (!(await exists(target))) fail(`missing required artifact ${path.relative(root, target)}`);
}

await requireFile(path.join(portal, "manifest.webmanifest"));
await requireFile(path.join(portal, "portal-service-worker.js"));
await requireFile(path.join(portal, "offline.html"));
await requireFile(path.join(portal, "offline.css"));

let manifest;
try {
  manifest = JSON.parse(await readFile(path.join(portal, "manifest.webmanifest"), "utf8"));
} catch {
  fail("Portal manifest is not valid JSON");
}
if (manifest.start_url !== "/login" || manifest.scope !== "/" || manifest.display !== "standalone") {
  fail("Portal manifest has an unexpected install scope or start URL");
}
for (const expected of [
  ["/brand/readypackets-approved-icon-light-192.png", "192x192", "any"],
  ["/brand/readypackets-approved-icon-light-512.png", "512x512", "any"],
  ["/brand/readypackets-approved-icon-maskable-512.png", "512x512", "maskable"],
]) {
  const [src, sizes, purpose] = expected;
  const icon = manifest.icons?.find((entry) => entry.src === src && entry.sizes === sizes && entry.purpose === purpose);
  if (!icon) fail(`Portal manifest is missing required ${sizes} ${purpose} icon`);
  await requireFile(path.join(portal, src.replace(/^\//, "")));
}

const worker = await readFile(path.join(portal, "portal-service-worker.js"), "utf8");
const source = await readFile(workerSource, "utf8");
if (!source.includes("precacheAndRoute") || !source.includes("new NetworkOnly()") || source.includes("BackgroundSyncPlugin")) {
  fail("Portal worker does not preserve the static-only, network-only caching policy");
}
const precacheUrls = [...worker.matchAll(/"url":"([^"]+)"/g)].map((match) => match[1]);
if (!precacheUrls.length) fail("Portal worker has no injected precache manifest");
for (const url of precacheUrls) {
  if (!allowedPrecache.test(url)) fail(`worker precache entry is outside the static allowlist: ${url}`);
  await requireFile(path.join(portal, url));
}

if (!portalOnly) {
  for (const outDir of ["dist", "dist-public"]) {
    for (const artifact of leakedArtifacts) {
      if (await exists(path.join(client, outDir, artifact))) {
        fail(`${outDir} must not contain Portal-only ${artifact}`);
      }
    }
  }
}

process.stdout.write("PASS: Portal PWA build artifacts are scoped, complete, and static-cache-only.\n");
