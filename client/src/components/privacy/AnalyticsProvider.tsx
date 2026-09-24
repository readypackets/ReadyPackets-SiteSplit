/**
 * Optional analytics loader.
 *
 * No third-party analytics script, request, identifier, session replay, or
 * autocapture starts unless the server confirms this browser has selected
 * analytics in the ReadyPackets preference center. Event payloads are curated
 * and use path/surface metadata only; they never contain form values, account
 * ids, order ids, document names, messages, or e-mail addresses.
 */
import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useCookieConsent } from "./CookieConsent";

type ClarityFn = ((command: string, ...args: unknown[]) => void) & { q?: unknown[][] };
type PostHogClient = {
  init: (key: string, options: Record<string, unknown>) => void;
  opt_in_capturing: () => void;
  opt_out_capturing: () => void;
  capture: (event: string, properties?: Record<string, unknown>) => void;
  reset: () => void;
};

declare global {
  interface Window {
    clarity?: ClarityFn;
    posthog?: PostHogClient;
  }
}

let posthogLoad: Promise<PostHogClient> | null = null;
let posthogConfigured = false;
const CROSS_SITE_ID_KEY = "rp_analytics_navigation_id";
const CROSS_SITE_PARAM = "rp_ac";

function surface(): "public" | "portal" {
  return document.documentElement.dataset.rpSurface === "portal" ? "portal" : "public";
}

function cleanPath(location: string): string {
  // Do not let query values or fragments enter analytics: these often carry
  // invitation, password-reset, search, campaign, or order information.
  return location.split(/[?#]/, 1)[0] || "/";
}

function isValidAnonymousHandoff(value: string | null): value is string {
  return Boolean(value && /^[a-f0-9]{32}$/.test(value));
}

function randomAnonymousHandoff(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function anonymousCrossSiteId(enabled: boolean): string | null {
  if (!enabled) return null;
  const url = new URL(window.location.href);
  const supplied = url.searchParams.get(CROSS_SITE_PARAM);
  const stored = window.localStorage.getItem(CROSS_SITE_ID_KEY);
  const id = isValidAnonymousHandoff(supplied) ? supplied : isValidAnonymousHandoff(stored) ? stored : randomAnonymousHandoff();
  window.localStorage.setItem(CROSS_SITE_ID_KEY, id);
  if (supplied) {
    url.searchParams.delete(CROSS_SITE_PARAM);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }
  return id;
}

function loadClarity(projectId: string): void {
  if (document.getElementById("rp-clarity")) return;
  const clarity = window.clarity ?? ((command: string, ...args: unknown[]) => {
    const queued = window.clarity ?? (Object.assign(() => undefined, { q: [] }) as ClarityFn);
    queued.q ??= [];
    queued.q.push([command, ...args]);
    window.clarity = queued;
  }) as ClarityFn;
  window.clarity = clarity;
  clarity("consentv2", { ad_Storage: "denied", analytics_Storage: "granted" });
  const script = document.createElement("script");
  script.id = "rp-clarity";
  script.async = true;
  script.src = `https://www.clarity.ms/tag/${encodeURIComponent(projectId)}`;
  script.referrerPolicy = "strict-origin-when-cross-origin";
  document.head.append(script);
}

async function loadPostHog(host: string): Promise<PostHogClient> {
  if (window.posthog) return window.posthog;
  if (!posthogLoad) {
    posthogLoad = new Promise<PostHogClient>((resolve, reject) => {
      const script = document.createElement("script");
      script.id = "rp-posthog";
      script.async = true;
      // `host` is a server-validated member of the two-region allowlist; it is
      // never read from browser-controlled configuration or a URL parameter.
      script.src = `${host}/static/array.js`;
      script.referrerPolicy = "strict-origin-when-cross-origin";
      script.onload = () => window.posthog ? resolve(window.posthog) : reject(new Error("PostHog did not initialize"));
      script.onerror = () => reject(new Error("PostHog script failed to load"));
      document.head.append(script);
    });
  }
  return posthogLoad;
}

export function AnalyticsProvider() {
  const { preferences } = useCookieConsent();
  const [location] = useLocation();
  const config = trpc.public.analyticsConfig.useQuery(undefined, {
    enabled: preferences?.analytics === true,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const lastPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (preferences?.analytics) return;
    // If a visitor withdraws consent in the same page session, disable any
    // provider that may already have been initialized. Clarity clears its
    // cookies on a false consent command; PostHog blocks all further capture.
    window.clarity?.("consent", false);
    window.posthog?.opt_out_capturing();
    window.localStorage.removeItem(CROSS_SITE_ID_KEY);
    lastPathRef.current = null;
  }, [preferences?.analytics]);

  useEffect(() => {
    const value = config.data;
    if (!preferences?.analytics || !value?.active) return;

    if (value.clarity.enabled && value.clarity.projectId) loadClarity(value.clarity.projectId);

    if (value.posthog.enabled && value.posthog.projectKey && value.posthog.host) {
      void loadPostHog(value.posthog.host).then((posthog) => {
        if (!posthogConfigured) {
          posthog.init(value.posthog.projectKey!, {
            api_host: value.posthog.host,
            autocapture: false,
            capture_pageview: false,
            disable_session_recording: true,
            person_profiles: "never",
            opt_out_capturing_by_default: true,
            opt_out_capturing_persistence_type: "local_storage",
          });
          posthogConfigured = true;
        }
        posthog.opt_in_capturing();
      }).catch(() => undefined);
    }
  }, [config.data, preferences?.analytics]);

  useEffect(() => {
    const value = config.data;
    const path = cleanPath(location);
    if (!preferences?.analytics || !value?.active || lastPathRef.current === path) return;
    lastPathRef.current = path;
    const anonymousId = anonymousCrossSiteId(value.crossSiteEnabled);
    const properties = {
      surface: surface(),
      path,
      cross_site_enabled: value.crossSiteEnabled,
      ...(anonymousId ? { anonymous_cross_site_id: anonymousId } : {}),
    };
    // Clarity receives its page information after consent through its own SDK.
    // PostHog receives only this narrow, explicit page-view event.
    window.posthog?.capture("readypackets_page_viewed", properties);
  }, [config.data, location, preferences?.analytics]);

  useEffect(() => {
    const value = config.data;
    if (!preferences?.analytics || !value?.active || !value.crossSiteEnabled) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || (anchor.target && anchor.target !== "_self")) return;
      const target = new URL(anchor.href, window.location.href);
      const portalOrigin = document.documentElement.dataset.rpPortalOrigin;
      // Preserve the anonymous handoff only when crossing to the configured
      // portal host. Same-host navigation needs no URL parameter and no value
      // is added to any third-party URL.
      if (!portalOrigin || target.origin !== portalOrigin || target.origin === window.location.origin) return;
      const id = anonymousCrossSiteId(true);
      if (!id || target.searchParams.has(CROSS_SITE_PARAM)) return;
      target.searchParams.set(CROSS_SITE_PARAM, id);
      anchor.href = target.toString();
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [config.data, preferences?.analytics]);

  return null;
}

/**
 * Curated application-event bridge for future public/portal features. Unknown
 * payload values are intentionally not accepted; keep event names and scalar
 * properties reviewed in source control.
 */
export function trackAnalyticsEvent(
  event: "public_packet_viewed" | "portal_workspace_opened" | "portal_checkout_started",
  properties: Record<string, string | number | boolean> = {},
): void {
  window.posthog?.capture(event, { surface: surface(), ...properties });
}
