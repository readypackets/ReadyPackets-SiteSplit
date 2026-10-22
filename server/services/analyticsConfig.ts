/**
 * Consent-gated analytics configuration.
 *
 * Provider configuration is deliberately resolved on the server after the
 * visitor's recorded preference is checked. The browser receives no provider
 * key, endpoint, or load instruction until analytics consent is affirmative.
 * Neither e-mail addresses nor ReadyPackets account/order/document identifiers
 * are ever returned or used as analytics subjects.
 */
import type { Request } from "express";
import { getCurrentCookieConsent } from "./cookieConsent.js";
import { getSetting, getSettingBool } from "./settings.js";

const POSTHOG_HOSTS = new Set([
  "https://us.i.posthog.com",
  "https://eu.i.posthog.com",
]);

function validClarityProjectId(value: string | null): value is string {
  return Boolean(value && /^[A-Za-z0-9_-]{6,64}$/.test(value));
}

function validPostHogProjectKey(value: string | null): value is string {
  return Boolean(value && /^[A-Za-z0-9_]{12,180}$/.test(value));
}

export interface ConsentGatedAnalyticsConfig {
  active: boolean;
  crossSiteEnabled: boolean;
  clarity: { enabled: boolean; projectId: string | null };
  posthog: { enabled: boolean; projectKey: string | null; host: string | null };
}

const disabled: ConsentGatedAnalyticsConfig = {
  active: false,
  crossSiteEnabled: false,
  clarity: { enabled: false, projectId: null },
  posthog: { enabled: false, projectKey: null, host: null },
};

export async function getConsentGatedAnalyticsConfig(req: Request): Promise<ConsentGatedAnalyticsConfig> {
  const consent = await getCurrentCookieConsent(req);
  // Do not rely only on a historic affirmative consent row. An administrator
  // can globally turn off the consent center or Analytics category at any time;
  // both switches must immediately withhold every provider instruction.
  if (!consent.config.enabled || !consent.config.analyticsAvailable || !consent.preferences?.analytics) return disabled;

  const [clarityEnabled, clarityProjectId, posthogEnabled, posthogProjectKey, requestedPosthogHost, crossSiteEnabled] = await Promise.all([
    getSettingBool("privacy.analytics_clarity_enabled", false),
    getSetting("privacy.analytics_clarity_project_id"),
    getSettingBool("privacy.analytics_posthog_enabled", false),
    getSetting("privacy.analytics_posthog_project_key"),
    getSetting("privacy.analytics_posthog_host"),
    getSettingBool("privacy.analytics_cross_site_enabled", false),
  ]);

  const posthogHost = POSTHOG_HOSTS.has(requestedPosthogHost ?? "")
    ? requestedPosthogHost
    : "https://us.i.posthog.com";
  const clarity = clarityEnabled && validClarityProjectId(clarityProjectId)
    ? { enabled: true, projectId: clarityProjectId }
    : { enabled: false, projectId: null };
  const posthog = posthogEnabled && validPostHogProjectKey(posthogProjectKey)
    ? { enabled: true, projectKey: posthogProjectKey, host: posthogHost }
    : { enabled: false, projectKey: null, host: null };

  return {
    active: clarity.enabled || posthog.enabled,
    crossSiteEnabled: crossSiteEnabled && (clarity.enabled || posthog.enabled),
    clarity,
    posthog,
  };
}

export const analyticsProviderValidation = {
  posthogHosts: [...POSTHOG_HOSTS],
  isValidClarityProjectId: validClarityProjectId,
  isValidPostHogProjectKey: validPostHogProjectKey,
};
