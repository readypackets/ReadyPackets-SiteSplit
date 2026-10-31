import { describe, expect, it } from "vitest";
import { normalizeSharePointRootFolderPath } from "../server/services/sharepoint.js";

describe("SharePoint base-folder normalization", () => {
  it("keeps a selected ReadyPackets base folder unchanged", () => {
    expect(normalizeSharePointRootFolderPath("RP_Intake_Raw/ReadyPackets")).toBe("RP_Intake_Raw/ReadyPackets");
  });

  it("normalizes a configured ReadyPacket/Orders path without changing its selected hierarchy", () => {
    expect(normalizeSharePointRootFolderPath(" /ReadyPacket\\Orders/ ")).toBe("ReadyPacket/Orders");
  });

  it("moves a selected managed customers folder back to its base", () => {
    expect(normalizeSharePointRootFolderPath("RP_Intake_Raw/ReadyPackets/customers")).toBe("RP_Intake_Raw/ReadyPackets");
  });

  it("removes a nested managed customer selection so a duplicate customers folder cannot be created", () => {
    expect(normalizeSharePointRootFolderPath("RP_Intake_Raw/ReadyPackets/customers/RP-CUST-000008")).toBe("RP_Intake_Raw/ReadyPackets");
  });

  it("rejects a root that would resolve above the document library root", () => {
    expect(() => normalizeSharePointRootFolderPath("customers")).toThrow("base folder above the ReadyPackets customers folder");
  });

  it("rejects both single-dot and parent-dot path segments", () => {
    expect(() => normalizeSharePointRootFolderPath("ReadyPackets/./Orders")).toThrow();
    expect(() => normalizeSharePointRootFolderPath("ReadyPackets/../Orders")).toThrow();
  });
});
