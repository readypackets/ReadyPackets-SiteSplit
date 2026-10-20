import { isIP } from "node:net";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { ipAllowlist, samlConfigs, users, webhookEndpoints } from "../db/schema.js";
import { encryptField, isPublicUserId } from "../security/crypto.js";
import { detectPatternType } from "../security/ipAddress.js";
import { recordActivity } from "../observability/audit.js";
import { getSetting, getSettingBool, getSettingJson, setSetting } from "../services/settings.js";
import { parseBackupControl, runBackupControl } from "../services/backupControl.js";
import { parsePlatformSetupProfile, PLATFORM_SETUP_PROFILE_FORMAT, PLATFORM_SETUP_PROFILE_VERSION } from "../services/platformSetupProfile.js";
import { normalizeSharePointRootFolderPath, resetGraphTokenCache } from "../services/sharepoint.js";
import { adminProcedure, router } from "../trpc/trpc.js";

const emailSchema = z.object({
  transport: z.enum(["none", "smtp", "graph"]),
  smtp: z.object({ host: z.string().trim().max(255), port: z.number().int().min(1).max(65535), user: z.string().trim().max(255), password: z.string().max(512).optional(), from: z.string().trim().email().max(320), replyTo: z.string().trim().email().max(320).optional().or(z.literal("")), secure: z.boolean() }),
  graph: z.object({ tenantId: z.string().trim().max(128), clientId: z.string().trim().max(128), clientSecret: z.string().max(512).optional(), sender: z.string().trim().email().max(320) }),
});

const entraSchema = z.object({ enabled: z.boolean(), name: z.string().trim().min(2).max(120), entryPoint: z.string().trim().url().max(500), issuer: z.string().trim().min(2).max(255), certificate: z.string().trim().max(12000).optional(), autoProvision: z.boolean(), defaultRole: z.enum(["customer", "staff", "admin"]) });
const webhookSchema = z.object({ url: z.string().trim().url().max(500).refine((value) => new URL(value).protocol === "https:", "Webhook URLs must use HTTPS."), secret: z.string().max(256).optional(), enabled: z.boolean() });

function validIpPattern(value: string): boolean {
  const pattern = value.trim();
  if (isIP(pattern) !== 0) return true;
  if (pattern.includes("/")) {
    const [address, prefix] = pattern.split("/");
    return isIP(address ?? "") === 4 && /^\d{1,2}$/.test(prefix ?? "") && Number(prefix) >= 0 && Number(prefix) <= 32;
  }
  if (pattern.includes("-")) {
    const [start, end] = pattern.split("-").map((part) => part.trim());
    return isIP(start ?? "") === 4 && isIP(end ?? "") === 4;
  }
  return false;
}

async function savePhaseEndpoint(eventType: "P101" | "P201", input: z.infer<typeof webhookSchema>, userId: number) {
  const existing = (await db.select().from(webhookEndpoints).orderBy(desc(webhookEndpoints.createdAt))).find((endpoint) => Array.isArray(endpoint.events) && endpoint.events.includes(eventType));
  const name = eventType === "P101" ? "Phase I Start — P101" : "Phase II Start — P201";
  if (existing) {
    const patch: Record<string, unknown> = { name, url: input.url, events: [eventType], enabled: input.enabled };
    if (input.secret) patch.secretEnc = encryptField(input.secret, `webhook:${existing.id}`);
    await db.update(webhookEndpoints).set(patch).where(eq(webhookEndpoints.id, existing.id));
    return existing.id;
  }
  const result = await db.insert(webhookEndpoints).values({ name, url: input.url, events: [eventType], enabled: input.enabled, createdByUserId: userId, secretEnc: null });
  const id = Number((result as { insertId?: number }).insertId ?? 0);
  if (input.secret) await db.update(webhookEndpoints).set({ secretEnc: encryptField(input.secret, `webhook:${id}`) }).where(eq(webhookEndpoints.id, id));
  return id;
}

export const platformSetupRouter = router({
  status: adminProcedure.query(async () => {
    const [emailTransport, stripeSecret, stripeWebhook, setupCompletedAt, loginWhitelistEnabled, loginWhitelist, saml, endpoints, sharepointTenant, sharepointClient, sharepointSecret, sharepointSite, sharepointDrive, sharepointSiteUrl, sharepointRoot, audioFallback, backupStatus, backupScheduleTime] = await Promise.all([
      getSetting("email.transport"), getSetting("stripe.secret_key"), getSetting("stripe.webhook_secret"), getSetting("platform.setup_completed_at"), getSettingBool("access.login_whitelist_enabled", false), getSettingJson<string[]>("access.login_whitelist_public_ids", []), db.select({ enabled: samlConfigs.enabled, name: samlConfigs.name }).from(samlConfigs).orderBy(desc(samlConfigs.updatedAt)).limit(1), db.select({ events: webhookEndpoints.events, enabled: webhookEndpoints.enabled }).from(webhookEndpoints),
      getSetting("sharepoint.tenant_id"), getSetting("sharepoint.client_id"), getSetting("sharepoint.client_secret_enc"), getSetting("sharepoint.site_id"), getSetting("sharepoint.drive_id"), getSetting("sharepoint.site_url"), getSetting("sharepoint.root_folder_path"), getSetting("sharepoint.audio_fallback_mode"), runBackupControl(["status"]).then(parseBackupControl).catch(() => null), getSetting("backup.schedule_time"),
    ]);
    const eventTypes = new Set(endpoints.filter((endpoint) => endpoint.enabled && Array.isArray(endpoint.events)).flatMap((endpoint) => endpoint.events as string[]));
    return {
      completedAt: setupCompletedAt,
      emailTransport: emailTransport ?? "none",
      stripeReady: Boolean(stripeSecret && stripeWebhook),
      entraEnabled: Boolean(saml[0]?.enabled),
      p101Configured: eventTypes.has("P101"),
      p201Configured: eventTypes.has("P201"),
      loginWhitelistEnabled,
      loginWhitelist,
      sharePointReady: Boolean(sharepointTenant && sharepointClient && sharepointSecret && sharepointSite && sharepointDrive),
      sharePoint: { tenantId: sharepointTenant ?? "", clientId: sharepointClient ?? "", siteId: sharepointSite ?? "", driveId: sharepointDrive ?? "", siteUrl: sharepointSiteUrl ?? "", rootFolderPath: sharepointRoot ?? "ReadyPackets/Orders", audioFallbackMode: audioFallback === "none" ? "none" as const : "mp3" as const },
      backupControlAvailable: backupStatus !== null,
      backupScheduleTime: /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(backupScheduleTime ?? "") ? backupScheduleTime : null,
    };
  }),

  exportProfile: adminProcedure.mutation(async ({ ctx }) => {
    const [
      emailTransport, smtpHost, smtpPort, smtpUser, smtpFrom, smtpReplyTo, smtpSecure, smtpPass,
      graphTenantId, graphClientId, graphSender, graphSecret,
      sharepointTenant, sharepointClient, sharepointSecret, sharepointSite, sharepointDrive, sharepointSiteUrl, sharepointRoot, audioFallback,
      stripePublishable, stripeSecret, stripeWebhook, endpoints, backupOutput, backupScheduleTime,
    ] = await Promise.all([
      getSetting("email.transport"), getSetting("email.smtp_host"), getSetting("email.smtp_port"), getSetting("email.smtp_user"), getSetting("email.smtp_from"), getSetting("email.smtp_reply_to"), getSetting("email.smtp_secure"), getSetting("email.smtp_pass"),
      getSetting("email.graph_tenant_id"), getSetting("email.graph_client_id"), getSetting("email.graph_email_sender"), getSetting("email.graph_client_secret"),
      getSetting("sharepoint.tenant_id"), getSetting("sharepoint.client_id"), getSetting("sharepoint.client_secret_enc"), getSetting("sharepoint.site_id"), getSetting("sharepoint.drive_id"), getSetting("sharepoint.site_url"), getSetting("sharepoint.root_folder_path"), getSetting("sharepoint.audio_fallback_mode"),
      getSetting("stripe.publishable_key"), getSetting("stripe.secret_key"), getSetting("stripe.webhook_secret"), db.select({ events: webhookEndpoints.events, url: webhookEndpoints.url, enabled: webhookEndpoints.enabled, secretEnc: webhookEndpoints.secretEnc }).from(webhookEndpoints), runBackupControl(["status"]).catch(() => ""), getSetting("backup.schedule_time"),
    ]);
    const endpointFor = (eventType: "P101" | "P201") => endpoints.find((endpoint) => Array.isArray(endpoint.events) && endpoint.events.includes(eventType));
    const p101 = endpointFor("P101");
    const p201 = endpointFor("P201");
    const output = parseBackupControl(backupOutput);
    const targets = backupOutput.split("\n").flatMap((line) => {
      const [provider, destination] = line.split("|", 2);
      return provider && destination ? [{ provider, destination }] : [];
    });
    const profile = {
      format: PLATFORM_SETUP_PROFILE_FORMAT,
      formatVersion: PLATFORM_SETUP_PROFILE_VERSION,
      exportedAt: new Date().toISOString(),
      setup: {
        email: {
          transport: emailTransport === "smtp" || emailTransport === "graph" ? emailTransport : "none",
          smtp: { host: smtpHost ?? "", port: Number(smtpPort ?? 587) || 587, user: smtpUser ?? "", from: smtpFrom ?? "no-reply@readypackets.com", replyTo: smtpReplyTo ?? "", secure: smtpSecure === "true" },
          graph: { tenantId: graphTenantId ?? "", clientId: graphClientId ?? "", sender: graphSender ?? "" },
          requiresSecret: Boolean((emailTransport === "smtp" && smtpPass) || (emailTransport === "graph" && graphSecret)),
        },
        sharePoint: { tenantId: sharepointTenant ?? "", clientId: sharepointClient ?? "", siteId: sharepointSite ?? "", driveId: sharepointDrive ?? "", siteUrl: sharepointSiteUrl ?? "", rootFolderPath: sharepointRoot ?? "ReadyPackets/Orders", audioFallbackMode: audioFallback === "none" ? "none" : "mp3", requiresClientSecret: Boolean(sharepointSecret) },
        backup: { scheduleTime: /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(backupScheduleTime ?? "") ? backupScheduleTime! : (/^([01][0-9]|2[0-3]):[0-5][0-9]/.test(output.next_run ?? "") ? (output.next_run ?? "02:30").match(/([01][0-9]|2[0-3]):[0-5][0-9]/)?.[0] ?? "02:30" : "02:30"), cloudTargets: targets, cloudCredentialsIncluded: false as const },
        webhooks: { p101: { url: p101?.url ?? "", enabled: Boolean(p101?.enabled) }, p201: { url: p201?.url ?? "", enabled: Boolean(p201?.enabled) }, requiresSigningSecrets: Boolean(p101?.secretEnc || p201?.secretEnc) },
        stripe: { publishableKey: stripePublishable ?? "", requiresSecretKey: Boolean(stripeSecret), requiresWebhookSecret: Boolean(stripeWebhook) },
        reviewRequired: { entra: true, accessControls: true },
      },
    };
    void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "platform_setup.profile_exported", entityType: "platform_setup_profile", entityId: 0, severity: "warning", summary: "Administrator exported a secret-free portable platform setup profile", ipAddress: ctx.clientIp });
    return parsePlatformSetupProfile(profile);
  }),

  importProfile: adminProcedure.input(z.unknown()).mutation(async ({ ctx, input }) => {
    let profile;
    try {
      profile = parsePlatformSetupProfile(input);
    } catch {
      throw new TRPCError({ code: "BAD_REQUEST", message: "This is not a supported ReadyPackets Platform Setup profile." });
    }
    const userId = ctx.session.user.id;
    const { email, sharePoint, backup, webhooks, stripe } = profile.setup;
    await runBackupControl(["schedule", backup.scheduleTime]).catch((error: unknown) => {
      throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: `The profile was not applied because protected backup scheduling is unavailable: ${error instanceof Error ? error.message : "unknown error"}` });
    });
    await setSetting("backup.schedule_time", backup.scheduleTime, { category: "backup", userId });
    await setSetting("email.transport", email.transport, { category: "email", userId });
    await Promise.all([
      setSetting("email.smtp_host", email.smtp.host || null, { category: "email", userId }), setSetting("email.smtp_port", String(email.smtp.port), { category: "email", userId }), setSetting("email.smtp_user", email.smtp.user || null, { category: "email", userId }), setSetting("email.smtp_from", email.smtp.from, { category: "email", userId }), setSetting("email.smtp_reply_to", email.smtp.replyTo || null, { category: "email", userId }), setSetting("email.smtp_secure", String(email.smtp.secure), { category: "email", userId }),
      setSetting("email.graph_tenant_id", email.graph.tenantId || null, { category: "email", userId }), setSetting("email.graph_client_id", email.graph.clientId || null, { category: "email", userId }), setSetting("email.graph_email_sender", email.graph.sender || null, { category: "email", userId }),
      setSetting("stripe.publishable_key", stripe.publishableKey || null, { category: "payments", userId }),
      setSetting("sharepoint.tenant_id", sharePoint.tenantId || null, { category: "sharepoint", userId }), setSetting("sharepoint.client_id", sharePoint.clientId || null, { category: "sharepoint", userId }), setSetting("sharepoint.site_id", sharePoint.siteId || null, { category: "sharepoint", userId }), setSetting("sharepoint.drive_id", sharePoint.driveId || null, { category: "sharepoint", userId }), setSetting("sharepoint.site_url", sharePoint.siteUrl || null, { category: "sharepoint", userId }), setSetting("sharepoint.root_folder_path", normalizeSharePointRootFolderPath(sharePoint.rootFolderPath), { category: "sharepoint", userId }), setSetting("sharepoint.audio_fallback_mode", sharePoint.audioFallbackMode, { category: "sharepoint", userId }),
    ]);
    resetGraphTokenCache();
    const importedEndpoints = [] as string[];
    for (const [eventType, endpoint] of [["P101", webhooks.p101], ["P201", webhooks.p201]] as const) {
      if (!endpoint.url) continue;
      await savePhaseEndpoint(eventType, { url: endpoint.url, enabled: false }, userId);
      importedEndpoints.push(eventType);
    }
    void recordActivity({ actorUserId: userId, actorRole: "admin", action: "platform_setup.profile_imported", entityType: "platform_setup_profile", entityId: 0, severity: "warning", summary: "Administrator imported a secret-free portable platform setup profile", changes: { importedEndpoints, secretsRequired: [email.requiresSecret ? "email" : null, sharePoint.requiresClientSecret ? "sharepoint" : null, webhooks.requiresSigningSecrets ? "webhooks" : null, stripe.requiresSecretKey || stripe.requiresWebhookSecret ? "stripe" : null].filter(Boolean) }, ipAddress: ctx.clientIp });
    return { ok: true as const, importedEndpoints, backupTargetsRequireReconfiguration: backup.cloudTargets.map((target) => target.provider), secretsRequired: [email.requiresSecret ? "Email password/client secret" : null, sharePoint.requiresClientSecret ? "SharePoint client secret" : null, webhooks.requiresSigningSecrets ? "Webhook signing secrets" : null, stripe.requiresSecretKey || stripe.requiresWebhookSecret ? "Stripe secret and webhook signing key" : null].filter((value): value is string => Boolean(value)) };
  }),

  saveEmail: adminProcedure.input(emailSchema).mutation(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;
    await setSetting("email.transport", input.transport, { category: "email", userId });
    if (input.transport === "smtp") {
      await Promise.all([
        setSetting("email.smtp_host", input.smtp.host, { category: "email", userId }), setSetting("email.smtp_port", String(input.smtp.port), { category: "email", userId }), setSetting("email.smtp_user", input.smtp.user, { category: "email", userId }), setSetting("email.smtp_from", input.smtp.from, { category: "email", userId }), setSetting("email.smtp_reply_to", input.smtp.replyTo || null, { category: "email", userId }), setSetting("email.smtp_secure", String(input.smtp.secure), { category: "email", userId }),
      ]);
      if (input.smtp.password !== undefined) await setSetting("email.smtp_pass", input.smtp.password || null, { category: "email", isSecret: true, userId });
    }
    if (input.transport === "graph") {
      await Promise.all([
        setSetting("email.graph_tenant_id", input.graph.tenantId, { category: "email", userId }), setSetting("email.graph_client_id", input.graph.clientId, { category: "email", userId }), setSetting("email.graph_email_sender", input.graph.sender, { category: "email", userId }),
      ]);
      if (input.graph.clientSecret !== undefined) await setSetting("email.graph_client_secret", input.graph.clientSecret || null, { category: "email", isSecret: true, userId });
    }
    void recordActivity({ actorUserId: userId, actorRole: "admin", action: "platform_setup.email_saved", entityType: "site_setting", entityId: 0, summary: `Platform setup saved ${input.transport} email configuration`, ipAddress: ctx.clientIp });
    return { ok: true as const };
  }),

  saveSharePoint: adminProcedure.input(z.object({
    tenantId: z.string().trim().min(3).max(128).optional().or(z.literal("")),
    clientId: z.string().trim().uuid().optional().or(z.literal("")),
    clientSecret: z.string().max(512).optional(),
    siteId: z.string().trim().min(1).max(512).optional().or(z.literal("")),
    driveId: z.string().trim().min(1).max(512).optional().or(z.literal("")),
    siteUrl: z.string().trim().url().max(1024).optional().or(z.literal("")),
    rootFolderPath: z.string().trim().min(1).max(512),
    audioFallbackMode: z.enum(["none", "mp3"]).default("mp3"),
  })).mutation(async ({ ctx, input }) => {
    const rootFolderPath = normalizeSharePointRootFolderPath(input.rootFolderPath);
    const userId = ctx.session.user.id;
    const [storedTenantId, storedClientId, storedSiteId, storedDriveId, storedSiteUrl] = await Promise.all([
      getSetting("sharepoint.tenant_id"), getSetting("sharepoint.client_id"), getSetting("sharepoint.site_id"), getSetting("sharepoint.drive_id"), getSetting("sharepoint.site_url"),
    ]);
    const tenantId = input.tenantId || storedTenantId;
    const clientId = input.clientId || storedClientId;
    const siteId = input.siteId || storedSiteId;
    const driveId = input.driveId || storedDriveId;
    const siteUrl = input.siteUrl || storedSiteUrl;
    if (!tenantId || !clientId || !siteId || !driveId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Enter the tenant, client, site, and document-library IDs before saving the first SharePoint configuration." });
    await Promise.all([
      setSetting("sharepoint.tenant_id", tenantId, { category: "sharepoint", userId }),
      setSetting("sharepoint.client_id", clientId, { category: "sharepoint", userId }),
      setSetting("sharepoint.site_id", siteId, { category: "sharepoint", userId }),
      setSetting("sharepoint.drive_id", driveId, { category: "sharepoint", userId }),
      setSetting("sharepoint.site_url", siteUrl || null, { category: "sharepoint", userId }),
      setSetting("sharepoint.root_folder_path", rootFolderPath, { category: "sharepoint", userId }),
      setSetting("sharepoint.audio_fallback_mode", input.audioFallbackMode, { category: "sharepoint", userId }),
    ]);
    if (input.clientSecret) await setSetting("sharepoint.client_secret_enc", encryptField(input.clientSecret, "sharepoint.client_secret"), { category: "sharepoint", isSecret: true, userId });
    resetGraphTokenCache();
    void recordActivity({ actorUserId: userId, actorRole: "admin", action: "platform_setup.sharepoint_saved", entityType: "sharepoint", entityId: 0, summary: "Platform setup saved SharePoint site synchronization configuration", changes: { siteId, driveId, rootFolderPath, audioFallbackMode: input.audioFallbackMode }, ipAddress: ctx.clientIp });
    return { ok: true as const, rootFolderPath };
  }),

  saveBackup: adminProcedure.input(z.object({ scheduleTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "Use a 24-hour HH:MM time.") })).mutation(async ({ ctx, input }) => {
    try {
      await runBackupControl(["schedule", input.scheduleTime]);
    } catch (error) {
      throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: `Protected backup scheduling is unavailable: ${error instanceof Error ? error.message : "unknown error"}` });
    }
    await setSetting("backup.schedule_time", input.scheduleTime, { category: "backup", userId: ctx.session.user.id });
    void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "platform_setup.backup_saved", entityType: "backup", entityId: 0, summary: `Platform setup set the daily local backup schedule to ${input.scheduleTime}`, ipAddress: ctx.clientIp });
    return { ok: true as const };
  }),

  saveStripe: adminProcedure.input(z.object({ secretKey: z.string().trim().optional(), publishableKey: z.string().trim().optional(), webhookSecret: z.string().trim().optional() })).mutation(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;
    if (input.secretKey !== undefined) await setSetting("stripe.secret_key", input.secretKey || null, { category: "payments", isSecret: true, userId });
    if (input.publishableKey !== undefined) await setSetting("stripe.publishable_key", input.publishableKey || null, { category: "payments", userId });
    if (input.webhookSecret !== undefined) await setSetting("stripe.webhook_secret", input.webhookSecret || null, { category: "payments", isSecret: true, userId });
    void recordActivity({ actorUserId: userId, actorRole: "admin", action: "platform_setup.stripe_saved", entityType: "site_setting", entityId: 0, summary: "Platform setup saved Stripe configuration", ipAddress: ctx.clientIp });
    return { ok: true as const };
  }),

  saveEntra: adminProcedure.input(entraSchema).mutation(async ({ ctx, input }) => {
    const existing = (await db.select().from(samlConfigs).orderBy(desc(samlConfigs.updatedAt)).limit(1))[0];
    if (!input.certificate && !existing) throw new TRPCError({ code: "BAD_REQUEST", message: "Paste the Entra Base64 certificate before saving the first configuration." });
    const data = { name: input.name, enabled: input.enabled, entryPoint: input.entryPoint, issuer: input.issuer, idpCertificate: input.certificate || existing!.idpCertificate, signatureAlgorithm: "sha256", autoProvision: input.autoProvision, defaultRole: input.defaultRole };
    if (existing) await db.update(samlConfigs).set(data).where(eq(samlConfigs.id, existing.id));
    else await db.insert(samlConfigs).values(data);
    void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "platform_setup.entra_saved", entityType: "saml_config", entityId: existing?.id ?? 0, summary: `Platform setup saved Microsoft Entra ID configuration (${input.enabled ? "enabled" : "disabled"})`, ipAddress: ctx.clientIp });
    return { ok: true as const };
  }),

  savePhaseWebhooks: adminProcedure.input(z.object({ p101: webhookSchema.optional(), p201: webhookSchema.optional() })).mutation(async ({ ctx, input }) => {
    if (!input.p101 && !input.p201) throw new TRPCError({ code: "BAD_REQUEST", message: "Configure at least one phase-start webhook." });
    const ids = await Promise.all([input.p101 ? savePhaseEndpoint("P101", input.p101, ctx.session.user.id) : null, input.p201 ? savePhaseEndpoint("P201", input.p201, ctx.session.user.id) : null]);
    void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "platform_setup.phase_webhooks_saved", entityType: "webhook_endpoint", entityId: ids.find((id) => id !== null) ?? 0, summary: "Platform setup saved phase-start webhook configuration", ipAddress: ctx.clientIp });
    return { ok: true as const, ids };
  }),

  saveAccess: adminProcedure.input(z.object({ ipPatterns: z.array(z.string().trim().min(3).max(64)).max(25), loginWhitelistEnabled: z.boolean(), loginWhitelistPublicIds: z.array(z.string().trim().refine(isPublicUserId, "Enter IDs in the form RP-CUS-XXXXXXXX.")).max(200) })).mutation(async ({ ctx, input }) => {
    for (const pattern of input.ipPatterns) if (!validIpPattern(pattern)) throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid IP allowlist entry: ${pattern}` });
    const ids = [...new Set(input.loginWhitelistPublicIds.map((value) => value.toUpperCase()))];
    if (input.loginWhitelistEnabled && ids.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose at least one public customer ID before enabling the login whitelist." });
    const matched = ids.length ? await db.select({ publicId: users.publicId }).from(users).where(inArray(users.publicId, ids)) : [];
    if (matched.length !== ids.length) throw new TRPCError({ code: "BAD_REQUEST", message: "One or more public customer IDs do not match an existing account." });
    for (const pattern of input.ipPatterns) {
      await db.insert(ipAllowlist).values({ pattern, patternType: detectPatternType(pattern), scope: "all", note: "Added by platform setup wizard", createdByUserId: ctx.session.user.id }).onDuplicateKeyUpdate({ set: { scope: "all", note: "Added by platform setup wizard" } });
    }
    await Promise.all([setSetting("access.login_whitelist_enabled", String(input.loginWhitelistEnabled), { category: "security", userId: ctx.session.user.id }), setSetting("access.login_whitelist_public_ids", JSON.stringify(ids), { category: "security", valueType: "json", userId: ctx.session.user.id })]);
    void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "platform_setup.access_saved", entityType: "site_setting", entityId: 0, summary: `Platform setup saved ${input.ipPatterns.length} IP allowlist entry(ies) and ${ids.length} login-whitelisted account(s)`, ipAddress: ctx.clientIp });
    return { ok: true as const };
  }),

  complete: adminProcedure.mutation(async ({ ctx }) => {
    const now = new Date().toISOString();
    await setSetting("platform.setup_completed_at", now, { category: "platform", userId: ctx.session.user.id });
    void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "platform_setup.completed", entityType: "site_setting", entityId: 0, summary: "Administrator marked the first-run platform setup wizard complete", ipAddress: ctx.clientIp });
    return { completedAt: now };
  }),
});
