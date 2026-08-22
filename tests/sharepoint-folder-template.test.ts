import { describe, expect, it } from "vitest";
import { normalizeSharePointFolderTemplate } from "../server/services/sharepoint.js";

describe("SharePoint phase folder-template normalization", () => {
  it("normalizes safe relative folder paths", () => {
    expect(normalizeSharePointFolderTemplate([" Phase I\\Docs/ ", "Phase I/Audio"])).toEqual([
      "Phase I/Docs",
      "Phase I/Audio",
    ]);
  });

  it("rejects traversal and safely normalizes an accidental leading separator", () => {
    expect(() => normalizeSharePointFolderTemplate(["../outside"])).toThrow("relative");
    expect(normalizeSharePointFolderTemplate(["/Phase I/Docs"])).toEqual(["Phase I/Docs"]);
  });

  it("rejects duplicate paths independent of case", () => {
    expect(() => normalizeSharePointFolderTemplate(["Phase I/Docs", "phase i/docs"])).toThrow("duplicate path");
  });

  it("rejects an empty template and excessive template size", () => {
    expect(() => normalizeSharePointFolderTemplate([])).toThrow("at least one");
    expect(() => normalizeSharePointFolderTemplate(Array.from({ length: 33 }, (_, index) => `Phase/${index}`))).toThrow("at most 32");
  });
});
