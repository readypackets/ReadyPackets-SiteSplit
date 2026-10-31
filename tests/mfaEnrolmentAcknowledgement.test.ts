import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const text = (path: string) => readFile(`${root}/${path}`, "utf8");

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Could not locate ${start} to ${end}.`);
  return source.slice(from, to);
}

describe("MFA enrolment recovery-code acknowledgement", () => {
  it("keeps a just-enrolled session restricted until explicit acknowledgement, then rotates it", async () => {
    const [auth, session, audit] = await Promise.all([
      text("server/routers/auth.ts"),
      text("server/auth/session.ts"),
      text("server/observability/audit.ts"),
    ]);
    const confirmation = between(auth, "confirmMfa: sessionProcedure", "regenerateBackupCodes: protectedProcedure");
    const completion = between(auth, "completeMfaEnrolment: sessionProcedure", "regenerateBackupCodes: protectedProcedure");

    expect(confirmation).toContain("requireMfaEnrolmentAcknowledgement(session.sessionId)");
    expect(confirmation).not.toContain("markMfaSatisfied(session.sessionId)");
    expect(session).toContain("set({ mfaPending: false, restricted: true })");
    expect(completion).toContain("if (!session?.restricted)");
    expect(completion).toContain("await hasConfirmedMfa(session.user.id)");
    expect(completion).toContain("await rotateSession(ctx.res, session, { mfaPending: false, restricted: false })");
    expect(audit).toContain('"mfa.enrolment_acknowledged"');
  });

  it("keeps one-time codes mounted through session/status refetches and only continues after the completion mutation", async () => {
    const [security, portalApp, legacyApp] = await Promise.all([
      text("client/src/pages/portal/Security.tsx"),
      text("client/src/PortalApp.tsx"),
      text("client/src/App.tsx"),
    ]);

    expect(security).toContain("const [recoveryCodesVisible, setRecoveryCodesVisible] = useState(false)");
    expect(security).toContain("enabled: !recoveryCodesVisible");
    expect(security).toContain("onRecoveryCodesVisible?.()");
    expect(security).toContain("trpc.auth.completeMfaEnrolment.useMutation");
    expect(security).toContain("completeEnrolment.mutate()");
    expect(security).toContain("copyToClipboard(backupCodes.join");
    expect(security).toContain("Clipboard unavailable");
    expect(portalApp).toContain('location !== "/portal/mfa-setup"');
    expect(legacyApp).toContain('location !== "/portal/mfa-setup"');
  });
});
