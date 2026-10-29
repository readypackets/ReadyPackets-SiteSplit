import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  parsePlatformSetupProfile,
  PLATFORM_SETUP_PROFILE_FORMAT,
  PLATFORM_SETUP_PROFILE_VERSION,
} from "../server/services/platformSetupProfile.js";

function profile() {
  return {
    format: PLATFORM_SETUP_PROFILE_FORMAT,
    formatVersion: PLATFORM_SETUP_PROFILE_VERSION,
    exportedAt: "2026-10-20T19:00:00.000Z",
    setup: {
      email: {
        transport: "graph",
        smtp: { host: "", port: 587, user: "", from: "no-reply@readypackets.com", replyTo: "", secure: false },
        graph: { tenantId: "tenant.example", clientId: "00000000-0000-4000-8000-000000000001", sender: "tools@readypackets.com" },
        requiresSecret: true,
      },
      sharePoint: {
        tenantId: "tenant.example",
        clientId: "00000000-0000-4000-8000-000000000002",
        siteId: "contoso.sharepoint.com,site-id,web-id",
        driveId: "b!drive-id",
        siteUrl: "https://contoso.sharepoint.com/sites/ReadyPackets",
        rootFolderPath: "RP_Intake_Raw/ReadyPackets",
        audioFallbackMode: "mp3",
        requiresClientSecret: true,
      },
      backup: { scheduleTime: "02:30", cloudTargets: [{ provider: "Amazon S3", destination: "archive:readypackets" }], cloudCredentialsIncluded: false },
      webhooks: { p101: { url: "https://automation.example.test/p101", enabled: true }, p201: { url: "", enabled: false }, requiresSigningSecrets: true, requiresDestinationConfiguration: true },
      stripe: { publishableKey: "pk_live_public_value", requiresSecretKey: true, requiresWebhookSecret: true },
      reviewRequired: { entra: true, accessControls: true },
    },
  };
}

describe("portable Platform Setup profiles", () => {
  it("accepts a versioned secret-free configuration profile", () => {
    expect(parsePlatformSetupProfile(profile())).toMatchObject({
      format: PLATFORM_SETUP_PROFILE_FORMAT,
      setup: { backup: { cloudCredentialsIncluded: false }, reviewRequired: { entra: true, accessControls: true } },
    });
  });

  it("rejects unversioned or secret-inclusive profile formats", () => {
    expect(() => parsePlatformSetupProfile({ ...profile(), formatVersion: 2 })).toThrow();
    expect(() => parsePlatformSetupProfile({ ...profile(), setup: { ...profile().setup, backup: { ...profile().setup.backup, cloudCredentialsIncluded: true } } })).toThrow();
  });

  it("keeps fixed backup directory provisioning out of the capability-restricted request controller", async () => {
    const [control, installer] = await Promise.all([
      readFile("deploy/backup-control.sh", "utf8"),
      readFile("deploy/install.sh", "utf8"),
    ]);
    expect(control).toContain('verify_fixed_directory "$BACKUP_DIR" "root:readypackets:2750"');
    expect(control).toContain('verify_fixed_directory "$STATE_DIR" "root:root:700"');
    expect(control).not.toContain('install -d -m 2750 "$BACKUP_DIR" "$EXPORT_DIR"');
    expect(installer).toContain("install -d -m 0700 -o root -g root /var/lib/readypackets/backup-control");
  });

  it("makes fresh portal installs choose a portal-only client surface", async () => {
    const [env, app, installer] = await Promise.all([
      readFile("server/config/env.ts", "utf8"),
      readFile("server/app.ts", "utf8"),
      readFile("deploy/install.sh", "utf8"),
    ]);
    expect(env).toContain('const portalOnly = bool("PORTAL_ONLY", false);');
    expect(env).toContain("siteSplitEnabled: portalOnly || publicSiteUrl.hostname !== appUrl.hostname");
    expect(app).toContain("!env.portalOnly && req.hostname === env.publicHostname");
    expect(installer).toContain("PORTAL_ONLY=$([[ -z \"${PUBLIC_DOMAIN:-}\" ]] && printf true || printf false)");
  });
});
