#!/usr/bin/env node
/**
 * ReadyPackets root platform-update control socket daemon.
 *
 * The portal calls this Unix-socket service with a fixed allowlist of update
 * actions. This keeps NoNewPrivileges=true on the public Node service while
 * avoiding arbitrary sudo capability. Requests are validated before the daemon
 * invokes the root-owned platform-update helper at its fixed absolute path.
 */
import net from "node:net";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";

const SOCKET_DIRECTORY = "/run/readypackets";
const SOCKET_PATH = `${SOCKET_DIRECTORY}/platform-update-control.sock`;
const CONTROL = "/usr/local/sbin/readypackets-platform-update";
const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const TIMEOUT_MS = 20 * 60 * 1000;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,128}$/;
const SHA_RE = /^[a-f0-9]{40}$/;
const RUN_RE = /^[1-9][0-9]*$/;

if (process.getuid?.() !== 0) throw new Error("platform-update-control daemon must run as root");

function deny(message) {
  const error = new Error(message);
  error.code = "INVALID_REQUEST";
  throw error;
}

function validateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) deny("Request must be an object.");
  const { action, args = [], stdin = "" } = value;
  if (typeof action !== "string" || !Array.isArray(args) || args.some((arg) => typeof arg !== "string") || typeof stdin !== "string") deny("Request shape is invalid.");
  if (Buffer.byteLength(stdin, "utf8") > 1024) deny("Request body is too large.");

  if (action === "status") {
    if (args.length !== 0 || stdin) deny("Status accepts no arguments.");
  } else if (action === "rollback") {
    if (args.length !== 1 || !RUN_RE.test(args[0]) || stdin) deny("Invalid rollback request.");
  } else if (action === "apply") {
    if (args.length !== 4 || !RUN_RE.test(args[0]) || !REPOSITORY_RE.test(args[1]) || !BRANCH_RE.test(args[2]) || !SHA_RE.test(args[3]) || !/^[^\r\n]{20,512}\n$/.test(stdin)) {
      deny("Invalid approved update request.");
    }
  } else {
    deny("Unsupported platform update action.");
  }
  return { action, args, stdin };
}

function runControl({ action, args, stdin }) {
  return new Promise((resolve, reject) => {
    const child = spawn(CONTROL, [action, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Platform update control timed out."));
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (Buffer.byteLength(stderr, "utf8") > MAX_OUTPUT_BYTES) child.kill("SIGTERM");
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `Platform update control exited with ${code}.`));
    });
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
  socket.setTimeout(30_000, () => send(socket, { ok: false, error: "Platform update control request timed out." }));
  socket.on("data", (chunk) => {
    data += String(chunk);
    if (Buffer.byteLength(data, "utf8") > MAX_MESSAGE_BYTES) {
      send(socket, { ok: false, error: "Platform update control request is too large." });
      return;
    }
    const newline = data.indexOf("\n");
    if (newline < 0) return;
    try {
      const request = validateRequest(JSON.parse(data.slice(0, newline)));
      runControl(request)
        .then((output) => send(socket, { ok: true, output }))
        .catch((error) => send(socket, { ok: false, error: String(error.message ?? error).slice(0, 4000) }));
    } catch (error) {
      send(socket, { ok: false, error: String(error.message ?? error).slice(0, 1000) });
    }
  });
  socket.on("error", () => undefined);
});

daemon.on("error", (error) => {
  console.error(`platform-update-control daemon error: ${error.message}`);
  process.exitCode = 1;
});
daemon.listen(SOCKET_PATH, () => {
  chmodSync(SOCKET_PATH, 0o660);
  console.log(`ReadyPackets platform-update-control daemon listening on ${SOCKET_PATH}`);
});
function shutdown() {
  daemon.close(() => {
    if (existsSync(SOCKET_PATH)) rmSync(SOCKET_PATH, { force: true });
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
