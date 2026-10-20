/**
 * Registration, email verification, and password recovery.
 *
 * The recovery flow never reveals whether an address is registered: the request
 * form always reports the same outcome. Reset tokens are single-use and are
 * invalidated by the server the moment a new password is set.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearchParams } from "wouter";
import { CheckCircle2, MailCheck, ShieldCheck, UserPlus } from "lucide-react";
import { BRAND } from "@shared/brand";
import { trpc, errorMessage } from "@/lib/trpc";
import { useSession } from "@/lib/session";
import { Button, LinkButton } from "@/components/ui/Button";
import { Checkbox, Input, PasswordInput, Select } from "@/components/ui/Field";
import { Alert, Card, Skeleton } from "@/components/ui/Surface";
import { useToast } from "@/components/ui/Toast";
import { PasswordStrength, evaluatePasswordLocally } from "@/components/PasswordStrength";
import { marketingSiteUrl } from "@/lib/marketing";
import { AuthShell } from "./Login";

interface RegisterForm {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  confirmPassword: string;
  company: string;
  phone: string;
  marketingOptIn: boolean;
  acceptedPolicies: boolean;
}

const EMPTY: RegisterForm = {
  firstName: "",
  lastName: "",
  email: "",
  password: "",
  confirmPassword: "",
  company: "",
  phone: "",
  marketingOptIn: false,
  acceptedPolicies: false,
};

export function RegisterPage() {
  const [, navigate] = useLocation();
  const toast = useToast();
  const session = useSession();
  const customFieldsQuery = trpc.auth.registrationFields.useQuery();

  const [form, setForm] = useState<RegisterForm>(EMPTY);
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Partial<Record<keyof RegisterForm, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const policy = session.passwordPolicy ?? undefined;

  const register = trpc.auth.register.useMutation({
    onSuccess() {
      setDone(true);
      setForm(EMPTY);
      toast.success("Account created", "Check your inbox to confirm your email address.");
    },
    onError(error) {
      setFormError(errorMessage(error));
    },
  });

  const update = <Key extends keyof RegisterForm>(key: Key, value: RegisterForm[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const strength = useMemo(
    () => evaluatePasswordLocally(form.password, policy),
    [form.password, policy],
  );

  const validate = (): boolean => {
    const next: Partial<Record<keyof RegisterForm, string>> = {};
    if (!form.firstName.trim()) next.firstName = "Enter your first name.";
    if (!form.lastName.trim()) next.lastName = "Enter your last name.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) {
      next.email = "Enter a valid email address.";
    }
    if (!strength.valid) next.password = "Your password does not yet meet the requirements below.";
    if (form.password !== form.confirmPassword) {
      next.confirmPassword = "The passwords do not match.";
    }
    if (!form.acceptedPolicies) {
      next.acceptedPolicies = "You must accept the privacy policy and terms to continue.";
    }
    for (const field of customFieldsQuery.data ?? []) {
      if (field.required && !(custom[field.fieldKey] ?? "").trim()) {
        setFormError(`${field.label} is required.`);
        return false;
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (!validate()) return;
    register.mutate({
      email: form.email.trim().toLowerCase(),
      password: form.password,
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      company: form.company.trim() || undefined,
      phone: form.phone.trim() || undefined,
      marketingOptIn: form.marketingOptIn,
      acceptedPolicies: form.acceptedPolicies,
      customFields: Object.keys(custom).length > 0 ? custom : undefined,
    });
  };

  if (!session.registrationEnabled) {
    return (
      <AuthShell
        title="Registration is closed"
        description="New accounts are not being created at the moment."
      >
        <p className="text-sm text-body">
          Contact us and we will arrange access directly, or sign in if you already have an account.
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <a
            href={marketingSiteUrl("/contact")}
            className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-teal px-4 text-sm font-semibold text-white no-underline shadow-sm transition-colors hover:bg-teal-dark"
          >
            Contact us
          </a>
          <LinkButton href="/login" variant="outline" fullWidth>
            Sign in
          </LinkButton>
        </div>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell title="Confirm your email address">
        <div className="text-center">
          <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-success/12 text-success">
            <MailCheck className="size-6" aria-hidden="true" />
          </span>
          <p className="mt-4 text-sm text-body">
            We have sent a confirmation link to your email address. Click it to activate your
            account — the link is valid for 24 hours.
          </p>
          <Alert tone="info" className="mt-5 text-left">
            You will need a confirmed address before placing an order. If the message does not
            arrive within a few minutes, check your spam folder.
          </Alert>
          <Button variant="outline" fullWidth className="mt-5" onClick={() => navigate("/login")}>
            Continue to sign in
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={`Create your ${BRAND.companyShortName} account`}
      description="One account covers your orders, deliverables, support, and the client community."
      footer={
        <>
          Already registered? <Link href="/login">Sign in</Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        {formError ? <Alert tone="danger">{formError}</Alert> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="First name"
            value={form.firstName}
            onChange={(event) => update("firstName", event.target.value)}
            error={errors.firstName}
            autoComplete="given-name"
            required
            maxLength={80}
          />
          <Input
            label="Last name"
            value={form.lastName}
            onChange={(event) => update("lastName", event.target.value)}
            error={errors.lastName}
            autoComplete="family-name"
            required
            maxLength={80}
          />
        </div>

        <Input
          label="Email address"
          type="email"
          value={form.email}
          onChange={(event) => update("email", event.target.value)}
          error={errors.email}
          autoComplete="email"
          required
          maxLength={254}
        />

        <PasswordInput
          label="Password"
          value={form.password}
          onChange={(event) => update("password", event.target.value)}
          error={errors.password}
          autoComplete="new-password"
          required
          footer={<PasswordStrength password={form.password} policy={policy} />}
        />

        <PasswordInput
          label="Confirm password"
          value={form.confirmPassword}
          onChange={(event) => update("confirmPassword", event.target.value)}
          error={errors.confirmPassword}
          autoComplete="new-password"
          required
        />

        {customFieldsQuery.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          (customFieldsQuery.data ?? []).map((field) => {
            const value = custom[field.fieldKey] ?? "";
            const setValue = (next: string) =>
              setCustom((current) => ({ ...current, [field.fieldKey]: next }));

            if (field.fieldType === "select" && Array.isArray(field.options)) {
              return (
                <Select
                  key={field.fieldKey}
                  label={field.label}
                  help={field.helpText ?? undefined}
                  value={value}
                  required={field.required}
                  onChange={(event) => setValue(event.target.value)}
                >
                  <option value="">Please choose…</option>
                  {(field.options as string[]).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              );
            }

            return (
              <Input
                key={field.fieldKey}
                label={field.label}
                help={field.helpText ?? undefined}
                type={field.fieldType === "tel" ? "tel" : "text"}
                value={value}
                required={field.required}
                maxLength={2000}
                onChange={(event) => setValue(event.target.value)}
              />
            );
          })
        )}

        <div className="space-y-3 border-t border-line pt-4">
          <Checkbox
            label={
              <>
                I accept the <Link href="/terms">terms of service</Link> and{" "}
                <Link href="/privacy">privacy policy</Link>.
              </>
            }
            checked={form.acceptedPolicies}
            onChange={(event) => update("acceptedPolicies", event.target.checked)}
            error={errors.acceptedPolicies}
          />
          <Checkbox
            label="Send me occasional updates about new packets and guidance. You can unsubscribe at any time."
            checked={form.marketingOptIn}
            onChange={(event) => update("marketingOptIn", event.target.checked)}
          />
        </div>

        <Button
          type="submit"
          fullWidth
          busy={register.isPending}
          leadingIcon={<UserPlus className="size-4" aria-hidden="true" />}
        >
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [, navigate] = useLocation();
  const session = useSession();
  const [state, setState] = useState<"working" | "ok" | "failed">("working");

  const verify = trpc.auth.verifyEmail.useMutation({
    async onSuccess() {
      setState("ok");
      await session.refresh();
    },
    onError() {
      setState("failed");
    },
  });

  // Run exactly once for the token in the URL.
  useEffect(() => {
    if (!token) {
      setState("failed");
      return;
    }
    verify.mutate({ token });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <AuthShell title="Email verification">
      {state === "working" ? (
        <div className="space-y-3 text-center">
          <Skeleton className="mx-auto h-12 w-12 rounded-full" />
          <p className="text-sm text-body">Confirming your email address…</p>
        </div>
      ) : state === "ok" ? (
        <div className="text-center">
          <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-success/12 text-success">
            <CheckCircle2 className="size-6" aria-hidden="true" />
          </span>
          <h2 className="mt-4 text-base font-semibold text-ink">Your address is confirmed</h2>
          <p className="mt-2 text-sm text-body">
            Thank you. Your account is now fully active and you can place an order.
          </p>
          <Button fullWidth className="mt-5" onClick={() => navigate("/portal")}>
            Go to my portal
          </Button>
        </div>
      ) : (
        <div className="text-center">
          <Alert tone="danger" title="That link is not valid">
            The confirmation link may have expired or already been used. Sign in and request a new
            one from your account settings.
          </Alert>
          <LinkButton href="/login" variant="outline" fullWidth className="mt-5">
            Sign in
          </LinkButton>
        </div>
      )}
    </AuthShell>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const request = trpc.auth.requestPasswordReset.useMutation({
    // Success and "no such account" are indistinguishable by design.
    onSuccess() {
      setSent(true);
    },
    onError(error) {
      setFormError(errorMessage(error));
    },
  });

  if (sent) {
    return (
      <AuthShell title="Check your email">
        <div className="text-center">
          <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-teal/12 text-teal-dark">
            <MailCheck className="size-6" aria-hidden="true" />
          </span>
          <p className="mt-4 text-sm text-body">
            If an account exists for that address, a reset link is on its way. The link can be used
            once and expires in 60 minutes.
          </p>
          <LinkButton href="/login" variant="outline" fullWidth className="mt-5">
            Back to sign in
          </LinkButton>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Reset your password"
      description="Enter the address you registered with and we will send you a reset link."
      footer={
        <>
          Remembered it? <Link href="/login">Sign in</Link>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setFormError(null);
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
            setFormError("Enter a valid email address.");
            return;
          }
          request.mutate({ email: email.trim().toLowerCase() });
        }}
        noValidate
        className="space-y-5"
      >
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

        <Button type="submit" fullWidth busy={request.isPending}>
          Send reset link
        </Button>

        <p className="text-xs text-muted">
          For your protection, reset requests are rate limited. If you have already requested a
          link, wait a few minutes before trying again.
        </p>
      </form>
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [, navigate] = useLocation();
  const session = useSession();
  const toast = useToast();

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const policy = session.passwordPolicy ?? undefined;
  const strength = useMemo(() => evaluatePasswordLocally(password, policy), [password, policy]);

  const reset = trpc.auth.resetPassword.useMutation({
    onSuccess() {
      toast.success("Password updated", "Sign in with your new password.");
      navigate("/login");
    },
    onError(error) {
      setFormError(errorMessage(error));
    },
  });

  if (!token) {
    return (
      <AuthShell title="Reset link required">
        <Alert tone="danger" title="This link is incomplete">
          Open the reset link directly from the email we sent you.
        </Alert>
        <LinkButton href="/forgot-password" variant="outline" fullWidth className="mt-5">
          Request a new link
        </LinkButton>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setFormError(null);
          if (!strength.valid) {
            setFormError("Your password does not yet meet the requirements below.");
            return;
          }
          if (password !== confirmPassword) {
            setFormError("The passwords do not match.");
            return;
          }
          reset.mutate({ token, password });
        }}
        noValidate
        className="space-y-5"
      >
        {formError ? <Alert tone="danger">{formError}</Alert> : null}

        <PasswordInput
          label="New password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          required
          footer={<PasswordStrength password={password} policy={policy} />}
        />

        <PasswordInput
          label="Confirm new password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          autoComplete="new-password"
          required
        />

        <Button
          type="submit"
          fullWidth
          busy={reset.isPending}
          leadingIcon={<ShieldCheck className="size-4" aria-hidden="true" />}
        >
          Set new password
        </Button>

        <p className="text-xs text-muted">
          Setting a new password signs out every other session on your account.
        </p>
      </form>
    </AuthShell>
  );
}
