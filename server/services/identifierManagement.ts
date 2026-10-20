/**
 * Validation and explanatory policy helpers for privileged identifier changes.
 *
 * Database mutations remain in the administrator router. Keeping these rules
 * pure makes the accepted modern ID formats and evidence policy independently
 * testable without a production database.
 */

/** Current opaque order-reference format; legacy sequential identifiers are not accepted. */
export const ORDER_REFERENCE_PATTERN = /^RP-ORD-(?:[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6,8}-)?\d{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

/** Identifier comparisons and persistence always use canonical uppercase form. */
export function normalizeAdministratorIdentifier(value: string): string {
  return value.trim().toUpperCase();
}

export interface OrderReferenceEvidence {
  invoice?: boolean;
  payment?: boolean;
  refund?: boolean;
  file?: boolean;
  sharepoint?: boolean;
  conversionOrTransfer?: boolean;
  webhook?: boolean;
  mnda?: boolean;
  intake?: boolean;
}

/**
 * An order reference becomes immutable as soon as a financial, customer-file,
 * external-transfer, outbound-webhook, or customer-agreement record exists.
 */
export function orderReferenceEvidenceLabels(evidence: OrderReferenceEvidence): string[] {
  return [
    evidence.invoice ? "invoice" : null,
    evidence.payment ? "payment" : null,
    evidence.refund ? "refund" : null,
    evidence.file ? "file" : null,
    evidence.sharepoint ? "SharePoint record" : null,
    evidence.conversionOrTransfer ? "conversion or transfer record" : null,
    evidence.webhook ? "webhook delivery" : null,
    evidence.mnda ? "MNDA acceptance" : null,
    evidence.intake ? "intake submission" : null,
  ].filter((value): value is string => Boolean(value));
}
