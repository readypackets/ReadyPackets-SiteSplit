import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENTRA_MFA_CLAIM,
  DEFAULT_ENTRA_MFA_VALUE,
  hasRequiredSamlMfaAssurance,
  samlMfaAssuranceEvidence,
  requiresSamlEntraAssurance,
  bypassesLocalMfaAfterVerifiedSaml,
  type SamlAdministratorMfaSourcePolicy,
} from "../server/auth/samlMfaSource.js";

const policy: SamlAdministratorMfaSourcePolicy = {
  source: "entra",
  claimName: DEFAULT_ENTRA_MFA_CLAIM,
  requiredValue: DEFAULT_ENTRA_MFA_VALUE,
};

describe("SAML Entra MFA assurance", () => {
  it("accepts the configured signed multipleauthn indicator among assertion values", () => {
    const profile = {
      [DEFAULT_ENTRA_MFA_CLAIM]: [
        "http://schemas.microsoft.com/ws/2008/06/identity/authenticationmethod/password",
        DEFAULT_ENTRA_MFA_VALUE,
      ],
    };
    expect(hasRequiredSamlMfaAssurance(profile, policy)).toBe(true);
    expect(samlMfaAssuranceEvidence(profile, policy)).toEqual({ claimPresent: true, assuranceSatisfied: true });
  });

  it("fails closed when the assurance claim is absent or only contains first-factor evidence", () => {
    expect(hasRequiredSamlMfaAssurance({}, policy)).toBe(false);
    expect(hasRequiredSamlMfaAssurance({ [DEFAULT_ENTRA_MFA_CLAIM]: "http://schemas.microsoft.com/ws/2008/06/identity/authenticationmethod/password" }, policy)).toBe(false);
  });

  it("requires signed Entra assurance for every SAML role when the source is Entra or dual", () => {
    const localPolicy: SamlAdministratorMfaSourcePolicy = { ...policy, source: "local" };
    const dualPolicy: SamlAdministratorMfaSourcePolicy = { ...policy, source: "both" };
    expect(requiresSamlEntraAssurance(localPolicy)).toBe(false);
    expect(requiresSamlEntraAssurance(policy)).toBe(true);
    expect(requiresSamlEntraAssurance(dualPolicy)).toBe(true);
  });

  it("bypasses the redundant local MFA prompt only for a verified Entra-only SSO assertion", () => {
    const localPolicy: SamlAdministratorMfaSourcePolicy = { ...policy, source: "local" };
    const dualPolicy: SamlAdministratorMfaSourcePolicy = { ...policy, source: "both" };
    expect(bypassesLocalMfaAfterVerifiedSaml(policy, true)).toBe(true);
    expect(bypassesLocalMfaAfterVerifiedSaml(policy, false)).toBe(false);
    expect(bypassesLocalMfaAfterVerifiedSaml(localPolicy, true)).toBe(false);
    expect(bypassesLocalMfaAfterVerifiedSaml(dualPolicy, true)).toBe(false);
  });

  it("matches a custom configured assurance claim case-insensitively without accepting unrelated claims", () => {
    const customPolicy: SamlAdministratorMfaSourcePolicy = {
      source: "entra",
      claimName: "custom-assurance",
      requiredValue: "Assurance-MFA",
    };
    expect(hasRequiredSamlMfaAssurance({ "custom-assurance": "assurance-mfa" }, customPolicy)).toBe(true);
    expect(hasRequiredSamlMfaAssurance({ "other-assurance": "assurance-mfa" }, customPolicy)).toBe(false);
  });
});
