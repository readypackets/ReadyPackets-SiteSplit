import { env } from "../config/env.js";

const READY_PACKETS_SAML_SERVICE_PATHS = new Set([
  "/api/saml/login",
  "/api/saml/acs",
  "/api/saml/metadata",
  "/api/saml/logout",
]);

/**
 * An IdP entry point must be the identity provider's Login URL. Rejecting the
 * Portal's own SAML endpoints prevents a field swap that leads Entra to receive
 * an IdP-initiated request without a SAMLRequest query parameter.
 */
export function isReadyPacketsSamlServiceUrl(value: string): boolean {
  try {
    const candidate = new URL(value);
    const portal = new URL(env.appUrl);
    const normalizedPath = candidate.pathname.replace(/\/+$/, "") || "/";
    return candidate.origin === portal.origin && READY_PACKETS_SAML_SERVICE_PATHS.has(normalizedPath);
  } catch {
    return false;
  }
}
