import { getSetting } from "../services/settings.js";

// The historic type name is retained for configuration and API compatibility;
// the selected policy now governs every successfully validated SAML SSO user.
export type SamlAdministratorMfaSource = "local" | "entra" | "both";

export interface SamlAdministratorMfaSourcePolicy {
  source: SamlAdministratorMfaSource;
  claimName: string;
  requiredValue: string;
}

export const DEFAULT_ENTRA_MFA_CLAIM = "http://schemas.microsoft.com/claims/authnmethodsreferences";
export const DEFAULT_ENTRA_MFA_VALUE = "http://schemas.microsoft.com/claims/multipleauthn";

function parseSource(value: string | null): SamlAdministratorMfaSource {
  return value === "entra" || value === "both" || value === "local" ? value : "local";
}

/**
 * Fetches the SAML SSO MFA source policy. The safe default keeps local
 * ReadyPackets MFA mandatory after SAML authentication for every SAML user.
 */
export async function getSamlAdministratorMfaSourcePolicy(): Promise<SamlAdministratorMfaSourcePolicy> {
  const [sourceValue, claimNameValue, requiredValue] = await Promise.all([
    getSetting("security.saml_admin_mfa_source"),
    getSetting("security.saml_entra_mfa_claim_name"),
    getSetting("security.saml_entra_mfa_required_value"),
  ]);

  return {
    source: parseSource(sourceValue),
    claimName: claimNameValue?.trim() || DEFAULT_ENTRA_MFA_CLAIM,
    requiredValue: requiredValue?.trim() || DEFAULT_ENTRA_MFA_VALUE,
  };
}

function valuesFromProfile(profile: Record<string, unknown>, claimName: string): string[] {
  const raw = profile[claimName];
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === "string");
  return [];
}

/**
 * Checks a signed SAML profile for one explicitly configured MFA assurance value.
 * This helper only receives the profile after node-saml validates the assertion
 * signature, issuer, recipient, audience, and assertion timing.
 */
export function hasRequiredSamlMfaAssurance(
  profile: Record<string, unknown>,
  policy: SamlAdministratorMfaSourcePolicy,
): boolean {
  const target = policy.requiredValue.trim().toLowerCase();
  if (!target) return false;
  return valuesFromProfile(profile, policy.claimName).some((value) => value.trim().toLowerCase() === target);
}

/**
 * Returns compact non-secret evidence suitable for an audit event. Never return
 * raw assertion attributes or values because they may contain identity data.
 */
export function samlMfaAssuranceEvidence(
  profile: Record<string, unknown>,
  policy: SamlAdministratorMfaSourcePolicy,
): { claimPresent: boolean; assuranceSatisfied: boolean } {
  const claimPresent = valuesFromProfile(profile, policy.claimName).length > 0;
  return { claimPresent, assuranceSatisfied: hasRequiredSamlMfaAssurance(profile, policy) };
}

/**
 * Entra or dual mode is meaningful only when the signed assertion contains the
 * configured assurance evidence. This applies consistently to all SAML roles.
 */
export function requiresSamlEntraAssurance(policy: SamlAdministratorMfaSourcePolicy): boolean {
  return policy.source !== "local";
}

/**
 * A local ReadyPackets prompt is redundant only in Entra-only mode and only
 * after a signed assertion satisfies the configured Entra MFA assurance claim.
 */
export function bypassesLocalMfaAfterVerifiedSaml(
  policy: SamlAdministratorMfaSourcePolicy,
  assuranceSatisfied: boolean,
): boolean {
  return policy.source === "entra" && assuranceSatisfied;
}
