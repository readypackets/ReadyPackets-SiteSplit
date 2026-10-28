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

describe("per-account SSO-to-local conversion", () => {
  it("adds an idempotent, default-preserving per-account SAML gate", async () => {
    const [schema, migration] = await Promise.all([
      text("server/db/schema.ts"),
      text("drizzle/migrations/0060_per_account_saml_login_control.sql"),
    ]);

    expect(schema).toContain('samlLoginEnabled: boolean("saml_login_enabled").notNull().default(true)');
    expect(migration).toContain("information_schema.columns");
    expect(migration).toContain("column_name = 'saml_login_enabled'");
    expect(migration).toContain("ADD COLUMN `saml_login_enabled` BOOLEAN NOT NULL DEFAULT TRUE");
  });

  it("converts only a different active SSO account, forces a password change, disables SSO, and revokes sessions", async () => {
    const router = await text("server/routers/admin.ts");
    const conversion = procedure(router, "convertSamlAccountToLocal", "adminSendPasswordResetLink");

    expect(conversion).toContain("convertSamlAccountToLocal: adminProcedure");
    expect(conversion).toContain('confirmation: z.literal("ENABLE LOCAL LOGIN")');
    expect(conversion).toContain("if (input.userId === ctx.session.user.id)");
    expect(conversion).toContain('user.loginMethod !== "saml"');
    expect(conversion).toContain("passwordHash: await hashPassword(temporary)");
    expect(conversion).toContain("mustChangePassword: true");
    expect(conversion).toContain('loginMethod: "local"');
    expect(conversion).toContain("samlLoginEnabled: false");
    expect(conversion).toContain('revokeAllUserSessions(input.userId, "saml_converted_to_local")');
  });

  it("audits the privileged conversion without writing a password or email address", async () => {
    const router = await text("server/routers/admin.ts");
    const conversion = procedure(router, "convertSamlAccountToLocal", "adminSendPasswordResetLink");

    expect(conversion).toContain('action: "account.saml_converted_to_local"');
    expect(conversion).toContain('message: "Administrator converted SSO account to local-only sign-in"');
    expect(conversion).toContain('changes: { authenticationMethod: "local", samlLoginEnabled: false, mustChangePassword: true }');
    expect(conversion).not.toMatch(/metadata:\s*\{[^}]*temporary/i);
    expect(conversion).not.toMatch(/changes:\s*\{[^}]*temporary/i);
    expect(conversion).not.toContain("email:");
  });

  it("blocks disabled SAML at the assertion boundary before it can overwrite local-only mode", async () => {
    const saml = await text("server/auth/saml.ts");
    const localOnlyStart = saml.indexOf("if (!user.samlLoginEnabled)");
    const methodOverwriteStart = saml.indexOf('if (user.loginMethod !== "saml")');

    expect(localOnlyStart).toBeGreaterThanOrEqual(0);
    expect(methodOverwriteStart).toBeGreaterThan(localOnlyStart);
    expect(saml).toContain('res.redirect(`${env.appUrl}/login?error=saml_local_only`)');
    expect(saml).toContain("SAML login blocked because this account is configured for local-only sign-in");
  });

  it("gives administrators a confirmed conversion UI and gives affected users local-login guidance", async () => {
    const [customers, login] = await Promise.all([
      text("client/src/pages/admin/Customers.tsx"),
      text("client/src/pages/auth/Login.tsx"),
    ]);

    expect(customers).toContain("Enable local sign-in");
    expect(customers).toContain('localLoginConfirmation !== "ENABLE LOCAL LOGIN"');
    expect(customers).toContain("This disables SSO for this account only");
    expect(customers).toContain("existing MFA enrolment remains in force");
    expect(login).toContain('error === "saml_local_only"');
    expect(login).toContain("Use the local email and password supplied by your administrator.");
  });

  it("does not offer an unusable password reset before SSO conversion", async () => {
    const router = await text("server/routers/admin.ts");
    const reset = procedure(router, "adminResetPassword", "convertSamlAccountToLocal");

    expect(reset).toContain('user.loginMethod !== "local"');
    expect(reset).toContain("Convert this single sign-on account to local sign-in before resetting its password.");
  });
});
