import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSettingMock } = vi.hoisted(() => ({ getSettingMock: vi.fn() }));

vi.mock("../server/services/settings.js", () => ({
  getSetting: getSettingMock,
}));

vi.mock("../server/security/crypto.js", () => ({
  decryptField: vi.fn(() => "test-client-secret"),
  encryptField: vi.fn(),
}));

import {
  SHAREPOINT_BASE_FOLDER_NOT_FOUND_MESSAGE,
  resetGraphTokenCache,
  testSharePointConnection,
} from "../server/services/sharepoint.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("SharePoint connection base-folder preflight", () => {
  beforeEach(() => {
    resetGraphTokenCache();
    getSettingMock.mockImplementation(async (key: string) => ({
      "sharepoint.tenant_id": "tenant.example.com",
      "sharepoint.client_id": "11111111-1111-4111-8111-111111111111",
      "sharepoint.client_secret_enc": "encrypted-secret",
      "sharepoint.site_id": "site-id",
      "sharepoint.drive_id": "drive-id",
      "sharepoint.root_folder_path": " ReadyPacket\\Orders/ ",
    })[key] ?? null);
  });

  it("normalizes the configured base path and turns an itemNotFound response into safe browse guidance without writing", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://login.microsoftonline.com/")) {
        return jsonResponse({ access_token: "access-token", expires_in: 3600 });
      }
      if (url.includes("/sites/site-id?")) return jsonResponse({ id: "site-id", displayName: "ReadyPackets" });
      if (url.includes("/drives/drive-id?")) return jsonResponse({ id: "drive-id", name: "Documents" });
      if (url.includes("/drives/drive-id/root:/ReadyPacket/Orders?$select=id,folder")) {
        return jsonResponse({ error: { code: "itemNotFound", message: "test-client-secret must not leak" } }, 404);
      }
      throw new Error(`Unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(testSharePointConnection()).rejects.toThrow(SHAREPOINT_BASE_FOLDER_NOT_FOUND_MESSAGE);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/drives/drive-id/root:/ReadyPacket/Orders?$select=id,folder",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("https://graph.microsoft.com/")).every(([, init]) => init?.method === "GET")).toBe(true);
    expect(SHAREPOINT_BASE_FOLDER_NOT_FOUND_MESSAGE).not.toContain("test-client-secret");
    expect(SHAREPOINT_BASE_FOLDER_NOT_FOUND_MESSAGE).not.toContain("itemNotFound");
  });
});
