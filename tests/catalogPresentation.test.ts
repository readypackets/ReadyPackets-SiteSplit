import { describe, expect, it } from "vitest";
import { normalizePublicPricingMode, publicPricingLabel } from "../server/services/catalogPresentation.js";

describe("catalog presentation policy", () => {
  it("preserves the legacy visible-price default when no pricing mode is saved", () => {
    expect(normalizePublicPricingMode(null, true)).toBe("show");
  });

  it("maps the legacy hidden-price setting to pricing on request rather than removing pricing unexpectedly", () => {
    expect(normalizePublicPricingMode(null, false)).toBe("on_request");
    expect(publicPricingLabel("on_request")).toBe("Pricing on request");
  });

  it("honors each explicit public pricing presentation mode", () => {
    expect(normalizePublicPricingMode("show", false)).toBe("show");
    expect(normalizePublicPricingMode("on_request", true)).toBe("on_request");
    expect(normalizePublicPricingMode("hidden", true)).toBe("hidden");
    expect(publicPricingLabel("hidden")).toBeNull();
  });

  it("fails closed to the legacy visibility setting for an invalid stored mode", () => {
    expect(normalizePublicPricingMode("unexpected", false)).toBe("on_request");
  });
});
