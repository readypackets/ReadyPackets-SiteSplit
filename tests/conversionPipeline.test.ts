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

  it("keeps the historical no-snapshot selected-site hierarchy available for pre-snapshot orders", () => {
    expect(buildSharepointOrderPath({
      rootFolderPath: "ReadyPackets/Orders",
      relativeRootPath: "Phase I/Originals",
      customerName: "Alex Example",
      customerId: "RP-CUS-4K2D8P",
      orderNumber: "RP-C000008-2608-6D823B",
    })).toBe("ReadyPackets/Orders/Phase I/Originals/Alex Example-RP-CUS-4K2D8P/RP-C000008-2608-6D823B");
  });

  it("uses first-two-first-name characters, full last name, and customer ID for newly snapshotted folders", () => {
    const customerFolderName = buildSharepointCustomerFolderName({ firstName: "Alex", lastName: "Example", customerId: "RP-CUS-4K2D8P" });
    const orderFolderName = buildSharepointOrderFolderName({ projectName: "Series A / data room", orderNumber: "RP-ORD-4K2D8P-2610-2W2YGW" });
    expect(customerFolderName).toBe("Al-Example-RP-CUS-4K2D8P");
    expect(orderFolderName).toBe("Series A _ data room-RP-ORD-4K2D8P-2610-2W2YGW");
    expect(buildSharepointOrderPath({ rootFolderPath: "ReadyPackets/Orders", relativeRootPath: "Originals", customerName: "Alex Example", customerId: "RP-CUS-4K2D8P", orderNumber: "RP-ORD-4K2D8P-2610-2W2YGW", customerFolderName, orderFolderName })).toBe("ReadyPackets/Orders/Originals/Al-Example-RP-CUS-4K2D8P/Series A _ data room-RP-ORD-4K2D8P-2610-2W2YGW");
  });

  it("keeps the opaque customer identifier intact and handles incomplete or unsafe name data", () => {
    expect(buildSharepointCustomerFolderName({ firstName: "A", lastName: "Example", customerId: "RP-CUS-4K2D8P" })).toBe("A-Example-RP-CUS-4K2D8P");
    expect(buildSharepointCustomerFolderName({ firstName: null, lastName: "Example", customerId: "RP-CUS-4K2D8P" })).toBe("Example-RP-CUS-4K2D8P");
    expect(buildSharepointCustomerFolderName({ firstName: "Alex", lastName: null, customerId: "RP-CUS-4K2D8P" })).toBe("Al-RP-CUS-4K2D8P");
    expect(buildSharepointCustomerFolderName({ firstName: null, lastName: null, customerId: "RP-CUS-4K2D8P" })).toBe("Customer-RP-CUS-4K2D8P");
    expect(buildSharepointCustomerFolderName({ firstName: "Élodie", lastName: "../../CON\n", customerId: "RP-CUS-4K2D8P" })).toBe("El-.._.._CON-RP-CUS-4K2D8P");
    const longCustomerId = "RP-CUS-" + "Z".repeat(89);
    const limited = buildSharepointCustomerFolderName({ firstName: "Alex", lastName: "E".repeat(200), customerId: longCustomerId });
    expect(limited.endsWith(`-${longCustomerId}`)).toBe(true);
    expect(limited.length).toBeLessThanOrEqual(180);
  });

  it("uses supplied snapshots verbatim so existing email-derived folders are never renamed", () => {
    expect(buildSharepointOrderPath({
      rootFolderPath: "ReadyPackets/Orders",
      customerName: "Changed Name",
      customerId: "RP-CUS-NEW",
      orderNumber: "RP-ORD-NEW",
      customerFolderName: "alex.example@ready.test-RP-CUS-4K2D8P",
      orderFolderName: "Historic project-RP-ORD-4K2D8P-2610-2W2YGW",
    })).toBe("ReadyPackets/Orders/alex.example@ready.test-RP-CUS-4K2D8P/Historic project-RP-ORD-4K2D8P-2610-2W2YGW");
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
