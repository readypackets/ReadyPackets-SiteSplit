#!/usr/bin/env node
/**
 * ReadyPackets root certificate-control socket daemon.
 *
 * The portal service receives no sudo capability. It can query certificate
 * metadata, install a validated Cloudflare Origin CA certificate, or switch
 * back to a present Let's Encrypt certificate through this local, group-gated
 * Unix socket. Private keys travel only in the local socket payload, never an
 * argv vector, settings record, browser response, audit event, or log output.
 */
import net from "node:net";
import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const SOCKET_DIRECTORY = "/run/readypackets";
const SOCKET_PATH = `${SOCKET_DIRECTORY}/certificate-control.sock`;
const TLS_DIRECTORY = "/etc/readypackets/tls";
const CLOUDFLARE_DIRECTORY = `${TLS_DIRECTORY}/cloudflare-origin`;
const TLS_INCLUDE = `${TLS_DIRECTORY}/nginx-tls.conf`;
const NGINX = "/usr/sbin/nginx";
const SYSTEMCTL = "/usr/bin/systemctl";
const OPENSSL = "/usr/bin/openssl";
const CERTBOT = "/usr/bin/certbot";
const CURL = "/usr/bin/curl";
const APP_ENV = "/etc/readypackets/portal.env";
const NGINX_SITE = "/etc/nginx/sites-available/readypackets";
const NGINX_TEMPLATE = "/opt/readypackets/deploy/nginx.conf";
const READY_PACKETS_SERVICE = "readypackets";
const MAX_MESSAGE_BYTES = 96 * 1024;
const MAX_PEM_BYTES = 32 * 1024;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const MAX_PORTAL_ALIASES = 5;
const RESERVED_PUBLIC_WEBSITE_HOSTNAMES = new Set(["readypackets.com", "www.readypackets.com"]);

if (process.getuid?.() !== 0) throw new Error("certificate-control daemon must run as root");

function deny(message) { const error = new Error(message); error.code = "INVALID_REQUEST"; throw error; }
function isPem(value, marker) { return typeof value === "string" && value.length >= 80 && Buffer.byteLength(value, "utf8") <= MAX_PEM_BYTES && value.includes(marker) && value.endsWith("\n"); }
function run(command, args, stdin = "", timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" } });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`${command} timed out`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); if (Buffer.byteLength(stdout) > 128 * 1024) child.kill("SIGTERM"); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); if (Buffer.byteLength(stderr) > 128 * 1024) child.kill("SIGTERM"); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} exited with ${code}`)); });
    child.stdin.end(stdin);
  });
}
function safeRead(path) { try { return readFileSync(path, "utf8"); } catch { return ""; } }
function writeAtomic(path, contents, mode) {
  const existing = existsSync(path) ? statSync(path) : null;
  const staged = `${path}.new-${process.pid}`;
  writeFileSync(staged, contents, { encoding: "utf8", mode });
  chmodSync(staged, mode);
  if (existing) chownSync(staged, existing.uid, existing.gid);
  renameSync(staged, path);
}
function includeFor(provider, certificate, key) {
  return `# Managed by ReadyPackets certificate control. Do not edit while the portal is running.\n# Provider: ${provider}\nssl_certificate ${certificate};\nssl_certificate_key ${key};\n`;
}
function parseCertificate(text) {
  const subject = (text.match(/^subject=(.*)$/m)?.[1] ?? "").trim();
  const issuer = (text.match(/^issuer=(.*)$/m)?.[1] ?? "").trim();
  const notBefore = (text.match(/^notBefore=(.*)$/m)?.[1] ?? "").trim();
  const notAfter = (text.match(/^notAfter=(.*)$/m)?.[1] ?? "").trim();
  const fingerprint = (text.match(/^sha256 Fingerprint=(.*)$/mi)?.[1] ?? "").trim();
  const san = (text.match(/X509v3 Subject Alternative Name:\s*\n\s*(.*)$/mi)?.[1] ?? "").trim();
  return { subject, issuer, notBefore, notAfter, fingerprint, san };
}
async function certificateMetadata(provider, certificatePath, rootPresent) {
  if (!existsSync(certificatePath)) return { provider, configured: false, rootPresent, certificatePath: null, subject: null, issuer: null, notBefore: null, notAfter: null, fingerprint: null, san: null };
  const output = await run(OPENSSL, ["x509", "-in", certificatePath, "-noout", "-subject", "-issuer", "-dates", "-fingerprint", "-sha256", "-ext", "subjectAltName"]);
  return { provider, configured: true, rootPresent, certificatePath, ...parseCertificate(output) };
}
function currentProvider() {
  const include = safeRead(TLS_INCLUDE);
  if (include.includes("/cloudflare-origin/certificate.pem")) return "cloudflare_origin";
  if (include.includes("/etc/letsencrypt/live/")) return "letsencrypt";
  return "unknown";
}
async function status() {
  const provider = currentProvider();
  if (provider === "cloudflare_origin") return certificateMetadata(provider, `${CLOUDFLARE_DIRECTORY}/certificate.pem`, existsSync(`${CLOUDFLARE_DIRECTORY}/cloudflare-origin-ca-root.pem`));
  const include = safeRead(TLS_INCLUDE);
  const match = include.match(/^ssl_certificate\s+([^;]+);/m);
  return certificateMetadata(provider, match?.[1] ?? "", false);
}
async function validateCloudflare({ hostnames, certificate, privateKey }) {
  if (!Array.isArray(hostnames) || hostnames.length < 1 || hostnames.some((hostname) => !HOSTNAME.test(hostname))) deny("Invalid certificate hostname.");
  const dir = mkdtempSync(join(tmpdir(), "rp-cert-"));
  const cert = join(dir, "certificate.pem"); const key = join(dir, "private-key.pem");
  try {
    writeFileSync(cert, certificate, { mode: 0o600 }); writeFileSync(key, privateKey, { mode: 0o600 });
    await run(OPENSSL, ["x509", "-in", cert, "-noout"]);
    await run(OPENSSL, ["x509", "-in", cert, "-noout", "-checkend", "0"]);
    await run(OPENSSL, ["pkey", "-in", key, "-noout"]);
    for (const hostname of hostnames) {
      const hostnameCheck = await run(OPENSSL, ["x509", "-in", cert, "-noout", "-checkhost", hostname]);
      if (!hostnameCheck.includes("does match certificate")) deny("The supplied certificate does not cover every configured portal hostname.");
    }
    const certPub = (await run("/bin/sh", ["-c", `${OPENSSL} x509 -in "$1" -pubkey -noout | ${OPENSSL} pkey -pubin -outform DER | ${OPENSSL} dgst -sha256`, "--", cert])).trim();
    const keyPub = (await run("/bin/sh", ["-c", `${OPENSSL} pkey -in "$1" -pubout -outform DER | ${OPENSSL} dgst -sha256`, "--", key])).trim();
    if (certPub !== keyPub) deny("The supplied certificate and private key do not match.");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function backupTlsMaterial() {
  const backup = `/var/backups/readypackets/tls-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const source of [TLS_INCLUDE, `${CLOUDFLARE_DIRECTORY}/certificate.pem`, `${CLOUDFLARE_DIRECTORY}/private-key.pem`, `${CLOUDFLARE_DIRECTORY}/cloudflare-origin-ca-root.pem`]) {
    if (existsSync(source)) copyFileSync(source, join(backup, source.split("/").pop()));
  }
  return backup;
}
async function reloadNginxWithRollback(previousInclude, backup) {
  try { await run(NGINX, ["-t"]); await run(SYSTEMCTL, ["reload", "nginx"]); }
  catch (error) {
    writeAtomic(TLS_INCLUDE, previousInclude, 0o640);
    if (existsSync(join(backup, "certificate.pem"))) copyFileSync(join(backup, "certificate.pem"), `${CLOUDFLARE_DIRECTORY}/certificate.pem`);
    if (existsSync(join(backup, "private-key.pem"))) { copyFileSync(join(backup, "private-key.pem"), `${CLOUDFLARE_DIRECTORY}/private-key.pem`); chmodSync(`${CLOUDFLARE_DIRECTORY}/private-key.pem`, 0o600); }
    if (existsSync(join(backup, "cloudflare-origin-ca-root.pem"))) copyFileSync(join(backup, "cloudflare-origin-ca-root.pem"), `${CLOUDFLARE_DIRECTORY}/cloudflare-origin-ca-root.pem`);
    else if (existsSync(`${CLOUDFLARE_DIRECTORY}/cloudflare-origin-ca-root.pem`)) unlinkSync(`${CLOUDFLARE_DIRECTORY}/cloudflare-origin-ca-root.pem`);
    await run(NGINX, ["-t"]).catch(() => undefined); await run(SYSTEMCTL, ["reload", "nginx"]).catch(() => undefined);
    throw error;
  }
}
async function installCloudflare(input) {
  const state = portalAliasState();
  const hostnames = certificateHostnames(state);
  if (input.hostname.toLowerCase() !== state.canonical) deny("The Cloudflare Origin certificate must be installed for the canonical portal hostname.");
  await validateCloudflare({ ...input, hostnames });
  mkdirSync(CLOUDFLARE_DIRECTORY, { recursive: true, mode: 0o700 });
  const backup = backupTlsMaterial(); const previousInclude = safeRead(TLS_INCLUDE);
  writeAtomic(`${CLOUDFLARE_DIRECTORY}/certificate.pem`, input.certificate, 0o644);
  writeAtomic(`${CLOUDFLARE_DIRECTORY}/private-key.pem`, input.privateKey, 0o600);
  if (input.caRoot) writeAtomic(`${CLOUDFLARE_DIRECTORY}/cloudflare-origin-ca-root.pem`, input.caRoot, 0o644);
  else if (existsSync(`${CLOUDFLARE_DIRECTORY}/cloudflare-origin-ca-root.pem`)) unlinkSync(`${CLOUDFLARE_DIRECTORY}/cloudflare-origin-ca-root.pem`);
  writeAtomic(TLS_INCLUDE, includeFor("cloudflare_origin", `${CLOUDFLARE_DIRECTORY}/certificate.pem`, `${CLOUDFLARE_DIRECTORY}/private-key.pem`), 0o640);
  await reloadNginxWithRollback(previousInclude, backup);
  return { ...(await status()), backup };
}
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function validEmail(value) { return typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function envValue(contents, key) { return contents.match(new RegExp(`^${escapeRegExp(key)}=(.*)$`, "m"))?.[1]?.trim() ?? ""; }
function setEnvValue(contents, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${escapeRegExp(key)}=.*$`, "m");
  return pattern.test(contents) ? contents.replace(pattern, line) : `${contents.replace(/\s*$/, "")}\n${line}\n`;
}
function normaliseHostname(value, label = "hostname") {
  if (typeof value !== "string") deny(`Invalid ${label}.`);
  const hostname = value.trim().toLowerCase();
  if (!HOSTNAME.test(hostname)) deny(`Invalid ${label}.`);
  return hostname;
}
function currentHostname() {
  const appUrl = envValue(safeRead(APP_ENV), "APP_URL");
  try { return normaliseHostname(new URL(appUrl).hostname, "APP_URL hostname"); } catch { return ""; }
}
function publicSiteHostname() {
  const publicUrl = envValue(safeRead(APP_ENV), "PUBLIC_SITE_URL");
  if (!publicUrl) return "";
  try { return normaliseHostname(new URL(publicUrl).hostname, "PUBLIC_SITE_URL hostname"); }
  catch { deny("PUBLIC_SITE_URL is invalid; repair the protected environment before changing portal aliases."); }
}
function nginxConfiguredHostnames() {
  return [...safeRead(NGINX_SITE).matchAll(/^\s*server_name\s+([^;]+);/gm)]
    .flatMap((match) => match[1].trim().split(/\s+/))
    .map((hostname) => hostname.toLowerCase())
    .filter((hostname) => HOSTNAME.test(hostname));
}
function deployedPublicSiteHostname() {
  const candidate = publicSiteHostname();
  if (!candidate) return "";
  const configuredNames = nginxConfiguredHostnames();
  return configuredNames.includes(candidate) ? candidate : "";
}
function configuredPortalHostnames() {
  const canonical = currentHostname();
  if (!canonical) deny("The current APP_URL is invalid; use the server deployment procedure to repair it.");
  const aliases = envValue(safeRead(APP_ENV), "PORTAL_ALIASES")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const seen = new Set([canonical]);
  for (const alias of aliases) {
    if (!HOSTNAME.test(alias) || seen.has(alias)) deny("PORTAL_ALIASES contains an invalid or duplicate hostname; use the server deployment procedure to repair it.");
    seen.add(alias);
  }
  return [...seen];
}
function portalAliasState() {
  const hostnames = configuredPortalHostnames();
  const publicHostname = deployedPublicSiteHostname();
  return { canonical: hostnames[0], aliases: hostnames.slice(1), publicHostname: publicHostname === hostnames[0] ? "" : publicHostname };
}
function certificateHostnames({ canonical, aliases, publicHostname }) {
  return [canonical, ...aliases, ...(publicHostname ? [publicHostname] : [])];
}
function addablePortalAlias(input) {
  const alias = normaliseHostname(input, "portal alias hostname");
  const { canonical, aliases, publicHostname } = portalAliasState();
  const configuredPublicHostname = publicSiteHostname();
  if (RESERVED_PUBLIC_WEBSITE_HOSTNAMES.has(alias)) deny(`${alias} is reserved for the independently hosted ReadyPackets website.`);
  if (alias === canonical) deny("A portal alias must differ from the canonical portal hostname.");
  if (configuredPublicHostname && alias === configuredPublicHostname) deny("A portal alias must differ from the configured public website hostname.");
  if (aliases.includes(alias)) deny("That portal alias is already configured.");
  if (nginxConfiguredHostnames().includes(alias)) deny("That hostname is already reserved by an active Nginx virtual host.");
  if (aliases.length >= MAX_PORTAL_ALIASES) deny(`At most ${MAX_PORTAL_ALIASES} portal aliases are permitted.`);
  return { canonical, aliases: [...aliases, alias], publicHostname, alias };
}
function renderNginxPortalAliases(contents, { canonical, aliases, publicHostname, httpAliases = aliases }) {
  const template = safeRead(NGINX_TEMPLATE);
  if (!template || !template.includes("__RP_HTTP_SERVER_NAMES__") || !template.includes("__RP_APP_SERVER_NAMES__")) {
    deny("The reviewed ReadyPackets nginx template is unavailable; apply the approved platform update before changing portal aliases.");
  }
  const routedHostnames = [canonical, ...httpAliases, ...(publicHostname ? [publicHostname] : [])];
  const appHostnames = [canonical, ...(publicHostname ? [publicHostname] : [])];
  const regexEscape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const replacements = [
    ["__RP_HTTP_SERVER_NAMES__", routedHostnames.join(" ")],
    ["__RP_PORTAL_ALIAS_SERVER_NAMES__", aliases.length ? aliases.join(" ") : '""'],
    ["__RP_APP_SERVER_NAMES__", appHostnames.join(" ")],
    ["__RP_APP_HOST_REGEX__", appHostnames.map(regexEscape).join("|")],
    ["__RP_CANONICAL_DOMAIN__", canonical],
    ["# __RP_MORE_CLEAR_HEADERS__", contents.includes("more_clear_headers 'Server';") ? "more_clear_headers 'Server';" : "# headers-more module not installed; \"Server: nginx\" is still sent."],
  ];
  let next = template;
  for (const [placeholder, value] of replacements) next = next.split(placeholder).join(value);
  if (/__RP_/.test(next)) {
    deny("The active nginx configuration is not a supported ReadyPackets multi-host configuration.");
  }
  return next;
}
function backupPortalAliasMaterial() {
  const backup = `/var/backups/readypackets/portal-alias-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const source of [APP_ENV, NGINX_SITE, TLS_INCLUDE, `${CLOUDFLARE_DIRECTORY}/certificate.pem`, `${CLOUDFLARE_DIRECTORY}/private-key.pem`, `${CLOUDFLARE_DIRECTORY}/cloudflare-origin-ca-root.pem`]) {
    if (existsSync(source)) copyFileSync(source, join(backup, source.split("/").pop()));
  }
  return backup;
}
function restorePortalAliasMaterial(backup) {
  const restoreFile = (name, target, mode) => {
    const source = join(backup, name);
    if (existsSync(source)) writeAtomic(target, readFileSync(source, "utf8"), mode);
    else if (existsSync(target)) unlinkSync(target);
  };
  restoreFile("portal.env", APP_ENV, 0o640);
  restoreFile("readypackets", NGINX_SITE, 0o640);
  restoreFile("nginx-tls.conf", TLS_INCLUDE, 0o640);
  restoreFile("certificate.pem", `${CLOUDFLARE_DIRECTORY}/certificate.pem`, 0o644);
  restoreFile("private-key.pem", `${CLOUDFLARE_DIRECTORY}/private-key.pem`, 0o600);
  restoreFile("cloudflare-origin-ca-root.pem", `${CLOUDFLARE_DIRECTORY}/cloudflare-origin-ca-root.pem`, 0o644);
}
async function verifyCanonicalHealth(hostname) {
  await run(CURL, ["--noproxy", "*", "-fsS", "--max-time", "20", "--resolve", `${hostname}:443:127.0.0.1`, "-k", `https://${hostname}/api/health`]);
}
function letsEncryptPaths() {
  const include = safeRead(TLS_INCLUDE);
  const certificate = include.match(/^ssl_certificate\s+([^;]+);/m)?.[1] ?? "";
  const privateKey = include.match(/^ssl_certificate_key\s+([^;]+);/m)?.[1] ?? "";
  const match = certificate.match(/^\/etc\/letsencrypt\/live\/([A-Za-z0-9._-]+)\/fullchain\.pem$/);
  if (!match || !privateKey.startsWith(`/etc/letsencrypt/live/${match[1]}/`)) deny("The active Let's Encrypt certificate paths are not supported for alias expansion.");
  return { certificate, privateKey, certName: match[1] };
}
function rewriteNginxHostname(contents, hostname, publicHostname) {
  return renderNginxPortalAliases(contents, { canonical: normaliseHostname(hostname), aliases: [], publicHostname });
}
function certNameFor(hostname) { return `readypackets-${hostname.replace(/[^a-z0-9]/gi, "-").slice(0, 48)}`; }
function backupDomainMaterial() {
  const backup = `/var/backups/readypackets/domain-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const source of [APP_ENV, NGINX_SITE, TLS_INCLUDE]) if (existsSync(source)) copyFileSync(source, join(backup, source.split("/").pop()));
  return backup;
}
async function updateDomainLetsEncrypt(input) {
  if (!HOSTNAME.test(input.hostname) || !validEmail(input.email)) deny("Invalid hostname or certificate contact email.");
  const oldHostname = currentHostname();
  if (!oldHostname) deny("The current APP_URL is invalid; use the server deployment procedure to repair it.");
  const currentState = portalAliasState();
  if (currentState.aliases.length > 0) deny("Canonical-domain changes are blocked while PORTAL_ALIASES is configured. Reconfigure aliases through the reviewed server deployment procedure so DNS, Nginx, and certificate SANs remain aligned.");
  if (oldHostname === input.hostname) deny("The requested hostname is already the portal domain.");
  if (!existsSync(CERTBOT) || !existsSync(APP_ENV) || !existsSync(NGINX_SITE)) deny("The protected domain-control prerequisites are unavailable on this server.");
  const backup = backupDomainMaterial();
  const previousEnv = safeRead(APP_ENV); const previousNginx = safeRead(NGINX_SITE); const previousInclude = safeRead(TLS_INCLUDE);
  try {
    writeAtomic(NGINX_SITE, rewriteNginxHostname(previousNginx, input.hostname, currentState.publicHostname), 0o640);
    await run(NGINX, ["-t"]); await run(SYSTEMCTL, ["reload", "nginx"]);
    const certName = certNameFor(input.hostname);
    const certificateHostnames = [input.hostname, ...(currentState.publicHostname ? [currentState.publicHostname] : [])];
    await run(CERTBOT, ["certonly", "--webroot", "-w", "/var/www/html", "--non-interactive", "--agree-tos", "--email", input.email, "--cert-name", certName, "--keep-until-expiring", ...certificateHostnames.flatMap((hostname) => ["-d", hostname])], "", 150_000);
    const certificate = `/etc/letsencrypt/live/${certName}/fullchain.pem`; const key = `/etc/letsencrypt/live/${certName}/privkey.pem`;
    if (!existsSync(certificate) || !existsSync(key)) deny("Let's Encrypt did not create the expected certificate files.");
    for (const hostname of certificateHostnames) {
      const hostnameCheck = await run(OPENSSL, ["x509", "-in", certificate, "-noout", "-checkhost", hostname]);
      if (!hostnameCheck.includes("does match certificate")) deny("The new Let's Encrypt certificate does not match every configured public hostname.");
    }
    writeAtomic(TLS_INCLUDE, includeFor("letsencrypt", certificate, key), 0o640);
    let nextEnv = setEnvValue(previousEnv, "APP_URL", `https://${input.hostname}`);
    nextEnv = setEnvValue(nextEnv, "ALLOWED_ORIGINS", certificateHostnames.map((hostname) => `https://${hostname}`).join(","));
    writeAtomic(APP_ENV, nextEnv, 0o640);
    await run(NGINX, ["-t"]); await run(SYSTEMCTL, ["reload", "nginx"]); await run(SYSTEMCTL, ["restart", READY_PACKETS_SERVICE]);
    await run(CURL, ["-fsS", "--max-time", "20", "--resolve", `${input.hostname}:443:127.0.0.1`, "-k", `https://${input.hostname}/api/health`]);
    return { ...(await status()), previousHostname: oldHostname, hostname: input.hostname, backup };
  } catch (error) {
    writeAtomic(APP_ENV, previousEnv, 0o640); writeAtomic(NGINX_SITE, previousNginx, 0o640); writeAtomic(TLS_INCLUDE, previousInclude, 0o640);
    await run(NGINX, ["-t"]).catch(() => undefined); await run(SYSTEMCTL, ["reload", "nginx"]).catch(() => undefined); await run(SYSTEMCTL, ["restart", READY_PACKETS_SERVICE]).catch(() => undefined);
    throw error;
  }
}
async function domainStatus() {
  const appUrl = envValue(safeRead(APP_ENV), "APP_URL");
  const aliases = configuredPortalHostnames().slice(1);
  return { appUrl, hostname: currentHostname() || null, aliases, aliasesRemaining: MAX_PORTAL_ALIASES - aliases.length, certificate: await status() };
}
async function activateLetsEncrypt(input) {
  const state = portalAliasState();
  const hostnames = certificateHostnames(state);
  if (input.hostname.toLowerCase() !== state.canonical) deny("The Let's Encrypt certificate must be activated for the canonical portal hostname.");
  const certificate = `/etc/letsencrypt/live/${input.hostname}/fullchain.pem`;
  const key = `/etc/letsencrypt/live/${input.hostname}/privkey.pem`;
  if (!HOSTNAME.test(input.hostname) || !existsSync(certificate) || !existsSync(key)) deny("A valid Let's Encrypt certificate was not found for this hostname.");
  for (const hostname of hostnames) {
    const hostnameCheck = await run(OPENSSL, ["x509", "-in", certificate, "-noout", "-checkhost", hostname]);
    if (!hostnameCheck.includes("does match certificate")) deny("The existing Let's Encrypt certificate does not cover every configured portal hostname.");
  }
  const backup = backupTlsMaterial(); const previousInclude = safeRead(TLS_INCLUDE);
  writeAtomic(TLS_INCLUDE, includeFor("letsencrypt", certificate, key), 0o640);
  await reloadNginxWithRollback(previousInclude, backup);
  return { ...(await status()), backup };
}
async function verifyAliasRedirect(alias, canonical) {
  const expected = `https://${canonical}/api/health`;
  const headers = await run(CURL, ["--noproxy", "*", "-ksS", "--max-time", "20", "--resolve", `${alias}:443:127.0.0.1`, "-o", "/dev/null", "-D", "-", `https://${alias}/api/health`]);
  const hasRedirect = new RegExp(`^location:\\s*${escapeRegExp(expected)}\\s*$`, "im").test(headers);
  if (!/\s308\s/.test(headers) || !hasRedirect) deny("The updated nginx configuration did not return the required canonical portal-alias redirect.");
}
function writePortalAliases(previousEnv, aliases) {
  return setEnvValue(previousEnv, "PORTAL_ALIASES", aliases.join(","));
}
async function addPortalAliasCloudflare(input) {
  if (currentProvider() !== "cloudflare_origin") deny("Cloudflare portal aliases can be added only while a Cloudflare Origin CA certificate is active.");
  const proposed = addablePortalAlias(input.hostname);
  await validateCloudflare({ hostnames: certificateHostnames(proposed), certificate: input.certificate, privateKey: input.privateKey });
  const backup = backupPortalAliasMaterial();
  const previousEnv = safeRead(APP_ENV); const previousNginx = safeRead(NGINX_SITE); const previousInclude = safeRead(TLS_INCLUDE);
  try {
    mkdirSync(CLOUDFLARE_DIRECTORY, { recursive: true, mode: 0o700 });
    writeAtomic(`${CLOUDFLARE_DIRECTORY}/certificate.pem`, input.certificate, 0o644);
    writeAtomic(`${CLOUDFLARE_DIRECTORY}/private-key.pem`, input.privateKey, 0o600);
    if (input.caRoot) writeAtomic(`${CLOUDFLARE_DIRECTORY}/cloudflare-origin-ca-root.pem`, input.caRoot, 0o644);
    writeAtomic(TLS_INCLUDE, includeFor("cloudflare_origin", `${CLOUDFLARE_DIRECTORY}/certificate.pem`, `${CLOUDFLARE_DIRECTORY}/private-key.pem`), 0o640);
    writeAtomic(NGINX_SITE, renderNginxPortalAliases(previousNginx, proposed), 0o640);
    writeAtomic(APP_ENV, writePortalAliases(previousEnv, proposed.aliases), 0o640);
    await run(NGINX, ["-t"]); await run(SYSTEMCTL, ["reload", "nginx"]);
    await verifyCanonicalHealth(proposed.canonical);
    await verifyAliasRedirect(proposed.alias, proposed.canonical);
    return { ...(await domainStatus()), addedAlias: proposed.alias, backup };
  } catch (error) {
    restorePortalAliasMaterial(backup);
    await run(NGINX, ["-t"]).catch(() => undefined); await run(SYSTEMCTL, ["reload", "nginx"]).catch(() => undefined);
    throw error;
  }
}
async function addPortalAliasLetsEncrypt(input) {
  if (currentProvider() !== "letsencrypt") deny("Let's Encrypt portal aliases can be added only while a Let's Encrypt certificate is active.");
  if (!validEmail(input.email) || !existsSync(CERTBOT)) deny("A valid certificate-contact email and local Certbot installation are required.");
  const proposed = addablePortalAlias(input.hostname);
  const previousEnv = safeRead(APP_ENV); const previousNginx = safeRead(NGINX_SITE); const previousInclude = safeRead(TLS_INCLUDE);
  const paths = letsEncryptPaths();
  if (!existsSync(paths.certificate) || !existsSync(paths.privateKey)) deny("The active Let's Encrypt certificate files are unavailable.");
  const backup = backupPortalAliasMaterial();
  try {
    // This exposes only the explicitly approved new name to the HTTP-01 location.
    // Its TLS alias server is deliberately left absent until the expanded SAN
    // certificate has been verified, so no HTTPS request can reach Node early.
    writeAtomic(NGINX_SITE, renderNginxPortalAliases(previousNginx, {
      ...proposed,
      aliases: proposed.aliases.filter((alias) => alias !== proposed.alias),
      httpAliases: proposed.aliases,
    }), 0o640);
    await run(NGINX, ["-t"]); await run(SYSTEMCTL, ["reload", "nginx"]);
    const certificateNames = certificateHostnames(proposed);
    await run(CERTBOT, ["certonly", "--webroot", "-w", "/var/www/html", "--non-interactive", "--agree-tos", "--email", input.email, "--cert-name", paths.certName, "--expand", "--keep-until-expiring", ...certificateNames.flatMap((hostname) => ["-d", hostname])], "", 150_000);
    for (const hostname of certificateNames) {
      const hostnameCheck = await run(OPENSSL, ["x509", "-in", paths.certificate, "-noout", "-checkhost", hostname]);
      if (!hostnameCheck.includes("does match certificate")) deny("Let's Encrypt did not issue a certificate covering every configured portal hostname.");
    }
    writeAtomic(TLS_INCLUDE, includeFor("letsencrypt", paths.certificate, paths.privateKey), 0o640);
    writeAtomic(NGINX_SITE, renderNginxPortalAliases(previousNginx, proposed), 0o640);
    writeAtomic(APP_ENV, writePortalAliases(previousEnv, proposed.aliases), 0o640);
    await run(NGINX, ["-t"]); await run(SYSTEMCTL, ["reload", "nginx"]);
    await verifyCanonicalHealth(proposed.canonical);
    await verifyAliasRedirect(proposed.alias, proposed.canonical);
    return { ...(await domainStatus()), addedAlias: proposed.alias, backup };
  } catch (error) {
    // Certbot can retain a successfully expanded certificate even if a later
    // health check fails. Restoring routing first remains fail-closed: a spare
    // SAN alone cannot make an unconfigured hostname reach the portal.
    restorePortalAliasMaterial(backup);
    await run(NGINX, ["-t"]).catch(() => undefined); await run(SYSTEMCTL, ["reload", "nginx"]).catch(() => undefined);
    throw error;
  }
}
function validateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) deny("Request must be an object.");
  if (value.action === "status") return { action: "status" };
  if (value.action === "domain-status") return { action: "domain-status" };
  if (value.action === "install-cloudflare-origin") {
    const { hostname, certificate, privateKey, caRoot = "" } = value;
    if (typeof hostname !== "string" || !isPem(certificate, "BEGIN CERTIFICATE") || !isPem(privateKey, "BEGIN") || (caRoot && !isPem(caRoot, "BEGIN CERTIFICATE"))) deny("Invalid Cloudflare Origin CA payload.");
    return { action: value.action, hostname, certificate, privateKey, caRoot };
  }
  if (value.action === "activate-letsencrypt") {
    if (typeof value.hostname !== "string" || value.confirmation !== "USE LETS ENCRYPT") deny("Invalid Let's Encrypt activation confirmation.");
    return { action: value.action, hostname: value.hostname };
  }
  if (value.action === "update-domain-letsencrypt") {
    if (typeof value.hostname !== "string" || !validEmail(value.email) || value.confirmation !== "CHANGE DOMAIN AND REQUEST CERTIFICATE") deny("Invalid domain change confirmation.");
    return { action: value.action, hostname: value.hostname.toLowerCase(), email: value.email, confirmation: value.confirmation };
  }
  if (value.action === "add-portal-alias-letsencrypt") {
    if (typeof value.hostname !== "string" || !validEmail(value.email) || value.confirmation !== "ADD PORTAL ALIAS") deny("Invalid portal alias request.");
    return { action: value.action, hostname: value.hostname.toLowerCase(), email: value.email };
  }
  if (value.action === "add-portal-alias-cloudflare") {
    const { hostname, certificate, privateKey, caRoot = "" } = value;
    if (typeof hostname !== "string" || !isPem(certificate, "BEGIN CERTIFICATE") || !isPem(privateKey, "BEGIN") || (caRoot && !isPem(caRoot, "BEGIN CERTIFICATE")) || value.confirmation !== "ADD PORTAL ALIAS") deny("Invalid Cloudflare portal alias payload.");
    return { action: value.action, hostname: hostname.toLowerCase(), certificate, privateKey, caRoot };
  }
  deny("Unsupported certificate action.");
}
function send(socket, payload) { socket.end(`${JSON.stringify(payload)}\n`); }

mkdirSync(SOCKET_DIRECTORY, { recursive: true, mode: 0o750 }); chmodSync(SOCKET_DIRECTORY, 0o750);
if (existsSync(SOCKET_PATH)) rmSync(SOCKET_PATH, { force: true });
let configurationMutationInFlight = false;
const daemon = net.createServer((socket) => {
  let data = ""; socket.setTimeout(35_000, () => send(socket, { ok: false, error: "Certificate request timed out." }));
  socket.on("data", (chunk) => {
    data += String(chunk); if (Buffer.byteLength(data, "utf8") > MAX_MESSAGE_BYTES) return send(socket, { ok: false, error: "Certificate request is too large." });
    const newline = data.indexOf("\n"); if (newline < 0) return;
    try {
      const request = validateRequest(JSON.parse(data.slice(0, newline)));
      const mutatesConfiguration = request.action !== "status" && request.action !== "domain-status";
      if (mutatesConfiguration && configurationMutationInFlight) deny("A certificate or portal-hostname change is already in progress. Wait for it to complete before retrying.");
      if (mutatesConfiguration) configurationMutationInFlight = true;
      const action = request.action === "status" ? status()
        : request.action === "domain-status" ? domainStatus()
          : request.action === "install-cloudflare-origin" ? installCloudflare(request)
            : request.action === "update-domain-letsencrypt" ? updateDomainLetsEncrypt(request)
              : request.action === "add-portal-alias-letsencrypt" ? addPortalAliasLetsEncrypt(request)
                : request.action === "add-portal-alias-cloudflare" ? addPortalAliasCloudflare(request)
                  : activateLetsEncrypt(request);
      action.then((output) => send(socket, { ok: true, output })).catch((error) => send(socket, { ok: false, error: String(error.message ?? error).slice(0, 4000) })).finally(() => { if (mutatesConfiguration) configurationMutationInFlight = false; });
    } catch (error) { send(socket, { ok: false, error: String(error.message ?? error).slice(0, 1000) }); }
  }); socket.on("error", () => undefined);
});
daemon.on("error", (error) => { console.error(`certificate-control daemon error: ${error.message}`); process.exitCode = 1; });
daemon.listen(SOCKET_PATH, () => { chmodSync(SOCKET_PATH, 0o660); console.log(`ReadyPackets certificate-control daemon listening on ${SOCKET_PATH}`); });
function shutdown() { daemon.close(() => { if (existsSync(SOCKET_PATH)) rmSync(SOCKET_PATH, { force: true }); process.exit(0); }); }
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
