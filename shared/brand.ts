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
 * Approved logo asset paths. Assets are served from the application's own
 * public directory — never from a CDN or third-party origin.
 */
export const BRAND_ASSETS = {
  light: {
    full: "/brand/readypackets-document-flow-light.svg",
    trademark: "/brand/readypackets-document-flow-light-tm.svg",
    wordmark: "/brand/readypackets-document-flow-light-wordmark.svg",
    wordmarkPng: "/brand/readypackets-document-flow-light-wordmark.png",
    wordmarkTrademark: "/brand/readypackets-document-flow-light-wordmark-tm.svg",
    wordmarkTrademarkPng: "/brand/readypackets-document-flow-light-wordmark-tm.png",
  },
  dark: {
    full: "/brand/readypackets-document-flow-dark.svg",
    trademark: "/brand/readypackets-document-flow-dark-tm.svg",
    wordmark: "/brand/readypackets-document-flow-dark-wordmark.svg",
    wordmarkPng: "/brand/readypackets-document-flow-dark-wordmark.png",
    wordmarkTrademark: "/brand/readypackets-document-flow-dark-wordmark-tm.svg",
    wordmarkTrademarkPng: "/brand/readypackets-document-flow-dark-wordmark-tm.png",
  },
  mark: {
    light: {
      svg: "/brand/readypackets-mark-light.svg",
      px1024: "/brand/readypackets-mark-light-1024.png",
      px512: "/brand/readypackets-mark-light-512.png",
      px256: "/brand/readypackets-mark-light-256.png",
      px128: "/brand/readypackets-mark-light-128.png",
      px64: "/brand/readypackets-mark-light-64.png",
      px32: "/brand/readypackets-mark-light-32.png",
      px16: "/brand/readypackets-mark-light-16.png",
    },
    dark: {
      svg: "/brand/readypackets-mark-dark.svg",
      px1024: "/brand/readypackets-mark-dark-1024.png",
      px512: "/brand/readypackets-mark-dark-512.png",
      px256: "/brand/readypackets-mark-dark-256.png",
      px128: "/brand/readypackets-mark-dark-128.png",
      px64: "/brand/readypackets-mark-dark-64.png",
      px32: "/brand/readypackets-mark-dark-32.png",
      px16: "/brand/readypackets-mark-dark-16.png",
    },
  },
  favicon: "/favicon.ico",
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
