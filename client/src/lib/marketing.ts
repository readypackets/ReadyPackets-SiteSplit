/**
 * External marketing-site navigation for the portal bundle.
 *
 * The portal must not treat the marketing site as an application origin. The
 * server injects this display/navigation-only value into portal.html; malformed
 * or absent values fall back to the canonical public ReadyPackets website.
 */
const FALLBACK_MARKETING_ORIGIN = "https://www.readypackets.com";

function validHttpsOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Returns the configured external marketing origin or a safe ReadyPackets
 * fallback. Pass an absolute site path for an outbound marketing destination.
 */
export function marketingSiteUrl(path?: string): string {
  const configured = typeof document === "undefined"
    ? undefined
    : document.documentElement.dataset.rpMarketingOrigin;
  const origin = validHttpsOrigin(configured) ?? FALLBACK_MARKETING_ORIGIN;
  if (!path) return origin;
  return /^\/(?![\\/])/.test(path) ? new URL(path, origin).toString() : origin;
}
