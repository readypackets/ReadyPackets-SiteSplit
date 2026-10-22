import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const portalApprovedWordmark = path.join(root, "client/public/brand/readypackets-approved-header-wordmark-light.png");
const mobileWordmark = path.join(root, "mobile/assets/readypackets_wordmark_light.png");
const iosAppIcon = path.join(root, "mobile/ios/ReadyPackets/ReadyPacketsApp/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png");
const androidApprovedIcon = path.join(root, "mobile/android/app/src/main/res/drawable-nodpi/readypackets_brand_icon.png");
const androidLauncher = path.join(root, "mobile/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml");
const retiredAndroidForeground = path.join(root, "mobile/android/app/src/main/res/drawable/ic_launcher_foreground.xml");

function sha256(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

describe("native mobile approved ReadyPackets branding", () => {
  it("keeps iOS and Android launch assets present and non-empty", () => {
    for (const file of [portalApprovedWordmark, mobileWordmark, iosAppIcon, androidApprovedIcon]) {
      expect(existsSync(file), `${file} must exist`).toBe(true);
      expect(statSync(file).size, `${file} must be non-empty`).toBeGreaterThan(1_000);
    }
  });

  it("uses the exact approved wordmark asset in the native mobile shared asset location", () => {
    expect(sha256(mobileWordmark)).toBe(sha256(portalApprovedWordmark));
  });

  it("maps the Android adaptive launcher to the approved icon without the prior generic foreground", () => {
    const launcher = readFileSync(androidLauncher, "utf8");
    expect(launcher).toContain('@drawable/readypackets_brand_icon');
    expect(launcher).not.toContain("ic_launcher_foreground");
    expect(existsSync(retiredAndroidForeground)).toBe(false);
  });
});
