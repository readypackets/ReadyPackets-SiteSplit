/**
 * Sign-in flow, including the second-factor challenge.
 *
 * Failures always show the same generic message regardless of whether the address
 * exists, the password was wrong, or the account is locked, so the form cannot be
 * used to enumerate accounts. The server applies the matching constant-work path.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { KeyRound, LogIn, Mail, ShieldCheck } from "lucide-react";
import { BRAND, BRAND_ASSETS } from "@shared/brand";
import { trpc, errorMessage, refreshCsrfToken } from "@/lib/trpc";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/Button";
import { Input, PasswordInput } from "@/components/ui/Field";
import { Alert, Card } from "@/components/ui/Surface";
import { useToast } from "@/components/ui/Toast";

export function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-surface-soft">
      <a href="#auth-main" className="skip-link">
        Skip to main content
      </a>
      <div className="flex flex-1 items-center justify-center px-4 py-10 sm:py-16">
        <div className="w-full max-w-md">
          <div className="text-center">
            <Link href="/" className="inline-block" aria-label={`${BRAND.companyShortName} home`}>
              <img
                src={BRAND_ASSETS.light.wordmark}
                alt={`${BRAND.wordmark} logo`}
                width={2300}
                height={760}
                className="mx-auto h-12 w-auto"
              />
            </Link>
          </div>

          <Card className="mt-7" as="main">
            <div id="auth-main">
              <h1 className="text-xl font-semibold text-ink">{title}</h1>
              {description ? <p className="mt-1.5 text-sm text-body">{description}</p> : null}
              <div className="mt-6">{children}</div>
            </div>
          </Card>

          {footer ? <div className="mt-5 text-center text-sm text-body">{footer}</div> : null}

          <p className="mt-8 text-center text-xs text-muted">{BRAND.copyright()}</p>
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const [, navigate] = useLocation();
  const toast = useToast();
  const session = useSession();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [stage, setStage] = useState<"credentials" | "mfa" | "mfaSetup">("credentials");
  const [code, setCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const magicHandled = useRef(false);
  const mobileContinuation = (): string | null => {
    const value = new URLSearchParams(window.location.search).get("continue");
    return value?.startsWith("/api/mobile/v1/authorize?") && value.length <= 2048 ? value : null;
  };
  const resumeMobileAuthorization = (): boolean => {
    const destination = mobileContinuation();
    if (!destination) return false;
    window.location.assign(destination);
    return true;
  };

  // A server-side idle timeout can leave a stale session-bound CSRF cookie in an
  // open tab. Refresh a same-origin anonymous token before any new sign-in
  // attempt so the user never needs to clear storage or hard-refresh.
  useEffect(() => {
    void refreshCsrfToken();
  }, []);

  // If a session already exists, do not show the form again.
  useEffect(() => {
    if (session.mfaPending) {
      setStage("mfa");
      return;
    }
    if (session.restricted) {
      navigate("/portal/mfa-setup");
      return;
    }
    if (session.authenticated && session.user) {
      if (resumeMobileAuthorization()) return;
      navigate(session.user.role === "customer" ? "/portal" : "/admin");
    }
  }, [session.authenticated, session.mfaPending, session.restricted, session.user, navigate]);

  const login = trpc.auth.login.useMutation({
    async onSuccess(result) {
      setPassword("");
      if (result.mfaRequired) {
        setStage("mfa");
        return;
      }
      await session.refresh();
      if (result.mfaSetupRequired) {
        toast.info(
          "Two-factor authentication required",
          "Administrators must enrol an authenticator app before continuing.",
        );
        navigate("/portal/mfa-setup");
        return;
      }
      if (result.mustChangePassword) {
        navigate("/portal/security?change=1");
        return;
      }
      if (resumeMobileAuthorization()) return;
      navigate(
        "role" in result && result.role !== "customer" ? "/admin" : "/portal",
      );
    },
    onError(error) {
      setFormError(errorMessage(error));
      setPassword("");
    },
  });

  const verifyMfa = trpc.auth.verifyMfa.useMutation({
    async onSuccess(result) {
      await session.refresh();
      if (resumeMobileAuthorization()) return;
      navigate(
        "role" in result && result.role !== "customer" ? "/admin" : "/portal",
      );
    },
    onError(error) {
      setFormError(errorMessage(error));
      setCode("");
    },
  });

  const requestMagicLink = trpc.auth.requestMagicLink.useMutation({
    onSuccess() {
      toast.success("If an eligible customer account uses that address, a secure sign-in link has been sent.", "The link expires in 15 minutes and requires MFA before portal access.");
    },
    onError(error) { setFormError(errorMessage(error)); },
  });

  const verifyMagicLink = trpc.auth.verifyMagicLink.useMutation({
    async onSuccess(result) {
      await session.refresh();
      if (result.mfaRequired) { setStage("mfa"); return; }
      if (result.mfaSetupRequired) { toast.info("MFA enrolment required", "Set up an authenticator app to complete your secure magic-link sign-in."); navigate("/portal/mfa-setup"); return; }
      if (resumeMobileAuthorization()) return;
      navigate("/portal");
    },
    onError(error) { setFormError(errorMessage(error)); },
  });

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("magic");
    if (!token || magicHandled.current) return;
    magicHandled.current = true;
    window.history.replaceState({}, document.title, "/login");
    void refreshCsrfToken().then(() => verifyMagicLink.mutate({ token }));
  }, [verifyMagicLink]);

  const submitCredentials = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (!email.trim() || !password) {
      setFormError("Enter your email address and password.");
      return;
    }
    await refreshCsrfToken();
    login.mutate({ email: email.trim().toLowerCase(), password });
  };

  const submitMfa = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    // Password and magic-link verification rotate the session and CSRF cookie.
    // Refresh immediately before the MFA mutation so an existing login tab never
    // submits the previous anonymous or expired-session token.
    const token = await refreshCsrfToken();
    if (!token) {
      setFormError("Your sign-in session could not be refreshed. Please try again.");
      return;
    }
    verifyMfa.mutate({ code: code.trim(), useBackupCode });
  };

  const maintenanceBlocking =
    session.maintenance?.enabled && session.maintenance.blocksLogin;

  if (stage === "mfa") {
    return (
      <AuthShell
        title="Two-factor verification"
        description={
          useBackupCode
            ? "Enter one of your single-use backup codes."
            : "Enter the six-digit code from your authenticator app."
        }
      >
        <form onSubmit={submitMfa} noValidate className="space-y-5">
          {formError ? <Alert tone="danger">{formError}</Alert> : null}

          <Input
            label={useBackupCode ? "Backup code" : "Authentication code"}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            inputMode={useBackupCode ? "text" : "numeric"}
            autoComplete="one-time-code"
            // Autofocus is appropriate here: the field is the sole purpose of the page.
            autoFocus
            required
            maxLength={useBackupCode ? 12 : 6}
            className="text-center text-lg tracking-[0.3em]"
            placeholder={useBackupCode ? "XXXX-XXXX" : "000000"}
          />

          <Button
            type="submit"
            fullWidth
            busy={verifyMfa.isPending}
            leadingIcon={<ShieldCheck className="size-4" aria-hidden="true" />}
          >
            Verify and continue
          </Button>

          <button
            type="button"
            onClick={() => {
              setUseBackupCode((current) => !current);
              setCode("");
              setFormError(null);
            }}
            className="w-full text-center text-sm font-medium text-teal-dark underline underline-offset-2"
          >
            {useBackupCode ? "Use an authenticator code instead" : "Use a backup code instead"}
          </button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Sign in"
      description="Access your orders, deliverables, and support history."
      footer={
        session.registrationEnabled ? (
          <>
            New to {BRAND.companyShortName}? <Link href="/register">Create an account</Link>
          </>
        ) : (
          <>
            Registration is currently closed. <Link href="/contact">Contact us</Link> for access.
          </>
        )
      }
    >
      <form onSubmit={submitCredentials} noValidate className="space-y-5">
        {maintenanceBlocking ? (
          <Alert tone="warning" title="Maintenance in progress">
            {session.maintenance?.message}
          </Alert>
        ) : null}

        {formError ? <Alert tone="danger">{formError}</Alert> : null}

        <Input
          label="Email address"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          required
          maxLength={254}
        />

        <PasswordInput
          label="Password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
        />

        <div className="flex items-center justify-end">
          <Link href="/forgot-password" className="text-sm font-medium">
            Forgot your password?
          </Link>
        </div>

        <Button
          type="submit"
          fullWidth
          busy={login.isPending}
          leadingIcon={<LogIn className="size-4" aria-hidden="true" />}
        >
          Sign in
        </Button>

        <div className="border-t border-line pt-4 space-y-3">
          <Button
            type="button"
            fullWidth
            variant="outline"
            busy={requestMagicLink.isPending}
            disabled={maintenanceBlocking || !email.trim()}
            leadingIcon={<Mail className="size-4" aria-hidden="true" />}
            onClick={() => {
              setFormError(null);
              void refreshCsrfToken().then(() => requestMagicLink.mutate({ email: email.trim().toLowerCase() }));
            }}
          >
            Email me a secure sign-in link
          </Button>
          <p className="text-center text-xs text-muted">Customer-only links expire in 15 minutes, work once, and require an authenticator factor before portal access.</p>
          <Button
            type="button"
            fullWidth
            variant="outline"
            disabled={!session.sso.enabled || maintenanceBlocking}
            leadingIcon={<ShieldCheck className="size-4" aria-hidden="true" />}
            onClick={() => { const continuation = mobileContinuation(); window.location.assign(continuation ? `/api/saml/login?return_to=${encodeURIComponent(continuation)}` : "/api/saml/login"); }}
          >
            Continue with Single Sign-On
          </Button>
          <p className="text-center text-xs text-muted">
            {session.sso.enabled
              ? `Use ${session.sso.name ?? "your organization’s"} single sign-on.`
              : "Single Sign-On will be available after an administrator enables a SAML identity provider."}
          </p>
        </div>
      </form>

      <div className="mt-6 border-t border-line pt-5">
        <p className="flex items-start gap-2 text-xs text-muted">
          <KeyRound className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            Sessions are protected with a strict same-site cookie and expire automatically. Review
            and revoke active sessions at any time from your security settings.
          </span>
        </p>
      </div>
    </AuthShell>
  );
}
