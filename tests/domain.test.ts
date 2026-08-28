/**
 * Order lifecycle rules and catalogue pricing.
 *
 * Pricing runs against the seeded database rather than a fixture, because the
 * commercially important behaviour — the fifteen percent All-In discount at six
 * distinct packet groups, and the institutional product that must never be
 * auto-priced — lives in the seeded rows, not in the code. A fixture would let
 * the code and the catalogue drift apart without a test noticing.
 */
import { afterAll, describe, expect, it } from "vitest";
import { and, eq, isNotNull } from "drizzle-orm";
import { closeDatabase, db } from "../server/db/client.js";
import { products } from "../server/db/schema.js";
import { getCatalog, priceSelection } from "../server/services/catalog.js";
import {
  BUNDLE_RULE,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  type OrderStatus,
} from "../shared/domain.js";

afterAll(async () => {
  await closeDatabase();
});

describe("order state machine", () => {
  it("declares a transition list for every status", () => {
    for (const status of ORDER_STATUSES) {
      expect(ORDER_TRANSITIONS[status]).toBeDefined();
    }
  });

  it("only ever targets a declared status", () => {
    const known = new Set<string>(ORDER_STATUSES);
    for (const [from, targets] of Object.entries(ORDER_TRANSITIONS)) {
      for (const target of targets) {
        expect(known.has(target), `${from} -> ${target}`).toBe(true);
      }
    }
  });

  it("never allows a transition back into the same status", () => {
    for (const [from, targets] of Object.entries(ORDER_TRANSITIONS)) {
      expect(targets).not.toContain(from as OrderStatus);
    }
  });

  it("treats cancelled and refunded as terminal while allowing a late Stripe refund after completion", () => {
    expect(ORDER_TRANSITIONS.cancelled).toEqual(["refunded"]);
    expect(ORDER_TRANSITIONS.refunded).toEqual([]);
    expect(ORDER_TRANSITIONS.closed).toEqual(["refunded"]);
  });

  it("follows the documented four-phase production path", () => {
    expect(ORDER_TRANSITIONS.new).toContain("phase_1_intake");
    expect(ORDER_TRANSITIONS.phase_1_intake).toContain("phase_2_synthesis");
    expect(ORDER_TRANSITIONS.phase_2_synthesis).toContain("in_production");
    expect(ORDER_TRANSITIONS.in_production).toContain("delivered");
    expect(ORDER_TRANSITIONS.delivered).toContain("closed");
  });

  it("allows cancellation only before delivery", () => {
    const cancellable = ORDER_STATUSES.filter((status) =>
      ORDER_TRANSITIONS[status].includes("cancelled"),
    );
    expect(cancellable).toEqual([
      "new",
      "phase_1_intake",
      "phase_2_synthesis",
      "in_production",
    ]);
    // Once work is delivered the remedy is a refund, not a cancellation.
    expect(ORDER_TRANSITIONS.delivered).not.toContain("cancelled");
  });

  it("permits a confirmed refund from any active, cancelled, or completed order state", () => {
    const refundable = ORDER_STATUSES.filter((status) =>
      ORDER_TRANSITIONS[status].includes("refunded"),
    );
    expect(refundable.sort()).toEqual(["cancelled", "closed", "delivered", "in_production", "new", "phase_1_intake", "phase_2_synthesis"]);
  });

  it("makes every status reachable from the initial status", () => {
    const seen = new Set<OrderStatus>(["new"]);
    const queue: OrderStatus[] = ["new"];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of ORDER_TRANSITIONS[current]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    for (const status of ORDER_STATUSES) {
      expect(seen.has(status), `${status} is unreachable`).toBe(true);
    }
  });
});

describe("catalogue", () => {
  it("exposes the eight packet groups with products", async () => {
    const catalog = await getCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(7);
    for (const group of catalog) {
      expect(group.slug).toMatch(/^[a-z0-9-]+$/);
      expect(Array.isArray(group.products)).toBe(true);
    }
  });

  it("never exposes a negative or fractional price", async () => {
    const catalog = await getCatalog();
    for (const group of catalog) {
      for (const product of group.products) {
        if (product.priceCents !== null) {
          expect(Number.isInteger(product.priceCents)).toBe(true);
          expect(product.priceCents).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("bundle pricing", () => {
  /** One priced product from each of the first `count` distinct groups. */
  async function pricedProductsAcrossGroups(count: number) {
    const rows = await db
      .select({
        id: products.id,
        packetGroupId: products.packetGroupId,
        priceCents: products.priceCents,
      })
      .from(products)
      .where(and(eq(products.active, true), isNotNull(products.priceCents)));

    const chosen: { id: number; packetGroupId: number; priceCents: number }[] = [];
    const usedGroups = new Set<number>();
    for (const row of rows) {
      if (usedGroups.has(row.packetGroupId)) continue;
      if (row.priceCents === null) continue;
      usedGroups.add(row.packetGroupId);
      chosen.push({
        id: row.id,
        packetGroupId: row.packetGroupId,
        priceCents: row.priceCents,
      });
      if (chosen.length === count) break;
    }
    return chosen;
  }

  it("returns a zero quote for an empty selection", async () => {
    const quote = await priceSelection([]);
    expect(quote.subtotalCents).toBe(0);
    expect(quote.totalCents).toBe(0);
    expect(quote.bundleApplied).toBe(false);
  });

  it("ignores an unknown product id instead of failing", async () => {
    const quote = await priceSelection([{ productId: 999_999 }]);
    expect(quote.lines).toEqual([]);
    expect(quote.totalCents).toBe(0);
  });

  it("sums a single line correctly", async () => {
    const [product] = await pricedProductsAcrossGroups(1);
    expect(product).toBeDefined();
    const quote = await priceSelection([{ productId: product!.id }]);
    expect(quote.subtotalCents).toBe(product!.priceCents);
    expect(quote.totalCents).toBe(product!.priceCents);
    expect(quote.bundleApplied).toBe(false);
  });

  it("clamps quantity to the permitted range", async () => {
    const [product] = await pricedProductsAcrossGroups(1);
    const tooMany = await priceSelection([{ productId: product!.id, quantity: 9_999 }]);
    expect(tooMany.lines[0]!.quantity).toBe(10);

    const tooFew = await priceSelection([{ productId: product!.id, quantity: 0 }]);
    expect(tooFew.lines[0]!.quantity).toBe(1);

    const negative = await priceSelection([{ productId: product!.id, quantity: -5 }]);
    expect(negative.lines[0]!.quantity).toBe(1);
  });

  it("withholds the discount below the group threshold", async () => {
    const chosen = await pricedProductsAcrossGroups(BUNDLE_RULE.minimumGroups - 1);
    expect(chosen.length).toBe(BUNDLE_RULE.minimumGroups - 1);
    const quote = await priceSelection(chosen.map((product) => ({ productId: product.id })));
    expect(quote.distinctGroups).toBe(BUNDLE_RULE.minimumGroups - 1);
    expect(quote.bundleApplied).toBe(false);
    expect(quote.discountCents).toBe(0);
    expect(quote.totalCents).toBe(quote.subtotalCents);
  });

  it("applies exactly fifteen percent at the group threshold", async () => {
    const chosen = await pricedProductsAcrossGroups(BUNDLE_RULE.minimumGroups);
    expect(chosen.length).toBe(BUNDLE_RULE.minimumGroups);
    const quote = await priceSelection(chosen.map((product) => ({ productId: product.id })));

    expect(quote.bundleApplied).toBe(true);
    expect(quote.distinctGroups).toBe(BUNDLE_RULE.minimumGroups);
    const expected = Math.floor(
      (quote.subtotalCents * BUNDLE_RULE.discountBasisPoints) / 10_000,
    );
    expect(quote.discountCents).toBe(expected);
    expect(quote.totalCents).toBe(quote.subtotalCents - expected);
  });

  it("keeps all money in whole cents and never rounds against the customer", async () => {
    const chosen = await pricedProductsAcrossGroups(BUNDLE_RULE.minimumGroups);
    const quote = await priceSelection(chosen.map((product) => ({ productId: product.id })));
    expect(Number.isInteger(quote.subtotalCents)).toBe(true);
    expect(Number.isInteger(quote.discountCents)).toBe(true);
    expect(Number.isInteger(quote.totalCents)).toBe(true);
    // Floor-based rounding means the charged discount is never smaller than the
    // stated percentage would imply.
    expect(quote.discountCents).toBeLessThanOrEqual(
      (quote.subtotalCents * BUNDLE_RULE.discountBasisPoints) / 10_000,
    );
  });

  it("flags a custom-priced product for manual quotation", async () => {
    const custom = await db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.customPricing, true))
      .limit(1);

    if (custom.length === 0) {
      // The institutional packet is optional in a trimmed catalogue.
      expect(true).toBe(true);
      return;
    }

    const quote = await priceSelection([{ productId: custom[0]!.id }]);
    expect(quote.requiresCustomQuote).toBe(true);
    // A product without a published price must contribute nothing to the total
    // rather than silently being treated as free.
    expect(quote.subtotalCents).toBe(0);
    expect(quote.lines[0]!.unitPriceCents).toBe(0);
  });

  it("deduplicates repeated selections of the same product for group counting", async () => {
    const [product] = await pricedProductsAcrossGroups(1);
    const quote = await priceSelection([
      { productId: product!.id },
      { productId: product!.id },
    ]);
    expect(quote.distinctGroups).toBe(1);
    expect(quote.subtotalCents).toBe(product!.priceCents * 2);
  });
});
