import { describe, expect, it } from "vitest";
import { invoicePdfFileName, renderInvoicePdf } from "../server/services/invoicePdf.js";
import type { ReadyPacketsInvoice } from "../server/services/invoices.js";

const invoice: ReadyPacketsInvoice = {
  id: 42,
  invoiceNumber: "RP-INV-2026-000042",
  orderId: 7,
  orderNumber: "RP-C000007-2608-ABCD12",
  issuedAt: new Date("2026-08-18T12:00:00Z"),
  paidAt: new Date("2026-08-18T12:01:00Z"),
  customer: { publicId: "RP26-ABCDEFGH", firstName: "Ada", lastName: "Customer", name: "Ada Customer", company: "Example LLC" },
  lines: [{ description: "Idea & IP Protection — Premium", quantity: 1, unitPriceCents: 245000, lineTotalCents: 245000 }],
  productValueCents: 245000,
  subtotalCents: 245000,
  pricingAdjustmentCents: 0,
  discountCents: 25000,
  discount: { code: "WELCOME10", amountCents: 25000 },
  totalCents: 220000,
  actualCustomerPaidCents: 220000,
  paymentReference: "pi_example",
  orderOrigin: "customer",
  orderOriginLabel: "Customer-created order",
  paymentRequirement: "required",
  paymentEvidenceLabel: "Stripe-confirmed customer payment",
  customerVisible: true,
  publishedAt: new Date("2026-08-18T12:00:00Z"),
  emailQueuedAt: new Date("2026-08-18T12:01:00Z"),
  brand: { companyName: "ReadyPackets", logoPath: "/brand/readypackets-document-flow-light-wordmark.svg", supportUrl: "https://www.readypackets.com" },
};

describe("branded invoice PDF", () => {
  it("renders a valid branded PDF with payment and origin evidence", () => {
    const pdf = renderInvoicePdf(invoice);
    const output = pdf.toString("latin1");
    expect(output.startsWith("%PDF-1.4")).toBe(true);
    expect(output).toContain("ReadyPackets");
    expect(output).toContain("Actual customer payment");
    expect(output).toContain("Customer-created order");
    expect(output).toContain("WELCOME10");
    expect(invoicePdfFileName(invoice)).toBe("RP-INV-2026-000042.pdf");
  });
});
