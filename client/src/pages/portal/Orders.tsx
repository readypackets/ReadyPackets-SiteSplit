/**
 * Order list and the new-order configurator.
 *
 * The configurator never computes a price itself: each change re-requests a quote
 * from the server, which is the same code path that prices the order on
 * submission. That guarantees the figure the customer agrees to is the figure
 * recorded, including the bundle discount.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  ArrowRight,
  Check,
  Info,
  Package,
  Percent,
  Search,
  ShoppingCart,
  Trash2,
} from "lucide-react";
import { trpc, errorMessage } from "@/lib/trpc";
import { formatDate, formatMoney } from "@/lib/utils";
import { Button, LinkButton } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import {
  Alert,
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Skeleton,
} from "@/components/ui/Surface";
import { DataTable, ProgressBar, type Column } from "@/components/ui/DataDisplay";
import { useToast } from "@/components/ui/Toast";
import { PageHeader } from "@/components/layout/PortalLayout";
import { PAYMENT_LABELS, PAYMENT_TONES, STATUS_LABELS, STATUS_TONES } from "./orderStatus";

interface OrderRow {
  id: number;
  orderNumber: string;
  status: string;
  statusLabel?: string;
  paymentStatus: string;
  projectName: string | null;
  totalCents: number;
  bundleApplied: boolean;
  completionPercent: number;
  createdAt: string | Date;
  dueAt: string | Date | null;
  itemCount: number;
  currentPhaseKey: string | null;
  currentPhaseLabel: string | null;
  attention: { state: "awaiting_staff_review" | "awaiting_customer_response" | "none"; phaseKey: string | null; occurredAt: string | Date | null };
}

function customerAttentionLabel(attention: OrderRow["attention"]) {
  if (attention.state === "awaiting_staff_review") return "Team review pending";
  if (attention.state === "awaiting_customer_response") return "Your response required";
  return "No action required";
}

function customerAttentionTone(attention: OrderRow["attention"]): "warning" | "teal" | "neutral" {
  if (attention.state === "awaiting_staff_review") return "warning";
  if (attention.state === "awaiting_customer_response") return "teal";
  return "neutral";
}

export function OrdersListPage() {
  const orders = trpc.orders.list.useQuery(undefined, { refetchOnMount: "always" });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const rows = useMemo(() => {
    const list = (orders.data ?? []) as unknown as OrderRow[];
    const needle = search.trim().toLowerCase();
    return list.filter((order) => {
      if (statusFilter !== "all" && order.status !== statusFilter) return false;
      if (!needle) return true;
      return (
        order.orderNumber.toLowerCase().includes(needle) ||
        (order.projectName ?? "").toLowerCase().includes(needle)
      );
    });
  }, [orders.data, search, statusFilter]);

  const statusOptions = useMemo(() => [...new Map((orders.data ?? []).map((order) => [order.status, order.statusLabel ?? STATUS_LABELS[order.status] ?? order.status])).entries()].map(([value, label]) => ({ value, label })), [orders.data]);
  const orderStatusLabel = (order: OrderRow) => order.statusLabel ?? STATUS_LABELS[order.status] ?? order.status;

  const columns: Column<OrderRow>[] = [
    {
      key: "order",
      header: "Order",
      cell: (order) => (
        <div className="min-w-0">
          <span className="font-mono text-xs font-semibold text-muted">{order.orderNumber}</span>
          <p className="mt-0.5 truncate font-medium text-ink">
            {order.projectName ?? "Untitled project"}
          </p>
          <p className="mt-0.5 text-xs text-muted sm:hidden">
            {orderStatusLabel(order)} · {order.currentPhaseLabel ?? "Workflow not assigned"} · {order.attention.state !== "none" ? `${customerAttentionLabel(order.attention)} · ` : ""}{order.completionPercent}% complete · {formatMoney(order.totalCents)}
          </p>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      hideOnMobile: true,
      cell: (order) => <Badge tone={STATUS_TONES[order.status] ?? "neutral"}>{orderStatusLabel(order)}</Badge>,
    },
    {
      key: "progress",
      header: "Progress",
      hideOnMobile: true,
      cell: (order) => <div className="w-32 space-y-1.5"><p className="text-sm font-semibold tabular-nums text-ink">{order.completionPercent}%</p><ProgressBar value={order.completionPercent} label={`${order.completionPercent}% complete`} /></div>,
    },
    {
      key: "phase",
      header: "Current phase",
      hideOnMobile: true,
      cell: (order) => <div className="max-w-44"><p className="truncate text-sm font-medium text-ink" title={order.currentPhaseLabel ?? undefined}>{order.currentPhaseLabel ?? "Workflow complete"}</p><p className="mt-0.5 text-xs text-muted">{order.currentPhaseKey ? "Assigned workflow" : "No active phase"}</p></div>,
    },
    {
      key: "attention",
      header: "Next action",
      hideOnMobile: true,
      cell: (order) => order.attention.state === "none" ? <span className="text-xs text-muted">No action</span> : <Link href={`/portal/orders/${order.id}`} className="no-underline"><Badge tone={customerAttentionTone(order.attention)}>{customerAttentionLabel(order.attention)}</Badge></Link>,
    },
    {
      key: "payment",
      header: "Payment",
      hideOnMobile: true,
      cell: (order) => (
        <Badge tone={PAYMENT_TONES[order.paymentStatus] ?? "neutral"}>
          {PAYMENT_LABELS[order.paymentStatus] ?? order.paymentStatus}
        </Badge>
      ),
    },
    {
      key: "placed",
      header: "Placed",
      hideOnMobile: true,
      cell: (order) => <span className="text-xs text-muted">{formatDate(order.createdAt)}</span>,
    },
    {
      key: "total",
      header: "Total",
      align: "right",
      cell: (order) => (
        <div className="text-right">
          <p className="font-semibold tabular-nums text-ink">{formatMoney(order.totalCents)}</p>
          {order.bundleApplied ? (
            <Badge tone="gold" className="mt-1">
              Bundle
            </Badge>
          ) : null}
        </div>
      ),
    },
    {
      key: "go",
      header: <span className="sr-only">View</span>,
      align: "right",
      cell: (order) => {
        const terminal = ["cancelled", "refunded", "closed"].includes(order.status) || order.paymentStatus === "refunded";
        const settledOrClosed = ["paid", "partially_refunded", "refunded"].includes(order.paymentStatus) || terminal;
        const activeWorkspace = !terminal && order.paymentStatus === "paid" && order.currentPhaseKey
          ? `/portal/orders/${order.id}/workflow/${order.currentPhaseKey}?focus=documents`
          : `/portal/orders/${order.id}`;
        return (
          <Link
            href={settledOrClosed ? activeWorkspace : `/portal/checkout?order=${order.id}`}
            className="inline-flex items-center gap-1 text-sm font-semibold text-teal-dark no-underline hover:text-teal"
            aria-label={settledOrClosed ? `${terminal ? "View closed" : "Open active"} order ${order.orderNumber}` : `Complete payment for order ${order.orderNumber}`}
          >
            {settledOrClosed ? (terminal ? "View closed order" : "Open workspace") : "Complete payment"}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="My orders"
        description="Every engagement you have placed, with its current phase and payment state."
        actions={
          <LinkButton
            href="/portal/orders/new"
            leadingIcon={<Package className="size-4" aria-hidden="true" />}
          >
            New order
          </LinkButton>
        }
      />

      <Card className="mb-5">
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <Input
            label="Search"
            placeholder="Order number or project name"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            leadingIcon={<Search className="size-4" aria-hidden="true" />}
          />
          <Select
            label="Status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            className="sm:w-56"
            options={[
              { value: "all", label: "All statuses" },
              ...statusOptions,
            ]}
          />
        </div>
      </Card>

      {orders.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-16 w-full" />
          ))}
        </div>
      ) : (
        <DataTable
          caption="Your orders"
          columns={columns}
          rows={rows}
          rowKey={(order) => order.id}
          empty={
            (orders.data ?? []).length === 0 ? (
              <EmptyState
                icon={Package}
                title="You have not placed an order yet"
                description="Choose the packet groups and tiers that match where your business is now."
                action={<LinkButton href="/portal/orders/new">Configure an order</LinkButton>}
              />
            ) : (
              <EmptyState
                icon={Search}
                title="No orders match your filters"
                description="Try a different search term or clear the status filter."
                action={
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSearch("");
                      setStatusFilter("all");
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            )
          }
        />
      )}
    </>
  );
}

const TIER_ORDER = ["basic", "standard", "premium", "custom", "institutional"] as const;
const CART_STORAGE_KEY = "readypackets.order-cart.v1";

type SavedOrderCart = { selections: Record<number, number>; projectName: string; couponCode: string };

function loadSavedOrderCart(): SavedOrderCart {
  if (typeof window === "undefined") return { selections: {}, projectName: "", couponCode: "" };
  try {
    const saved = JSON.parse(window.localStorage.getItem(CART_STORAGE_KEY) ?? "{}") as Partial<SavedOrderCart>;
    return {
      selections: saved.selections && typeof saved.selections === "object" ? saved.selections : {},
      projectName: typeof saved.projectName === "string" ? saved.projectName.slice(0, 190) : "",
      couponCode: typeof saved.couponCode === "string" ? saved.couponCode.slice(0, 48).toUpperCase() : "",
    };
  } catch {
    return { selections: {}, projectName: "", couponCode: "" };
  }
}

export function NewOrderPage() {
  const [, navigate] = useLocation();
  const toast = useToast();
  const utils = trpc.useUtils();
  const catalog = trpc.public.catalog.useQuery();
  const presentation = trpc.public.catalogPresentation.useQuery();
  const customerPortalDeliveryEstimatesVisible = presentation.data?.customerPortalDeliveryEstimatesVisible ?? true;
  const restoredCart = useRef(loadSavedOrderCart()).current;
  const [selections, setSelections] = useState<Record<number, number>>(restoredCart.selections);
  const [projectName, setProjectName] = useState(restoredCart.projectName);
  const [couponCode, setCouponCode] = useState(restoredCart.couponCode);
  const [appliedCoupon, setAppliedCoupon] = useState<{ code: string; discountCents: number } | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [applyingCoupon, setApplyingCoupon] = useState(false);

  const selectionList = useMemo(
    () =>
      Object.entries(selections)
        .filter(([, productId]) => productId > 0)
        .map(([, productId]) => ({ productId, quantity: 1 })),
    [selections],
  );

  const quote = trpc.orders.quote.useQuery(
    { selections: selectionList },
    { enabled: selectionList.length > 0, staleTime: 0 },
  );

  useEffect(() => {
    const draft: SavedOrderCart = { selections, projectName, couponCode };
    if (Object.keys(selections).length === 0 && !projectName.trim() && !couponCode.trim()) {
      window.localStorage.removeItem(CART_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(draft));
  }, [couponCode, projectName, selections]);

  const applyCoupon = useCallback(async () => {
    const code = couponCode.trim().toUpperCase();
    if (!code || !quote.data) return;
    setApplyingCoupon(true);
    setCouponError(null);
    try {
      const result = await utils.stripe.validateCoupon.fetch({ code, orderTotalCents: quote.data.totalCents });
      if (!result.valid || !result.code || result.discountCents === undefined) {
        setAppliedCoupon(null);
        setCouponError(result.message ?? "This coupon cannot be applied.");
        return;
      }
      setCouponCode(result.code);
      setAppliedCoupon({ code: result.code, discountCents: result.discountCents });
      toast.success(`Coupon ${result.code} applied`, `${formatMoney(result.discountCents)} will be applied at secure checkout.`);
    } catch (error) {
      setAppliedCoupon(null);
      setCouponError(errorMessage(error));
    } finally {
      setApplyingCoupon(false);
    }
  }, [couponCode, quote.data, toast, utils.stripe.validateCoupon]);

  const create = trpc.orders.create.useMutation({
    onSuccess(result) {
      window.localStorage.removeItem(CART_STORAGE_KEY);
      if (result.requiresCustomQuote) {
        toast.success(`Order ${result.orderNumber} created`, "We will prepare a custom quote and contact you shortly.");
        navigate(`/portal/orders/${result.orderId}`);
        return;
      }
      toast.success(`Order ${result.orderNumber} created`, "Continue to secure payment to confirm your order.");
      const coupon = appliedCoupon?.code ? `&coupon=${encodeURIComponent(appliedCoupon.code)}` : "";
      navigate(`/portal/checkout?order=${result.orderId}${coupon}`);
    },
    onError(error) {
      toast.error("Could not create the order", errorMessage(error));
    },
  });

  const groups = (catalog.data ?? []).filter((group) => group.groupNumber <= 6);
  const selectedGroupCount = groups.filter((group) =>
    group.products.some((product) => selections[group.id] === product.id),
  ).length;

  const bundleEligible = selectedGroupCount >= 6;
  const recommendations = useMemo(
    () => groups
      .filter((group) => !selections[group.id])
      .map((group) => ({
        group,
        product: [...group.products].sort((left, right) => {
          const leftRank = left.tier === "standard" ? -1 : TIER_ORDER.indexOf(left.tier as (typeof TIER_ORDER)[number]);
          const rightRank = right.tier === "standard" ? -1 : TIER_ORDER.indexOf(right.tier as (typeof TIER_ORDER)[number]);
          return leftRank - rightRank;
        })[0],
      }))
      .filter((recommendation): recommendation is { group: (typeof groups)[number]; product: NonNullable<typeof recommendation.product> } => Boolean(recommendation.product))
      .slice(0, 3),
    [groups, selections],
  );

  const setTier = (groupId: number, productId: number | null) => {
    setSelections((current) => {
      const next = { ...current };
      if (productId === null) delete next[groupId];
      else next[groupId] = productId;
      return next;
    });
  };

  return (
    <>
      <PageHeader
        title="Configure your order"
        description="Build a cart by choosing one tier from each packet group. Your selections are saved in this browser until checkout."
        breadcrumb={{ href: "/portal/orders", label: "My orders" }}
        actions={Object.keys(selections).length > 0 ? <Button variant="outline" onClick={() => { setSelections({}); setProjectName(""); setCouponCode(""); setAppliedCoupon(null); setCouponError(null); }}>Clear cart</Button> : undefined}
      />

      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr] lg:items-start">
        <div className="space-y-5">
          <Card>
            <Input
              label="Order or project name"
              help="Required. This becomes the friendly name for your order and its secure document folder."
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              maxLength={190}
              required
              placeholder="e.g. Series A data room, or Widget patent filing"
            />
          </Card>

          {catalog.isLoading
            ? Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} className="h-52 w-full rounded-[var(--radius-card)]" />
              ))
            : groups.map((group) => {
                const selectedProductId = selections[group.id];
                const sorted = [...group.products].sort(
                  (left, right) =>
                    TIER_ORDER.indexOf(left.tier as (typeof TIER_ORDER)[number]) -
                    TIER_ORDER.indexOf(right.tier as (typeof TIER_ORDER)[number]),
                );

                return (
                  <Card key={group.id}>
                    <CardHeader
                      title={`Packet ${group.groupNumber} — ${group.name}`}
                      description={group.summary ?? undefined}
                      actions={
                        selectedProductId ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setTier(group.id, null)}
                            leadingIcon={<Trash2 className="size-4" aria-hidden="true" />}
                          >
                            Remove
                          </Button>
                        ) : null
                      }
                    />

                    <fieldset className="mt-4">
                      <legend className="sr-only">Choose a tier for {group.name}</legend>
                      <div className="grid gap-3 sm:grid-cols-3">
                        {sorted.map((product) => {
                          const selected = selectedProductId === product.id;
                          return (
                            <label
                              key={product.id}
                              className={`cursor-pointer rounded-lg border p-3.5 transition-colors ${
                                selected
                                  ? "border-teal bg-teal/5 ring-1 ring-teal/25"
                                  : "border-line hover:border-muted"
                              }`}
                            >
                              <span className="flex items-start justify-between gap-2">
                                <input
                                  type="radio"
                                  name={`group-${group.id}`}
                                  value={product.id}
                                  checked={selected}
                                  onChange={() => setTier(group.id, product.id)}
                                  className="mt-0.5 size-4 accent-teal"
                                />
                                {selected ? (
                                  <Check className="size-4 text-teal" aria-hidden="true" />
                                ) : null}
                              </span>
                              <span className="mt-2 block text-sm font-semibold capitalize text-ink">
                                {product.tier}
                              </span>
                              <span className="mt-1 block text-lg font-semibold tabular-nums text-ink">
                                {formatMoney(product.priceCents)}
                              </span>
                              {customerPortalDeliveryEstimatesVisible ? (
                                <span className="mt-1 block text-xs text-muted">
                                  {product.deliveryEstimate}
                                </span>
                              ) : null}
                            </label>
                          );
                        })}
                      </div>
                    </fieldset>
                  </Card>
                );
              })}
        </div>

        {/* Quote panel */}
        <Card className="lg:sticky lg:top-24">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <ShoppingCart className="size-4 text-teal" aria-hidden="true" />
                Your cart ({selectionList.length})
              </span>
            }
          />

          {selectionList.length === 0 ? (
            <p className="mt-5 text-sm text-body">
              Select a tier for at least one packet group to see your quote.
            </p>
          ) : quote.isLoading ? (
            <div className="mt-5 space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="mt-4 h-8 w-1/2" />
            </div>
          ) : quote.data ? (
            <div className="mt-5">
              <ul className="space-y-2.5 border-b border-line pb-4">
                {quote.data.lines.map((line) => (
                  <li key={line.productId} className="flex items-start justify-between gap-3 text-sm">
                    <span className="min-w-0">
                      <span className="block truncate text-ink">{line.name}</span>
                      <span className="text-xs capitalize text-muted">{line.tier}</span>
                    </span>
                    <span className="shrink-0 tabular-nums text-ink">
                      {line.unitPriceCents === 0
                        ? "Custom"
                        : formatMoney(line.lineTotalCents)}
                    </span>
                  </li>
                ))}
              </ul>

              <div className="mt-4 rounded-lg border border-line bg-surface-soft p-3">
                <label className="block text-sm font-medium text-ink" htmlFor="order-coupon">Coupon code</label>
                <p className="mt-0.5 text-xs text-muted">Enter a code, then click Apply or click outside this field.</p>
                <div className="mt-2 flex gap-2">
                  <Input id="order-coupon" aria-label="Coupon code" value={couponCode} onChange={(event) => { setCouponCode(event.target.value.toUpperCase()); setCouponError(null); if (appliedCoupon) setAppliedCoupon(null); }} onBlur={() => void applyCoupon()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void applyCoupon(); } }} placeholder="Enter coupon code" disabled={applyingCoupon} />
                  {appliedCoupon ? <Button size="sm" variant="outline" onClick={() => { setAppliedCoupon(null); setCouponCode(""); setCouponError(null); }}>Remove</Button> : <Button size="sm" variant="outline" busy={applyingCoupon} disabled={!couponCode.trim()} onClick={() => void applyCoupon()}>Apply</Button>}
                </div>
                {appliedCoupon ? <p className="mt-2 text-xs font-medium text-success">Coupon {appliedCoupon.code} applied — saving {formatMoney(appliedCoupon.discountCents)} at checkout.</p> : null}
                {couponError ? <p className="mt-2 text-xs font-medium text-danger">{couponError}</p> : null}
              </div>

              <dl className="mt-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-body">Subtotal</dt>
                  <dd className="tabular-nums text-ink">{formatMoney(quote.data.subtotalCents)}</dd>
                </div>
                {appliedCoupon ? (
                  <div className="flex justify-between text-success">
                    <dt>Coupon {appliedCoupon.code}</dt>
                    <dd className="tabular-nums">−{formatMoney(appliedCoupon.discountCents)}</dd>
                  </div>
                ) : null}
                {quote.data.discountCents > 0 ? (
                  <div className="flex justify-between text-success">
                    <dt className="flex items-center gap-1.5">
                      <Percent className="size-3.5" aria-hidden="true" />
                      Bundle reduction
                    </dt>
                    <dd className="tabular-nums">−{formatMoney(quote.data.discountCents)}</dd>
                  </div>
                ) : null}
                <div className="flex justify-between border-t border-line pt-3 text-base font-semibold">
                  <dt className="text-ink">Total</dt>
                  <dd className="tabular-nums text-ink">{formatMoney(Math.max(0, quote.data.totalCents - (appliedCoupon?.discountCents ?? 0)))}</dd>
                </div>
              </dl>

              {quote.data.requiresCustomQuote ? (
                <Alert tone="info" className="mt-4">
                  One or more selections are priced per engagement. We will prepare a written quote
                  before any work begins.
                </Alert>
              ) : null}

              {!bundleEligible && selectedGroupCount > 0 ? (
                <Alert tone="info" className="mt-4">
                  <span className="flex items-start gap-1.5">
                    <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    <span>
                      {selectedGroupCount} of 6 packet groups selected. Choose a tier in all six to
                      unlock the 15% bundle reduction.
                    </span>
                  </span>
                </Alert>
              ) : null}

              {bundleEligible ? (
                <Alert tone="success" className="mt-4" title="Bundle reduction applied">
                  All six packet groups are selected, so the 15% All-In reduction has been applied.
                </Alert>
              ) : null}

              {recommendations.length > 0 ? <div className="mt-4 border-t border-line pt-4"><h3 className="text-sm font-semibold text-ink">Suggested additions</h3><p className="mt-1 text-xs text-muted">Recommendations are based on the packet groups not yet in your cart. You stay in control of every addition.</p><ul className="mt-3 space-y-2">{recommendations.map(({ group, product }) => <li key={group.id} className="flex items-center justify-between gap-3 rounded-lg border border-line p-2.5"><div className="min-w-0"><p className="truncate text-xs font-medium text-ink">{group.name}</p><p className="text-xs capitalize text-muted">Suggested {product.tier} tier · {product.priceCents === null ? "Custom quote" : formatMoney(product.priceCents)}</p></div><Button size="sm" variant="outline" onClick={() => setTier(group.id, product.id)}>Add</Button></li>)}</ul></div> : null}

              <Button
                fullWidth
                className="mt-5"
                busy={create.isPending}
                disabled={selectionList.length === 0 || !projectName.trim()}
                onClick={() =>
                  create.mutate({
                    selections: selectionList,
                    projectName: projectName.trim(),
                  })
                }
              >
                Place order
              </Button>

              <p className="mt-3 text-xs text-muted">
                You will be redirected to secure Stripe Checkout to confirm payment. Work does not begin until payment, the mutual NDA, and the Phase I intake are complete; no card details are stored on our servers.
              </p>
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}
