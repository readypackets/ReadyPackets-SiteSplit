import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const text = (path: string) => readFile(`${root}/${path}`, "utf8");

function procedure(source: string, name: string, nextName: string) {
  const start = source.indexOf(`  ${name}:`);
  const end = source.indexOf(`\n  ${nextName}:`, start);
  expect(start, `Missing ${name} procedure`).toBeGreaterThanOrEqual(0);
  expect(end, `Missing end of ${name} procedure`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("per-account SSO and local authentication conversion", () => {
  it("adds an idempotent, default-preserving per-account SAML gate", async () => {
    const [schema, migration, subjectMigration] = await Promise.all([
      text("server/db/schema.ts"),
      text("drizzle/migrations/0060_per_account_saml_login_control.sql"),
      text("drizzle/migrations/0061_saml_subject_binding.sql"),
    ]);

    expect(schema).toContain('samlLoginEnabled: boolean("saml_login_enabled").notNull().default(true)');
    expect(migration).toContain("information_schema.columns");
    expect(migration).toContain("column_name = 'saml_login_enabled'");
    expect(migration).toContain("ADD COLUMN `saml_login_enabled` BOOLEAN NOT NULL DEFAULT TRUE");
    expect(schema).toContain('samlSubjectIndex: varchar("saml_subject_index", { length: 64 })');
    expect(schema).toContain('samlSubjectConfigId: int("saml_subject_config_id")');
    expect(schema).toContain('uniqueIndex("users_saml_subject_unique")');
    expect(subjectMigration).toContain("saml_subject_index");
    expect(subjectMigration).toContain("users_saml_subject_unique");
  });

  it("converts only a different active SSO account, forces a password change, disables SSO, and revokes browser/mobile sessions", async () => {
    const router = await text("server/routers/admin.ts");
    const conversion = procedure(router, "convertSamlAccountToLocal", "convertLocalAccountToSaml");

    expect(conversion).toContain("convertSamlAccountToLocal: adminProcedure");
    expect(conversion).toContain('confirmation: z.literal("ENABLE LOCAL LOGIN")');
    expect(conversion).toContain("if (input.userId === ctx.session.user.id)");
    expect(conversion).toContain('user.loginMethod !== "saml"');
    expect(conversion).toContain("passwordHash: await hashPassword(temporary)");
    expect(conversion).toContain("mustChangePassword: true");
    expect(conversion).toContain('loginMethod: "local"');
    expect(conversion).toContain("samlLoginEnabled: false");
    expect(conversion).toContain('revokeAllUserSessions(input.userId, "saml_converted_to_local")');
    expect(conversion).toContain('revokeMobileSessionsForUser(input.userId, "saml_converted_to_local")');
    expect(conversion).toContain("passwordResetTokens");
  });

  it("audits SSO-to-local conversion without writing a password or email address", async () => {
    const router = await text("server/routers/admin.ts");
    const conversion = procedure(router, "convertSamlAccountToLocal", "convertLocalAccountToSaml");

    expect(conversion).toContain('action: "account.saml_converted_to_local"');
    expect(conversion).toContain('message: "Administrator converted SSO account to local-only sign-in"');
    expect(conversion).toContain('changes: { authenticationMethod: "local", samlLoginEnabled: false, mustChangePassword: true }');
    expect(conversion).not.toMatch(/metadata:\s*\{[^}]*temporary/i);
    expect(conversion).not.toMatch(/changes:\s*\{[^}]*temporary/i);
    expect(conversion).not.toContain("email:");
  });

  it("converts only a different verified local account to an enabled Entra SSO configuration and removes local credentials", async () => {
    const router = await text("server/routers/admin.ts");
    const conversion = procedure(router, "convertLocalAccountToSaml", "adminSendPasswordResetLink");

    expect(conversion).toContain("convertLocalAccountToSaml: adminProcedure");
    expect(conversion).toContain('confirmation: z.literal("ENABLE ENTRA SSO")');
    expect(conversion).toContain("if (input.userId === ctx.session.user.id)");
    expect(conversion).toContain('user.loginMethod !== "local"');
    expect(conversion).toContain("if (!user.emailVerified)");
    expect(conversion).toContain("samlConfigs.enabled, true");
    expect(conversion).toContain("activeSamlConfig.length !== 1");
    expect(conversion).toContain("Keep a different active local-only administrator with confirmed MFA");
    expect(conversion).toContain("hasConfirmedMfa(candidate.id)");
    expect(conversion).toContain("passwordHash: null");
    expect(conversion).toContain('loginMethod: "saml"');
    expect(conversion).toContain("samlLoginEnabled: true");
    expect(conversion).toContain("samlSubjectIndex: null");
    expect(conversion).toContain("samlSubjectConfigId: null");
    expect(conversion).toContain("mustChangePassword: false");
    expect(conversion).toContain('revokeAllUserSessions(input.userId, "local_converted_to_saml")');
    expect(conversion).toContain('revokeMobileSessionsForUser(input.userId, "local_converted_to_saml")');
    expect(conversion).toContain('action: "account.local_converted_to_saml"');
  });

  it("audits local-to-Entra conversion without persisting email or password material", async () => {
    const router = await text("server/routers/admin.ts");
    const conversion = procedure(router, "convertLocalAccountToSaml", "adminSendPasswordResetLink");

    expect(conversion).toContain('message: "Administrator converted local account to SAML single sign-on"');
    expect(conversion).toContain('changes: { authenticationMethod: "saml", samlLoginEnabled: true, localPasswordRemoved: true, samlConfigId: samlConfig.id }');
    expect(conversion).not.toMatch(/metadata:\s*\{[^}]*email/i);
    expect(conversion).not.toMatch(/changes:\s*\{[^}]*passwordHash/i);
  });

  it("blocks disabled SAML and unapproved local accounts at the assertion boundary without changing their login method", async () => {
    const saml = await text("server/auth/saml.ts");
    const localOnlyStart = saml.indexOf("if (!user.samlLoginEnabled)");
    const conversionRequiredStart = saml.indexOf('if (user.loginMethod !== "saml")');

    expect(localOnlyStart).toBeGreaterThanOrEqual(0);
    expect(conversionRequiredStart).toBeGreaterThan(localOnlyStart);
    expect(saml).toContain('res.redirect(`${env.appUrl}/login?error=saml_local_only`)');
    expect(saml).toContain("SAML login blocked because this account is configured for local-only sign-in");
    expect(saml).toContain('res.redirect(`${env.appUrl}/login?error=saml_conversion_required`)');
    expect(saml).toContain("SAML login blocked because the account has not been approved for single sign-on");
    expect(saml).toContain("getUserBySamlSubject(config.id, subject)");
    expect(saml).toContain("bindUserSamlSubject(user.id, config.id, subject)");
    expect(saml).not.toContain('.set({ loginMethod: "saml" })');
  });

  it("fails closed rather than choosing an arbitrary enabled SAML configuration", async () => {
    const saml = await text("server/auth/saml.ts");
    expect(saml).toContain(".limit(2)");
    expect(saml).toContain("if (rows.length !== 1) return null");
    expect(saml).toContain("Choosing an arbitrary");
  });

  it("keeps assertion diagnostics and password-reset completion free of account conversion bypasses", async () => {
    const [saml, auth] = await Promise.all([
      text("server/auth/saml.ts"),
      text("server/routers/auth.ts"),
    ]);

    expect(saml).toContain('logger.warn("saml.acs.validation_failed", { samlConfigId: config.id })');
    expect(saml).not.toContain("JSON.stringify(profile).slice(0, 200)");
    expect(auth).toContain('user.status !== "active" || user.loginMethod !== "local"');
    expect(auth).toContain('eq(users.loginMethod, "local")');
    expect(auth).toContain('eq(users.status, "active")');
    expect(auth).toContain("affectedRows(consumed) !== 1");
  });

  it("gives administrators confirmed conversion UIs and gives affected users local-login guidance", async () => {
    const [customers, login] = await Promise.all([
      text("client/src/pages/admin/Customers.tsx"),
      text("client/src/pages/auth/Login.tsx"),
    ]);

    expect(customers).toContain("Enable local sign-in");
    expect(customers).toContain('localLoginConfirmation !== "ENABLE LOCAL LOGIN"');
    expect(customers).toContain("This disables SSO for this account only");
    expect(customers).toContain("existing MFA enrolment remains in force");
    expect(customers).toContain("Enable Microsoft Entra SSO");
    expect(customers).toContain('entraLoginConfirmation !== "ENABLE ENTRA SSO"');
    expect(customers).toContain("This permanently removes the local password");
    expect(customers).toContain("The user&apos;s role, orders, profile, and MFA enrolment remain unchanged.");
    expect(login).toContain('error === "saml_local_only"');
    expect(login).toContain('error === "saml_conversion_required"');
    expect(login).toContain('error === "saml_identity_required" || error === "saml_identity_mismatch"');
    expect(login).toContain("Use the local email and password supplied by your administrator.");
  });

  it("does not offer an unusable password reset before SSO conversion", async () => {
    const [router, customers] = await Promise.all([
      text("server/routers/admin.ts"),
      text("client/src/pages/admin/Customers.tsx"),
    ]);
    const reset = procedure(router, "adminResetPassword", "convertSamlAccountToLocal");

    expect(reset).toContain('user.loginMethod !== "local"');
    expect(reset).toContain("Convert this single sign-on account to local sign-in before resetting its password.");
    expect(router).toContain("loginMethod: user.loginMethod");
    expect(customers).toContain('row.loginMethod === "local"');
  });
});
