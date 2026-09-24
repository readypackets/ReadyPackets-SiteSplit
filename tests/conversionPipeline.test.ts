import { describe, expect, it } from "vitest";
import {
  buildSharepointOrderPath,
  conversionProfileLabel,
  normalizeSharepointIdentitySegment,
} from "../server/services/conversionPipeline.js";
import { allowedExtensions } from "../server/services/storage.js";

describe("append-only conversion routing", () => {
  it("normalizes external folder identity segments without traversal or controls", () => {
    expect(normalizeSharepointIdentitySegment("  Acme / ../ Labs\n", "Customer")).toBe("Acme _ .._ Labs");
    expect(normalizeSharepointIdentitySegment("CON", "Customer")).toBe("rp_CON");
    expect(normalizeSharepointIdentitySegment("...", "Customer")).toBe("Customer");
  });

  it("builds the required immutable customer and order hierarchy", () => {
    expect(buildSharepointOrderPath({
      rootFolderPath: "ReadyPackets/Orders",
      relativeRootPath: "Phase I/Originals",
      customerName: "Alex Example",
      customerId: "RP-CUS-4K2D8P",
      orderNumber: "RP-C000008-2608-6D823B",
    })).toBe("ReadyPackets/Orders/Phase I/Originals/Alex Example-RP-CUS-4K2D8P/RP-C000008-2608-6D823B");
  });

  it("exposes only named fixed conversion operations", () => {
    expect(conversionProfileLabel("pdf_to_docx")).toBe("PDF to Word (reflow)");
    expect(conversionProfileLabel("audio_to_webm")).toBe("Audio to WebM/Opus");
  });

  it("accepts common magic-validated source containers for audio conversion", () => {
    const extensions = allowedExtensions();
    expect(extensions).toEqual(expect.arrayContaining(["aac", "aiff", "flac", "m4a", "mp3", "ogg", "opus", "wav", "webm"]));
  });
});
