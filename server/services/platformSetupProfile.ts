import { z } from "zod";

/**
 * Portable, reviewable setup profile. It intentionally contains no passwords,
 * client secrets, OAuth refresh tokens, certificate bodies, private keys, or
 * current portal hostname/network settings. Encrypted .rpconfig exports remain
 * the break-glass mechanism for full configuration migration.
 */
export const PLATFORM_SETUP_PROFILE_FORMAT = "readypackets-platform-setup-profile" as const;
export const PLATFORM_SETUP_PROFILE_VERSION = 1 as const;

const optionalText = z.string().trim().max(512).optional().default("");
const optionalUrl = z.string().trim().url().max(1024).optional().or(z.literal("")).default("");

export const platformSetupProfileSchema = z.object({
  format: z.literal(PLATFORM_SETUP_PROFILE_FORMAT),
  formatVersion: z.literal(PLATFORM_SETUP_PROFILE_VERSION),
  exportedAt: z.string().datetime(),
  setup: z.object({
    email: z.object({
      transport: z.enum(["none", "smtp", "graph"]),
      smtp: z.object({
        host: optionalText,
        port: z.number().int().min(1).max(65_535).default(587),
        user: optionalText,
        from: z.string().trim().email().max(320).default("no-reply@readypackets.com"),
        replyTo: z.string().trim().email().max(320).optional().or(z.literal("")).default(""),
        secure: z.boolean().default(false),
      }),
      graph: z.object({
        tenantId: optionalText,
        clientId: optionalText,
        sender: z.string().trim().email().max(320).optional().or(z.literal("")).default(""),
      }),
      requiresSecret: z.boolean(),
    }),
    sharePoint: z.object({
      tenantId: optionalText,
      clientId: optionalText,
      siteId: optionalText,
      driveId: optionalText,
      siteUrl: optionalUrl,
      rootFolderPath: z.string().trim().min(1).max(512).default("ReadyPackets/Orders"),
      audioFallbackMode: z.enum(["none", "mp3"]).default("mp3"),
      requiresClientSecret: z.boolean(),
    }),
    backup: z.object({
      scheduleTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/).default("02:30"),
      cloudTargets: z.array(z.object({
        provider: z.string().trim().min(1).max(64),
        destination: z.string().trim().min(3).max(512),
      })).max(16).default([]),
      cloudCredentialsIncluded: z.literal(false),
    }),
    webhooks: z.object({
      p101: z.object({ url: optionalUrl, enabled: z.boolean().default(false) }),
      p201: z.object({ url: optionalUrl, enabled: z.boolean().default(false) }),
      requiresSigningSecrets: z.boolean(),
      requiresDestinationConfiguration: z.boolean().default(false),
    }),
    stripe: z.object({
      publishableKey: optionalText,
      requiresSecretKey: z.boolean(),
      requiresWebhookSecret: z.boolean(),
    }),
    reviewRequired: z.object({
      entra: z.boolean(),
      accessControls: z.boolean(),
    }),
  }),
});

export type PlatformSetupProfile = z.infer<typeof platformSetupProfileSchema>;

export function parsePlatformSetupProfile(value: unknown): PlatformSetupProfile {
  return platformSetupProfileSchema.parse(value);
}
