import { describe, expect, it } from "vitest";
import { analyticsProviderValidation } from "../server/services/analyticsConfig.js";

describe("consent-gated analytics configuration", () => {
  it("accepts only approved PostHog ingestion regions", () => {
    expect(analyticsProviderValidation.posthogHosts).toEqual([
      "https://us.i.posthog.com",
      "https://eu.i.posthog.com",
    ]);
  });

  it("accepts bounded provider identifiers and rejects URL-like input", () => {
    expect(analyticsProviderValidation.isValidClarityProjectId("abc123xyz0")).toBe(true);
    expect(analyticsProviderValidation.isValidClarityProjectId("https://clarity.ms/tag/project")).toBe(false);
    expect(analyticsProviderValidation.isValidClarityProjectId("../../project")).toBe(false);
    expect(analyticsProviderValidation.isValidPostHogProjectKey("phc_1234567890abcdef")).toBe(true);
    expect(analyticsProviderValidation.isValidPostHogProjectKey("https://example.invalid/key")).toBe(false);
  });
});
