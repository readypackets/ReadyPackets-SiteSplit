/**
 * Authentication router.
 *
 * Design notes that matter for security:
 *  - Every failure path returns the same message and does comparable work, so
 *    account existence cannot be inferred from responses or timing.
 *  - Password reset and verification tokens are single-use, hashed at rest, and
 *    cleared immediately after use.
 *  - Administrators without MFA receive a restricted session that can only
 *    complete enrolment.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import {
  emailVerificationTokens,
  magicLinkTokens,
  passwordResetTokens,
  registrationFields,
  samlConfigs,
  users,
} from "../db/schema.js";
import {
  createUser,
  displayNameOf,
  emailExists,
  getUserByEmail,
  getUserById,
  isAccountLocked,
  markEmailVerified,
  recordFailedLogin,
  recordSuccessfulLogin,
  setMfaEnabled,
  setPasswordHash,
  setProfileValue,
  updateUserProfile,
} from "../db/users.js";
import {
  burnPasswordVerification,
  hashPassword,
  hashToken,
  needsRehash,
  randomToken,
  verifyPassword,
} from "../security/crypto.js";
import {
  clearSessionCookies,
  createSession,
  markMfaSatisfied,
  resolveSession,
  revokePendingMfaSessions,
  revokeAllUserSessions,
  revokeSession,
  rotateSession,
} from "../auth/session.js";
import {
  accountLabelFor,
  beginMfaEnrolment,
  confirmMfaEnrolment,
  consumeBackupCode,
  countUnusedBackupCodes,
  disableMfa,
  hasConfirmedMfa,
  regenerateBackupCodes,
  verifyTotp,
} from "../auth/mfa.js";
import { assertPasswordAcceptable, evaluatePassword } from "../auth/passwordPolicy.js";
import { recordActivity, recordSecurityEvent } from "../observability/audit.js";
import {
  getMaintenanceState,
  getPasswordPolicy,
  getSettingBool,
  getSettingJson,
  getSettingNumber,
  isFeatureEnabled,
} from "../services/settings.js";
import { isIpAllowlisted } from "../security/ipBlacklist.js";
import { button, queueTemplatedEmail, wrapHtmlBody } from "../services/email.js";
import { fireAutomations } from "../services/emailAutomations.js";
import { affectedRows } from "../db/result.js";
import { getMfaPolicyForRole, mfaRequirement } from "../auth/mfaPolicy.js";
import { isAdministratorOnlyAccessEnabled, isRoleBlockedByAdministratorOnlyAccess } from "../auth/adminOnlyAccess.js";
import { getBusinessProfile } from "../services/businessProfile.js";
import { revokeMobileSessionsForUser } from "../auth/mobileOidc.js";
import { publicProcedure, protectedProcedure, router, sessionProcedure } from "../trpc/trpc.js";

/** The single message returned for every credential failure. */
const GENERIC_LOGIN_ERROR = "Invalid email or password.";

async function isLoginWhitelisted(user: { publicId: string | null }): Promise<boolean> {
  if (!await getSettingBool("access.login_whitelist_enabled", false)) return true;
  if (!user.publicId) return false;
  const allowlisted = await getSettingJson<string[]>("access.login_whitelist_public_ids", []);
  return allowlisted.includes(user.publicId.toUpperCase());
}

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(5)
  .max(254)
  .email("Enter a valid email address.");

const passwordSchema = z.string().min(1).max(256);

const nameSchema = z
  .string()
  .trim()
  .max(80)
  .regex(/^[\p{L}\p{M}'\- .]*$/u, "Use letters, spaces, hyphens and apostrophes only.");

function sessionSummary(user: {
  id: number;
  role: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
}) {
  return {
    id: user.id,
    role: user.role,
    emailVerified: user.emailVerified,
    mfaEnabled: user.mfaEnabled,
    mustChangePassword: user.mustChangePassword,
  };
}

async function issueVerificationEmail(userId: number, email: string, name: string) {
  const token = randomToken(32);
  await db.insert(emailVerificationTokens).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  const link = `${env.appUrl}/verify-email?token=${encodeURIComponent(token)}`;
  await queueTemplatedEmail({
    to: email,
    templateKey: "email_verification",
              variables: { name, link, verifyUrl: link, expiry: "24 hours" },

    fallback: {
      subject: "Verify your ReadyPackets account",
      html: wrapHtmlBody(
        "Verify your email address",
        `<h1 style="margin:0 0 12px 0;font-size:20px;">Welcome, {{name}}</h1>
         <p style="margin:0 0 12px 0;">Confirm your email address to activate your ReadyPackets account.</p>
         ${button("Verify my email", "{{link}}")}
         <p style="margin:0;font-size:13px;">This link expires in {{expiry}}. If you did not create an account, no action is needed.</p>`,
      ),
      text: "Verify your email: {{link}}",
    },
  });
}

export const authRouter = router({
  /** Bootstrap payload for the client: session state plus public configuration. */
  session: publicProcedure.query(async ({ ctx }) => {
    const [maintenance, registrationEnabled, policy, ssoRows, businessProfile] = await Promise.all([
      getMaintenanceState(),
      isFeatureEnabled("registration", true),
      getPasswordPolicy(),
      db.select({ name: samlConfigs.name }).from(samlConfigs).where(eq(samlConfigs.enabled, true)).limit(1),
      getBusinessProfile(),
    ]);
    const sso = { enabled: ssoRows.length > 0, name: ssoRows[0]?.name ?? null };

    if (!ctx.session) {
      return {
        authenticated: false as const,
        user: null,
        mfaPending: false,
        restricted: false,
        maintenance,
        registrationEnabled,
        sso,
        passwordPolicy: policy,
        csrfToken: null as string | null,
        businessProfile,
        sessionExpiresAt: null as string | null,
      };
    }

    const user = await getUserById(ctx.session.user.id);
    return {
      authenticated: true as const,
      user: user
        ? {
            ...sessionSummary(user),
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            preferredName: user.preferredName,
            displayName: displayNameOf(user),
            company: user.company,
            onboardingCompleted: user.onboardingCompletedAt !== null,
            timezone: user.timezone,
            publicId: user.publicId,
          }
        : null,
      mfaPending: ctx.session.mfaPending,
      restricted: ctx.session.restricted,
      maintenance,
      registrationEnabled,
      sso,
      passwordPolicy: policy,
      csrfToken: ctx.session.csrfSecret,
      businessProfile,
      sessionExpiresAt: ctx.session.expiresAt.toISOString(),
    };
  }),

  /** Custom registration fields configured by an administrator. */
  registrationFields: publicProcedure.query(async () => {
    const rows = await db
      .select({
        fieldKey: registrationFields.fieldKey,
        label: registrationFields.label,
        helpText: registrationFields.helpText,
        fieldType: registrationFields.fieldType,
        options: registrationFields.options,
        required: registrationFields.required,
      })
      .from(registrationFields)
      .where(eq(registrationFields.enabled, true))
      .orderBy(registrationFields.sortOrder);
    return rows;
  }),

  checkPasswordStrength: publicProcedure
    .input(z.object({ password: z.string().max(256) }))
    .query(async ({ input }) => {
      const policy = await getPasswordPolicy();
      return evaluatePassword(input.password, policy);
    }),

  register: publicProcedure
    .input(
      z.object({
        email: emailSchema,
        password: passwordSchema,
        firstName: nameSchema.min(1, "Enter your first name."),
        lastName: nameSchema.min(1, "Enter your last name."),
        preferredName: nameSchema.optional(),
        company: z.string().trim().max(160).optional(),
        phone: z.string().trim().max(40).optional(),
        marketingOptIn: z.boolean().default(false),
        acceptedPolicies: z.boolean(),
        customFields: z.record(z.string(), z.string().max(2000)).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const maintenance = await getMaintenanceState();
      const bypass = await isIpAllowlisted(ctx.clientIp, "maintenance");
      const maintenanceBlocksRegistration = await getSettingBool("maintenance.blocks_registration", false);
      if (maintenance.enabled && maintenanceBlocksRegistration && !bypass) {
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "New account creation is temporarily unavailable during maintenance.",
        });
      }
      if (await isAdministratorOnlyAccessEnabled()) {
        void recordSecurityEvent({
          eventType: "register.blocked_administrator_only",
          outcome: "blocked",
          severity: "warning",
          message: "Registration blocked by administrator-only access mode",
          subject: input.email,
          ipAddress: ctx.clientIp,
          userAgent: ctx.userAgent,
        });
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "New account creation is temporarily unavailable.",
        });
      }
      if (!(await isFeatureEnabled("registration", true))) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Registration is currently closed. Please contact us for access.",
        });
      }
      if (!input.acceptedPolicies) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You must accept the Privacy Policy and Terms of Service to register.",
        });
      }

      await assertPasswordAcceptable(input.password, {
        email: input.email,
        names: [input.firstName, input.lastName, input.preferredName],
      });

      // Registration always reports success so it cannot be used to enumerate accounts.
      if (await emailExists(input.email)) {
        void recordSecurityEvent({
          eventType: "register.duplicate",
          outcome: "blocked",
          message: "Registration attempted with an address that already exists",
          subject: input.email,
          ipAddress: ctx.clientIp,
        });
        return { ok: true as const, requiresVerification: true };
      }

      const passwordHash = await hashPassword(input.password);
      // When email_verification_bypass is enabled, accounts are pre-verified.
      const emailBypass = await isFeatureEnabled("email_verification_bypass", false);
      const user = await createUser({
        email: input.email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        preferredName: input.preferredName ?? null,
        company: input.company ?? null,
        phone: input.phone ?? null,
        marketingOptIn: input.marketingOptIn,
        role: "customer",
        emailVerified: emailBypass,
      });

      for (const [key, value] of Object.entries(input.customFields ?? {})) {
        await setProfileValue(user.id, key, value);
      }

      if (!emailBypass) {
        await issueVerificationEmail(user.id, user.email, displayNameOf(user));
      }

      void recordSecurityEvent({
        eventType: "register.success",
        message: "New customer account created",
        userId: user.id,
        subject: user.email,
        ipAddress: ctx.clientIp,
      });
      void recordActivity({
        actorUserId: user.id,
        actorRole: "customer",
        action: "account.register",
        entityType: "user",
        entityId: user.id,
        summary: "Customer registered a new account",
        ipAddress: ctx.clientIp,
      });

      // Fire user.registered automation (non-fatal).
      void fireAutomations("user.registered", { userId: user.id });
      return { ok: true as const, requiresVerification: true };
    }),

  requestMagicLink: publicProcedure
    .input(z.object({ email: emailSchema }))
    .mutation(async ({ ctx, input }) => {
      const maintenance = await getMaintenanceState();
      const bypass = await isIpAllowlisted(ctx.clientIp, "maintenance");
      if ((maintenance.enabled && maintenance.blocksLogin && !bypass) || (await isFeatureEnabled("login_block", false) && !bypass)) {
        // Keep the external response uniform while avoiding a usable delivery path during a gate.
        return { ok: true as const };
      }
      if (await isAdministratorOnlyAccessEnabled()) {
        void recordSecurityEvent({
          eventType: "magic_link.blocked_administrator_only",
          outcome: "blocked",
          severity: "notice",
          message: "Magic-link request blocked by administrator-only access mode",
          subject: input.email,
          ipAddress: ctx.clientIp,
          userAgent: ctx.userAgent,
        });
        return { ok: true as const };
      }
      const user = await getUserByEmail(input.email);
      // Customer-only, active accounts receive a link. The constant response avoids account enumeration.
      if (!user || user.role !== "customer" || user.status !== "active") {
        void recordSecurityEvent({ eventType: "magic_link.requested", outcome: "blocked", message: "Magic-link request was not eligible", subject: input.email, ipAddress: ctx.clientIp, userAgent: ctx.userAgent });
        return { ok: true as const };
      }
      const token = randomToken(32);
      const now = new Date();
      await db.update(magicLinkTokens).set({ usedAt: now }).where(and(eq(magicLinkTokens.userId, user.id), isNull(magicLinkTokens.usedAt)));
      await db.insert(magicLinkTokens).values({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 15 * 60_000), requestIp: ctx.clientIp, requestUserAgent: ctx.userAgent });
      const link = `${env.appUrl}/login?magic=${encodeURIComponent(token)}`;
      void queueTemplatedEmail({
        to: user.email,
        templateKey: "customer_magic_link",
        variables: { name: displayNameOf(user), magic_link: link, expires_minutes: "15" },
        fallback: { subject: "Your secure ReadyPackets sign-in link", html: wrapHtmlBody("Your secure sign-in link", `<p>Hello {{name}},</p><p>Use the link below to sign in. It expires in 15 minutes and can be used once.</p>${button("Sign in securely", "{{magic_link}}")}<p>If you did not request this link, you can safely ignore this email.</p>`), text: "Hello {{name}}. Sign in securely within 15 minutes: {{magic_link}}. If you did not request this link, ignore this email." },
      });
      void recordSecurityEvent({ eventType: "magic_link.requested", message: "Customer magic-link sign-in requested", userId: user.id, ipAddress: ctx.clientIp, userAgent: ctx.userAgent });
      return { ok: true as const };
    }),

  verifyMagicLink: publicProcedure
    .input(z.object({ token: z.string().trim().min(32).max(256) }))
    .mutation(async ({ ctx, input }) => {
      const tokenHash = hashToken(input.token);
      const record = (await db.select().from(magicLinkTokens).where(and(eq(magicLinkTokens.tokenHash, tokenHash), isNull(magicLinkTokens.usedAt), gt(magicLinkTokens.expiresAt, new Date()))).limit(1))[0];
      if (!record) {
        void recordSecurityEvent({ eventType: "magic_link.invalid", outcome: "failure", message: "Invalid, expired, or previously used magic link", ipAddress: ctx.clientIp, userAgent: ctx.userAgent });
        throw new TRPCError({ code: "UNAUTHORIZED", message: "This sign-in link is invalid, expired, or has already been used." });
      }
      const user = await getUserById(record.userId);
      if (await isRoleBlockedByAdministratorOnlyAccess(user?.role)) {
        void recordSecurityEvent({
          eventType: "magic_link.blocked_administrator_only",
          outcome: "blocked",
          severity: "notice",
          message: "Magic-link completion blocked by administrator-only access mode",
          userId: record.userId,
          ipAddress: ctx.clientIp,
          userAgent: ctx.userAgent,
        });
        throw new TRPCError({ code: "UNAUTHORIZED", message: "This sign-in link is no longer available." });
      }
      const consumed = await db.update(magicLinkTokens).set({ usedAt: new Date() }).where(and(eq(magicLinkTokens.id, record.id), isNull(magicLinkTokens.usedAt)));
      if (!affectedRows(consumed)) throw new TRPCError({ code: "UNAUTHORIZED", message: "This sign-in link has already been used." });
      if (!user || user.role !== "customer" || user.status !== "active" || !await isLoginWhitelisted(user)) {
        void recordSecurityEvent({ eventType: "magic_link.invalid", outcome: "blocked", message: "Magic-link account was not eligible", userId: record.userId, ipAddress: ctx.clientIp, userAgent: ctx.userAgent });
        throw new TRPCError({ code: "UNAUTHORIZED", message: "This sign-in link is no longer available." });
      }
      // Magic-link authentication is a successful sign-in even when policy requires
      // a second factor before general portal access. Keep the account’s visible
      // last-sign-in fields consistent with password and SAML sign-in paths.
      await recordSuccessfulLogin(user.id, ctx.clientIp);
      const [mfaConfirmed, policy] = await Promise.all([hasConfirmedMfa(user.id), getMfaPolicyForRole(user.role)]);
      const requirement = mfaRequirement(policy, mfaConfirmed);
      await revokePendingMfaSessions(user.id);
      await createSession(ctx.res, { userId: user.id, ipAddress: ctx.clientIp, userAgent: ctx.userAgent, mfaPending: requirement.mfaPending, restricted: requirement.restricted });
      void recordSecurityEvent({ eventType: requirement.mfaPending ? "login.mfa_required" : requirement.mfaSetupRequired ? "mfa.enrolment_required" : "login.success", message: requirement.mfaPending ? "Magic link accepted; awaiting second factor" : requirement.mfaSetupRequired ? "Magic link accepted; MFA enrolment required by policy" : "Magic link accepted", userId: user.id, ipAddress: ctx.clientIp, userAgent: ctx.userAgent, metadata: { authenticationMethod: "magic_link" } });
      return { ok: true as const, mfaRequired: requirement.mfaRequired, mfaSetupRequired: requirement.mfaSetupRequired, role: user.role };
    }),

  login: publicProcedure
    .input(
      z.object({
        email: emailSchema,
        password: passwordSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const maintenance = await getMaintenanceState();
      const bypass = await isIpAllowlisted(ctx.clientIp, "maintenance");
      if (maintenance.enabled && maintenance.blocksLogin && !bypass) {
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "The portal is temporarily unavailable for maintenance.",
        });
      }

      // Admin-configurable login block (separate from maintenance mode).
      const loginBlocked = await isFeatureEnabled("login_block", false);
      if (loginBlocked && !bypass) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Logins are currently disabled. Please contact support for assistance.",
        });
      }

      const user = await getUserByEmail(input.email);

      // Constant-work path: hash comparison happens whether or not the user exists.
      if (!user || !user.passwordHash) {
        await burnPasswordVerification(input.password);
        void recordSecurityEvent({
          eventType: "login.failure",
          outcome: "failure",
          message: "Login failed",
          subject: input.email,
          ipAddress: ctx.clientIp,
          userAgent: ctx.userAgent,
        });
        throw new TRPCError({ code: "UNAUTHORIZED", message: GENERIC_LOGIN_ERROR });
      }

      const lockedUntil = await isAccountLocked(user.id);
      if (lockedUntil) {
        await burnPasswordVerification(input.password);
        void recordSecurityEvent({
          eventType: "login.locked",
          outcome: "blocked",
          severity: "warning",
          message: "Login attempted against a locked account",
          userId: user.id,
          ipAddress: ctx.clientIp,
        });
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "This account is temporarily locked. Try again later or reset your password.",
        });
      }

      if (user.status !== "active") {
        await burnPasswordVerification(input.password);
        throw new TRPCError({ code: "UNAUTHORIZED", message: GENERIC_LOGIN_ERROR });
      }

      if (user.loginMethod === "saml") {
        await burnPasswordVerification(input.password);
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This account signs in with single sign-on. Use the SSO button instead.",
        });
      }

      const passwordOk = await verifyPassword(user.passwordHash, input.password);
      if (!passwordOk) {
        const threshold = await getSettingNumber("auth.lockout_threshold", 8);
        const lockMinutes = await getSettingNumber("auth.lockout_minutes", 15);
        const locked = await recordFailedLogin(user.id, threshold, lockMinutes);
        void recordSecurityEvent({
          eventType: "login.failure",
          outcome: "failure",
          message: locked ? "Login failed; account locked" : "Login failed",
          userId: user.id,
          subject: user.email,
          ipAddress: ctx.clientIp,
          userAgent: ctx.userAgent,
        });
        throw new TRPCError({ code: "UNAUTHORIZED", message: GENERIC_LOGIN_ERROR });
      }

      if (await isRoleBlockedByAdministratorOnlyAccess(user.role)) {
        void recordSecurityEvent({
          eventType: "login.blocked_administrator_only",
          outcome: "blocked",
          severity: "notice",
          message: "Password login blocked by administrator-only access mode",
          userId: user.id,
          ipAddress: ctx.clientIp,
          userAgent: ctx.userAgent,
        });
        throw new TRPCError({ code: "FORBIDDEN", message: "Administrator-only access is currently enabled." });
      }

      if (!await isLoginWhitelisted(user)) {
        void recordSecurityEvent({ eventType: "login.failure", outcome: "blocked", severity: "warning", message: "Login was blocked by the account whitelist", userId: user.id, ipAddress: ctx.clientIp, userAgent: ctx.userAgent });
        throw new TRPCError({ code: "FORBIDDEN", message: "This account is not currently permitted to sign in." });
      }

      // Transparently upgrade legacy bcrypt hashes on successful login.
      if (needsRehash(user.passwordHash)) {
        await setPasswordHash(user.id, await hashPassword(input.password), {
          mustChangePassword: user.mustChangePassword,
        });
      }

      await recordSuccessfulLogin(user.id, ctx.clientIp);

      const [mfaConfirmed, policy] = await Promise.all([hasConfirmedMfa(user.id), getMfaPolicyForRole(user.role)]);
      const requirement = mfaRequirement(policy, mfaConfirmed);

      // Revoke any stale mfaPending sessions before creating a new one.
      // Without this, the browser can accumulate multiple session cookies and
      // the session.refresh() call after verifyMfa may read the old pending
      // session instead of the newly-satisfied one, causing an infinite loop.
      await revokePendingMfaSessions(user.id);

      const { csrfToken } = await createSession(ctx.res, {
        userId: user.id,
        ipAddress: ctx.clientIp,
        userAgent: ctx.userAgent,
        mfaPending: requirement.mfaPending,
        restricted: requirement.restricted,
      });

      void recordSecurityEvent({
        eventType: requirement.mfaPending ? "login.mfa_required" : requirement.mfaSetupRequired ? "mfa.enrolment_required" : "login.success",
        message: requirement.mfaPending ? "Password accepted; awaiting second factor" : requirement.mfaSetupRequired ? "Password accepted; MFA enrolment required by policy" : "Login succeeded",
        userId: user.id,
        ipAddress: ctx.clientIp,
        userAgent: ctx.userAgent,
        metadata: { authenticationMethod: "password" },
      });

      return {
        ok: true as const,
        mfaRequired: requirement.mfaRequired,
        mfaSetupRequired: requirement.mfaSetupRequired,
        mustChangePassword: user.mustChangePassword,
        emailVerified: user.emailVerified,
        role: user.role,
        csrfToken,
      };
    }),

  /** Present the second factor for a session that is awaiting MFA. */
  verifyMfa: sessionProcedure
    .input(
      z.object({
        code: z.string().trim().min(6).max(12),
        useBackupCode: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session;
      if (!session) throw new TRPCError({ code: "UNAUTHORIZED" });
      if (!session.mfaPending) return { ok: true as const };

      const user = await getUserById(session.user.id);
      if (!user) throw new TRPCError({ code: "UNAUTHORIZED" });

      const accepted = input.useBackupCode
        ? await consumeBackupCode(user.id, input.code)
        : (await verifyTotp(user.id, input.code, accountLabelFor(user.id, user.email))).valid;

      if (!accepted) {
        void recordSecurityEvent({
          eventType: "login.mfa_failure",
          outcome: "failure",
          severity: "warning",
          message: input.useBackupCode
            ? "Backup code rejected"
            : "Authenticator code rejected",
          userId: user.id,
          ipAddress: ctx.clientIp,
        });
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "That verification code is not valid.",
        });
      }

      // Rotate the session after MFA succeeds: this revokes the mfaPending
      // session and issues a fresh cookie. The browser then has exactly one
      // valid session cookie pointing at a row with mfaPending=false, so the
      // subsequent session.refresh() call reliably returns authenticated=true.
      await rotateSession(ctx.res, session, { mfaPending: false, restricted: false });
      void recordSecurityEvent({
        eventType: input.useBackupCode ? "mfa.backup_code_used" : "login.mfa_success",
        message: input.useBackupCode
          ? "Signed in using a backup code"
          : "Second factor accepted",
        userId: user.id,
        ipAddress: ctx.clientIp,
      });

      return { ok: true as const, role: user.role };
    }),

  logout: sessionProcedure.mutation(async ({ ctx }) => {
    const session = ctx.session;
    if (session) {
      await revokeSession(session.sessionId, "user_logout");
      void recordSecurityEvent({
        eventType: "logout",
        message: "User signed out",
        userId: session.user.id,
        ipAddress: ctx.clientIp,
      });
    }
    clearSessionCookies(ctx.res);
    return { ok: true as const };
  }),

  requestPasswordReset: publicProcedure
    .input(z.object({ email: emailSchema }))
    .mutation(async ({ ctx, input }) => {
      const user = await getUserByEmail(input.email);

      // Always report success; the response must not reveal whether the address exists.
      if (user && user.status === "active" && user.loginMethod === "local") {
        const token = randomToken(32);
        await db.insert(passwordResetTokens).values({
          userId: user.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
          requestIp: ctx.clientIp.slice(0, 64),
        });
        const link = `${env.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
        await queueTemplatedEmail({
          to: user.email,
          templateKey: "password_reset",
          variables: { name: displayNameOf(user), link, resetUrl: link, expiry: "30 minutes" },
          fallback: {
            subject: "Reset your ReadyPackets password",
            html: wrapHtmlBody(
              "Reset your password",
              `<h1 style="margin:0 0 12px 0;font-size:20px;">Password reset requested</h1>
               <p style="margin:0 0 12px 0;">Hello {{name}}, use the button below to choose a new password.</p>
               ${button("Choose a new password", "{{link}}")}
               <p style="margin:0;font-size:13px;">This link expires in {{expiry}} and can be used once. If you did not request it, you can ignore this message.</p>`,
            ),
            text: "Reset your password: {{link}}",
          },
        });
        void recordSecurityEvent({
          eventType: "password.reset_requested",
          message: "Password reset email issued",
          userId: user.id,
          ipAddress: ctx.clientIp,
        });
      } else {
        void recordSecurityEvent({
          eventType: "password.reset_requested",
          outcome: "failure",
          message: "Password reset requested for an unknown or ineligible address",
          subject: input.email,
          ipAddress: ctx.clientIp,
        });
      }

      return {
        ok: true as const,
        message: "If an account exists for that address, a reset link is on its way.",
      };
    }),

  resetPassword: publicProcedure
    .input(
      z.object({
        token: z.string().min(20).max(200),
        password: passwordSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rows = await db
        .select({
          id: passwordResetTokens.id,
          userId: passwordResetTokens.userId,
        })
        .from(passwordResetTokens)
        .where(
          and(
            eq(passwordResetTokens.tokenHash, hashToken(input.token)),
            isNull(passwordResetTokens.usedAt),
            gt(passwordResetTokens.expiresAt, new Date()),
          ),
        )
        .limit(1);

      const record = rows[0];
      if (!record) {
        void recordSecurityEvent({
          eventType: "password.reset_completed",
          outcome: "failure",
          severity: "warning",
          message: "Password reset attempted with an invalid or expired token",
          ipAddress: ctx.clientIp,
        });
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This reset link is invalid or has expired. Request a new one.",
        });
      }

      const user = await getUserById(record.userId);
      if (!user || user.status !== "active" || user.loginMethod !== "local") {
        await db
          .update(passwordResetTokens)
          .set({ usedAt: new Date() })
          .where(and(eq(passwordResetTokens.id, record.id), isNull(passwordResetTokens.usedAt)));
        throw new TRPCError({ code: "BAD_REQUEST", message: "This reset link is no longer valid." });
      }

      await assertPasswordAcceptable(input.password, {
        email: user.email,
        names: [user.firstName, user.lastName, user.preferredName],
      });

      // Consume first and make both the consume and password write conditional.
      // This prevents a concurrent account conversion from leaving a dormant
      // local credential on an SSO-only account.
      const consumed = await db
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(passwordResetTokens.id, record.id), isNull(passwordResetTokens.usedAt)));
      if (affectedRows(consumed) !== 1) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This reset link is no longer valid." });
      }
      const passwordUpdate = await db
        .update(users)
        .set({
          passwordHash: await hashPassword(input.password),
          passwordChangedAt: new Date(),
          mustChangePassword: false,
          failedLoginCount: 0,
          lockedUntil: null,
        })
        .where(and(eq(users.id, user.id), eq(users.loginMethod, "local"), eq(users.status, "active"), isNull(users.deletedAt)));
      if (affectedRows(passwordUpdate) !== 1) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This reset link is no longer valid." });
      }
      await db
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(
          and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.usedAt)),
        );

      // A password change invalidates every existing session.
      await revokeAllUserSessions(user.id, "password_reset");
      await revokeMobileSessionsForUser(user.id, "password_reset");

      void recordSecurityEvent({
        eventType: "password.reset_completed",
        message: "Password reset completed; all sessions revoked",
        userId: user.id,
        ipAddress: ctx.clientIp,
      });

      return { ok: true as const };
    }),

  verifyEmail: publicProcedure
    .input(z.object({ token: z.string().min(20).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const rows = await db
        .select({ id: emailVerificationTokens.id, userId: emailVerificationTokens.userId })
        .from(emailVerificationTokens)
        .where(
          and(
            eq(emailVerificationTokens.tokenHash, hashToken(input.token)),
            isNull(emailVerificationTokens.usedAt),
            gt(emailVerificationTokens.expiresAt, new Date()),
          ),
        )
        .limit(1);

      const record = rows[0];
      if (!record) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This verification link is invalid or has expired.",
        });
      }

      await markEmailVerified(record.userId);
      await db
        .update(emailVerificationTokens)
        .set({ usedAt: new Date() })
        .where(eq(emailVerificationTokens.id, record.id));

            void recordSecurityEvent({
        eventType: "email.verified",
        message: "Email address verified",
        userId: record.userId,
        ipAddress: ctx.clientIp,
      });
      // Fire user.email_verified automation (non-fatal).
      void fireAutomations("user.email_verified", { userId: record.userId });
      return { ok: true as const };
    }),
  resendVerification: sessionProcedure.mutation(async ({ ctx }) => {
    const session = ctx.session;
    if (!session) throw new TRPCError({ code: "UNAUTHORIZED" });
    const user = await getUserById(session.user.id);
    if (!user) throw new TRPCError({ code: "UNAUTHORIZED" });
    if (user.emailVerified) return { ok: true as const };
    await issueVerificationEmail(user.id, user.email, displayNameOf(user));
    return { ok: true as const };
  }),

  changePassword: sessionProcedure
    .input(
      z.object({
        currentPassword: passwordSchema,
        newPassword: passwordSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session;
      if (!session) throw new TRPCError({ code: "UNAUTHORIZED" });
      const user = await getUserById(session.user.id);
      if (!user?.passwordHash) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This account has no password set." });
      }

      const ok = await verifyPassword(user.passwordHash, input.currentPassword);
      if (!ok) {
        void recordSecurityEvent({
          eventType: "password.changed",
          outcome: "failure",
          severity: "warning",
          message: "Password change rejected: current password incorrect",
          userId: user.id,
          ipAddress: ctx.clientIp,
        });
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Your current password is incorrect." });
      }

      await assertPasswordAcceptable(input.newPassword, {
        email: user.email,
        names: [user.firstName, user.lastName, user.preferredName],
      });
      await setPasswordHash(user.id, await hashPassword(input.newPassword));

      // Keep the current session, drop every other one.
      await revokeAllUserSessions(user.id, "password_changed", session.sessionId);
      await revokeMobileSessionsForUser(user.id, "password_changed");
      const refreshed = await resolveSession(ctx.req);
      if (refreshed) await rotateSession(ctx.res, refreshed);

      void recordSecurityEvent({
        eventType: "password.changed",
        message: "Password changed; other sessions revoked",
        userId: user.id,
        ipAddress: ctx.clientIp,
      });

      return { ok: true as const };
    }),

  /* ---------------------------------------------------------------- */
  /* MFA management                                                    */
  /* ---------------------------------------------------------------- */

  mfaStatus: sessionProcedure.query(async ({ ctx }) => {
    const session = ctx.session;
    if (!session) throw new TRPCError({ code: "UNAUTHORIZED" });
    const [confirmed, remaining, policy] = await Promise.all([
      hasConfirmedMfa(session.user.id),
      countUnusedBackupCodes(session.user.id),
      getMfaPolicyForRole(session.user.role),
    ]);
    return {
      enabled: confirmed,
      remainingBackupCodes: remaining,
      requiredForRole: policy === "required",
      policy,
    };
  }),

  enrollMfa: sessionProcedure.mutation(async ({ ctx }) => {
    const session = ctx.session;
    if (!session) throw new TRPCError({ code: "UNAUTHORIZED" });
    const user = await getUserById(session.user.id);
    if (!user) throw new TRPCError({ code: "UNAUTHORIZED" });
    const enrolment = await beginMfaEnrolment(user.id, accountLabelFor(user.id, user.email));
    return { otpauthUrl: enrolment.otpauthUrl, qrDataUrl: enrolment.qrDataUrl, secret: enrolment.secret };
  }),

  confirmMfa: sessionProcedure
    .input(z.object({ code: z.string().trim().length(6) }))
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session;
      if (!session) throw new TRPCError({ code: "UNAUTHORIZED" });
      const user = await getUserById(session.user.id);
      if (!user) throw new TRPCError({ code: "UNAUTHORIZED" });

      const { backupCodes } = await confirmMfaEnrolment(
        user.id,
        input.code,
        accountLabelFor(user.id, user.email),
      );
      await setMfaEnabled(user.id, true);
      await markMfaSatisfied(session.sessionId);

      void recordSecurityEvent({
        eventType: "mfa.enrolled",
        message: "Multi-factor authentication enabled",
        userId: user.id,
        ipAddress: ctx.clientIp,
      });

      return { ok: true as const, backupCodes };
    }),

  regenerateBackupCodes: protectedProcedure
    .input(z.object({ code: z.string().trim().length(6) }))
    .mutation(async ({ ctx, input }) => {
      const user = await getUserById(ctx.session.user.id);
      if (!user) throw new TRPCError({ code: "UNAUTHORIZED" });
      const result = await verifyTotp(
        user.id,
        input.code,
        accountLabelFor(user.id, user.email),
      );
      if (!result.valid) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "That verification code is not valid." });
      }
      const codes = await regenerateBackupCodes(user.id);
      return { ok: true as const, backupCodes: codes };
    }),

  disableMfa: protectedProcedure
    .input(
      z.object({
        password: passwordSchema,
        code: z.string().trim().length(6),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = await getUserById(ctx.session.user.id);
      if (!user?.passwordHash) throw new TRPCError({ code: "UNAUTHORIZED" });

      const policy = await getMfaPolicyForRole(user.role);
      if (policy === "required") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Multi-factor authentication is required by the current account policy and cannot be disabled.",
        });
      }

      const passwordOk = await verifyPassword(user.passwordHash, input.password);
      const codeOk = (
        await verifyTotp(user.id, input.code, accountLabelFor(user.id, user.email))
      ).valid;
      if (!passwordOk || !codeOk) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Password or verification code is incorrect.",
        });
      }

      await disableMfa(user.id);
      await setMfaEnabled(user.id, false);
      await revokeMobileSessionsForUser(user.id, "mfa_disabled");
      void recordSecurityEvent({
        eventType: "mfa.disabled",
        severity: "warning",
        message: "Multi-factor authentication disabled",
        userId: user.id,
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  /* ---------------------------------------------------------------- */
  /* Session management                                               */
  /* ---------------------------------------------------------------- */

  sessions: protectedProcedure.query(async ({ ctx }) => {
    const rows = await db
      .select({
        id: sql<string>`id`,
        ipAddress: sql<string | null>`ip_address`,
        userAgent: sql<string | null>`user_agent`,
        status: sql<string>`status`,
        lastSeenAt: sql<Date>`last_seen_at`,
        expiresAt: sql<Date>`expires_at`,
        createdAt: sql<Date>`created_at`,
      })
      .from(sql`user_sessions`)
      .where(sql`user_id = ${ctx.session.user.id}`)
      .orderBy(sql`last_seen_at DESC`)
      .limit(50);

    return rows.map((row) => ({
      ...row,
      current: row.id === ctx.session.sessionId,
    }));
  }),

  revokeOtherSessions: protectedProcedure.mutation(async ({ ctx }) => {
    await revokeAllUserSessions(ctx.session.user.id, "user_revoked", ctx.session.sessionId);
    void recordSecurityEvent({
      eventType: "session.revoked",
      message: "User revoked all other sessions",
      userId: ctx.session.user.id,
      ipAddress: ctx.clientIp,
    });
    return { ok: true as const };
  }),

  revokeSession: protectedProcedure
    .input(z.object({ sessionId: z.string().length(64) }))
    .mutation(async ({ ctx, input }) => {
      // Ownership check prevents revoking another account's session.
      const rows = await db
        .select({ userId: sql<number>`user_id` })
        .from(sql`user_sessions`)
        .where(sql`id = ${input.sessionId}`)
        .limit(1);
      if (rows[0]?.userId !== ctx.session.user.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Session not found." });
      }
      await revokeSession(input.sessionId, "user_revoked");
      return { ok: true as const };
    }),

  completeOnboarding: protectedProcedure.mutation(async ({ ctx }) => {
    await db
      .update(users)
      .set({ onboardingCompletedAt: new Date() })
      .where(eq(users.id, ctx.session.user.id));
    return { ok: true as const };
  }),

  updateProfile: protectedProcedure
    .input(
      z.object({
        firstName: nameSchema.optional(),
        middleName: nameSchema.optional(),
        lastName: nameSchema.optional(),
        preferredName: nameSchema.optional(),
        suffix: nameSchema.optional(),
        company: z.string().trim().max(160).optional(),
        phone: z.string().trim().max(40).optional(),
        address: z.string().trim().max(400).optional(),
        timezone: z.string().trim().max(64).optional(),
        marketingOptIn: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await updateUserProfile(ctx.session.user.id, input);
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: ctx.session.user.role,
        action: "profile.update",
        entityType: "user",
        entityId: ctx.session.user.id,
        summary: "Customer updated their profile",
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),
});
