#!/usr/bin/env node
/**
 * ReadyPackets root backup-control socket daemon.
 *
 * The web application can request only a fixed allowlist of backup operations
 * through a local Unix socket. The daemon validates the request, invokes the
 * root-owned backup-control helper with a fixed absolute path, and returns only
 * its bounded text response. The portal service never receives sudo access.
 */
import net from "node:net";
import { existsSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { spawn } from "node:child_process";

const SOCKET_DIRECTORY = "/run/readypackets";
const SOCKET_PATH = `${SOCKET_DIRECTORY}/backup-control.sock`;
const CONTROL = "/usr/local/sbin/readypackets-backup-control";
const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const TIMEOUT_MS = 5 * 60 * 1000;
const SAFE_TARGET = /^[A-Za-z0-9._-]+:.+$/;
const SAFE_FILENAME = /^readypackets-[0-9TZ-]+\.tar\.gz(?:\.(?:age|gpg))?$/;
const SAFE_CONFIG_EXPORT = /^readypackets-config-github-secrets-[0-9TZ-]+\.rpconfig$/;
const SAFE_CONFIG_IMPORT = /^rpconfig-import-[a-f0-9]{32}\.rpconfig$/;
const SAFE_BACKUP_IMPORT = /^rpbackup-import-[a-f0-9]{32}\.tar\.gz$/;
const SAFE_SCOPED_IMPORT = /^rprecovery-import-[a-f0-9]{32}\.rprecovery$/;
const SAFE_SCOPE = /^(?:identities|orders)$/;
const SAFE_PASSPHRASE_LINE = /^[^\r\n]{16,512}\n$/;

if (process.getuid?.() !== 0) throw new Error("backup-control daemon must run as root");

function deny(message) {
  const error = new Error(message);
  error.code = "INVALID_REQUEST";
  throw error;
}

function validateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) deny("Request must be an object.");
  const { action, args = [], stdin = "" } = value;
  if (typeof action !== "string" || !Array.isArray(args) || args.some((arg) => typeof arg !== "string") || typeof stdin !== "string") deny("Request shape is invalid.");
  if (Buffer.byteLength(stdin, "utf8") > 24 * 1024) deny("Request body is too large.");
  switch (action) {
    case "start": case "status": case "restore-status":
      if (args.length !== 0 || stdin) deny("This action accepts no arguments."); break;
    case "schedule":
      if (args.length !== 1 || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(args[0]) || stdin) deny("Invalid schedule."); break;
    case "prepare-download": case "verify-archive":
      if (args.length !== 1 || !SAFE_FILENAME.test(args[0]) || stdin) deny("Invalid backup filename."); break;
    case "start-restore":
      if (args.length !== 1 || !SAFE_FILENAME.test(args[0]) || stdin !== `RESTORE ${args[0]}\n`) deny("Invalid restore confirmation."); break;
    case "test-target":
      if (args.length !== 1 || !SAFE_TARGET.test(args[0]) || stdin) deny("Invalid cloud target."); break;
    case "configure-targets": case "configure-remote": case "export-config": case "export-config-secrets":
      if (args.length !== 0 || !stdin) deny("This action requires a configuration payload."); break;
    case "export-scoped-recovery":
      if (args.length !== 1 || !SAFE_SCOPE.test(args[0]) || !SAFE_PASSPHRASE_LINE.test(stdin)) deny("Invalid scoped recovery export request."); break;
    case "inspect-scoped-recovery-import":
      if (args.length !== 2 || !SAFE_SCOPE.test(args[0]) || !SAFE_SCOPED_IMPORT.test(args[1]) || !SAFE_PASSPHRASE_LINE.test(stdin)) deny("Invalid scoped recovery inspection request."); break;
    case "restore-scoped-recovery-import": {
      if (args.length !== 2 || !SAFE_SCOPE.test(args[0]) || !SAFE_SCOPED_IMPORT.test(args[1])) deny("Invalid scoped recovery restore request.");
      const confirmation = `RESTORE ${args[0].toUpperCase()} RECOVERY`;
      if (!stdin.startsWith("\n") && stdin !== "") {
        const divider = stdin.indexOf("\n");
        if (divider < 16 || !SAFE_PASSPHRASE_LINE.test(stdin.slice(0, divider + 1)) || stdin.slice(divider + 1) !== `${confirmation}\n`) deny("Invalid scoped recovery restore confirmation.");
      } else deny("Invalid scoped recovery restore confirmation.");
      break;
    }
    case "inspect-archive-import":
      if (args.length !== 1 || !SAFE_BACKUP_IMPORT.test(args[0]) || stdin) deny("Invalid uploaded backup inspection request."); break;
    case "start-restore-import":
      if (args.length !== 1 || !SAFE_BACKUP_IMPORT.test(args[0]) || stdin !== "RESTORE BACKUP\n") deny("Invalid uploaded backup restore confirmation."); break;
    case "inspect-config":
      if (args.length !== 1 || !SAFE_CONFIG_IMPORT.test(args[0]) || !stdin || /\r|\n/.test(stdin.slice(0, -1)) || !stdin.endsWith("\n")) deny("Invalid configuration restore inspection request."); break;
    case "restore-config":
      if (args.length !== 1 || !SAFE_CONFIG_IMPORT.test(args[0]) || !/^[^\r\n]{16,512}\nRESTORE CONFIGURATION\n$/.test(stdin)) deny("Invalid configuration restore confirmation."); break;
    case "delete-export":
      if (args.length !== 1 || !SAFE_CONFIG_EXPORT.test(args[0]) || stdin) deny("Invalid protected configuration export filename."); break;
    default: deny("Unsupported backup action.");
  }
  return { action, args, stdin };
}

function runControl({ action, args, stdin }) {
  return new Promise((resolve, reject) => {
    const child = spawn(CONTROL, [action, ...args], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" } });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Backup control timed out.")); }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) child.kill("SIGTERM"); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); if (Buffer.byteLength(stderr, "utf8") > MAX_OUTPUT_BYTES) child.kill("SIGTERM"); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `Backup control exited with ${code}.`)); });
    child.stdin.end(stdin);
  });
}

function send(socket, payload) {
  socket.end(`${JSON.stringify(payload)}\n`);
}

mkdirSync(SOCKET_DIRECTORY, { recursive: true, mode: 0o750 });
chmodSync(SOCKET_DIRECTORY, 0o750);
if (existsSync(SOCKET_PATH)) rmSync(SOCKET_PATH, { force: true });
const daemon = net.createServer((socket) => {
  let data = "";
  socket.setTimeout(30_000, () => send(socket, { ok: false, error: "Backup control request timed out." }));
  socket.on("data", (chunk) => {
    data += String(chunk);
    if (Buffer.byteLength(data, "utf8") > MAX_MESSAGE_BYTES) { send(socket, { ok: false, error: "Backup control request is too large." }); return; }
    const newline = data.indexOf("\n");
    if (newline < 0) return;
    const line = data.slice(0, newline);
    try {
      const request = validateRequest(JSON.parse(line));
      runControl(request).then((output) => send(socket, { ok: true, output })).catch((error) => send(socket, { ok: false, error: String(error.message ?? error).slice(0, 4000) }));
    } catch (error) { send(socket, { ok: false, error: String(error.message ?? error).slice(0, 1000) }); }
  });
  socket.on("error", () => undefined);
});
daemon.on("error", (error) => { console.error(`backup-control daemon error: ${error.message}`); process.exitCode = 1; });
daemon.listen(SOCKET_PATH, () => {
  chmodSync(SOCKET_PATH, 0o660);
  console.log(`ReadyPackets backup-control daemon listening on ${SOCKET_PATH}`);
});
function shutdown() { daemon.close(() => { if (existsSync(SOCKET_PATH)) rmSync(SOCKET_PATH, { force: true }); process.exit(0); }); }
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
