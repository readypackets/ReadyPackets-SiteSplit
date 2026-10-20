import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { marketingSiteUrl } from "../client/src/lib/marketing.js";

const root = process.cwd();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("portal marketing navigation", () => {
  it("uses only an injected HTTPS origin and otherwise falls back to the public ReadyPackets site", () => {
    vi.stubGlobal("document", {
      documentElement: { dataset: { rpMarketingOrigin: "https://marketing.example.test" } },
    });
    expect(marketingSiteUrl()).toBe("https://marketing.example.test");
    expect(marketingSiteUrl("/contact")).toBe("https://marketing.example.test/contact");
    expect(marketingSiteUrl("https://untrusted.example.test")).toBe("https://marketing.example.test");
    expect(marketingSiteUrl("/\\untrusted.example.test")).toBe("https://marketing.example.test");

    vi.stubGlobal("document", {
      documentElement: { dataset: { rpMarketingOrigin: "http://marketing.example.test" } },
    });
    expect(marketingSiteUrl("/contact")).toBe("https://www.readypackets.com/contact");

    vi.stubGlobal("document", {
      documentElement: { dataset: { rpMarketingOrigin: "https://marketing.example.test/untrusted-path" } },
    });
    expect(marketingSiteUrl()).toBe("https://www.readypackets.com");
  });

  it("keeps public not-found content out of PortalApp and uses the portal-only fallback", () => {
    const portalApp = readFileSync(resolve(root, "client/src/PortalApp.tsx"), "utf8");
    const portalNotFound = readFileSync(resolve(root, "client/src/pages/portal/PortalNotFound.tsx"), "utf8");

    expect(portalApp).toContain('import { PortalNotFoundPage } from "@/pages/portal/PortalNotFound";');
    expect(portalApp).not.toContain('from "@/pages/public/Content"');
    expect(portalApp).toContain("component={PortalNotFoundPage}");
    expect(portalApp).toContain('path={/^\\/$/}><Redirect to="/login" replace />');
    expect(portalNotFound).toContain('href="/login"');
    expect(portalNotFound).toContain("marketingSiteUrl()");
  });
});
