import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "../../lib/trpc";
import { Card } from "../../components/ui/Surface";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Field";
import { useToast } from "../../components/ui/Toast";
import { ArrowUpRight, CheckCircle2, LockKeyhole, ReceiptText } from "lucide-react";

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

type CouponPreview = {
  code: string;
  discountCents: number;
  discountType: "percent" | "fixed" | "cart_price";
  discountValue: number;
};

export default function Checkout() {
  const [, navigate] = useLocation();
  const { success, error } = useToast();
  const utils = trpc.useUtils();

  const params = new URLSearchParams(window.location.search);
  const orderId = parseInt(params.get("order") ?? "0", 10);

  const initialCouponCode = params.get("coupon")?.trim().toUpperCase() ?? "";
  const [couponCode, setCouponCode] = useState(initialCouponCode);
  const shouldAutoApplyCoupon = useRef(Boolean(initialCouponCode));
  const [appliedCoupon, setAppliedCoupon] = useState<CouponPreview | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [isApplyingCoupon, setIsApplyingCoupon] = useState(false);

  const order = trpc.orders.checkoutDetail.useQuery(
    { orderId },
    { enabled: orderId > 0 },
  );

  const createCheckout = trpc.stripe.createCheckout.useMutation();

  const applyCouponCode = useCallback(async () => {
    const normalizedCode = couponCode.trim().toUpperCase();
    if (!normalizedCode || !order.data?.order) return;
    if (appliedCoupon?.code === normalizedCode) return;

    setCouponError(null);
    setIsApplyingCoupon(true);
    try {
      const result = await utils.stripe.validateCoupon.fetch({
        code: normalizedCode,
        orderTotalCents: order.data.order.totalCents,
      });
      if (!result.valid || !result.code || result.discountCents === undefined || !result.discountType || result.discountValue === undefined) {
        setAppliedCoupon(null);
        setCouponError(result.message ?? "Invalid or expired coupon code.");
        return;
      }
      setCouponCode(result.code);
      setAppliedCoupon({
        code: result.code,
        discountCents: result.discountCents,
        discountType: result.discountType,
        discountValue: result.discountValue,
      });
      success(
        `Coupon ${result.code} applied`,
        result.discountType === "cart_price"
          ? `Your final cart price will be ${formatMoney(result.discountValue)}.`
          : `${formatMoney(result.discountCents)} will be applied at payment.`,
      );
    } catch (cause) {
      setAppliedCoupon(null);
      setCouponError(cause instanceof Error ? cause.message : "Could not validate this coupon code.");
    } finally {
      setIsApplyingCoupon(false);
    }
  }, [appliedCoupon?.code, couponCode, order.data?.order, success, utils.stripe.validateCoupon]);

  useEffect(() => {
    if (!shouldAutoApplyCoupon.current || !order.data?.order || !couponCode || appliedCoupon || isApplyingCoupon) return;
    shouldAutoApplyCoupon.current = false;
    void applyCouponCode();
  }, [appliedCoupon, applyCouponCode, couponCode, isApplyingCoupon, order.data?.order]);

  async function startCheckout() {
    try {
      const result = await createCheckout.mutateAsync({
        orderId,
        couponCode: appliedCoupon?.code,
      });
      window.location.href = result.url;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Could not start checkout.";
      error(msg);
    }
  }

  if (!orderId) {
    return (
      <div className="max-w-lg mx-auto py-12">
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 text-red-700 dark:text-red-400">
          No order specified. Please go back and try again.
        </div>
      </div>
    );
  }

  if (order.isLoading) {
    return <div className="max-w-lg mx-auto py-12 text-center text-gray-400">Loading order…</div>;
  }

  if (!order.data?.order) {
    return (
      <div className="max-w-lg mx-auto py-12">
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 text-red-700 dark:text-red-400">
          Order not found.
        </div>
      </div>
    );
  }

  const o = order.data.order;
  const items = order.data.items;
  const couponDiscount = appliedCoupon?.discountCents ?? 0;
  const payableTotal = Math.max(0, o.totalCents - couponDiscount);

  return (
    <div className="max-w-lg mx-auto py-8 space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-teal-700 dark:text-teal-300">Secure checkout</p>
        <h1 className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">Review, pay securely, and return to your work.</h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">ReadyPackets prepares the order record. Payment details are entered only in the secure Stripe-hosted checkout.</p>
      </div>

      <Card className="p-6 space-y-4">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">Order #{o.orderNumber}</h2>
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.id} className="flex justify-between text-sm">
              <span className="text-gray-700 dark:text-gray-300">{item.name} — {item.tier}</span>
              <span className="font-medium text-gray-900 dark:text-white">{formatMoney(item.unitPriceCents)}</span>
            </div>
          ))}
        </div>
        {o.discountCents > 0 && (
          <div className="flex justify-between text-sm text-green-600 dark:text-green-400">
            <span>Order discount</span><span>−{formatMoney(o.discountCents)}</span>
          </div>
        )}
        {appliedCoupon && (
          <div className="flex justify-between text-sm text-green-600 dark:text-green-400">
            <span>Coupon {appliedCoupon.code}{appliedCoupon.discountType === "cart_price" ? ` — cart price ${formatMoney(appliedCoupon.discountValue)}` : ""}</span><span>−{formatMoney(couponDiscount)}</span>
          </div>
        )}
        <div className="border-t border-gray-200 dark:border-gray-700 pt-3 flex justify-between font-semibold">
          <span className="text-gray-900 dark:text-white">Total due today</span>
          <span className="text-teal-600 dark:text-teal-400">{formatMoney(payableTotal)}</span>
        </div>
      </Card>

      <Card className="p-6">
        <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-white"><ReceiptText className="size-5 text-teal-600" aria-hidden="true" />What happens next</h2>
        <ol className="mt-4 grid gap-3 text-sm text-gray-600 dark:text-gray-300 sm:grid-cols-3">
          <li className="rounded-lg border border-gray-200 p-3 dark:border-gray-700"><span className="font-semibold text-gray-900 dark:text-white">1. Review</span><br />Confirm the order and any eligible coupon.</li>
          <li className="rounded-lg border border-gray-200 p-3 dark:border-gray-700"><span className="font-semibold text-gray-900 dark:text-white">2. Pay in Stripe</span><br />Enter payment information only on Stripe’s secure page.</li>
          <li className="rounded-lg border border-gray-200 p-3 dark:border-gray-700"><span className="font-semibold text-gray-900 dark:text-white">3. Confirm in Portal</span><br />Return here while the Portal verifies the payment webhook.</li>
        </ol>
      </Card>

      <Card className="p-6 space-y-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Coupon code</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Enter a code and click outside the field to apply automatically, or use Apply.</p>
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <Input
              value={couponCode}
              onChange={(event) => {
                setCouponCode(event.target.value.toUpperCase());
                setCouponError(null);
                if (appliedCoupon) setAppliedCoupon(null);
              }}
              onBlur={() => void applyCouponCode()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void applyCouponCode();
                }
              }}
              placeholder="Enter coupon code"
              disabled={isApplyingCoupon}
            />
          </div>
          {appliedCoupon ? (
            <Button variant="secondary" onClick={() => { setAppliedCoupon(null); setCouponCode(""); setCouponError(null); }}>Remove</Button>
          ) : (
            <Button variant="secondary" busy={isApplyingCoupon} onClick={() => void applyCouponCode()} disabled={!couponCode.trim()}>
              Apply
            </Button>
          )}
        </div>
        {appliedCoupon ? <p className="text-sm text-green-600 dark:text-green-400">Coupon <strong>{appliedCoupon.code}</strong> applied — saving {formatMoney(appliedCoupon.discountCents)}.</p> : null}
        {couponError ? <p className="text-sm text-red-600 dark:text-red-400">{couponError}</p> : null}
      </Card>

      <Card className="p-6 space-y-4">
        <div className="flex items-start gap-3"><div className="rounded-full bg-teal-50 p-2 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300"><LockKeyhole className="size-5" aria-hidden="true" /></div><div><h2 className="text-base font-semibold text-gray-900 dark:text-white">Continue to secure payment</h2><p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Your card details never pass through ReadyPackets. Stripe processes the payment on its hosted page.</p></div></div>
        <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300"><CheckCircle2 className="mr-1 inline size-4 text-teal-600" aria-hidden="true" />A return to the Portal does not by itself confirm payment. Your order activates only after the provider webhook is verified.</p>
        <button onClick={startCheckout} disabled={createCheckout.isPending} aria-busy={createCheckout.isPending} className="flex w-full items-center justify-center gap-2 rounded-lg bg-teal-600 px-6 py-3 font-semibold text-white transition-colors hover:bg-teal-700 disabled:opacity-50">
          {createCheckout.isPending ? "Opening secure payment…" : <><span>Pay {formatMoney(payableTotal)} in Stripe</span><ArrowUpRight className="size-4" aria-hidden="true" /></>}
        </button>
        <p className="text-center text-xs text-gray-500 dark:text-gray-400" aria-live="polite">You will leave ReadyPackets briefly and return to your order after completing or cancelling payment.</p>
      </Card>

      <div className="text-center"><button onClick={() => navigate("/portal/orders")} className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">← Back to my orders</button></div>
    </div>
  );
}
