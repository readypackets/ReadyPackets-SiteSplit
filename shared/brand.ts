/**
 * ReadyPackets brand constants — Document-Flow Brand Package (September 2026).
 * Values are aligned to the verified supplied production-candidate package.
 * These are the single source of truth for colour, naming and legal marks.
 */

export const BRAND = {
  companyLegalName: "Ready Packets Consulting LLC",
  companyShortName: "ReadyPackets",
  wordmark: "ReadyPackets\u2122",
  tagline: "Your Business, Professionally Packeted\u2122",
  taglinePlain: "Your Business, Professionally Packeted",
  address: "7404 Executive Pl, Lanham, MD 20706",
  emails: {
    general: "info@readypackets.com",
    compliance: "compliance@readypackets.com",
    cancellations: "cancellations@readypackets.com",
    disputes: "disputes@readypackets.com",
    brand: "brand@readypackets.com",
  },
  copyright: (year = new Date().getFullYear()) =>
    `\u00A9 ${year} Ready Packets Consulting LLC. All rights reserved.`,
} as const;

/** Primary and secondary palette. Hex values from the Brand Guidelines colour page. */
export const BRAND_COLORS = {
  navy: "#0D1B2A",
  navyRaised: "#12263A",
  navyElevated: "#17304A",
  teal: "#20A090",
  tealDark: "#1A7A6E",
  tealLight: "#2EC4B6",
  gold: "#C9A84C",
  goldDark: "#A98C36",
  grayDark: "#4A5568",
  white: "#FFFFFF",
} as const;

/**
 * Approved updated logo asset paths. Assets are served from the application's
 * own public directory — never from a CDN or third-party origin. Retired
 * document-flow and square-lockup artwork is intentionally not registered.
 */
export const BRAND_ASSETS = {
  light: {
    icon: "/brand/readypackets-approved-header-icon-light.png",
    wordmark: "/brand/readypackets-approved-header-wordmark-light.png",
    rule: "/brand/readypackets-approved-header-rule-light.png",
    tagline: "/brand/readypackets-approved-header-tagline-light.png",
  },
  dark: {
    icon: "/brand/readypackets-approved-header-icon-dark.png",
    wordmark: "/brand/readypackets-approved-header-wordmark-dark.png",
    rule: "/brand/readypackets-approved-header-rule-dark.png",
    tagline: "/brand/readypackets-approved-header-tagline-dark.png",
  },
  favicon: "/brand/readypackets-approved-icon-light-192.png",
  pwaIcon: "/brand/readypackets-approved-icon-light-512.png",
} as const;

/** Brand pillars, used on the public About page. */
export const BRAND_PILLARS = [
  {
    name: "Professionalism",
    detail: "Every touchpoint reflects expertise, clarity, and polish.",
  },
  { name: "Reliability", detail: "Clients trust us to deliver on time, every time." },
  { name: "Clarity", detail: "Complex business needs translated into actionable documents." },
  { name: "Momentum", detail: "We exist to help businesses move — fast and with confidence." },
] as const;
