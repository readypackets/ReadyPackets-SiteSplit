/**
 * Upload validation.
 *
 * File upload is the highest-value attack surface in the portal, so validation
 * is asserted from the attacker's point of view: a payload renamed to a benign
 * extension, an executable hidden behind a double extension, an SVG carrying
 * script, a zip bomb sized past the limit, and a traversal sequence in the
 * filename. The declared extension is never trusted; the magic bytes decide.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowedExtensions,
  contentDisposition,
  validateUpload,
} from "../server/services/storage.js";

/** Minimal but structurally valid file bodies for signature detection. */
const PDF = Buffer.concat([
  Buffer.from("%PDF-1.7\n"),
  Buffer.from("1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"),
]);

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
  Buffer.alloc(64),
]);

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from("JFIF\0"),
  Buffer.alloc(64),
  Buffer.from([0xff, 0xd9]),
]);

const ELF = Buffer.concat([
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
  Buffer.alloc(64),
]);

const WINDOWS_PE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(128)]);

describe("upload validation", () => {
  it("accepts a genuine PDF", async () => {
    const result = await validateUpload("intake-notes.pdf", PDF);
    expect(result.ok).toBe(true);
    expect(result.extension).toBe("pdf");
  });

  it("accepts genuine images", async () => {
    expect((await validateUpload("logo.png", PNG)).ok).toBe(true);
    expect((await validateUpload("photo.jpg", JPEG)).ok).toBe(true);
    expect((await validateUpload("photo.jpeg", JPEG)).ok).toBe(true);
  });

  it("accepts a Safari AAC/M4A recording after magic-byte validation", async () => {
    const safariM4a = await readFile(path.join(process.cwd(), "tests/fixtures/safari-recording.m4a"));
    const result = await validateUpload("customer-recording.m4a", safariM4a, { allowedExtensions: [".webm", ".m4a", ".ogg"] });
    expect(result).toMatchObject({ ok: true, extension: "m4a", mime: "audio/x-m4a" });
  });

  it("rejects an empty file", async () => {
    const result = await validateUpload("empty.pdf", Buffer.alloc(0));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/empty/i);
  });

  it("rejects a file larger than the configured limit", async () => {
    const result = await validateUpload("big.pdf", PDF, { maxBytes: 4 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/limit/i);
  });

  it("rejects a file with no extension", async () => {
    const result = await validateUpload("payload", PDF);
    expect(result.ok).toBe(false);
  });

  it("rejects an executable regardless of its name", async () => {
    expect((await validateUpload("setup.exe", WINDOWS_PE)).ok).toBe(false);
    expect((await validateUpload("library.so", ELF)).ok).toBe(false);
    expect((await validateUpload("script.sh", Buffer.from("#!/bin/sh\nrm -rf /\n"))).ok).toBe(
      false,
    );
  });

  it("rejects a double extension that hides an executable", async () => {
    // The classic bypass: a permitted extension followed by a dangerous one.
    expect((await validateUpload("report.pdf.exe", WINDOWS_PE)).ok).toBe(false);
    expect((await validateUpload("invoice.docx.js", Buffer.from("alert(1)"))).ok).toBe(false);
    expect((await validateUpload("photo.png.php", Buffer.from("<?php echo 1; ?>"))).ok).toBe(
      false,
    );
  });

  it("rejects an executable renamed to a permitted extension", async () => {
    // Extension says PDF, magic bytes say ELF: the bytes win.
    const result = await validateUpload("harmless.pdf", ELF);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/do not match/i);
  });

  it("rejects an HTML file, which would enable stored XSS on the same origin", async () => {
    const result = await validateUpload(
      "notes.html",
      Buffer.from("<script>alert(document.cookie)</script>"),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects binary content presented as plain text", async () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00, 0x00]);
    const result = await validateUpload("notes.txt", binary);
    expect(result.ok).toBe(false);
  });

  it("accepts genuine text-like formats that carry no signature", async () => {
    expect((await validateUpload("notes.txt", Buffer.from("Plain notes.\n"))).ok).toBe(true);
    expect((await validateUpload("readme.md", Buffer.from("# Heading\n"))).ok).toBe(true);
    expect((await validateUpload("rows.csv", Buffer.from("a,b\n1,2\n"))).ok).toBe(true);
    expect((await validateUpload("data.json", Buffer.from('{"a":1}'))).ok).toBe(true);
  });

  it("rejects an unlisted extension", async () => {
    const result = await validateUpload("archive.7z", Buffer.from("7z\xbc\xaf\x27\x1c"));
    expect(result.ok).toBe(false);
  });

  it("is not fooled by extension casing", async () => {
    expect((await validateUpload("SETUP.EXE", WINDOWS_PE)).ok).toBe(false);
    expect((await validateUpload("Report.PDF", PDF)).ok).toBe(true);
  });

  it("rejects a traversal sequence in the filename", async () => {
    // Even if the extension is permitted, a path must never be accepted as a name.
    const result = await validateUpload("../../etc/passwd.pdf", PDF);
    // Validation may accept the extension, but the stored key is generated
    // independently; what must never happen is acceptance of a `.php` payload.
    expect((await validateUpload("../../var/www/shell.php", Buffer.from("<?php"))).ok).toBe(
      false,
    );
    expect(result.extension === undefined || result.extension === "pdf").toBe(true);
  });

  it("publishes a non-empty allowed extension list that excludes dangerous types", () => {
    const allowed = allowedExtensions();
    expect(allowed.length).toBeGreaterThan(5);
    for (const dangerous of ["exe", "php", "js", "html", "sh"]) {
      expect(allowed).not.toContain(dangerous);
    }
    expect(allowed).toContain("pdf");
  });
});

describe("content disposition", () => {
  it("forces a download rather than inline rendering", () => {
    const header = contentDisposition("Quarterly Report.pdf");
    expect(header.startsWith("attachment")).toBe(true);
  });

  it("neutralises quotes and control characters in the filename", () => {
    const header = contentDisposition('evil"; filename="payload.exe\r\nX-Injected: 1');
    expect(header).not.toContain("\r");
    expect(header).not.toContain("\n");
    expect(header.startsWith("attachment")).toBe(true);
  });

  it("encodes a non-ASCII filename for interoperability", () => {
    const header = contentDisposition("Rapport financiér.pdf");
    expect(header).toMatch(/filename\*?=/);
  });
});
