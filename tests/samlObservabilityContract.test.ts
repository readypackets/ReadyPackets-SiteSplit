import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const text = (path: string) => readFile(`${root}/${path}`, "utf8");

describe("SAML Entra registration and observability safeguards", () => {
  it("keeps the Portal entity ID, ACS, and configured IdP issuer distinct", async () => {
    const saml = await text("server/auth/saml.ts");
    expect(saml).toContain('issuer: `${env.appUrl}/api/saml/metadata`');
    expect(saml).toContain('callbackUrl: `${env.appUrl}/api/saml/acs`');
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
    expect(saml).toContain("relayStateAccepted: Boolean(relayState)");
    expect(saml).not.toContain("metadata: { relayState");
  });

  it("labels Entra values so IdP and service-provider identifiers cannot be confused", async () => {
    const setup = await text("client/src/pages/admin/EntraSetup.tsx");
    expect(setup).toContain('label: "Identifier (Entity ID)"');
    expect(setup).toContain('label: "Sign-on URL"');
    expect(setup).toContain("Microsoft Entra Identifier (IdP issuer)");
  });
});
