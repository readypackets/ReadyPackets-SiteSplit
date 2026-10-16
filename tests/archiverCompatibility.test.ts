import { Writable } from "node:stream";
import * as archiverModule from "archiver";
import { describe, expect, it } from "vitest";

interface ZipArchiveInstance {
  pipe(destination: NodeJS.WritableStream): NodeJS.WritableStream;
  append(source: Buffer | string, data?: { name: string }): this;
  finalize(): Promise<void>;
}

const ZipArchive = (archiverModule as unknown as {
  ZipArchive: new (options?: { zlib?: { level?: number } }) => ZipArchiveInstance;
}).ZipArchive;

describe("Archiver 8 compatibility", () => {
  it("creates an in-memory ZIP through the native ESM export", async () => {
    const chunks: Buffer[] = [];
    const target = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.pipe(target);
    archive.append("ReadyPackets", { name: "readme.txt" });
    const completed = new Promise<void>((resolve, reject) => {
      target.once("finish", resolve);
      target.once("error", reject);
    });
    await archive.finalize();
    await completed;
    expect(Buffer.concat(chunks).subarray(0, 4).toString("hex")).toBe("504b0304");
  });
});
