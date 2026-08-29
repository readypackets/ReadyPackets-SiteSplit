import { getSetting, getSettingBool } from "./settings.js";

export const PUBLIC_PRICING_MODES = ["show", "on_request", "hidden"] as const;
export type PublicPricingMode = (typeof PUBLIC_PRICING_MODES)[number];

export interface CatalogPresentationSettings {
  pricingMode: PublicPricingMode;
  publicDeliveryEstimatesVisible: boolean;
  customerPortalDeliveryEstimatesVisible: boolean;
  publicReviewsNavigationVisible: boolean;
  publicCommunityNavigationVisible: boolean;
}

/**
 * Preserves the earlier boolean setting during upgrades. A legacy false value
 * maps to the former customer-facing behavior, "Pricing on request", rather
 * than unexpectedly hiding the pricing area altogether.
 */
export function normalizePublicPricingMode(value: string | null, legacyVisible: boolean): PublicPricingMode {
  return value === "show" || value === "on_request" || value === "hidden"
    ? value
    : legacyVisible
      ? "show"
      : "on_request";
}

/**
 * Only controls presentation. Checkout, protected customer quotes, invoices,
 * and the integer-cent catalog price remain server-authoritative.
 */
export async function getCatalogPresentationSettings(): Promise<CatalogPresentationSettings> {
  const [pricingModeValue, legacyPriceVisibility, publicDelivery, portalDelivery, reviewsNavigation, communityNavigation] = await Promise.all([
    getSetting("catalog.public_pricing_mode"),
    getSettingBool("catalog.public_prices_visible", true),
    getSettingBool("catalog.public_delivery_estimates_visible", true),
    getSettingBool("catalog.customer_portal_delivery_estimates_visible", true),
    getSettingBool("public.navigation.reviews_visible", true),
    getSettingBool("public.navigation.community_visible", true),
  ]);

  return {
    pricingMode: normalizePublicPricingMode(pricingModeValue, legacyPriceVisibility),
    publicDeliveryEstimatesVisible: publicDelivery,
    customerPortalDeliveryEstimatesVisible: portalDelivery,
    publicReviewsNavigationVisible: reviewsNavigation,
    publicCommunityNavigationVisible: communityNavigation,
  };
}

export function publicPricingLabel(mode: PublicPricingMode): string | null {
  if (mode === "on_request") return "Pricing on request";
  return null;
}
