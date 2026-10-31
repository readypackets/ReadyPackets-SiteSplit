import { Readable, Writable } from "node:stream";
import { ZipFile } from "yazl";
import { describe, expect, it } from "vitest";

describe("streaming ZIP compatibility", () => {
  it("creates an in-memory ZIP through the supported streaming writer", async () => {
    const chunks: Buffer[] = [];
    const target = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    const archive = new ZipFile();
    archive.outputStream.pipe(target);
    archive.addReadStream(Readable.from("ReadyPackets"), "readme.txt", { compress: true });
    const completed = new Promise<void>((resolve, reject) => {
      target.once("finish", resolve);
      target.once("error", reject);
      archive.once("error", reject);
    });
    archive.end();
    await completed;
    expect(Buffer.concat(chunks).subarray(0, 4).toString("hex")).toBe("504b0304");
  });
});
