import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const text = (path: string) => readFile(`${root}/${path}`, "utf8");

describe("SAML Entra registration and observability safeguards", () => {
  it("keeps the Portal entity ID, ACS, and configured IdP issuer distinct", async () => {
    const saml = await text("server/auth/saml.ts");
    expect(saml).toContain('issuer: `${env.appUrl}/api/saml/metadata`');
    expect(saml).toContain('callbackUrl: `${env.appUrl}/api/saml/acs`');
    expect(saml).toContain('authnRequestBinding: "HTTP-Redirect"');
    expect(saml).toContain("idpIssuer: config.issuer");
  });

  it("records a privacy-minimised initiation event for Entra correlation", async () => {
    const [saml, audit] = await Promise.all([
      text("server/auth/saml.ts"),
      text("server/observability/audit.ts"),
    ]);
    expect(audit).toContain('"saml.login_started"');
    expect(saml).toContain('eventType: "saml.login_started"');
    expect(saml).toContain("identityProviderHost");
    expect(saml).toContain('authnRequestBinding: "HTTP-Redirect"');
    expect(saml).toContain("outboundSamlRequestPresent: true");
    expect(saml).toContain('redirect.searchParams.get("SAMLRequest")');
    expect(saml).toContain("relayStateAccepted: Boolean(relayState)");
    expect(saml).not.toContain("metadata: { relayState");
  });

  it("keeps assertion failure diagnostics bounded to the configuration identifier", async () => {
    const saml = await text("server/auth/saml.ts");
    expect(saml).toContain('logger.warn("saml.acs.validation_failed", { samlConfigId: config.id })');
    expect(saml).toContain('message: "SAML assertion validation failed"');
    expect(saml).toContain('logger.warn("saml.acs.no_email", { samlConfigId: config.id })');
    expect(saml).not.toContain("JSON.stringify(profile).slice(0, 200)");
    expect(saml).not.toContain("SAML assertion validation failed: ${msg}");
  });

  it("does not retain malformed ACS assertion query strings in edge access logs", async () => {
    const nginx = await text("deploy/nginx.conf");
    expect(nginx).toContain("location = /api/saml/acs");
    expect(nginx).toContain("access_log off;");
  });

  it("labels Entra values and rejects swapped Portal endpoint values", async () => {
    const [setup, system, securityRouter, platformSetup, config] = await Promise.all([
      text("client/src/pages/admin/EntraSetup.tsx"),
      text("client/src/pages/admin/System.tsx"),
      text("server/routers/adminSecurity.ts"),
      text("server/routers/platformSetup.ts"),
      text("server/auth/samlConfig.ts"),
    ]);
    expect(setup).toContain('label: "Identifier (Entity ID)"');
    expect(setup).toContain('label: "Sign-on URL (ReadyPackets SP launch URL)"');
    expect(setup).toContain("Microsoft Entra Login URL (IdP SSO endpoint)");
    expect(securityRouter).toContain("signOnUrl: `${env.appUrl}/api/saml/login`");
    expect(setup).toContain("Microsoft Entra Identifier (IdP issuer)");
    expect(system).toContain("Identity provider Login URL (SAML entry point)");
    expect(securityRouter).toContain("isReadyPacketsSamlServiceUrl");
    expect(platformSetup).toContain("isReadyPacketsSamlServiceUrl");
    expect(config).toContain('"/api/saml/login"');
  });
});
