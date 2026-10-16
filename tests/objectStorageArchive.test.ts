import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const adapter = path.join(repositoryRoot, "deploy", "object-storage-archive.mjs");
const temporaryRoots: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const directory = path.join(tmpdir(), `readypackets-${label}-${randomBytes(8).toString("hex")}`);
  temporaryRoots.push(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

async function runAdapter(args: string[], storageRoot: string) {
  return execFileAsync(process.execPath, [adapter, ...args], {
    env: {
      ...process.env,
      STORAGE_DRIVER: "local",
      STORAGE_LOCAL_ROOT: storageRoot,
    },
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("object storage archive adapter", () => {
  it("round-trips opaque local upload objects without accepting source paths", async () => {
    const sourceRoot = await temporaryDirectory("storage-source");
    const archiveRoot = await temporaryDirectory("storage-archive");
    const restoredRoot = await temporaryDirectory("storage-restored");
    const key = `${"a".repeat(48)}.pdf`;
    const sourceFile = path.join(sourceRoot, key.slice(0, 2), key.slice(2, 4), key);
    const bytes = Buffer.from("ready-packets-object-recovery\n", "utf8");
    await mkdir(path.dirname(sourceFile), { recursive: true, mode: 0o700 });
    await writeFile(sourceFile, bytes, { mode: 0o600 });

    const exported = await runAdapter(["export", "--destination", archiveRoot], sourceRoot);
    expect(exported.stdout).toContain("storage_driver=local");
    expect(exported.stdout).toContain("object_count=1");
    expect(await readFile(path.join(archiveRoot, key.slice(0, 2), key.slice(2, 4), key))).toEqual(bytes);

    const imported = await runAdapter(["import", "--source", archiveRoot], restoredRoot);
    expect(imported.stdout).toContain("object_count=1");
    expect(await readFile(path.join(restoredRoot, key.slice(0, 2), key.slice(2, 4), key))).toEqual(bytes);
  });

  it("rejects a storage-key list containing traversal data", async () => {
    const sourceRoot = await temporaryDirectory("storage-source");
    const archiveRoot = await temporaryDirectory("storage-archive");
    const listFile = path.join(await temporaryDirectory("storage-list"), "keys.txt");
    await writeFile(listFile, "../../etc/passwd\n", { mode: 0o600 });

    await expect(runAdapter(["export", "--destination", archiveRoot, "--keys-file", listFile], sourceRoot)).rejects.toThrow();
  });
});
