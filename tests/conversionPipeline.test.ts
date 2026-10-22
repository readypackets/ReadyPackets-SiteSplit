import { describe, expect, it } from "vitest";
import {
  buildSharepointOrderPath,
  conversionProfileLabel,
  normalizeSharepointIdentitySegment,
} from "../server/services/conversionPipeline.js";
import { allowedExtensions } from "../server/services/storage.js";
import { buildSharepointCustomerFolderName, buildSharepointOrderFolderName } from "../server/services/sharepointFolderNaming.js";

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

  it("uses snapshot-friendly email and project labels for new SharePoint order folders", () => {
    const customerFolderName = buildSharepointCustomerFolderName({ email: "Alex.Example@ready.test", customerId: "RP-CUS-4K2D8P" });
    const orderFolderName = buildSharepointOrderFolderName({ projectName: "Series A / data room", orderNumber: "RP-ORD-4K2D8P-2610-2W2YGW" });
    expect(customerFolderName).toBe("alex.example@ready.test-RP-CUS-4K2D8P");
    expect(orderFolderName).toBe("Series A _ data room-RP-ORD-4K2D8P-2610-2W2YGW");
    expect(buildSharepointOrderPath({ rootFolderPath: "ReadyPackets/Orders", relativeRootPath: "Originals", customerName: "Alex Example", customerId: "RP-CUS-4K2D8P", orderNumber: "RP-ORD-4K2D8P-2610-2W2YGW", customerFolderName, orderFolderName })).toBe("ReadyPackets/Orders/Originals/alex.example@ready.test-RP-CUS-4K2D8P/Series A _ data room-RP-ORD-4K2D8P-2610-2W2YGW");
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
