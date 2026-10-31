/**
 * Security settings: password change, MFA enrolment and management, and the list
 * of active sessions.
 *
 * The QR code is produced by the server as a data URI and the shared secret is
 * shown only during enrolment; afterwards there is no procedure that can read it
 * back, so a stolen session cannot be used to clone the second factor.
 */
import { useState } from "react";
import { useLocation, useSearchParams } from "wouter";
import {
  Copy,
  KeyRound,
  Laptop,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Smartphone,
} from "lucide-react";
import { trpc, errorMessage } from "@/lib/trpc";
import { useSession } from "@/lib/session";
import { copyToClipboard, formatDateTime, formatRelative } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Input, PasswordInput } from "@/components/ui/Field";
import { Alert, Badge, Card, CardHeader, Skeleton } from "@/components/ui/Surface";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { PasswordStrength, evaluatePasswordLocally } from "@/components/PasswordStrength";
import { PageHeader } from "@/components/layout/PortalLayout";

export function SecurityPage() {
  const session = useSession();
  const toast = useToast();
  const [params] = useSearchParams();
  const mfa = trpc.auth.mfaStatus.useQuery();
  const sessions = trpc.auth.sessions.useQuery();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenCode, setRegenCode] = useState("");
  const [freshBackupCodes, setFreshBackupCodes] = useState<string[] | null>(null);

  const policy = session.passwordPolicy ?? undefined;
  const strength = evaluatePasswordLocally(newPassword, policy);

  const changePassword = trpc.auth.changePassword.useMutation({
    async onSuccess() {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      await sessions.refetch();
      toast.success("Password changed", "Every other session has been signed out.");
    },
    onError(error) {
      setPasswordError(errorMessage(error));
    },
  });

  const revokeOthers = trpc.auth.revokeOtherSessions.useMutation({
    async onSuccess() {
      await sessions.refetch();
      toast.success("Other sessions signed out");
    },
    onError(error) {
      toast.error("Could not revoke sessions", errorMessage(error));
    },
  });

  const revokeOne = trpc.auth.revokeSession.useMutation({
    async onSuccess() {
      await sessions.refetch();
      toast.success("Session signed out");
    },
    onError(error) {
      toast.error("Could not revoke that session", errorMessage(error));
    },
  });

  const disableMfa = trpc.auth.disableMfa.useMutation({
    async onSuccess() {
      setDisableOpen(false);
      setDisablePassword("");
      setDisableCode("");
      await mfa.refetch();
      toast.info("Two-factor disabled", "Your account is now protected by password only.");
    },
    onError(error) {
      toast.error("Could not disable two-factor", errorMessage(error));
    },
  });

  const regenerate = trpc.auth.regenerateBackupCodes.useMutation({
    async onSuccess(result) {
      setRegenOpen(false);
      setRegenCode("");
      setFreshBackupCodes(result.backupCodes);
      await mfa.refetch();
    },
    onError(error) {
      toast.error("Could not regenerate codes", errorMessage(error));
    },
  });

  const forcedChange = params.get("change") === "1";

  return (
    <>
      <PageHeader
        title="Security"
        description="Your password, second factor, and the devices currently signed in."
      />

      {forcedChange ? (
        <Alert tone="warning" className="mb-6" title="You must change your password">
          An administrator has required a password change on this account. Set a new password below
          to continue.
        </Alert>
      ) : null}

      {freshBackupCodes ? (
        <Card className="mb-6 border-gold/40 bg-gold/5">
          <CardHeader
            title="Save your new backup codes"
            description="These replace any codes you had before. Each can be used once, and they will not be shown again."
          />
          <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {freshBackupCodes.map((code) => (
              <li
                key={code}
                className="rounded border border-line bg-white px-2.5 py-2 text-center font-mono text-sm tracking-wide text-ink"
              >
                {code}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(freshBackupCodes.join("\n"));
                toast.success("Copied to clipboard");
              }}
              leadingIcon={<Copy className="size-4" aria-hidden="true" />}
            >
              Copy codes
            </Button>
            <Button size="sm" onClick={() => setFreshBackupCodes(null)}>
              I have saved them
            </Button>
          </div>
        </Card>
      ) : null}

      <div className="grid max-w-5xl gap-6 lg:grid-cols-2 lg:items-start">
        {/* Password */}
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <KeyRound className="size-4 text-teal" aria-hidden="true" />
                Password
              </span>
            }
            description="Changing your password signs out every other session."
          />
          <form
            className="mt-5 space-y-5"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              setPasswordError(null);
              if (!strength.valid) {
                setPasswordError("Your new password does not yet meet the requirements.");
                return;
              }
              if (newPassword !== confirmPassword) {
                setPasswordError("The new passwords do not match.");
                return;
              }
              changePassword.mutate({ currentPassword, newPassword });
            }}
          >
            {passwordError ? <Alert tone="danger">{passwordError}</Alert> : null}

            <PasswordInput
              label="Current password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
            <PasswordInput
              label="New password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
              required
              footer={<PasswordStrength password={newPassword} policy={policy} />}
            />
            <PasswordInput
              label="Confirm new password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              required
            />

            <Button type="submit" busy={changePassword.isPending}>
              Change password
            </Button>
          </form>
        </Card>

        {/* MFA */}
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <Smartphone className="size-4 text-teal" aria-hidden="true" />
                Two-factor authentication
              </span>
            }
            description="A time-based code from an authenticator app, required in addition to your password."
          />

          {mfa.isLoading ? (
            <Skeleton className="mt-5 h-24 w-full" />
          ) : mfa.data?.enabled ? (
            <div className="mt-5 space-y-4">
              <p className="flex items-center gap-2 text-sm font-medium text-success">
                <ShieldCheck className="size-4" aria-hidden="true" />
                Enabled on this account
              </p>
              <p className="text-sm text-body">
                {mfa.data.remainingBackupCodes} unused backup{" "}
                {mfa.data.remainingBackupCodes === 1 ? "code" : "codes"} remaining.
                {mfa.data.remainingBackupCodes <= 2
                  ? " Generate a new set before you run out."
                  : ""}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRegenOpen(true)}
                  leadingIcon={<RefreshCw className="size-4" aria-hidden="true" />}
                >
                  New backup codes
                </Button>
                {mfa.data.requiredForRole ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDisableOpen(true)}
                    leadingIcon={<ShieldOff className="size-4" aria-hidden="true" />}
                  >
                    Disable
                  </Button>
                )}
              </div>
              {mfa.data.requiredForRole ? (
                <Alert tone="info">
                  Two-factor authentication is mandatory for administrator accounts and cannot be
                  disabled.
                </Alert>
              ) : null}
            </div>
          ) : (
            <div className="mt-5">
              <Alert tone="warning" title="Not enabled">
                Without a second factor, a stolen password is enough to reach your project material.
              </Alert>
              <MfaEnrolment onComplete={() => void mfa.refetch()} />
            </div>
          )}
        </Card>

        {/* Sessions */}
        <Card className="lg:col-span-2">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <Laptop className="size-4 text-teal" aria-hidden="true" />
                Active sessions
              </span>
            }
            description="Every device currently signed in to your account."
            actions={
              (sessions.data ?? []).length > 1 ? (
                <Button
                  size="sm"
                  variant="outline"
                  busy={revokeOthers.isPending}
                  onClick={() => revokeOthers.mutate()}
                >
                  Sign out all others
                </Button>
              ) : null
            }
          />

          {sessions.isLoading ? (
            <div className="mt-5 space-y-3">
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} className="h-16 w-full" />
              ))}
            </div>
          ) : (
            <ul className="mt-5 divide-y divide-line">
              {(sessions.data ?? []).map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 py-3.5">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                      {entry.current ? <Badge tone="teal">This device</Badge> : null}
                      <Badge tone={entry.status === "active" ? "success" : "neutral"}>
                        {entry.status}
                      </Badge>
                      <span className="font-mono text-xs text-muted">
                        {entry.ipAddress ?? "unknown IP"}
                      </span>
                    </p>
                    <p className="mt-1 truncate text-xs text-muted" title={entry.userAgent ?? ""}>
                      {entry.userAgent ?? "Unknown device"}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      Last active {formatRelative(entry.lastSeenAt)} · expires{" "}
                      {formatDateTime(entry.expiresAt)}
                    </p>
                  </div>
                  {!entry.current && entry.status === "active" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => revokeOne.mutate({ sessionId: entry.id })}
                    >
                      Sign out
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Modal
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        title="Disable two-factor authentication"
        description="Confirm with your password and a current authenticator code."
        footer={
          <>
            <Button variant="outline" onClick={() => setDisableOpen(false)}>
              Keep it enabled
            </Button>
            <Button
              variant="danger"
              busy={disableMfa.isPending}
              disabled={disableCode.trim().length !== 6 || disablePassword.length === 0}
              onClick={() =>
                disableMfa.mutate({ password: disablePassword, code: disableCode.trim() })
              }
            >
              Disable
            </Button>
          </>
        }
      >
        <PasswordInput
          label="Your password"
          value={disablePassword}
          onChange={(event) => setDisablePassword(event.target.value)}
          autoComplete="current-password"
        />
        <Input
          label="Authenticator code"
          className="mt-4"
          value={disableCode}
          onChange={(event) => setDisableCode(event.target.value)}
          inputMode="numeric"
          maxLength={6}
          autoComplete="one-time-code"
        />
      </Modal>

      <Modal
        open={regenOpen}
        onClose={() => setRegenOpen(false)}
        title="Generate new backup codes"
        description="Your existing codes will stop working immediately."
        footer={
          <>
            <Button variant="outline" onClick={() => setRegenOpen(false)}>
              Cancel
            </Button>
            <Button
              busy={regenerate.isPending}
              disabled={regenCode.trim().length !== 6}
              onClick={() => regenerate.mutate({ code: regenCode.trim() })}
            >
              Generate codes
            </Button>
          </>
        }
      >
        <Input
          label="Authenticator code"
          value={regenCode}
          onChange={(event) => setRegenCode(event.target.value)}
          inputMode="numeric"
          maxLength={6}
          autoComplete="one-time-code"
        />
      </Modal>
    </>
  );
}

/** Enrolment flow, shared by the settings page and the mandatory admin gate. */
export function MfaEnrolment({
  onComplete,
  onRecoveryCodesVisible,
}: {
  onComplete?: () => void;
  onRecoveryCodesVisible?: () => void;
}) {
  const toast = useToast();
  const session = useSession();
  const [stage, setStage] = useState<"idle" | "scan" | "codes">("idle");
  const [secret, setSecret] = useState<{ qrDataUrl: string; secret: string; otpauthUrl: string } | null>(
    null,
  );
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  const enroll = trpc.auth.enrollMfa.useMutation({
    onSuccess(result) {
      setSecret(result);
      setStage("scan");
    },
    onError(error) {
      toast.error("Could not start enrolment", errorMessage(error));
    },
  });

  const confirm = trpc.auth.confirmMfa.useMutation({
    onSuccess(result) {
      // Do not refresh the restricted session yet: the route guard would navigate
      // away before the user has a chance to save these one-time recovery codes.
      setBackupCodes(result.backupCodes);
      setStage("codes");
      onRecoveryCodesVisible?.();
    },
    onError(error) {
      setFormError(errorMessage(error));
      setCode("");
    },
  });

  const completeEnrolment = trpc.auth.completeMfaEnrolment.useMutation({
    async onSuccess() {
      await session.refresh();
      onComplete?.();
    },
    onError(error) {
      toast.error("Could not complete MFA enrolment", errorMessage(error));
    },
  });

  if (stage === "idle") {
    return (
      <Button
        className="mt-4"
        busy={enroll.isPending}
        onClick={() => enroll.mutate()}
        leadingIcon={<ShieldCheck className="size-4" aria-hidden="true" />}
      >
        Set up two-factor authentication
      </Button>
    );
  }

  if (stage === "scan" && secret) {
    return (
      <div className="mt-5">
        <ol className="space-y-4 text-sm text-body">
          <li>
            <span className="font-medium text-ink">1. Scan this code</span> with an authenticator
            app such as Aegis, 1Password, Bitwarden, or Google Authenticator.
            <div className="mt-3 inline-block rounded-lg border border-line bg-white p-3">
              <img
                src={secret.qrDataUrl}
                alt="Two-factor authentication QR code"
                width={180}
                height={180}
                className="size-[180px]"
              />
            </div>
          </li>
          <li>
            <span className="font-medium text-ink">Cannot scan?</span> Enter this key manually:
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="rounded border border-line bg-surface-soft px-2.5 py-1.5 font-mono text-xs tracking-wider text-ink">
                {secret.secret}
              </code>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void navigator.clipboard.writeText(secret.secret);
                  toast.success("Key copied");
                }}
                leadingIcon={<Copy className="size-4" aria-hidden="true" />}
              >
                Copy
              </Button>
            </div>
          </li>
          <li>
            <span className="font-medium text-ink">2. Enter the six-digit code</span> your app
            displays.
          </li>
        </ol>

        <form
          className="mt-5 max-w-xs space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setFormError(null);
            confirm.mutate({ code: code.trim() });
          }}
        >
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <Input
            label="Verification code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            className="text-center text-lg tracking-[0.3em]"
            placeholder="000000"
            required
          />
          <Button type="submit" fullWidth busy={confirm.isPending}>
            Verify and enable
          </Button>
        </form>
      </div>
    );
  }

  return (
    <div className="mt-5">
      <Alert tone="success" title="Two-factor authentication is enabled">
        Store these backup codes somewhere safe. Each works once, and they are your way back in if
        you lose your authenticator device. They will not be shown again. Do not close or reload this
        screen until you have saved them.
      </Alert>
      <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {backupCodes.map((backupCode) => (
          <li
            key={backupCode}
            className="rounded border border-line bg-surface-soft px-2.5 py-2 text-center font-mono text-sm tracking-wide text-ink"
          >
            {backupCode}
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => {
            void copyToClipboard(backupCodes.join("\n")).then((copied) => {
              if (copied) toast.success("Copied to clipboard");
              else toast.error("Clipboard unavailable", "Select and copy the codes manually before continuing.");
            });
          }}
          leadingIcon={<Copy className="size-4" aria-hidden="true" />}
        >
          Copy codes
        </Button>
        <Button
          busy={completeEnrolment.isPending}
          onClick={() => {
            completeEnrolment.mutate();
          }}
        >
          I have saved my codes — continue
        </Button>
      </div>
    </div>
  );
}

/** Standalone page used to force administrators through enrolment. */
export function MfaSetupPage() {
  const session = useSession();
  const [, navigate] = useLocation();
  const [recoveryCodesVisible, setRecoveryCodesVisible] = useState(false);
  const mfa = trpc.auth.mfaStatus.useQuery(undefined, { enabled: !recoveryCodesVisible });

  return (
    <>
      <PageHeader
        title="Set up two-factor authentication"
        description={
          session.restricted
            ? "Administrator accounts require a second factor. Complete enrolment to continue."
            : "Add a second factor to protect your account."
        }
      />

      <Card className="max-w-2xl">
        {mfa.data?.enabled && !recoveryCodesVisible ? (
          <Alert tone="success" title="Already enabled">
            Two-factor authentication is active on this account.
          </Alert>
        ) : (
          <>
            <p className="text-sm leading-relaxed text-body">
              You will need an authenticator app on your phone or in your password manager. Any app
              that supports time-based one-time passwords will work; nothing proprietary is required.
            </p>
            <MfaEnrolment
              onRecoveryCodesVisible={() => setRecoveryCodesVisible(true)}
              onComplete={() => {
                setRecoveryCodesVisible(false);
                void mfa.refetch();
                navigate(session.isAdmin || session.isStaff ? "/admin" : "/portal", { replace: true });
              }}
            />
          </>
        )}
      </Card>
    </>
  );
}
