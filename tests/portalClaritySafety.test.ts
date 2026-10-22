import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");

const analyticsProvider = read("client/src/components/privacy/AnalyticsProvider.tsx");
const analyticsConfig = read("server/services/analyticsConfig.ts");
const portalHtml = read("client/portal.html");
const cookieConsent = read("client/src/components/privacy/CookieConsent.tsx");
const migration = read("drizzle/migrations/0058_portal_clarity_preconfiguration_and_consent_refresh.sql");

describe("Portal Microsoft Clarity safety boundary", () => {
  it("masks the entire Portal DOM and never declares an unmask escape hatch", () => {
    expect(portalHtml).toContain('<body data-clarity-mask="true">');
    expect(portalHtml).not.toContain("data-clarity-unmask");
    expect(cookieConsent).toContain("Allows Microsoft Clarity measurement on anonymous sign-in, registration, verification, and recovery screens.");
    expect(cookieConsent).toContain("Customer and administrator workspaces are excluded, and the Portal DOM remains masked.");
  });

  it("limits all provider activity on the Portal host to a bounded anonymous entry-route allowlist", () => {
    expect(analyticsProvider).toContain("const PORTAL_ANALYTICS_ENTRY_PATHS = new Set([");
    for (const path of ["/login", "/register", "/verify-email", "/forgot-password", "/reset-password"]) {
      expect(analyticsProvider).toContain(`"${path}"`);
    }
    expect(analyticsProvider).toContain("const portalAnalyticsEntryRoute = portalSurface && isPortalAnalyticsEntryRoute(location);");
    expect(analyticsProvider).toContain("enabled: preferences?.analytics === true && providerRouteAllowed");
    expect(analyticsProvider).toContain("if (!preferences?.analytics || !providerRouteAllowed || !value?.active) return;");
    expect(analyticsProvider).toContain("if (portalAnalyticsEntryRoute && value.clarity.enabled && value.clarity.projectId) loadClarity(value.clarity.projectId);");
    expect(analyticsProvider).toContain('if (surface() !== "portal" || !isPortalAnalyticsEntryRoute(window.location.pathname)) return;');
  });

  it("uses an explicit denied ConsentV2 state and cookie erasure on withdrawal or protected-route entry", () => {
    expect(analyticsProvider).toContain('window.clarity?.("consentv2", { ad_Storage: "denied", analytics_Storage: "denied" });');
    expect(analyticsProvider).toContain('window.clarity?.("consent", false);');
    expect(analyticsProvider).toContain('clarity("consentv2", { ad_Storage: "denied", analytics_Storage: "granted" });');
    expect(analyticsProvider).toContain('if (document.getElementById("rp-clarity")) return;');
  });

  it("withholds provider configuration if the consent center or Analytics category is globally disabled", () => {
    expect(analyticsConfig).toContain("if (!consent.config.enabled || !consent.config.analyticsAvailable || !consent.preferences?.analytics) return disabled;");
  });

  it("ships the supplied public project identifier inertly, refreshes consent, and preserves an existing administrator value", () => {
    expect(migration).toContain("'privacy.cookie_consent_version', '2026.10.22'");
    expect(migration).toContain("'privacy.analytics_clarity_project_id', 'z1vdbjl7z3'");
    expect(migration).toContain("WHEN setting_key = 'privacy.analytics_clarity_project_id'");
    expect(migration).toContain("AND (setting_value IS NULL OR TRIM(setting_value) = '') THEN VALUES(setting_value)");
    expect(migration).not.toContain("privacy.analytics_clarity_enabled', 'true'");
    expect(migration).not.toContain("privacy.analytics_tracking_enabled', 'true'");
    expect(migration).not.toContain("privacy.analytics_cross_site_enabled', 'true'");
  });
});
