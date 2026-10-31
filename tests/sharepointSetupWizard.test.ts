import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const text = (path: string) => readFile(`${root}/${path}`, "utf8");

describe("guided SharePoint setup", () => {
  it("offers discovery, selected-library choice, read-only folder selection, and save-and-test from Platform Setup", async () => {
    const wizard = await text("client/src/pages/admin/PlatformSetup.tsx");
    expect(wizard).toContain("trpc.integrations.discoverGraphConfig.useMutation");
    expect(wizard).toContain("Discover site & libraries");
    expect(wizard).toContain("Document library");
    expect(wizard).toContain("trpc.integrations.browseGraphFolders.useQuery");
    expect(wizard).toContain("Select existing sync folder");
    expect(wizard).toContain("Use current folder as base");
    expect(wizard).toContain("trpc.integrations.testGraphConnection.useMutation");
    expect(wizard).toContain("Save & test SharePoint sync");
    expect(wizard).toContain("SharePoint read preflight passed");
    expect(wizard).not.toContain("Use the Site and library IDs discovered in Administrator → Integrations");
  });

  it("keeps Graph discovery and preflight administrator-only, masked, and non-writing", async () => {
    const [router, service] = await Promise.all([
      text("server/routers/integrations.ts"),
      text("server/services/sharepoint.ts"),
    ]);
    expect(router).toContain("discoverGraphConfig: adminProcedure");
    expect(router).toContain("browseGraphFolders: adminProcedure");
    expect(router).toContain("testGraphConnection: adminProcedure");
    expect(service).toContain("List existing folders beneath a configured drive path without creating or altering anything.");
    expect(service).toContain("The selected document library does not belong to the configured SharePoint site.");
    expect(service).toContain("error.status !== 404");
  });
});
