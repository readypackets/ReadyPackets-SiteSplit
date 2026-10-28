/**
 * SAML 2.0 SSO service.
 *
 * Supports Microsoft Entra ID, Okta, and any standards-compliant SAML 2.0 IdP.
 * Configuration is stored per-tenant in the saml_configs table and is hot-reloaded
 * on each request so an admin can update it without restarting the service.
 *
 * Flow:
 *   1. Browser hits GET /api/saml/login  → service builds AuthnRequest, redirects to IdP
 *   2. IdP authenticates user, POSTs assertion to POST /api/saml/acs
 *   3. ACS validates signature, extracts attributes, provisions/finds the user,
 *      creates a session, and redirects to the portal
 *   4. GET /api/saml/metadata  → SP metadata XML for IdP registration
 *   5. GET /api/saml/logout    → SLO initiation (best-effort)
 */
import { SAML, type SamlConfig } from "@node-saml/node-saml";
import { eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../db/client.js";
import { samlConfigs, users } from "../db/schema.js";
import {
  createUser,
  getUserByEmail,
  recordSuccessfulLogin,
  type CreateUserInput,
} from "../db/users.js";
import { createSession, revokePendingMfaSessions } from "./session.js";
import { env } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { recordSecurityEvent } from "../observability/audit.js";
import { hasConfirmedMfa } from "./mfa.js";
import { getMfaPolicyForRole, mfaRequirement } from "./mfaPolicy.js";
import {
  getSamlAdministratorMfaSourcePolicy,
  hasRequiredSamlMfaAssurance,
  samlMfaAssuranceEvidence,
  requiresSamlEntraAssurance,
  bypassesLocalMfaAfterVerifiedSaml,
} from "./samlMfaSource.js";
import { getSettingBool, getSettingJson } from "../services/settings.js";
import { isAdministratorOnlyAccessEnabled, isRoleBlockedByAdministratorOnlyAccess } from "./adminOnlyAccess.js";


// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

interface SamlConfigRow {
  id: number;
  name: string;
  enabled: boolean;
  entryPoint: string;
  issuer: string;
  idpCertificate: string;
  signatureAlgorithm: string;
  attributeMapping: Record<string, string> | null;
  defaultRole: string;
  autoProvision: boolean;
}

async function getActiveSamlConfig(): Promise<SamlConfigRow | null> {
  const rows = await db
    .select()
    .from(samlConfigs)
    .where(eq(samlConfigs.enabled, true))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0]!;
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    entryPoint: row.entryPoint,
    issuer: row.issuer,
    idpCertificate: row.idpCertificate,
    signatureAlgorithm: row.signatureAlgorithm,
    attributeMapping: row.attributeMapping as Record<string, string> | null,
    defaultRole: row.defaultRole,
    autoProvision: row.autoProvision,
  };
}

function buildSamlInstance(config: SamlConfigRow): SAML {
  const samlOptions: SamlConfig = {
    entryPoint: config.entryPoint,
    issuer: `${env.appUrl}/api/saml/metadata`,
    callbackUrl: `${env.appUrl}/api/saml/acs`,
    idpCert: config.idpCertificate,
    idpIssuer: config.issuer,
    signatureAlgorithm: config.signatureAlgorithm as "sha1" | "sha256" | "sha512",
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    disableRequestedAuthnContext: true,
  };
  return new SAML(samlOptions);
}

function identityProviderHost(entryPoint: string): string | null {
  try {
    return new URL(entryPoint).hostname;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SP Metadata
// ---------------------------------------------------------------------------

export async function handleMetadata(req: Request, res: Response): Promise<void> {
  const config = await getActiveSamlConfig();
  if (!config) {
    res.status(404).type("text/plain").send("SAML SSO is not configured.");
    return;
  }

  const saml = buildSamlInstance(config);
  const metadata = saml.generateServiceProviderMetadata(null, null);
  res.type("application/xml").send(metadata);
}

// ---------------------------------------------------------------------------
// IdP redirect (login initiation)
// ---------------------------------------------------------------------------

export async function handleLoginRedirect(req: Request, res: Response): Promise<void> {
  const config = await getActiveSamlConfig();
  if (!config) {
    res.status(503).type("text/plain").send("SAML SSO is not currently enabled.");
    return;
  }

  try {
    const saml = buildSamlInstance(config);
    // Relay only a strictly local portal/mobile authorization route; never relay user-controlled hosts.
    const requestedReturn = typeof req.query.return_to === "string" ? req.query.return_to : "";
    const relayState = requestedReturn.startsWith("/portal") || (env.mobile.enabled && requestedReturn.startsWith("/api/mobile/v1/authorize?")) ? requestedReturn : "";
    const authorizeUrl = await saml.getAuthorizeUrlAsync(relayState, req.headers.host ?? "", {});
    const redirectUrl = typeof authorizeUrl === "string" ? authorizeUrl : (authorizeUrl as any).context as string;
    await recordSecurityEvent({
      eventType: "saml.login_started",
      outcome: "success",
      message: "SAML SSO redirect initiated",
      ipAddress: req.ip ?? null,
      userAgent: req.headers["user-agent"]?.slice(0, 255) ?? null,
      metadata: {
        samlConfigId: config.id,
        identityProvider: config.name,
        identityProviderHost: identityProviderHost(config.entryPoint),
        serviceProviderEntityId: `${env.appUrl}/api/saml/metadata`,
        relayStateAccepted: Boolean(relayState),
      },
    });
    res.redirect(redirectUrl);
  } catch (err) {
    logger.error("saml.login.redirect_failed", {
      errorName: err instanceof Error ? err.name : "UnknownError",
      samlConfigId: config.id,
      identityProvider: config.name,
    });
    await recordSecurityEvent({
      eventType: "login.failure",
      outcome: "failure",
      message: "SAML SSO redirect could not be initiated",
      ipAddress: req.ip ?? null,
      userAgent: req.headers["user-agent"]?.slice(0, 255) ?? null,
      metadata: { samlConfigId: config.id, identityProvider: config.name },
    });
    res.status(500).type("text/plain").send("Failed to initiate SSO. Please try again.");
  }
}

// ---------------------------------------------------------------------------
// ACS (Assertion Consumer Service) — receives the IdP POST
// ---------------------------------------------------------------------------

export async function handleAcs(req: Request, res: Response): Promise<void> {
  const config = await getActiveSamlConfig();
  if (!config) {
    res.status(503).type("text/plain").send("SAML SSO is not currently enabled.");
    return;
  }

  const samlResponse = req.body?.SAMLResponse as string | undefined;
  if (!samlResponse) {
    res.status(400).type("text/plain").send("Missing SAMLResponse.");
    return;
  }

  const saml = buildSamlInstance(config);
  let profile: Record<string, unknown>;

  try {
    const result = await saml.validatePostResponseAsync(req.body as Record<string, string>);
    profile = result.profile as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("saml.acs.validation_failed", { error: msg });
    await recordSecurityEvent({
      eventType: "login.failure",
      outcome: "failure",
      message: `SAML assertion validation failed: ${msg}`,
      ipAddress: req.ip ?? null,
    });
    res.redirect(`${env.appUrl}/login?error=saml_invalid`);
    return;
  }

  // Extract email from the assertion using the configured attribute mapping.
  const mapping = config.attributeMapping ?? {};
  const emailAttr = mapping["email"] ?? "email";
  const firstNameAttr = mapping["firstName"] ?? "firstName";
  const lastNameAttr = mapping["lastName"] ?? "lastName";

  const rawEmail =
    (profile[emailAttr] as string | undefined) ??
    (profile["nameID"] as string | undefined) ??
    "";

  const email = rawEmail.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    logger.warn("saml.acs.no_email", { profile: JSON.stringify(profile).slice(0, 200) });
    res.redirect(`${env.appUrl}/login?error=saml_no_email`);
    return;
  }

  const firstName = String(profile[firstNameAttr] ?? "").slice(0, 64) || "User";
  const lastName = String(profile[lastNameAttr] ?? "").slice(0, 64) || "";

  // Find or provision the user. Administrator-only access deliberately
  // disables SAML auto-provisioning so no new account can enter during a gate.
  const administratorOnly = await isAdministratorOnlyAccessEnabled();
  let user = await getUserByEmail(email);

  if (!user) {
    if (administratorOnly || !config.autoProvision) {
      logger.warn("saml.acs.no_account", { email: email.slice(0, 4) + "***" });
      await recordSecurityEvent({
        eventType: "login.failure",
        outcome: "failure",
        message: administratorOnly
          ? "SAML login blocked because administrator-only access does not permit auto-provisioning"
          : "SAML login attempted for unregistered user and auto-provisioning is disabled",
        ipAddress: req.ip ?? null,
      });
      res.redirect(`${env.appUrl}/login?error=saml_no_account`);
      return;
    }

    // Auto-provision the account.
    const input: CreateUserInput = {
      email,
      firstName,
      lastName,
      loginMethod: "saml",
      role: config.defaultRole as "admin" | "staff" | "customer",
      emailVerified: true, // IdP-verified
    };
    user = await createUser(input);
    logger.info("saml.user_provisioned", { userId: user.id });
  } else {
    if (!user.samlLoginEnabled) {
      await recordSecurityEvent({
        eventType: "login.failure",
        outcome: "blocked",
        severity: "notice",
        message: "SAML login blocked because this account is configured for local-only sign-in",
        userId: user.id,
        ipAddress: req.ip ?? null,
      });
      res.redirect(`${env.appUrl}/login?error=saml_local_only`);
      return;
    }
    // Ensure the user's login method is set to SAML.
    if (user.loginMethod !== "saml") {
      await db
        .update(users)
        .set({ loginMethod: "saml" })
        .where(eq(users.id, user.id));
    }
  }

  if (await isRoleBlockedByAdministratorOnlyAccess(user.role)) {
    await recordSecurityEvent({
      eventType: "login.blocked_administrator_only",
      outcome: "blocked",
      severity: "notice",
      message: "SAML login blocked by administrator-only access mode",
      userId: user.id,
      ipAddress: req.ip ?? null,
    });
    res.redirect(`${env.appUrl}/login?error=administrator_only`);
    return;
  }

  // Check the user is active and permitted by the optional account whitelist.
  const whitelistEnabled = await getSettingBool("access.login_whitelist_enabled", false);
  const whitelist = whitelistEnabled ? await getSettingJson<string[]>("access.login_whitelist_public_ids", []) : [];
  if (user.status !== "active" || (whitelistEnabled && (!user.publicId || !whitelist.includes(user.publicId.toUpperCase())))) {
    await recordSecurityEvent({
      eventType: "login.failure",
      outcome: "failure",
      message: whitelistEnabled ? "SAML login blocked by account whitelist or account status" : `SAML login blocked: account status is ${user.status}`,
      userId: user.id,
      ipAddress: req.ip ?? null,
    });
    res.redirect(`${env.appUrl}/login?error=account_suspended`);
    return;
  }

  // SAML is the primary factor. The security console can select ReadyPackets
  // local MFA, verified Entra MFA, or both for every SAML principal. Entra trust
  // is never inferred from the issuer alone: it requires an explicitly
  // configured claim and value from the signed assertion.
  const [mfaConfirmed, roleMfaPolicy, samlMfaPolicy] = await Promise.all([
    hasConfirmedMfa(user.id),
    getMfaPolicyForRole(user.role),
    getSamlAdministratorMfaSourcePolicy(),
  ]);
  const requiresEntraAssurance = requiresSamlEntraAssurance(samlMfaPolicy);
  const assuranceEvidence = requiresEntraAssurance
    ? samlMfaAssuranceEvidence(profile, samlMfaPolicy)
    : { claimPresent: false, assuranceSatisfied: false };

  if (requiresEntraAssurance && !hasRequiredSamlMfaAssurance(profile, samlMfaPolicy)) {
    await recordSecurityEvent({
      eventType: "login.failure",
      outcome: "failure",
      severity: "warning",
      message: "SAML login denied because the configured Entra MFA assurance claim was absent or insufficient",
      userId: user.id,
      ipAddress: req.ip ?? null,
      userAgent: req.headers["user-agent"]?.slice(0, 255) ?? null,
      metadata: { mfaSource: samlMfaPolicy.source, claimPresent: assuranceEvidence.claimPresent },
    });
    res.redirect(`${env.appUrl}/login?error=saml_mfa_assurance_required`);
    return;
  }

  // Keep the user record consistent with password and magic-link sign-ins.
  // The customer grid's “Last sign-in” value is derived from lastLoginAt, while
  // the audit event below retains SAML-specific provider/MFA evidence. This is
  // intentionally after all account, access, and Entra-assurance gates pass.
  await recordSuccessfulLogin(user.id, req.ip ?? null);

  // Dual mode always requires a local MFA factor in addition to the signed
  // Entra assurance assertion, even if the generic role policy was relaxed.
  // Entra-only mode intentionally skips the redundant local prompt only after
  // the configured assurance claim has passed the validation above.
  const effectiveLocalPolicy = samlMfaPolicy.source === "both" ? "required" : roleMfaPolicy;
  let requirement = mfaRequirement(effectiveLocalPolicy, mfaConfirmed);
  if (bypassesLocalMfaAfterVerifiedSaml(samlMfaPolicy, assuranceEvidence.assuranceSatisfied)) {
    requirement = { mfaPending: false, restricted: false, mfaRequired: false, mfaSetupRequired: false };
  }

  await revokePendingMfaSessions(user.id);
  await createSession(res, {
    userId: user.id,
    userAgent: req.headers["user-agent"]?.slice(0, 255) ?? null,
    ipAddress: req.ip ?? null,
    mfaPending: requirement.mfaPending,
    restricted: requirement.restricted,
  });
  await recordSecurityEvent({
    eventType: requirement.mfaPending ? "login.mfa_required" : requirement.mfaSetupRequired ? "mfa.enrolment_required" : "login.success",
    outcome: "success",
    message: samlMfaPolicy.source === "entra"
      ? "SAML assertion accepted with configured Entra MFA assurance"
      : samlMfaPolicy.source === "both"
        ? "SAML assertion accepted with Entra MFA assurance; awaiting local MFA"
        : requirement.mfaPending
          ? "SAML assertion accepted; awaiting local second factor"
          : requirement.mfaSetupRequired
            ? "SAML assertion accepted; local MFA enrolment required by policy"
            : "SAML SSO login succeeded",
    userId: user.id,
    ipAddress: req.ip ?? null,
    userAgent: req.headers["user-agent"]?.slice(0, 255) ?? null,
    metadata: {
      authenticationMethod: "saml",
      identityProvider: config.name,
      mfaSource: samlMfaPolicy.source,
      entraAssuranceSatisfied: assuranceEvidence.assuranceSatisfied,
    },
  });
  const relayState = req.body?.RelayState as string | undefined;
  const redirectTo = relayState && relayState.startsWith("/") ? relayState : "/portal";
  const destination = requirement.mfaPending || requirement.mfaSetupRequired ? "/login?from=saml" : redirectTo;
  res.redirect(`${env.appUrl}${destination}`);
}

// ---------------------------------------------------------------------------
// SLO (Single Logout) — best-effort
// ---------------------------------------------------------------------------

export async function handleLogout(req: Request, res: Response): Promise<void> {
  // Clear the local session cookie and redirect to the IdP logout if configured.
  const cookieName = `${env.cookiePrefix}session`;
  res.clearCookie(cookieName, { path: "/" });
  res.redirect(`${env.appUrl}/login?logged_out=1`);
}
