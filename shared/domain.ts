/**
 * Shared domain vocabulary used by both the server and the client.
 * Keeping these unions in one place means an illegal state cannot be
 * expressed on either side of the API boundary.
 */

export const USER_ROLES = ["admin", "staff", "customer"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const LOGIN_METHODS = ["local", "saml"] as const;
export type LoginMethod = (typeof LOGIN_METHODS)[number];

export const ORDER_STATUSES = [
  "new",
  "phase_1_intake",
  "phase_2_synthesis",
  "in_production",
  "delivered",
  "closed",
  "cancelled",
  "refunded",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  new: "New",
  phase_1_intake: "Phase I \u2014 Intake (P101)",
  phase_2_synthesis: "Phase II \u2014 Logic Synthesis (P201)",
  in_production: "In Production",
  delivered: "Delivered",
  closed: "Closed",
  cancelled: "Cancelled",
  refunded: "Refunded",
};

/**
 * Legal state transitions. The order service refuses any transition that is
 * not represented here, so the lifecycle cannot be corrupted by a client.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  // A refund may be confirmed at any point before a terminal completion state.
  // Both cancellation and refund are terminal: no customer work can resume.
  new: ["phase_1_intake", "cancelled", "refunded"],
  phase_1_intake: ["phase_2_synthesis", "cancelled", "refunded"],
  phase_2_synthesis: ["in_production", "cancelled", "refunded"],
  in_production: ["delivered", "cancelled", "refunded"],
  delivered: ["closed", "refunded"],
  // A completed order may still receive a later Stripe-confirmed refund.
  closed: ["refunded"],
  cancelled: ["refunded"],
  refunded: [],
};

export const PAYMENT_STATUSES = [
  "unpaid",
  "awaiting_invoice",
  "processing",
  "paid",
  "partially_refunded",
  "refunded",
  "failed",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PRODUCT_TIERS = ["basic", "standard", "premium", "institutional", "custom"] as const;
export type ProductTier = (typeof PRODUCT_TIERS)[number];

export const TICKET_STATUSES = ["open", "pending", "answered", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const LOG_SEVERITIES = ["debug", "info", "notice", "warning", "error", "critical"] as const;
export type LogSeverity = (typeof LOG_SEVERITIES)[number];

export const RATE_LIMIT_CATEGORIES = [
  "auth_high_risk",
  "user_login",
  "form_submission",
  "api",
  "expensive",
  "standard_browsing",
] as const;
export type RateLimitCategory = (typeof RATE_LIMIT_CATEGORIES)[number];

export const RATE_LIMIT_CATEGORY_LABELS: Record<RateLimitCategory, string> = {
  auth_high_risk: "Authentication & High-Risk",
  user_login: "User Logins",
  form_submission: "Form Submissions",
  api: "APIs",
  expensive: "Expensive / Resource-Heavy",
  standard_browsing: "Standard Browsing",
};

export const POLICY_SLUGS = [
  "privacy-policy",
  "refund-policy",
  "liability-disclaimer",
  "terms-of-service",
  "mnda",
] as const;
export type PolicySlug = (typeof POLICY_SLUGS)[number];

/** Intake form desired-outcome options, from Phase 1 Intake Form v1.0. */
export const INTAKE_OUTCOMES = [
  "Secure Investors",
  "Find a Manufacturing Partner",
  "Technical Feasibility Audit",
  "Patent Application Support",
] as const;

/** Integrity Clause choice, from Phase 1 Intake Form v1.0. */
export const INTEGRITY_CHOICES = ["pivot_strategy", "kill_memo"] as const;
export type IntegrityChoice = (typeof INTEGRITY_CHOICES)[number];

export const INTEGRITY_CHOICE_LABELS: Record<IntegrityChoice, string> = {
  pivot_strategy: "A Pivot Strategy \u2014 guidance on adjusting the concept to make it viable",
  kill_memo: "A Kill Memo \u2014 a hard-truth report and a 50% refund of the packet fee",
};

/** Bundle rule from Product Matrix v3.0: six packet groups earn a flat 15% discount. */
export const BUNDLE_RULE = {
  minimumGroups: 6,
  discountBasisPoints: 1500,
} as const;

export const FEATURE_FLAG_KEYS = [
  "forum",
  "reviews",
  "community_teaser",
  "changelog",
  "registration",
  "stripe_checkout",
  "saml_sso",
  "newsletter",
  "meeting_scheduler",
  "login_block",
  "email_verification_bypass",
  "show_prices",
  "launch_countdown",
  "referrals",
  "stripe_payments",
  "webhooks",
] as const;
export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];

export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}
