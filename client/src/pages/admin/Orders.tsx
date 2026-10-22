/**
 * Admin order queue and order detail.
 *
 * Status changes are offered only for transitions the server's state machine
 * accepts, so the UI cannot present an action that would be rejected. Internal
 * notes are visually separated from shared notes to make an accidental disclosure
 * to the customer difficult.
 */
import { useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "wouter";
import {
  ArrowRight,
  ClipboardList,
  Cloud,
  Download,
  Grid2X2,
  History,
  FileSignature,
  FileAudio,
  LayoutList,
  Lock,
  MessageSquarePlus,
  Plus,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Send,
  Trash2,
  Unlock,
  Upload,
} from "lucide-react";
import { ORDER_TRANSITIONS, INTEGRITY_CHOICE_LABELS } from "@shared/domain";
import { trpc, errorMessage, csrfToken, refreshCsrfToken } from "@/lib/trpc";
import { useSession } from "@/lib/session";
import { formatBytes, formatDate, formatDateTime, formatMoney, humanizeKey } from "@/lib/utils";
import { Button, LinkButton } from "@/components/ui/Button";
import { AudioPlayback } from "@/components/ui/AudioPlayback";
import { Checkbox, FieldShell, Input, Select, Textarea } from "@/components/ui/Field";
import {
  Alert,
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Skeleton,
} from "@/components/ui/Surface";
import { DataTable, ProgressBar, TabStrip, type Column } from "@/components/ui/DataDisplay";
import { ConfirmDialog, Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { PageHeader } from "@/components/layout/PortalLayout";
import {
  PAYMENT_LABELS,
  PAYMENT_TONES,
  STATUS_LABELS,
  STATUS_TONES,
} from "../portal/orderStatus";

/** Modal for admins to create an order on behalf of a customer. */
function CreateOrderModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const utils = trpc.useUtils();
  const [userId, setUserId] = useState("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [projectName, setProjectName] = useState("");
  const [canonVersion, setCanonVersion] = useState("");
  const [runMode, setRunMode] = useState("production");
  const [releaseStatus, setReleaseStatus] = useState("");
  const [bundleScopeManifest, setBundleScopeManifest] = useState("");
  const [paymentRequirement, setPaymentRequirement] = useState<"required" | "waived" | "test">("required");
  const [manualPrice, setManualPrice] = useState("");
  const [selectedProducts, setSelectedProducts] = useState<number[]>([]);

  const customers = trpc.admin.customers.useQuery(
    { search: customerSearch || undefined, limit: 20 },
    { enabled: open },
  );
  const catalog = trpc.admin.catalog.useQuery(undefined, { enabled: open });

  const createMut = trpc.admin.createOrderForCustomer.useMutation({
    async onSuccess(result) {
      toast.success("Order created", `Order ${result.orderNumber} created successfully.`);
      await utils.admin.orders.invalidate();
      onClose();
      setUserId("");
      setCustomerSearch("");
      setProjectName("");
      setPaymentRequirement("required");
      setManualPrice("");
      setSelectedProducts([]);
    },
    onError(error) {
      toast.error("Could not create order", errorMessage(error));
    },
  });

  const allProducts = catalog.data?.flatMap((g) => g.products) ?? [];

  function toggleProduct(id: number) {
    setSelectedProducts((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  }

  function handleSubmit() {
    if (!userId || selectedProducts.length === 0) return;
    if (!projectName.trim()) {
      toast.error("Order or project name required", "Enter the customer-facing project name before creating the order.");
      return;
    }
    const normalizedPrice = manualPrice.trim();
    const manualPriceCents: number | undefined = normalizedPrice ? Math.round(Number(normalizedPrice) * 100) : undefined;
    if (manualPriceCents !== undefined && (!Number.isFinite(manualPriceCents) || manualPriceCents < 0 || manualPriceCents > 100_000_000)) {
      toast.error("Invalid administrator price", "Enter a price between $0.00 and $1,000,000.00.");
      return;
    }
    createMut.mutate({
      userId: Number(userId),
      selections: selectedProducts.map((productId) => ({ productId, quantity: 1 })),
      projectName: projectName.trim(),
      canonVersion: canonVersion.trim() || undefined,
      runMode: runMode.trim() || undefined,
      releaseStatus: releaseStatus.trim() || undefined,
      bundleScopeManifest: bundleScopeManifest.trim() || undefined,
      paymentRequirement,
      manualPriceCents,
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create order for customer"
      description="Select a customer and one or more packets to create an order on their behalf."
    >
      <div className="space-y-4">
        <Input
          label="Search customer"
          placeholder="Name or email…"
          value={customerSearch}
          onChange={(e) => setCustomerSearch(e.target.value)}
        />
        <FieldShell label="Customer" required>
          <select
            className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-teal"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          >
            <option value="">Select a customer…</option>
            {(customers.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} — {c.email}
              </option>
            ))}
          </select>
        </FieldShell>
        <Input
          label="Order or project name"
          help="Required. This becomes the friendly name for the secure order folder."
          placeholder="e.g. Project Mercury"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          required
          maxLength={200}
        />
        <div className="grid gap-4 rounded-xl border border-line bg-surface-soft p-4 md:grid-cols-2">
          <Select
            label="Payment requirement"
            value={paymentRequirement}
            onChange={(event) => setPaymentRequirement(event.target.value as "required" | "waived" | "test")}
            options={[
              { value: "required", label: "Require verified Stripe payment" },
              { value: "waived", label: "No payment required — administrator waiver" },
              { value: "test", label: "Test order — no payment or external automations" },
            ]}
            help="Only a verified Stripe webhook activates required-payment orders. Waived and test orders are marked paid by the administrator-created order policy."
          />
          <Input
            label="Administrator price (USD)"
            type="number"
            min="0"
            max="1000000"
            step="0.01"
            placeholder="Use packet pricing when blank"
            value={manualPrice}
            onChange={(event) => setManualPrice(event.target.value)}
            help="Optional fixed total. When payment is required, Stripe charges this exact amount instead of the packet-price total."
          />
          {paymentRequirement === "test" ? <Alert tone="warning" className="md:col-span-2">Test orders are usable without payment, but never create Stripe charges, SharePoint folders, or payment/order automation messages.</Alert> : null}
          {paymentRequirement === "waived" ? <Alert tone="warning" className="md:col-span-2">This creates an auditable administrator payment waiver and immediately activates the order without Stripe checkout.</Alert> : null}
        </div>
        <div className="border-t border-line pt-4 mt-2">
          <p className="mb-3 text-sm font-semibold text-ink">Webhook payload fields</p>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Canon version"
              placeholder="e.g. ReadyPackets_Production_v2.0"
              value={canonVersion}
              onChange={(e) => setCanonVersion(e.target.value)}
            />
            <Input
              label="Run mode"
              placeholder="e.g. production"
              value={runMode}
              onChange={(e) => setRunMode(e.target.value)}
            />
            <Input
              label="Release status"
              placeholder="Optional tracking label"
              value={releaseStatus}
              onChange={(e) => setReleaseStatus(e.target.value)}
            />
          </div>
          <div className="mt-4 mb-4">
            <Textarea
              label="Bundle scope manifest (JSON string)"
              rows={2}
              placeholder='e.g. {"packet_1":"Standard","packet_2":"Basic"}'
              value={bundleScopeManifest}
              onChange={(e) => setBundleScopeManifest(e.target.value)}
              help="Must be a valid JSON string (it will be escaped in the webhook payload)."
            />
          </div>
        </div>
        <FieldShell label="Packets" required>
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
            {allProducts.length === 0 ? (
              <p className="p-2 text-sm text-muted">Loading catalogue…</p>
            ) : (
              allProducts.map((p) => (
                <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-surface-soft">
                  <input
                    type="checkbox"
                    className="size-4 accent-teal"
                    checked={selectedProducts.includes(p.id)}
                    onChange={() => toggleProduct(p.id)}
                  />
                  <span className="min-w-0 flex-1 text-sm text-ink">{p.name}</span>
                  {p.priceCents ? (
                    <span className="shrink-0 text-xs text-muted">{formatMoney(p.priceCents)}</span>
                  ) : (
                    <span className="shrink-0 text-xs text-muted">Custom quote</span>
                  )}
                </label>
              ))
            )}
          </div>
        </FieldShell>
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            busy={createMut.isPending}
            disabled={!userId || selectedProducts.length === 0}
            onClick={handleSubmit}
          >
            Create order
          </Button>
        </div>
      </div>
    </Modal>
  );
}

interface AdminOrderRow {
  id: number;
  orderNumber: string;
  customer: string;
  userId: number;
  status: string;
  paymentStatus: string;
  totalCents: number;
  bundleApplied: boolean;
  completionPercent: number;
  projectName: string | null;
  createdAt: string | Date;
  dueAt: string | Date | null;
  attention: { state: "awaiting_staff_review" | "awaiting_customer_response" | "none"; phaseKey: string | null; occurredAt: string | Date | null };
}

function adminAttentionLabel(attention: AdminOrderRow["attention"]) {
  if (attention.state === "awaiting_staff_review") return "Customer submission awaiting review";
  if (attention.state === "awaiting_customer_response") return "Awaiting customer response";
  return "No action required";
}

function adminAttentionTone(attention: AdminOrderRow["attention"]): "warning" | "teal" | "neutral" {
  if (attention.state === "awaiting_staff_review") return "warning";
  if (attention.state === "awaiting_customer_response") return "teal";
  return "neutral";
}

/** Grid card with inline completion editing; lifecycle status changes stay in the audited order workspace control. */
function InlineOrderCard({
  order,
  onUpdated,
}: {
  order: AdminOrderRow;
  onUpdated: () => void;
}) {
  const toast = useToast();
  const [editPercent, setEditPercent] = useState(false);
  const [percent, setPercent] = useState(String(order.completionPercent));

  const updateMut = trpc.admin.updateOrder.useMutation({
    onSuccess() {
      toast.success("Order updated");
      setEditPercent(false);
      onUpdated();
    },
    onError(err) {
      toast.error("Update failed", errorMessage(err));
    },
  });

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-xs font-semibold text-muted">{order.orderNumber}</span>
        <div className="flex flex-wrap justify-end gap-1"><Badge tone={STATUS_TONES[order.status] ?? "neutral"} className="shrink-0">{STATUS_LABELS[order.status] ?? order.status}</Badge>{order.attention.state !== "none" ? <Badge tone={adminAttentionTone(order.attention)}>{order.attention.state === "awaiting_staff_review" ? "Review needed" : "Customer action"}</Badge> : null}</div>
      </div>

      <div>
        <p className="truncate font-medium text-ink">{order.projectName ?? "Untitled project"}</p>
        <p className="mt-0.5 truncate text-sm text-muted">{order.customer}</p>
      </div>

      {/* Completion % */}
      <div>
        {editPercent ? (
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={100}
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
              className="w-20 rounded border border-line px-2 py-1 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-teal"
            />
            <span className="text-sm text-muted">%</span>
            <Button
              size="sm"
              busy={updateMut.isPending}
              onClick={() =>
                updateMut.mutate({
                  orderId: order.id,
                  completionPercent: Math.min(100, Math.max(0, Number(percent))),
                })
              }
            >
              Save
            </Button>
            <button
              type="button"
              className="text-xs text-muted hover:text-ink"
              onClick={() => {
                setEditPercent(false);
                setPercent(String(order.completionPercent));
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="w-full text-left"
            onClick={() => setEditPercent(true)}
            title="Click to edit completion %"
          >
            <ProgressBar value={order.completionPercent} />
            <p className="mt-1 text-xs text-muted">{order.completionPercent}% complete — click to edit</p>
          </button>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-line pt-2">
        <Badge tone={PAYMENT_TONES[order.paymentStatus] ?? "neutral"}>
          {PAYMENT_LABELS[order.paymentStatus] ?? order.paymentStatus}
        </Badge>
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold tabular-nums text-ink">
            {formatMoney(order.totalCents)}
          </span>
          <Link
            href={`/admin/orders/${order.id}`}
            className="text-sm font-semibold text-teal-dark no-underline hover:text-teal"
          >
            Open →
          </Link>
        </div>
      </div>
    </Card>
  );
}

export function AdminOrdersPage() {
  const toast = useToast();
  const utils = trpc.useUtils();
  const [params] = useSearchParams();
  const statusParam = params.get("status") ?? "";
  const attentionParam = params.get("attention") ?? "";
  const [status, setStatus] = useState(statusParam);
  const [attention, setAttention] = useState(attentionParam);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [bulkTrashOpen, setBulkTrashOpen] = useState(false);

  const orders = trpc.admin.orders.useQuery({
    status: status || undefined,
    attention: attention === "awaiting_staff_review" || attention === "awaiting_customer_response" ? attention : undefined,
    limit: 200,
    offset: 0,
  });
  const configuredStatuses = trpc.admin.orderStatusOptions.useQuery();

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = (orders.data ?? []) as unknown as AdminOrderRow[];
    if (!needle) return list;
    return list.filter(
      (order) =>
        order.orderNumber.toLowerCase().includes(needle) ||
        order.customer.toLowerCase().includes(needle) ||
        (order.projectName ?? "").toLowerCase().includes(needle),
    );
  }, [orders.data, search]);

  const bulkTrash = trpc.admin.bulkSoftDeleteOrders.useMutation({
    async onSuccess(result) { setSelectedIds([]); setBulkTrashOpen(false); await utils.admin.orders.invalidate(); toast.success(`${result.count} order(s) moved to trash`); },
    onError(error) { toast.error("Could not move orders to trash", errorMessage(error)); },
  });

  const exportCsv = trpc.admin.exportOrdersCsv.useMutation({
    onSuccess(result) {
      const blob = new Blob([result.csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    },
  });

  const columns: Column<AdminOrderRow>[] = [
    { key: "select", header: <Checkbox label="Select all orders" checked={rows.length > 0 && rows.every((row) => selectedIds.includes(row.id))} onChange={(event) => setSelectedIds(event.target.checked ? rows.map((row) => row.id) : [])} />, cell: (order) => <Checkbox label={`Select ${order.orderNumber}`} checked={selectedIds.includes(order.id)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...new Set([...current, order.id])] : current.filter((id) => id !== order.id))} /> },
    {
      key: "order",
      header: "Order",
      cell: (order) => (
        <div className="min-w-0">
          <span className="font-mono text-xs font-semibold text-muted">{order.orderNumber}</span>
          <p className="mt-0.5 truncate font-medium text-ink">
            {order.projectName ?? "Untitled project"}
          </p>
          <p className="mt-0.5 text-xs text-muted">{order.customer}</p>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      hideOnMobile: true,
      cell: (order) => (
        <div className="space-y-1.5">
          <Badge tone={STATUS_TONES[order.status] ?? "neutral"}>
            {STATUS_LABELS[order.status] ?? order.status}
          </Badge>
          <ProgressBar value={order.completionPercent} className="w-24" />
        </div>
      ),
    },
    {
      key: "attention",
      header: "Next action",
      hideOnMobile: true,
      cell: (order) => order.attention.state === "none" ? <span className="text-xs text-muted">No action</span> : <Link href={`/admin/orders/${order.id}`} className="no-underline"><Badge tone={adminAttentionTone(order.attention)}>{adminAttentionLabel(order.attention)}</Badge></Link>,
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
      key: "due",
      header: "Due",
      hideOnMobile: true,
      cell: (order) => (
        <span className="text-xs text-muted">
          {order.dueAt ? formatDate(order.dueAt) : "—"}
        </span>
      ),
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
      header: <span className="sr-only">Open</span>,
      align: "right",
      cell: (order) => (
        <Link
          href={`/admin/orders/${order.id}`}
          className="inline-flex items-center gap-1 text-sm font-semibold text-teal-dark no-underline hover:text-teal"
          aria-label={`Open order ${order.orderNumber}`}
        >
          Open
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      ),
    },
  ];

  return (
    <>
      <CreateOrderModal open={createOpen} onClose={() => setCreateOpen(false)} />
      <ConfirmDialog open={bulkTrashOpen} onClose={() => setBulkTrashOpen(false)} onConfirm={() => bulkTrash.mutate({ orderIds: selectedIds, confirmation: "MOVE_TO_TRASH" })} title="Move selected orders to trash?" message={`This soft-deletes ${selectedIds.length} order(s). They can be restored until the configured retention period expires.`} confirmLabel="Move to trash" cancelLabel="Cancel" variant="danger" busy={bulkTrash.isPending} />
      <PageHeader
        title="Order queue"
        description="All orders across the platform, newest first."
        actions={
          <div className="flex items-center gap-2">
            <LinkButton href="/admin/orders/trash" variant="outline" leadingIcon={<Trash2 className="size-4" aria-hidden="true" />}>
              Order trash
            </LinkButton>
            <Button
              variant="outline"
              busy={exportCsv.isPending}
              onClick={() => exportCsv.mutate({})}
              leadingIcon={<Download className="size-4" aria-hidden="true" />}
            >
              Export CSV
            </Button>
            <Button
              onClick={() => setCreateOpen(true)}
              leadingIcon={<Plus className="size-4" aria-hidden="true" />}
            >
              Create order
            </Button>
          </div>
        }
      />

      {selectedIds.length > 0 ? <Card className="mb-5 border-warning/40 bg-warning/5"><div className="flex items-center justify-between gap-3"><p className="text-sm font-medium text-ink">{selectedIds.length} order(s) selected</p><Button variant="danger" leadingIcon={<Trash2 className="size-4" />} onClick={() => setBulkTrashOpen(true)}>Move selected orders to trash</Button></div></Card> : null}

      <Card className="mb-5">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex-1 min-w-48">
            <Input
              label="Search"
              placeholder="Order number, customer, or project"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              leadingIcon={<Search className="size-4" aria-hidden="true" />}
            />
          </div>
          <div className="w-48">
            <Select
              label="Status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              options={[
                { value: "", label: "All statuses" },
                ...(configuredStatuses.data ?? []).filter((option) => option.active).map((option) => ({ value: option.key, label: option.label })),
              ]}
            />
          </div>
          <div className="w-56">
            <Select
              label="Next action"
              value={attention}
              onChange={(event) => setAttention(event.target.value)}
              options={[
                { value: "", label: "All response states" },
                { value: "awaiting_staff_review", label: "Customer submission awaiting review" },
                { value: "awaiting_customer_response", label: "Awaiting customer response" },
              ]}
            />
          </div>
          <div className="flex items-center gap-1 pb-0.5">
            <button
              type="button"
              onClick={() => setViewMode("list")}
              className={`rounded p-1.5 transition-colors ${
                viewMode === "list" ? "bg-teal/10 text-teal" : "text-muted hover:text-ink"
              }`}
              aria-label="List view"
              aria-pressed={viewMode === "list"}
            >
              <LayoutList className="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode("grid")}
              className={`rounded p-1.5 transition-colors ${
                viewMode === "grid" ? "bg-teal/10 text-teal" : "text-muted hover:text-ink"
              }`}
              aria-label="Grid view"
              aria-pressed={viewMode === "grid"}
            >
              <Grid2X2 className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </Card>

      {orders.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-16 w-full" />
          ))}
        </div>
      ) : viewMode === "grid" ? (
        rows.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="No orders match"
            description="Adjust the status filter or search term."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {rows.map((order) => (
              <InlineOrderCard
                key={order.id}
                order={order}
                onUpdated={() => void orders.refetch()}
              />
            ))}
          </div>
        )
      ) : (
        <DataTable
          caption="Orders"
          columns={columns}
          rows={rows}
          rowKey={(order) => order.id}
          empty={
            <EmptyState
              icon={ClipboardList}
              title="No orders match"
              description="Adjust the status filter or search term."
            />
          }
        />
      )}
    </>
  );
}

export function AdminOrderTrashPage() {
  const toast = useToast();
  const utils = trpc.useUtils();
  const [restoreId, setRestoreId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [bulkRestoreOpen, setBulkRestoreOpen] = useState(false);
  const [purgeIds, setPurgeIds] = useState<number[]>([]);
  const [purgePhrase, setPurgePhrase] = useState("");
  const trashed = trpc.admin.trashedOrders.useQuery();
  const restore = trpc.admin.restoreOrder.useMutation({
    async onSuccess() {
      setRestoreId(null);
      await Promise.all([trashed.refetch(), utils.admin.orders.invalidate()]);
      toast.success("Order restored", "The order is visible in the order queue again.");
    },
    onError(error) { toast.error("Could not restore order", errorMessage(error)); },
  });
  const permanentlyPurge = trpc.admin.permanentlyPurgeOrder.useMutation({
    async onSuccess() {
      setPurgeIds([]); setPurgePhrase(""); setSelectedIds([]);
      await Promise.all([trashed.refetch(), utils.admin.orders.invalidate()]);
      toast.success("Order permanently deleted", "The trashed order and its order-linked records were removed.");
    },
    onError(error) { toast.error("Could not permanently delete order", errorMessage(error)); },
  });
  const bulkPurge = trpc.admin.bulkPurgeOrders.useMutation({
    async onSuccess(result) {
      setPurgeIds([]); setPurgePhrase(""); setSelectedIds([]);
      await Promise.all([trashed.refetch(), utils.admin.orders.invalidate()]);
      toast.success(`${result.count} order(s) permanently deleted`);
    },
    onError(error) { toast.error("Could not permanently delete selected orders", errorMessage(error)); },
  });
  const bulkRestore = trpc.admin.bulkRestoreOrders.useMutation({
    async onSuccess(result) {
      setSelectedIds([]);
      setBulkRestoreOpen(false);
      await Promise.all([trashed.refetch(), utils.admin.orders.invalidate()]);
      toast.success(`${result.count} order(s) restored`);
    },
    onError(error) { toast.error("Could not restore orders", errorMessage(error)); },
  });
  const rows = (trashed.data ?? []) as Array<{
    id: number; orderNumber: string; customer: string; status: string; paymentStatus: string; totalCents: number; projectName: string | null; createdAt: string | Date; deletedAt: string | Date | null;
  }>;
  const columns: Column<(typeof rows)[number]>[] = [
    { key: "select", header: <Checkbox label="Select all trashed orders" checked={rows.length > 0 && rows.every((order) => selectedIds.includes(order.id))} onChange={(event) => setSelectedIds(event.target.checked ? rows.map((order) => order.id) : [])} />, cell: (order) => <Checkbox label={`Select ${order.orderNumber}`} checked={selectedIds.includes(order.id)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...new Set([...current, order.id])] : current.filter((id) => id !== order.id))} /> },
    { key: "order", header: "Order", cell: (order) => <div><p className="font-mono text-xs font-semibold text-muted">{order.orderNumber}</p><p className="mt-0.5 font-medium text-ink">{order.projectName ?? "Untitled project"}</p></div> },
    { key: "customer", header: "Customer", cell: (order) => <span className="text-sm text-body">{order.customer}</span> },
    { key: "deleted", header: "Moved to trash", cell: (order) => <span className="text-sm text-body">{formatDate(order.deletedAt)}</span> },
    { key: "total", header: "Total", align: "right", cell: (order) => <span className="font-medium tabular-nums text-ink">{formatMoney(order.totalCents)}</span> },
    { key: "restore", header: <span className="sr-only">Actions</span>, align: "right", cell: (order) => <div className="flex justify-end gap-2"><Button size="sm" variant="outline" onClick={() => setRestoreId(order.id)}>Restore</Button><Button size="sm" variant="danger" onClick={() => { setPurgeIds([order.id]); setPurgePhrase(""); }}>Delete</Button></div> },
  ];
  return <>
    <ConfirmDialog open={restoreId !== null} onClose={() => setRestoreId(null)} onConfirm={() => { if (restoreId !== null) restore.mutate({ orderId: restoreId }); }} title="Restore this order?" message="The order will return to the active order queue and become visible to its customer again." confirmLabel="Restore order" cancelLabel="Cancel" variant="primary" busy={restore.isPending} />
    <ConfirmDialog open={bulkRestoreOpen} onClose={() => setBulkRestoreOpen(false)} onConfirm={() => bulkRestore.mutate({ orderIds: selectedIds, confirmation: "RESTORE_FROM_TRASH" })} title="Restore selected orders?" message={`This restores ${selectedIds.length} selected order(s) to the active queue and preserves their customer, payment, history, and files.`} confirmLabel="Restore selected orders" cancelLabel="Cancel" variant="primary" busy={bulkRestore.isPending} />
    <Modal open={purgeIds.length > 0} onClose={() => { if (!permanentlyPurge.isPending && !bulkPurge.isPending) { setPurgeIds([]); setPurgePhrase(""); } }} title={purgeIds.length === 1 ? "Permanently delete this order?" : `Permanently delete ${purgeIds.length} orders?`} description="This irreversible action removes the trashed order records, phase materials, notes, questions, automation history, and linked financial/order metadata." footer={<><Button variant="outline" onClick={() => { setPurgeIds([]); setPurgePhrase(""); }}>Cancel</Button><Button variant="danger" disabled={purgePhrase !== "DELETE ORDER"} busy={permanentlyPurge.isPending || bulkPurge.isPending} onClick={() => purgeIds.length === 1 ? permanentlyPurge.mutate({ orderId: purgeIds[0]!, confirmation: "DELETE ORDER" }) : bulkPurge.mutate({ orderIds: purgeIds, confirmation: "DELETE ORDER" })}>Permanently delete</Button></>}><Alert tone="danger"><strong>This cannot be undone.</strong> Type <code>DELETE ORDER</code> exactly to enable permanent deletion.</Alert><Input className="mt-4" label="Confirmation" value={purgePhrase} onChange={(event) => setPurgePhrase(event.target.value)} placeholder="DELETE ORDER" autoComplete="off" /></Modal>
    <PageHeader title="Order trash" description="Soft-deleted orders remain recoverable until the configured retention window expires." breadcrumb={{ href: "/admin/orders", label: "Order queue" }} actions={<LinkButton href="/admin/orders" variant="outline">Back to order queue</LinkButton>} />
    <Alert tone="info" className="mb-5">Restoring an order preserves its order number, payment state, history, files, and customer association.</Alert>
    {selectedIds.length > 0 ? <Card className="mb-5 border-success/40 bg-success/5"><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm font-medium text-ink">{selectedIds.length} order(s) selected</p><div className="flex flex-wrap gap-2"><Button variant="primary" onClick={() => setBulkRestoreOpen(true)}>Restore selected orders</Button><Button variant="danger" onClick={() => { setPurgeIds(selectedIds); setPurgePhrase(""); }}>Permanently delete selected</Button></div></div></Card> : null}
    {trashed.isLoading ? <div className="space-y-3">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-16 w-full" />)}</div> : <DataTable caption="Orders in trash" columns={columns} rows={rows} rowKey={(order) => order.id} empty={<EmptyState icon={Trash2} title="Order trash is empty" description="Deleted orders will appear here until the retention window expires." />} />}
  </>;
}

export function AdminOrderDetailPage() {
  const params = useParams<{ id: string }>();
  const orderId = Number(params.id);
  const toast = useToast();
  const session = useSession();

  const detail = trpc.admin.orderDetail.useQuery({ orderId }, { enabled: Number.isFinite(orderId) });
  const files = trpc.adminFiles.list.useQuery({ orderId }, { enabled: Number.isFinite(orderId) });
  const workflows = trpc.admin.orderWorkflows.useQuery();
  const configuredStatuses = trpc.admin.orderStatusOptions.useQuery();
  const phaseLocks = trpc.admin.phaseLocks.useQuery({ orderId, includeUnlocked: true }, { enabled: Number.isFinite(orderId) });
  const sharePointSync = trpc.integrations.sharepointSyncLogs.useQuery(
    { orderId, page: 1 },
    { enabled: Number.isFinite(orderId) },
  );
  const invoice = trpc.invoices.getForOrder.useQuery(
    { orderId },
    { enabled: Number.isFinite(orderId) && ["paid", "partially_refunded"].includes(detail.data?.order.paymentStatus ?? "") },
  );

  const [tab, setTab] = useState("overview");
  const [note, setNote] = useState("");
  const [noteVisibility, setNoteVisibility] = useState<"internal" | "shared">("internal");
  const [question, setQuestion] = useState("");
  const [questionRequired, setQuestionRequired] = useState(true);
  const [transitionTo, setTransitionTo] = useState("");
  const [transitionReason, setTransitionReason] = useState("");
  const [completion, setCompletion] = useState<number | null>(null);
  const [dueAt, setDueAt] = useState("");
  const [paymentStatus, setPaymentStatus] = useState("");
  const [internalNotes, setInternalNotes] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [changeOrderIdOpen, setChangeOrderIdOpen] = useState(false);
  const [newOrderNumber, setNewOrderNumber] = useState("");
  const [orderIdChangeReason, setOrderIdChangeReason] = useState("");
  const [orderIdChangeConfirmation, setOrderIdChangeConfirmation] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [phaseUploadOpen, setPhaseUploadOpen] = useState(false);
  const [phaseUpload, setPhaseUpload] = useState("phase_1");
  const [phaseUploading, setPhaseUploading] = useState(false);
  const [phaseUploadPreRecordedAudio, setPhaseUploadPreRecordedAudio] = useState(false);
  const [unlockTarget, setUnlockTarget] = useState<{ phaseKey: string } | null>(null);
  const [unlockReason, setUnlockReason] = useState("");
  const [unlockConfirmation, setUnlockConfirmation] = useState("");
  const phaseFileInput = useRef<HTMLInputElement>(null);

  const assignedWorkflow = (workflows.data ?? []).find((workflow) => String(workflow.id) === (workflowId || String(detail.data?.order.workflowId ?? "")));
  const workflowStageOptions = Array.isArray(assignedWorkflow?.stages)
    ? (assignedWorkflow.stages as { key?: unknown; label?: unknown; order?: unknown }[])
        .filter((stage) => typeof stage.key === "string" && typeof stage.label === "string")
        .sort((left, right) => (typeof left.order === "number" ? left.order : 0) - (typeof right.order === "number" ? right.order : 0))
        .map((stage) => ({ value: stage.key as string, label: stage.label as string, capabilities: Array.isArray((stage as { capabilities?: unknown }).capabilities) ? (stage as { capabilities: unknown[] }).capabilities.filter((capability): capability is string => typeof capability === "string") : ["documents", "questions", "recording"] }))
    : [];
  const phaseUploadOptions = [
    { value: "phase_1", label: "Phase 1", capabilities: ["documents", "questions", "recording"] },
    { value: "phase_2", label: "Phase 2", capabilities: ["documents", "questions", "recording"] },
    ...workflowStageOptions.filter((stage) => stage.value !== "phase_1" && stage.value !== "phase_2"),
  ];

  const selectedPhaseOption = phaseUploadOptions.find((option) => option.value === phaseUpload);
  const phaseAllowsPreRecordedAudio = selectedPhaseOption?.capabilities.includes("audio_upload") ?? false;

  const refetchAll = async () => {
    await Promise.all([detail.refetch(), files.refetch(), phaseLocks.refetch(), sharePointSync.refetch(), invoice.refetch()]);
  };

  const setInvoiceVisibility = trpc.invoices.setCustomerVisibility.useMutation({
    async onSuccess(result) {
      await invoice.refetch();
      toast.success(result.customerVisible ? "Invoice published" : "Invoice hidden", result.customerVisible ? "The customer can now view this invoice in their portal." : "The invoice is no longer visible in the customer portal.");
    },
    onError(error) { toast.error("Could not update invoice visibility", errorMessage(error)); },
  });
  const downloadInvoicePdf = trpc.invoices.requestPdfDownload.useMutation({
    onSuccess(result) {
      window.open(result.url, "_blank", "noopener,noreferrer");
    },
    onError(error) { toast.error("Could not prepare invoice PDF", errorMessage(error)); },
  });
  const renameOrder = trpc.orders.rename.useMutation({
    async onSuccess(result) {
      setRenameOpen(false);
      setRenameValue(result.projectName);
      await refetchAll();
      toast.success("Order renamed", "The updated title is now visible to the customer and staff.");
    },
    onError(error) { toast.error("Could not rename the order", errorMessage(error)); },
  });
  const changeOrderId = trpc.admin.changeOrderId.useMutation({
    async onSuccess() {
      setChangeOrderIdOpen(false);
      setNewOrderNumber("");
      setOrderIdChangeReason("");
      setOrderIdChangeConfirmation("");
      await refetchAll();
      toast.success("Order reference changed", "The order detail now reflects the new order reference.");
    },
    onError(error) { toast.error("Could not change order reference", errorMessage(error)); },
  });
  const emailInvoice = trpc.invoices.sendCustomerCopy.useMutation({
    async onSuccess(result) {
      await invoice.refetch();
      toast.success("Invoice email queued", `A branded copy of ${result.invoiceNumber} was queued for the customer.`);
    },
    onError(error) { toast.error("Could not queue invoice email", errorMessage(error)); },
  });

  const retrySharePointSync = trpc.integrations.retrySharepointSync.useMutation({
    async onSuccess() {
      await sharePointSync.refetch();
      toast.success("SharePoint retry queued", "The selected file will be retried by the secure background sync worker.");
    },
    onError(error) {
      toast.error("Could not queue SharePoint retry", errorMessage(error));
    },
  });

  const assignWorkflow = trpc.admin.assignOrderWorkflow.useMutation({
    async onSuccess() { await detail.refetch(); toast.success("Workflow assigned", "The order now uses the selected workflow."); },
    onError(error) { toast.error("Could not assign workflow", errorMessage(error)); },
  });

  const transition = trpc.admin.transitionOrder.useMutation({
    async onSuccess() {
      setTransitionTo("");
      setTransitionReason("");
      await refetchAll();
      toast.success("Status updated", "The customer has been notified by email.");
    },
    onError(error) {
      toast.error("Transition rejected", errorMessage(error));
    },
  });

  const updateOrder = trpc.admin.updateOrder.useMutation({
    async onSuccess() {
      await refetchAll();
      toast.success("Order updated");
    },
    onError(error) {
      toast.error("Could not update the order", errorMessage(error));
    },
  });

  const addNote = trpc.admin.addOrderNote.useMutation({
    async onSuccess() {
      setNote("");
      await refetchAll();
      toast.success(
        noteVisibility === "shared" ? "Note shared with the customer" : "Internal note saved",
      );
    },
    onError(error) {
      toast.error("Could not save the note", errorMessage(error));
    },
  });

  const questionTemplates = trpc.admin.questionTemplates.useQuery();
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [questionPhase, setQuestionPhase] = useState("phase_1");
  const [adminAnswerByQuestion, setAdminAnswerByQuestion] = useState<Record<number, string>>({});
  const applyTemplate = trpc.admin.applyQuestionTemplate.useMutation({
    async onSuccess() { setSelectedTemplateId(""); await refetchAll(); toast.success("Template question added to this order"); },
    onError(error) { toast.error("Could not apply template", errorMessage(error)); },
  });
  const answerAsAdmin = trpc.admin.answerOrderQuestionAsAdmin.useMutation({
    async onSuccess(_result, variables) { setAdminAnswerByQuestion((state) => ({ ...state, [variables.questionId]: "" })); await refetchAll(); toast.success("Staff answer saved"); },
    onError(error) { toast.error("Could not save staff answer", errorMessage(error)); },
  });

  const addQuestion = trpc.admin.addOrderQuestion.useMutation({
    async onSuccess() {
      setQuestion("");
      await refetchAll();
      toast.success("Clarification question sent");
    },
    onError(error) {
      toast.error("Could not send the question", errorMessage(error));
    },
  });

  const setVisibility = trpc.adminFiles.setVisibility.useMutation({
    async onSuccess() {
      await files.refetch();
    },
    onError(error) {
      toast.error("Could not change visibility", errorMessage(error));
    },
  });
  const requestDownload = trpc.files.requestDownload.useMutation({
    onSuccess(result) {
      window.open(result.url, "_blank", "noopener,noreferrer");
    },
    onError(error) { toast.error("Could not prepare file download", errorMessage(error)); },
  });
  const bulkDownload = trpc.files.bulkDownload.useMutation({
    onSuccess(result) {
      window.location.assign(result.url);
      toast.success("Download prepared", `${result.fileCount} file(s) will download as a ZIP archive.`);
    },
    onError(error) { toast.error("Could not prepare download", errorMessage(error)); },
  });

  const uploadPhaseDocuments = async (selected: FileList | null) => {
    if (!selected || selected.length === 0) return;
          const selectedFiles = Array.from(selected).slice(0, 5);
      if (phaseUploadPreRecordedAudio && !phaseAllowsPreRecordedAudio) {
        toast.error("Audio upload is not enabled", "Enable Pre-recorded audio file for this workflow phase before uploading audio.");
        return;
      }
      setPhaseUploading(true);

    try {
      const post = async (token: string) => {
        const body = new FormData();
        selectedFiles.forEach((file) => body.append("files", file));
        body.append("orderId", String(orderId));
        body.append("category", "reference");
        body.append("phase", phaseUpload);
        if (phaseUploadPreRecordedAudio) body.append("prerecordedAudio", "true");
        const response = await fetch("/api/files/upload", { method: "POST", credentials: "same-origin", headers: { "x-rp-csrf": token }, body });
        let payload: { error?: string; files?: unknown[] } = {};
        try { payload = await response.json() as typeof payload; } catch { /* status below handles malformed responses */ }
        return { response, payload };
      };
      let token = await refreshCsrfToken();
      let result = await post(token ?? csrfToken() ?? "");
      if (result.response.status === 403 && /csrf|security token/i.test(result.payload.error ?? "")) {
        token = await refreshCsrfToken();
        if (token) result = await post(token);
      }
      if (!result.response.ok) { toast.error("Upload rejected", result.payload.error ?? "The documents could not be uploaded."); return; }
      await files.refetch();
      setPhaseUploadOpen(false);
      toast.success("Phase documents uploaded", `${result.payload.files?.length ?? 0} file(s) were added to ${phaseUploadOptions.find((option) => option.value === phaseUpload)?.label ?? "the selected phase"}.`);
    } catch {
      toast.error("Upload failed", "A network error occurred. Please try again.");
    } finally {
      setPhaseUploading(false);
      if (phaseFileInput.current) phaseFileInput.current.value = "";
    }
  };

  const reviewWorkflowPhase = trpc.admin.reviewWorkflowPhase.useMutation({
    async onSuccess() { await refetchAll(); toast.success("Customer submission reviewed", "The order no longer appears in the staff review queue."); },
    onError(error) { toast.error("Could not mark the submission reviewed", errorMessage(error)); },
  });

  const unlockWorkflowPhase = trpc.admin.unlockWorkflowPhase.useMutation({
    async onSuccess() {
      setUnlockTarget(null);
      setUnlockReason("");
      setUnlockConfirmation("");
      await refetchAll();
      toast.success("Workflow phase unlocked", "The customer can update this phase again until it is resubmitted.");
    },
    onError(error) { toast.error("Could not unlock workflow phase", errorMessage(error)); },
  });

  const softDelete = trpc.admin.softDeleteOrder.useMutation({
    async onSuccess() {
      setDeleteOpen(false);
      toast.info("Order archived", "It can be restored from the database within the retention window.");
    },
    onError(error) {
      toast.error("Could not archive the order", errorMessage(error));
    },
  });

  if (detail.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  if (detail.isError || !detail.data) {
    return (
      <EmptyState
        icon={ClipboardList}
        title="Order not found"
        description="This order may have been archived."
        action={
          <LinkButton href="/admin/orders" variant="outline">
            Back to the queue
          </LinkButton>
        }
      />
    );
  }

  const { order, customer, notes, questions, attachments, intakeSubmission } = detail.data;
  const businessPitchSubmitted = attachments.some((file) => file.category === "intake_attachment" && (file.detectedMime?.startsWith("audio/") || ["webm", "wav", "mp3", "m4a", "ogg"].includes((file.extension ?? "").toLowerCase())));
  const configuredStatusLabel = (value: string) => (configuredStatuses.data ?? []).find((option) => option.key === value)?.label ?? STATUS_LABELS[value] ?? value;
  const systemTransitions = ORDER_TRANSITIONS[order.status as keyof typeof ORDER_TRANSITIONS];
  const allowedNext = systemTransitions ?? (configuredStatuses.data ?? []).filter((option) => option.active && option.key !== order.status).map((option) => option.key);
  const orderIdChangeReady =
    newOrderNumber.trim().length > 0 &&
    orderIdChangeReason.trim().length >= 10 &&
    orderIdChangeConfirmation === "CHANGE ORDER ID";

  function closeChangeOrderIdModal() {
    if (changeOrderId.isPending) return;
    setChangeOrderIdOpen(false);
    setNewOrderNumber("");
    setOrderIdChangeReason("");
    setOrderIdChangeConfirmation("");
  }

  return (
    <>
      <PageHeader
        title={order.projectName ?? `Order ${order.orderNumber}`}
        description={`${order.orderNumber} · ${customer?.name ?? "Unknown customer"} · placed ${formatDate(order.createdAt)}`}
        breadcrumb={{ href: "/admin/orders", label: "Order queue" }}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" leadingIcon={<Pencil className="size-4" aria-hidden="true" />} onClick={() => { setRenameValue(order.projectName ?? ""); setRenameOpen(true); }}>Rename order</Button>
            {session.isAdmin ? (
              <Button variant="outline" onClick={() => setChangeOrderIdOpen(true)}>
                Change order reference
              </Button>
            ) : null}
            {["paid", "partially_refunded"].includes(order.paymentStatus) ? <><LinkButton href={`/admin/orders/${order.id}/invoice`} variant="outline">Invoice</LinkButton>{session.isAdmin ? <LinkButton href={`/admin/finance?orderId=${order.id}`} variant="danger">Refund</LinkButton> : null}</> : null}
            {session.isAdmin ? (
              <Button
                variant="ghost"
                onClick={() => setDeleteOpen(true)}
                leadingIcon={<Trash2 className="size-4" aria-hidden="true" />}
              >
                Move to trash
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONES[order.status] ?? "neutral"}>
          {STATUS_LABELS[order.status] ?? order.status}
        </Badge>
        <Badge tone={PAYMENT_TONES[order.paymentStatus] ?? "neutral"}>
          {PAYMENT_LABELS[order.paymentStatus] ?? order.paymentStatus}
        </Badge>
        {order.bundleApplied ? <Badge tone="gold">All-In bundle</Badge> : null}
        {order.isTestOrder ? <Badge tone="warning">Test order</Badge> : null}
        {businessPitchSubmitted ? <Badge tone="success">Business Pitch submitted</Badge> : <Badge tone="neutral">No Business Pitch submitted</Badge>}
        <span className="text-sm font-semibold tabular-nums text-ink">
          {formatMoney(order.totalCents)}
        </span>
      </div>

      <TabStrip
        tabs={[
          { id: "overview", label: "Overview" },
          ...(intakeSubmission?.status === "submitted" || (files.data ?? []).some((file) => file.category === "intake_attachment") ? [{ id: "intake", label: "Phase I record" }] : []),
          { id: "notes", label: `Notes (${notes.length})` },
                    { id: "questions", label: `Questions (${questions.length})` },
          { id: "files", label: `Files (${attachments.length})` },
          { id: "phase-locks", label: `Phase locks (${(phaseLocks.data ?? []).filter((stage) => stage.active).length})` },
          { id: "automation", label: "Automation" },
          { id: "sharepoint-sync", label: `SharePoint sync (${sharePointSync.data?.total ?? 0})` },
          ...(["paid", "partially_refunded"].includes(order.paymentStatus) ? [{ id: "invoice", label: "Invoice" }] : []),
          { id: "refund", label: "Refund" },
          { id: "history", label: "Order history" },
          { id: "mnda", label: `MNDA (${detail.data.mnda.length})` },
        ]}
        active={tab}
        onChange={setTab}
      />
      <div className="mt-6">
        {tab === "automation" ? (
          <OrderAutomationTab order={order} customer={customer} />
        ) : null}
        {tab === "sharepoint-sync" ? (
          <OrderSharePointSyncTab
            sync={sharePointSync.data}
            loading={sharePointSync.isLoading}
            retrying={retrySharePointSync.isPending}
            onRetry={(logId) => retrySharePointSync.mutate({ logId })}
          />
        ) : null}
        {tab === "invoice" ? (
          <Card>
            <CardHeader title="Saved customer invoice" description="The invoice record is stored with this order. You can publish it to the customer portal and queue a branded email copy." />
            {invoice.isLoading ? <Skeleton className="mt-5 h-48 w-full" /> : null}
            {invoice.error ? <Alert tone="danger" className="mt-5">{errorMessage(invoice.error)}</Alert> : null}
            {invoice.data ? <div className="mt-5 space-y-5">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div><p className="text-xs font-semibold uppercase tracking-wide text-muted">Invoice number</p><p className="mt-1 font-mono text-sm font-semibold text-ink">{invoice.data.invoiceNumber}</p></div>
                <div><p className="text-xs font-semibold uppercase tracking-wide text-muted">Customer</p><p className="mt-1 text-sm font-medium text-ink">{invoice.data.customer.name}</p></div>
                <div><p className="text-xs font-semibold uppercase tracking-wide text-muted">Order source</p><p className="mt-1 text-sm font-medium text-ink">{invoice.data.orderOriginLabel}</p></div>
                <div><p className="text-xs font-semibold uppercase tracking-wide text-muted">Catalog product value</p><p className="mt-1 text-sm font-medium text-ink">{formatMoney(invoice.data.productValueCents)}</p></div>
                <div><p className="text-xs font-semibold uppercase tracking-wide text-muted">Order amount due</p><p className="mt-1 text-sm font-medium text-ink">{formatMoney(invoice.data.totalCents)}</p></div>
                <div><p className="text-xs font-semibold uppercase tracking-wide text-muted">Actual customer payment</p><p className="mt-1 text-sm font-semibold text-success">{formatMoney(invoice.data.actualCustomerPaidCents)}</p></div>
              </div>
              {invoice.data.pricingAdjustmentCents > 0 ? <Alert tone="info">Pricing or bundle adjustment: <strong>{formatMoney(invoice.data.pricingAdjustmentCents)}</strong>.</Alert> : null}
              {invoice.data.discountCents > 0 ? <Alert tone="success">Discount applied: <strong>{invoice.data.discount?.code ?? "Recorded discount"}</strong> — {formatMoney(invoice.data.discountCents)} off.</Alert> : null}
              <Alert tone="info">{invoice.data.paymentEvidenceLabel}</Alert>
              <div className="flex flex-wrap gap-3 border-t border-line pt-5">
                <LinkButton href={`/admin/orders/${order.id}/invoice`} variant="outline">Open invoice</LinkButton>
                <Button variant="outline" leadingIcon={<Download className="size-4" />} busy={downloadInvoicePdf.isPending} onClick={() => downloadInvoicePdf.mutate({ orderId })}>Download branded PDF</Button>
                {session.isAdmin ? <Button variant={invoice.data.customerVisible ? "outline" : "primary"} busy={setInvoiceVisibility.isPending} onClick={() => setInvoiceVisibility.mutate({ orderId, visible: !invoice.data.customerVisible })}>{invoice.data.customerVisible ? "Hide from customer portal" : "Publish to customer portal"}</Button> : null}
                {session.isAdmin ? <Button variant="primary" leadingIcon={<Send className="size-4" />} busy={emailInvoice.isPending} onClick={() => emailInvoice.mutate({ orderId })}>Email customer a copy</Button> : null}
              </div>
              <div className="grid gap-3 text-sm text-body sm:grid-cols-2"><p>Portal availability: <strong className={invoice.data.customerVisible ? "text-success" : "text-warning"}>{invoice.data.customerVisible ? "Published" : "Hidden"}</strong>{invoice.data.publishedAt ? ` · ${formatDateTime(invoice.data.publishedAt)}` : ""}</p><p>Email status: <strong className="text-ink">{invoice.data.emailQueuedAt ? `Queued ${formatDateTime(invoice.data.emailQueuedAt)}` : "Not yet queued"}</strong></p></div>
            </div> : null}
          </Card>
        ) : null}
        {tab === "refund" ? (
          <Card>
            <CardHeader title="Refund this order" description="Refunds are sent to Stripe only after a review and exact typed confirmation." />
            {["paid", "partially_refunded"].includes(order.paymentStatus) ? <div className="mt-4 space-y-4"><Alert tone="warning">A refund is irreversible in ReadyPackets. The Finance workspace verifies the remaining refundable balance, requires a reason, and requires the exact phrase <code>REFUND ORDER</code> before Stripe is called.</Alert><LinkButton href={`/admin/finance?orderId=${order.id}`} variant="danger">Prepare refund for {order.orderNumber}</LinkButton></div> : <Alert tone="info" className="mt-4">This order has no confirmed Stripe payment available for a portal refund.</Alert>}
          </Card>
        ) : null}
        {tab === "history" ? <OrderHistoryTab statusHistory={detail.data.history.status} activityHistory={detail.data.history.activity} /> : null}
        {tab === "mnda" ? <OrderMndaTab acceptances={detail.data.mnda} /> : null}
        {tab === "overview" ? (
          <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr] lg:items-start">
            <div className="space-y-6">
              <Card>
                <CardHeader
                  title="Manage lifecycle status"
                  description="Use this controlled exception tool to change the business lifecycle status. Assigned workflow phases advance through customer submissions and staff review, not this form."
                />
                {allowedNext.length === 0 ? (
                  <Alert tone="info" className="mt-4">
                    This order is in a terminal state; no further transitions are possible.
                  </Alert>
                ) : (
                  <div className="mt-4 space-y-4">
                    <Select
                      label="New status"
                      value={transitionTo}
                      onChange={(event) => setTransitionTo(event.target.value)}
                      options={[
                        { value: "", label: "Choose a status…" },
                        ...allowedNext.map((value) => ({
                          value,
                          label: configuredStatusLabel(value),
                        })),
                      ]}
                    />
                    <Input
                      label="Reason"
                      help="Recorded in the order history and the audit log."
                      value={transitionReason}
                      onChange={(event) => setTransitionReason(event.target.value)}
                      maxLength={255}
                    />
                    <Button
                      busy={transition.isPending}
                      disabled={!transitionTo}
                      onClick={() =>
                        transition.mutate({
                          orderId,
                          to: transitionTo,
                          reason: transitionReason.trim() || undefined,
                        })
                      }
                    >
                      Apply status change
                    </Button>
                  </div>
                )}
              </Card>

              <Card>
                <CardHeader title="Order workflow" description="Select the active workflow that organizes this order’s stages. Status, payment, and automation safeguards remain enforced separately." actions={<LinkButton href="/admin/order-workflows" size="sm" variant="outline">Manage workflows</LinkButton>} />
                <div className="mt-4 space-y-3"><Select label="Assigned workflow" value={workflowId || String(order.workflowId ?? "")} onChange={(event) => setWorkflowId(event.target.value)} options={[{ value: "", label: "Choose a workflow…" }, ...(workflows.data ?? []).filter((workflow) => workflow.active || workflow.id === order.workflowId).map((workflow) => ({ value: String(workflow.id), label: `${workflow.name}${workflow.isDefault ? " (default)" : ""}` }))]} /><Button size="sm" busy={assignWorkflow.isPending} disabled={!workflowId || Number(workflowId) === order.workflowId} onClick={() => assignWorkflow.mutate({ orderId, workflowId: Number(workflowId) })}>Assign workflow</Button></div>
              </Card>

              <Card>
                <CardHeader title="Delivery and payment" />
                <div className="mt-4 space-y-4">
                  <div>
                    <label
                      htmlFor="completion-range"
                      className="mb-1.5 block text-sm font-medium text-ink"
                    >
                      Completion: {completion ?? order.completionPercent}%
                    </label>
                    <input
                      id="completion-range"
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={completion ?? order.completionPercent}
                      onChange={(event) => setCompletion(Number(event.target.value))}
                      className="w-full accent-teal"
                    />
                  </div>

                  <Input
                    label="Target delivery date"
                    type="date"
                    value={
                      dueAt ||
                      (order.dueAt ? new Date(order.dueAt).toISOString().slice(0, 10) : "")
                    }
                    onChange={(event) => setDueAt(event.target.value)}
                  />

                  <Select
                    label="Payment status"
                    value={paymentStatus || order.paymentStatus}
                    onChange={(event) => setPaymentStatus(event.target.value)}
                    options={Object.entries(PAYMENT_LABELS).map(([value, label]) => ({
                      value,
                      label,
                    }))}
                  />

                  <Button
                    busy={updateOrder.isPending}
                    onClick={() =>
                      updateOrder.mutate({
                        orderId,
                        completionPercent: completion ?? undefined,
                        dueAt: dueAt ? new Date(`${dueAt}T12:00:00Z`).toISOString() : undefined,
                        paymentStatus: (paymentStatus || undefined) as never,
                      })
                    }
                    leadingIcon={<Save className="size-4" aria-hidden="true" />}
                  >
                    Save changes
                  </Button>
                </div>
              </Card>

              <Card>
                <CardHeader
                  title="Internal notes"
                  description="Never visible to the customer."
                />
                <Textarea
                  label="Notes"
                  className="mt-4"
                  rows={6}
                  maxLength={20_000}
                  value={internalNotes ?? order.internalNotesText ?? ""}
                  onChange={(event) => setInternalNotes(event.target.value)}
                />
                <Button
                  className="mt-3"
                  variant="outline"
                  busy={updateOrder.isPending}
                  onClick={() =>
                    updateOrder.mutate({ orderId, internalNotes: internalNotes ?? "" })
                  }
                  leadingIcon={<Save className="size-4" aria-hidden="true" />}
                >
                  Save internal notes
                </Button>
              </Card>
            </div>

            <div className="space-y-6">
              <Card>
                <CardHeader title="Customer" />
                {customer ? (
                  <dl className="mt-4 space-y-3 text-sm">
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-muted">Name</dt>
                      <dd className="mt-0.5">
                        <Link href={`/admin/customers/${customer.id}`}>{customer.name}</Link>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-muted">Email</dt>
                      <dd className="mt-0.5 break-all text-ink">{customer.email}</dd>
                    </div>
                    {customer.company ? (
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-muted">Company</dt>
                        <dd className="mt-0.5 text-ink">{customer.company}</dd>
                      </div>
                    ) : null}
                    {customer.phone ? (
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-muted">Phone</dt>
                        <dd className="mt-0.5 text-ink">{customer.phone}</dd>
                      </div>
                    ) : null}
                  </dl>
                ) : (
                  <p className="mt-4 text-sm text-body">The customer record has been deleted.</p>
                )}
              </Card>

              <Card>
                <CardHeader title="Financials" />
                <dl className="mt-4 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-body">Subtotal</dt>
                    <dd className="tabular-nums text-ink">{formatMoney(order.subtotalCents)}</dd>
                  </div>
                  {order.discountCents > 0 ? (
                    <div className="flex justify-between text-success">
                      <dt>Bundle reduction</dt>
                      <dd className="tabular-nums">−{formatMoney(order.discountCents)}</dd>
                    </div>
                  ) : null}
                  <div className="flex justify-between border-t border-line pt-2 font-semibold">
                    <dt className="text-ink">Total</dt>
                    <dd className="tabular-nums text-ink">{formatMoney(order.totalCents)}</dd>
                  </div>
                </dl>
                {order.integrityChoice ? (
                  <div className="mt-4 rounded-lg border border-gold/30 bg-gold/5 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gold-dark">
                      Integrity clause
                    </p>
                    <p className="mt-1 text-sm text-body">
                      {INTEGRITY_CHOICE_LABELS[
                        order.integrityChoice as keyof typeof INTEGRITY_CHOICE_LABELS
                      ] ?? order.integrityChoice}
                    </p>
                  </div>
                ) : null}
              </Card>
            </div>
          </div>
        ) : null}

        {tab === "intake" ? (
          <Card>
            <CardHeader
              title="Phase I record"
              description={
                intakeSubmission
                  ? `${intakeSubmission.status === "submitted" ? "Submitted" : "Draft"}${
                      intakeSubmission.submittedAt
                        ? ` ${formatDateTime(intakeSubmission.submittedAt)}`
                        : ""
                    }`
                  : "The customer has not started the intake form."
              }
            />
            {!intakeSubmission ? (
              <Alert tone="info" className="mt-4">
                Nothing has been submitted yet. The customer must sign the mutual NDA before the
                intake form becomes available.
              </Alert>
            ) : (
              <>
                <div className="mt-4 flex flex-wrap gap-2">
                  {((intakeSubmission.desiredOutcomes as string[] | null) ?? []).map((outcome) => (
                    <Badge key={outcome} tone="teal">
                      {outcome}
                    </Badge>
                  ))}
                  {businessPitchSubmitted ? <Badge tone="success">Business Pitch submitted</Badge> : <Badge tone="neutral">No Business Pitch submitted</Badge>}
                  {intakeSubmission.integrityChoice ? (
                    <Badge tone="gold">
                      {INTEGRITY_CHOICE_LABELS[
                        intakeSubmission.integrityChoice as keyof typeof INTEGRITY_CHOICE_LABELS
                      ] ?? intakeSubmission.integrityChoice}
                    </Badge>
                  ) : null}
                </div>

                <dl className="mt-6 space-y-5">
                  {Object.entries(intakeSubmission.answers ?? {}).map(([key, value]) => (
                    <div key={key}>
                      <dt className="text-sm font-semibold text-ink">{humanizeKey(key)}</dt>
                      <dd className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-body">
                        {value ?? "—"}
                      </dd>
                    </div>
                  ))}
                </dl>
                {(() => {
                  const intakeFiles = (files.data ?? []).filter((file) => file.category === "intake_attachment");
                  const pitches = intakeFiles.filter((file) => file.detectedMime?.startsWith("audio/"));
                  const documents = intakeFiles.filter((file) => !file.detectedMime?.startsWith("audio/"));
                  return <div className="mt-6 grid gap-4 lg:grid-cols-2"><Card className="bg-surface-soft"><CardHeader title={`Business Pitch Ideas (${pitches.length})`} description="Browser-recorded WebM pitches submitted by the customer." />{pitches.length ? <ul className="mt-3 space-y-2">{pitches.map((file) => <li key={file.id} className="flex items-center justify-between gap-3 text-sm"><span className="truncate text-ink">{file.originalName}</span><span className="shrink-0 text-xs text-muted">{formatBytes(file.sizeBytes)}</span></li>)}</ul> : <p className="mt-3 text-sm text-muted">No Business Pitch Idea recording was saved for this order.</p>}</Card><Card className="bg-surface-soft"><CardHeader title={`Supporting documents (${documents.length})`} description="Customer documents attached during Phase 1 intake." />{documents.length ? <ul className="mt-3 space-y-2">{documents.map((file) => <li key={file.id} className="flex items-center justify-between gap-3 text-sm"><span className="truncate text-ink">{file.originalName}</span><span className="shrink-0 text-xs text-muted">{formatBytes(file.sizeBytes)}</span></li>)}</ul> : <p className="mt-3 text-sm text-muted">No supporting documents were saved for this order.</p>}</Card></div>;
                })()}
              </>
            )}
          </Card>
        ) : null}

        {tab === "notes" ? (
          <div className="grid gap-6 lg:grid-cols-[1fr_1fr] lg:items-start">
            <Card>
              <CardHeader title="Add a note" />
              <Textarea
                label="Note"
                className="mt-4"
                rows={5}
                maxLength={10_000}
                showCount
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <Select
                label="Visibility"
                className="mt-4"
                value={noteVisibility}
                onChange={(event) =>
                  setNoteVisibility(event.target.value as "internal" | "shared")
                }
                options={[
                  { value: "internal", label: "Internal — staff only" },
                  { value: "shared", label: "Shared — visible to the customer" },
                ]}
              />
              {noteVisibility === "shared" ? (
                <Alert tone="warning" className="mt-3">
                  This note will be visible to the customer in their portal.
                </Alert>
              ) : null}
              <Button
                className="mt-4"
                busy={addNote.isPending}
                disabled={note.trim().length === 0}
                onClick={() =>
                  addNote.mutate({ orderId, body: note.trim(), visibility: noteVisibility })
                }
                leadingIcon={<MessageSquarePlus className="size-4" aria-hidden="true" />}
              >
                Save note
              </Button>
            </Card>

            <Card>
              <CardHeader title="Note history" />
              {notes.length === 0 ? (
                <p className="mt-4 text-sm text-body">No notes recorded yet.</p>
              ) : (
                <ul className="mt-4 space-y-4">
                  {notes.map((entry) => (
                    <li
                      key={entry.id}
                      className={`rounded-lg border p-3.5 ${
                        entry.visibility === "shared"
                          ? "border-teal/30 bg-teal/[0.04]"
                          : "border-line bg-surface-soft"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Badge tone={entry.visibility === "shared" ? "teal" : "neutral"}>
                          {entry.visibility === "shared" ? "Shared" : "Internal"}
                        </Badge>
                        <span className="text-xs text-muted">
                          {formatDateTime(entry.createdAt)}
                        </span>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-body">
                        {entry.body}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        ) : null}

        {tab === "questions" ? (
          <div className="grid gap-6 lg:grid-cols-[1fr_1fr] lg:items-start">
            <Card>
              <CardHeader
                title="Ask a clarification question"
                description="The customer sees this in their portal and is notified by email."
              />
              <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto]">
                <Select label="Order Question Bank" value={selectedTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)} options={[{ value: "", label: "Choose a reusable question…" }, ...(questionTemplates.data ?? []).map((template) => ({ value: String(template.id), label: `${template.phase === "phase_2" ? "Phase 2" : "Phase 1"} — ${template.name}` }))]} />
                <div className="flex items-end"><Button variant="outline" busy={applyTemplate.isPending} disabled={!selectedTemplateId} onClick={() => applyTemplate.mutate({ orderId, templateId: Number(selectedTemplateId) })}>Apply to order</Button></div>
              </div>
              <Select className="mt-4" label="Workflow phase" value={questionPhase} onChange={(event) => setQuestionPhase(event.target.value)} options={phaseUploadOptions} />
              <Textarea
                label="Question"
                className="mt-4"
                rows={4}
                maxLength={2000}
                showCount
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
              />
              <Checkbox
                className="mt-3"
                label="An answer is required before delivery"
                checked={questionRequired}
                onChange={(event) => setQuestionRequired(event.target.checked)}
              />
              <Button
                className="mt-4"
                busy={addQuestion.isPending}
                disabled={question.trim().length < 5}
                onClick={() =>
                  addQuestion.mutate({
                    orderId,
                    question: question.trim(),
                    phase: questionPhase,
                    required: questionRequired,
                  })
                }
                leadingIcon={<Send className="size-4" aria-hidden="true" />}
              >
                Send question
              </Button>
            </Card>

            <Card>
              <CardHeader title="Questions asked" />
              {questions.length === 0 ? (
                <p className="mt-4 text-sm text-body">No questions have been raised.</p>
              ) : (
                <ul className="mt-4 space-y-3">
                  {questions.map((entry) => (
                    <li key={entry.id} className="rounded-lg border border-line p-3.5">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-sm text-ink">{entry.question}</p>
                        <Badge
                          tone={entry.status === "answered" ? "success" : "warning"}
                          className="shrink-0"
                        >
                          {entry.status}
                        </Badge>
                      </div>
                      {entry.required ? (
                        <p className="mt-1.5 text-xs text-muted">Required before delivery</p>
                      ) : null}
                      <div className="mt-3 rounded border border-line bg-surface-soft p-3">
                        <Textarea label="Staff answer or amendment" rows={3} value={adminAnswerByQuestion[entry.id] ?? ""} onChange={(event) => setAdminAnswerByQuestion((state) => ({ ...state, [entry.id]: event.target.value }))} />
                        <div className="mt-2 flex justify-end"><Button size="sm" variant="outline" busy={answerAsAdmin.isPending} disabled={!(adminAnswerByQuestion[entry.id] ?? "").trim()} onClick={() => answerAsAdmin.mutate({ questionId: entry.id, body: adminAnswerByQuestion[entry.id] ?? "" })}>Save staff answer</Button></div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        ) : null}

        {tab === "phase-locks" ? (
          <Card>
            <CardHeader title="Workflow phase review" description="Every phase in the workflow assigned to this order is listed below. Submitted phases are locked until an administrator unlocks the matching stage." />
            {(phaseLocks.data ?? []).length === 0 ? <p className="mt-4 text-sm text-muted">This order has no assigned workflow phases or historical phase locks.</p> : <div className="mt-4 space-y-3">{(phaseLocks.data ?? []).map((stage) => { const lock = stage.lock; const requiresParticipantSubmission = stage.capabilities.length > 0; return <div key={`${stage.phaseKey}-${stage.rawPhaseKey ?? "workflow"}`} className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4 ${stage.active ? "border-warning/40 bg-warning/5" : "border-line"}`}><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-medium text-ink">{stage.label}</p>{stage.appliedWorkflow ? <Badge tone="teal">Workflow step {stage.stageOrder}</Badge> : <Badge tone="warning">Historical lock</Badge>}</div>{lock ? <><p className="mt-1 text-xs text-muted">Submitted {formatDateTime(lock.lockedAt)}{stage.rawPhaseKey && stage.rawPhaseKey !== stage.phaseKey ? ` · stored as ${stage.rawPhaseKey}` : ""}{lock.unlockedAt ? ` · Unlocked ${formatDateTime(lock.unlockedAt)}` : " · Customer changes are locked"}</p>{lock.reviewedAt ? <p className="mt-1 text-xs text-success">Reviewed {formatDateTime(lock.reviewedAt)}</p> : stage.active ? <p className="mt-1 text-xs font-medium text-warning">Awaiting staff review</p> : null}{lock.unlockReason ? <p className="mt-1 text-xs text-muted">Unlock reason: {lock.unlockReason}</p> : null}</> : <p className="mt-1 text-xs text-muted">{requiresParticipantSubmission ? "Not submitted yet." : "No phase submission is required for this workflow step."}</p>}</div>{stage.active && lock ? <div className="flex flex-wrap gap-2">{!lock.reviewedAt ? <Button variant="primary" size="sm" busy={reviewWorkflowPhase.isPending} onClick={() => reviewWorkflowPhase.mutate({ orderId, phaseKey: stage.phaseKey })}>Mark reviewed</Button> : <Badge tone="success">Reviewed</Badge>}{session.isAdmin ? <Button variant="danger" size="sm" onClick={() => { setUnlockTarget({ phaseKey: stage.phaseKey }); setUnlockReason(""); setUnlockConfirmation(""); }}>Unlock phase</Button> : null}</div> : lock?.unlockedAt ? <Badge tone="success">Unlocked</Badge> : <Badge tone="neutral">Not locked</Badge>}</div>; })}</div>}
          </Card>
        ) : null}

        {tab === "files" ? (
          <Card>
            <CardHeader
              title="Files on this order"
              description="Review all Phase 1 intake artifacts and Phase 2/delivery files. Toggle visibility to publish a deliverable to the customer."
              actions={<div className="flex flex-wrap gap-2"><Button size="sm" variant="primary" leadingIcon={<Upload className="size-3.5" />} onClick={() => setPhaseUploadOpen(true)}>Upload phase documents</Button><Button size="sm" busy={bulkDownload.isPending} disabled={(files.data ?? []).filter((file) => !file.isPlaceholder).length === 0} onClick={() => bulkDownload.mutate({ fileIds: (files.data ?? []).filter((file) => !file.isPlaceholder).map((file) => file.id), archiveName: `${order.orderNumber}-all-files` })}>Download all</Button><LinkButton href="/admin/files" size="sm" variant="outline">File manager</LinkButton></div>}
            />
            {(files.data ?? []).length === 0 ? (
              <p className="mt-4 text-sm text-body">No files have been uploaded to this order.</p>
            ) : (
              <div className="mt-4 space-y-6">
                {(() => {
                  const grouped = new Map<string, any[]>();
                  for (const file of files.data ?? []) {
                    const key = file.phase || "general";
                    grouped.set(key, [...(grouped.get(key) ?? []), file]);
                  }
                  return Array.from(grouped.entries()).map(([phase, phaseFiles]) => {
                    const phaseLabel = phaseUploadOptions.find((option) => option.value === phase)?.label ?? (phase === "general" ? "General / delivery" : phase.replaceAll("_", " "));
                    const downloadablePhaseFiles = phaseFiles.filter((file) => !file.isPlaceholder);
                    return <section key={phase} className="overflow-hidden rounded-lg border border-line"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface-soft px-4 py-3"><div><p className="font-medium text-ink">{phaseLabel}</p><p className="mt-0.5 text-xs text-muted">{phaseFiles.length} file{phaseFiles.length === 1 ? "" : "s"} assigned to this phase</p></div><div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" leadingIcon={<Download className="size-3.5" />} busy={bulkDownload.isPending} disabled={downloadablePhaseFiles.length === 0} onClick={() => bulkDownload.mutate({ fileIds: downloadablePhaseFiles.map((file) => file.id), archiveName: `${order.orderNumber}-${phase}-files` })}>Download phase ({downloadablePhaseFiles.length})</Button><Badge tone="neutral">{phase}</Badge></div></div><ul className="divide-y divide-line">{phaseFiles.map((file) => { const isAudio = ["webm", "wav", "mp3", "m4a", "ogg"].includes((file.extension ?? "").toLowerCase()); return <li key={file.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"><div className="min-w-0"><p className="truncate text-sm font-medium text-ink">{isAudio ? <FileAudio className="mr-1 inline size-4 text-teal" /> : null}{file.originalName}</p><p className="mt-0.5 text-xs text-muted">{file.category === "intake_attachment" ? "Customer artifact" : "Staff document"} · {formatBytes(file.sizeBytes)} · v{file.version} · {formatDate(file.createdAt)}</p></div><div className="flex flex-wrap items-center justify-end gap-2">{isAudio ? <AudioPlayback fileId={file.id} label="Play" /> : null}{!file.isPlaceholder ? <Button size="sm" variant="outline" leadingIcon={<Download className="size-3.5" />} busy={requestDownload.isPending} onClick={() => requestDownload.mutate({ fileId: file.id })}>Download</Button> : null}<Button size="sm" variant={file.visibleToCustomer ? "outline" : "primary"} busy={setVisibility.isPending} onClick={() => setVisibility.mutate({ fileId: file.id, visibleToCustomer: !file.visibleToCustomer })} leadingIcon={file.visibleToCustomer ? <Unlock className="size-4" aria-hidden="true" /> : <Lock className="size-4" aria-hidden="true" />}>{file.visibleToCustomer ? "Visible to customer" : "Publish"}</Button></div></li>; })}</ul></section>;
                  });
                })()}
              </div>
            )}
          </Card>
        ) : null}
      </div>

      <Modal open={phaseUploadOpen} onClose={() => setPhaseUploadOpen(false)} title="Upload phase documents" description="Attach administrator documents to this order and assign them to the correct workflow phase." footer={<><Button variant="outline" onClick={() => setPhaseUploadOpen(false)}>Cancel</Button><Button busy={phaseUploading} leadingIcon={<Upload className="size-4" />} onClick={() => phaseFileInput.current?.click()}>Choose documents</Button></>}><div className="space-y-4"><Select label="Order phase" value={phaseUpload} onChange={(event) => { setPhaseUpload(event.target.value); setPhaseUploadPreRecordedAudio(false); }} options={phaseUploadOptions} />{phaseAllowsPreRecordedAudio ? <Checkbox label="Upload pre-recorded audio files for this phase" checked={phaseUploadPreRecordedAudio} onChange={(event) => setPhaseUploadPreRecordedAudio(event.target.checked)} /> : null}<Alert tone="info">Uploaded administrator documents are initially internal. Use the visibility control in the Files tab to publish a file to the customer inside this order’s matching phase workspace.</Alert><input ref={phaseFileInput} className="hidden" type="file" accept={phaseUploadPreRecordedAudio ? "audio/*,.webm,.ogg" : undefined} multiple onChange={(event) => void uploadPhaseDocuments(event.target.files)} /></div></Modal>

      <Modal open={Boolean(unlockTarget)} onClose={() => setUnlockTarget(null)} title="Unlock customer workflow phase" description="This reopens customer changes for the selected phase. The action is audited and should be used only when a correction is needed." footer={<><Button variant="outline" onClick={() => setUnlockTarget(null)}>Cancel</Button><Button variant="danger" busy={unlockWorkflowPhase.isPending} disabled={unlockConfirmation !== "UNLOCK PHASE" || unlockReason.trim().length < 10} onClick={() => { if (unlockTarget) unlockWorkflowPhase.mutate({ orderId, phaseKey: unlockTarget.phaseKey, reason: unlockReason.trim(), confirmation: "UNLOCK PHASE" }); }}>Unlock phase</Button></>}><div className="space-y-4"><Alert tone="warning">Unlocking allows the customer to add, remove, or update files, recordings, and answers until they submit this phase again.</Alert><Input label="Reason for unlock" value={unlockReason} onChange={(event) => setUnlockReason(event.target.value)} help="Required; recorded in the audit trail." maxLength={1000} /><Input label="Type UNLOCK PHASE to confirm" value={unlockConfirmation} onChange={(event) => setUnlockConfirmation(event.target.value)} /></div></Modal>

      <Modal open={renameOpen} onClose={() => setRenameOpen(false)} title="Rename order" description="This changes the project title only. The order number, customer, payment evidence, files, workflow, and invoice remain unchanged."><div className="space-y-4"><Input autoFocus label="Order title" value={renameValue} maxLength={190} onChange={(event) => setRenameValue(event.target.value)} placeholder="e.g., Building Mount Olympus" /><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setRenameOpen(false)}>Cancel</Button><Button busy={renameOrder.isPending} disabled={!renameValue.trim()} onClick={() => renameOrder.mutate({ orderId, projectName: renameValue.trim() })}>Save title</Button></div></div></Modal>

      {session.isAdmin ? (
        <Modal
          open={changeOrderIdOpen}
          onClose={closeChangeOrderIdModal}
          title="Change order reference"
          description="Use this audited exception only when an order reference must be corrected."
          dismissible={!changeOrderId.isPending}
          footer={
            <>
              <Button variant="outline" onClick={closeChangeOrderIdModal} disabled={changeOrderId.isPending}>
                Cancel
              </Button>
              <Button
                type="submit"
                form="change-order-id-form"
                busy={changeOrderId.isPending}
                disabled={!orderIdChangeReady}
              >
                Change order reference
              </Button>
            </>
          }
        >
          <form
            id="change-order-id-form"
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!orderIdChangeReady) return;
              changeOrderId.mutate({
                orderId,
                orderNumber: newOrderNumber.trim(),
                reason: orderIdChangeReason.trim(),
                confirmation: "CHANGE ORDER ID",
              });
            }}
          >
            <Alert tone="warning">
              <strong>Business policy:</strong> order reference changes may be blocked if immutable financial or external evidence exists.
            </Alert>
            <Input
              label="New order reference"
              value={newOrderNumber}
              onChange={(event) => setNewOrderNumber(event.target.value)}
              autoComplete="off"
              required
              data-autofocus
            />
            <Textarea
              label="Reason for change"
              help="Explain the business need in at least 10 characters. This is retained for audit review."
              value={orderIdChangeReason}
              onChange={(event) => setOrderIdChangeReason(event.target.value)}
              minLength={10}
              maxLength={255}
              required
            />
            <Input
              label="Type CHANGE ORDER ID to confirm"
              value={orderIdChangeConfirmation}
              onChange={(event) => setOrderIdChangeConfirmation(event.target.value)}
              placeholder="CHANGE ORDER ID"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </form>
        </Modal>
      ) : null}

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() =>
          softDelete.mutate({
            orderId,
            reason: deleteReason.trim() || "Moved to trash by an administrator from the order detail view.",
          })
        }
        title="Move this order to trash?"
        message={
          <>
            <p>
              The order is moved to trash and hidden from both the customer and the queue. It remains
              recoverable in the database for the retention period before permanent purge.
            </p>
            <Input
              label="Reason"
              className="mt-4"
              help="Recorded in the audit trail."
              value={deleteReason}
              onChange={(event) => setDeleteReason(event.target.value)}
              maxLength={255}
            />
          </>
        }
        confirmLabel="Move to trash"
        variant="danger"
        busy={softDelete.isPending}
      />
    </>
  );
}

function OrderSharePointSyncTab({ sync, loading, retrying, onRetry }: { sync: any; loading: boolean; retrying: boolean; onRetry: (logId: number) => void }) {
  const rows = sync?.rows ?? [];
  const counts = rows.reduce((result: Record<string, number>, row: any) => {
    result[row.status] = (result[row.status] ?? 0) + 1;
    return result;
  }, {});
  const toneByStatus: Record<string, "neutral" | "warning" | "success" | "danger" | "teal"> = {
    pending: "warning",
    running: "teal",
    succeeded: "success",
    failed: "danger",
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="SharePoint file sync"
          description="Order-scoped delivery status for files queued to the configured SharePoint library. Retry is available only for a failed transfer whose source file still exists."
          actions={<LinkButton href="/admin/integrations" size="sm" variant="outline">Open Sync Log Center</LinkButton>}
        />
        <div className="mt-4 flex flex-wrap gap-2" aria-label="SharePoint sync summary">
          <Badge tone="neutral">{sync?.total ?? 0} total</Badge>
          <Badge tone="success">{counts.succeeded ?? 0} synced</Badge>
          <Badge tone="warning">{(counts.pending ?? 0) + (counts.running ?? 0)} in progress</Badge>
          {counts.failed ? <Badge tone="danger">{counts.failed} failed</Badge> : null}
        </div>
      </Card>

      <Card>
        <CardHeader title="File transfer history" description="Newest synchronization attempt first. The target path and any error are retained for operational review." />
        {loading ? (
          <div className="mt-4 space-y-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>
        ) : rows.length === 0 ? (
          <EmptyState icon={Cloud} title="No SharePoint file transfers yet" description="Files appear here after they are queued for SharePoint synchronization. Check Integrations if SharePoint is not configured." />
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted"><th className="px-3 py-2">File</th><th className="px-3 py-2">Phase</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Target path</th><th className="px-3 py-2">Last update</th><th className="px-3 py-2 text-right">Action</th></tr></thead>
              <tbody>
                {rows.map((row: any) => (
                  <tr key={row.id} className="border-b border-line align-top">
                    <td className="max-w-52 px-3 py-3"><p className="truncate font-medium text-ink">{row.fileName ?? `File #${row.fileId ?? "unknown"}`}</p><p className="mt-1 text-xs text-muted">Attempt {row.attempts} · {row.detectedMime ?? row.extension ?? "File"}</p></td>
                    <td className="px-3 py-3 text-body">{row.phase ? humanizeKey(row.phase) : "Not assigned"}</td>
                    <td className="px-3 py-3"><Badge tone={toneByStatus[row.status] ?? "neutral"}>{row.status}</Badge>{row.errorMessage ? <p className="mt-2 max-w-80 text-xs text-danger">{row.errorMessage}</p> : null}</td>
                    <td className="max-w-80 px-3 py-3 font-mono text-xs text-body"><span className="break-all">{row.sharepointPath || "Path pending"}</span></td>
                    <td className="whitespace-nowrap px-3 py-3 text-xs text-muted">{formatDateTime(row.updatedAt)}</td>
                    <td className="px-3 py-3 text-right">{row.status === "failed" ? <Button size="sm" variant="outline" busy={retrying} onClick={() => onRetry(row.id)} leadingIcon={<RefreshCw className="size-3.5" aria-hidden="true" />}>Retry</Button> : <span className="text-xs text-muted">{row.status === "succeeded" ? "Complete" : "Queued"}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {sync && sync.total > rows.length ? <p className="mt-4 text-xs text-muted">Showing the newest {rows.length} of {sync.total} transfer records. Use the Sync Log Center for paginated search and organization-wide filtering.</p> : null}
      </Card>
    </div>
  );
}

function OrderHistoryTab({ statusHistory, activityHistory }: { statusHistory: any[]; activityHistory: any[] }) {
  return <div className="grid gap-6 lg:grid-cols-2">
    <Card><CardHeader title="Status history" description="Every lifecycle transition recorded for this order." />{statusHistory.length ? <ol className="mt-4 space-y-3">{statusHistory.map((entry) => <li key={entry.id} className="rounded-lg border border-line bg-surface-soft p-3"><div className="flex flex-wrap items-center gap-2"><Badge tone="neutral">{entry.fromStatus ?? "Created"}</Badge><ArrowRight className="size-4 text-muted" /><Badge tone="teal">{entry.toStatus}</Badge></div>{entry.reason ? <p className="mt-2 text-sm text-body">{entry.reason}</p> : null}<p className="mt-2 text-xs text-muted">{formatDateTime(entry.createdAt)}{entry.actorUserId ? ` · actor #${entry.actorUserId}` : ""}</p></li>)}</ol> : <p className="mt-4 text-sm text-muted">No lifecycle transitions have been recorded yet.</p>}</Card>
    <Card><CardHeader title="Order activity" description="Order-scoped actions and automation events retained for audit." />{activityHistory.length ? <ol className="mt-4 space-y-3">{activityHistory.map((entry) => <li key={entry.id} className="rounded-lg border border-line p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-mono text-xs font-semibold text-ink">{entry.action}</p><Badge tone={entry.severity === "critical" || entry.severity === "error" ? "danger" : entry.severity === "warning" ? "warning" : "neutral"}>{entry.severity}</Badge></div><p className="mt-2 text-sm text-body">{entry.summary}</p><p className="mt-2 text-xs text-muted">{formatDateTime(entry.createdAt)}{entry.actorRole ? ` · ${entry.actorRole}` : ""}</p></li>)}</ol> : <p className="mt-4 text-sm text-muted">No order-scoped activity has been recorded yet.</p>}</Card>
  </div>;
}

function OrderMndaTab({ acceptances }: { acceptances: any[] }) {
  return <Card><CardHeader title="MNDA acceptance" description="Order-specific Mutual Non-Disclosure Agreement acceptance and signature records." />{acceptances.length ? <div className="mt-4 space-y-4">{acceptances.map((acceptance) => <div key={acceptance.id} className="rounded-lg border border-line bg-surface-soft p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-medium text-ink">MNDA {acceptance.version}</p><p className="mt-1 text-sm text-body">Signed by {acceptance.signatureName || "Customer"} using {acceptance.signatureMethod} signature.</p></div><Badge tone="success">Accepted</Badge></div><dl className="mt-4 grid gap-3 text-sm md:grid-cols-3"><div><dt className="text-xs uppercase tracking-wide text-muted">Accepted</dt><dd className="mt-1 text-ink">{formatDateTime(acceptance.acceptedAt)}</dd></div><div><dt className="text-xs uppercase tracking-wide text-muted">Source address</dt><dd className="mt-1 font-mono text-xs text-ink">{acceptance.ipAddress || "Not captured"}</dd></div><div><dt className="text-xs uppercase tracking-wide text-muted">Signed file</dt><dd className="mt-1 text-ink">{acceptance.uploadedFileId ? `Order file #${acceptance.uploadedFileId}` : "Typed acceptance"}</dd></div></dl></div>)}</div> : <Alert tone="info" className="mt-4">The customer has not yet accepted an MNDA for this order. Phase I intake remains unavailable until the required MNDA is accepted.</Alert>}</Card>;
}

function OrderAutomationTab({ order, customer }: { order: any; customer: any }) {
  const toast = useToast();
  const utils = trpc.useUtils();
  const graphConfig = trpc.integrations.graphConfig.useQuery();
  const workflows = trpc.admin.orderWorkflows.useQuery();
  const workflowStageRuns = trpc.admin.workflowStageRuns.useQuery({ orderId: order.id });
  const workflowCompletionJobs = trpc.admin.workflowCompletionJobs.useQuery({ orderId: order.id });
  const assignedWorkflow = (workflows.data ?? []).find((workflow) => workflow.id === order.workflowId);
  const workflowStages = Array.isArray(assignedWorkflow?.stages)
    ? (assignedWorkflow.stages as Array<{ key?: unknown; label?: unknown; order?: unknown; actions?: unknown }>).filter((stage) => typeof stage.key === "string" && typeof stage.label === "string").sort((left, right) => (typeof left.order === "number" ? left.order : 0) - (typeof right.order === "number" ? right.order : 0))
    : [];
  const phaseJobs = trpc.integrations.phaseJobs.useQuery({ orderId: order.id });
  const deliveryLog = trpc.integrations.webhookDeliveries.useQuery({ orderId: order.id });
  const runWorkflowActions = trpc.admin.runWorkflowStageActions.useMutation({
    onSuccess(result) { void workflowStageRuns.refetch(); toast.success("Workflow actions completed", result.executed.length ? result.executed.join(" • ") : "No actions are configured for this phase."); },
    onError(error) { toast.error("Could not run workflow actions", errorMessage(error)); },
  });
  const retryPhaseJob = trpc.integrations.retryPhaseJob.useMutation({ onSuccess: () => { void phaseJobs.refetch(); toast.success("Phase job queued for retry"); }, onError: (error) => toast.error("Could not retry phase job", errorMessage(error)) });
  const retryDelivery = trpc.integrations.retryWebhookDelivery.useMutation({ onSuccess: () => { void deliveryLog.refetch(); toast.success("Webhook delivery queued for retry"); }, onError: (error) => toast.error("Could not retry delivery", errorMessage(error)) });
  const redeliver = trpc.integrations.redeliverWebhook.useMutation({ onSuccess: () => { void deliveryLog.refetch(); toast.success("New webhook redelivery queued"); }, onError: (error) => toast.error("Could not create redelivery", errorMessage(error)) });

  const p101Payload = {
    customer_id: customer?.customerNumber ?? "RP-CUS-UNKNOWN0",
    order_id: order.orderNumber,
    packet: order.p101Packet ?? "7",
    tier: order.p101Tier ?? "Mixed",
    canon_version: order.canonVersion ?? "ReadyPackets_Production_v2.0",
    run_mode: order.runMode ?? "production",
    client_name: customer?.name ?? "",
    client_email: customer?.email ?? "",
    release_status: order.releaseStatus ?? "",
    bundle_scope_manifest: order.bundleScopeManifest ?? "{}",
  };

  const p201Payload = {
    customer_id: p101Payload.customer_id,
    order_id: p101Payload.order_id,
    run_mode: p101Payload.run_mode,
  };

  const manualKickoff = trpc.integrations.manualPhaseKickoff.useMutation({
    onSuccess(_result, variables) {
      toast.success(
        "Phase kickoff queued",
        `${variables.phase === "phase_1_intake" ? "P101" : variables.phase === "phase_2_synthesis" ? "P201" : variables.phase} is now queued for delivery to the configured phase-start webhook endpoint.`,
      );
      void utils.integrations.phaseJobs.invalidate({ orderId: order.id });
    },
    onError(error) {
      toast.error("Could not queue phase kickoff", errorMessage(error));
    },
  });

  const handleKickoff = (phase: "phase_1_intake" | "phase_2_synthesis" | "in_production" | "delivered") => {
    manualKickoff.mutate({ orderId: order.id, phase });
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr] lg:items-start">
      <div className="space-y-6">
        <Card>
          <CardHeader title="Workflow stage actions" description={assignedWorkflow ? `${assignedWorkflow.name} actions run only when an administrator selects Run actions for this order. Every run is recorded below.` : "Assign an active workflow on the Overview tab to configure order-specific stage actions."} />
          {workflowStages.length ? <div className="mt-4 space-y-2">{workflowStages.map((stage) => {
            const actions = stage.actions && typeof stage.actions === "object" ? stage.actions as Record<string, unknown> : {};
            const actionCount = Number(Boolean(actions.emailTemplateKey)) + Number(Boolean(actions.orderStatus)) + Number(actions.completionPercent !== undefined || actions.completionMode === "fixed" || actions.completionMode === "random") + Number(Boolean(actions.webhookEndpointId)) + Number((actions.adminAlert as { enabled?: unknown } | undefined)?.enabled === true);
            return <div key={stage.key as string} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line p-3"><div><p className="font-medium text-ink">{stage.label as string}</p><p className="text-xs text-muted">{actionCount ? `${actionCount} configured action${actionCount === 1 ? "" : "s"}` : "No administrator actions configured"}</p></div><Button size="sm" variant={actionCount ? "primary" : "outline"} busy={runWorkflowActions.isPending} disabled={!actionCount} onClick={() => runWorkflowActions.mutate({ orderId: order.id, stageKey: stage.key as string })}>Run actions</Button></div>;
          })}</div> : <Alert tone="info" className="mt-4">No workflow stages are assigned to this order yet.</Alert>}
          {(workflowStageRuns.data ?? []).length ? <div className="mt-4 border-t border-line pt-4"><p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Recent workflow action runs</p><div className="space-y-2">{(workflowStageRuns.data ?? []).slice(0, 6).map((run) => <div key={run.id} className="flex items-center justify-between gap-3 rounded-lg bg-surface-soft px-3 py-2 text-xs"><span><strong>{run.stageKey}</strong> · {new Date(run.startedAt).toLocaleString()}</span><Badge tone={run.status === "completed" ? "success" : run.status === "failed" ? "danger" : "warning"}>{run.status}</Badge></div>)}</div></div> : null}
          {(workflowCompletionJobs.data ?? []).length ? <div className="mt-4 border-t border-line pt-4"><p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Completion update schedule</p><div className="space-y-2">{(workflowCompletionJobs.data ?? []).slice(0, 8).map((job) => <div key={job.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-soft px-3 py-2 text-xs"><span><strong>{job.stageKey}</strong> · {job.mode === "random" ? `${job.minPercent}%–${job.maxPercent}% random` : `${job.targetPercent}% fixed`} · target {job.targetPercent}% · {job.status === "pending" ? `runs ${formatDateTime(job.runAfter)}` : job.completedAt ? `finished ${formatDateTime(job.completedAt)}` : "processing"}</span><Badge tone={job.status === "completed" ? "success" : job.status === "failed" ? "danger" : job.status === "cancelled" ? "neutral" : "warning"}>{job.status}</Badge></div>)}</div></div> : null}
        </Card>
        <Card>
          <CardHeader
            title="Phase I Start Webhook (P101)"
            description="Payload generated for this specific order."
          />
          <div className="mt-4">
            <pre className="overflow-x-auto rounded-lg bg-navy p-4 text-xs text-white/90">
              {JSON.stringify(p101Payload, null, 2)}
            </pre>
          </div>
          <div className="mt-4 flex items-center gap-3 border-t border-line pt-4">
            <Button
              variant="primary"
              busy={manualKickoff.isPending}
              onClick={() => handleKickoff("phase_1_intake")}
            >
              Start Phase I / queue P101
            </Button>
            <p className="text-xs text-muted">Uses configured endpoint secrets and records delivery results in the webhook delivery log.</p>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Phase II Start Webhook (P201)"
            description="Trigger only after Phase I final artifacts exist."
          />
          <div className="mt-4">
            <pre className="overflow-x-auto rounded-lg bg-navy p-4 text-xs text-white/90">
              {JSON.stringify(p201Payload, null, 2)}
            </pre>
          </div>
          <div className="mt-4 flex items-center gap-3 border-t border-line pt-4">
            <Button
              variant="outline"
              busy={manualKickoff.isPending}
              onClick={() => handleKickoff("phase_2_synthesis")}
            >
              Start Phase II / queue P201
            </Button>
            <p className="text-xs text-muted">Use only after the Phase I final artifacts are present in SharePoint.</p>
          </div>
        </Card>
      </div>

      <div className="space-y-6">
        <Alert tone="info" title="Webhook Rules">
          <ul className="mt-2 list-disc pl-5 space-y-1 text-sm text-body">
            <li><strong>P201 must match P101:</strong> customer_id, order_id, and run_mode must be identical.</li>
            <li><strong>Bundle scope manifest:</strong> Must be passed as a JSON string inside the outer JSON, not as a nested object.</li>
            <li><strong>Phase I Artifacts:</strong> Do not trigger P201 until Phase I final artifacts exist in the SharePoint folder.</li>
          </ul>
        </Alert>

        <Card>
          <CardHeader title="Manual phase actions" description="Queue configured actions for the later lifecycle phases." />
          <div className="mt-4 grid gap-2">
            <Button variant="outline" busy={manualKickoff.isPending} onClick={() => handleKickoff("in_production")}>Kick off Phase III</Button>
            <Button variant="outline" busy={manualKickoff.isPending} onClick={() => handleKickoff("delivered")}>Kick off Phase IV</Button>
          </div>
        </Card>

        <Card>
          <CardHeader title="This order’s Phase I and Phase II automation history" description="Jobs and webhook deliveries for this order only. Retry or create a fresh redelivery without leaving the order." />
          <div className="mt-4 space-y-5"><div><p className="text-sm font-semibold text-ink">Phase jobs</p>{(phaseJobs.data?.rows ?? []).filter((job) => job.phase === "phase_1_intake" || job.phase === "phase_2_synthesis").length ? <ul className="mt-2 space-y-2">{(phaseJobs.data?.rows ?? []).filter((job) => job.phase === "phase_1_intake" || job.phase === "phase_2_synthesis").map((job) => <li key={job.id} className="rounded border border-line p-2.5 text-xs"><div className="flex items-center justify-between gap-2"><span className="font-medium text-ink">{job.phase === "phase_1_intake" ? "Phase I" : "Phase II"} · {job.jobType}</span><Badge tone={job.status === "completed" ? "success" : job.status === "failed" ? "danger" : "warning"}>{job.status}</Badge></div><p className="mt-1 text-muted">Started {formatDateTime(job.createdAt)}{job.completedAt ? ` · finished ${formatDateTime(job.completedAt)}` : ""}</p>{job.lastError ? <p className="mt-1 text-danger">{job.lastError}</p> : null}{job.status === "failed" || job.status === "stopped" ? <Button className="mt-2" size="sm" variant="outline" busy={retryPhaseJob.isPending} onClick={() => retryPhaseJob.mutate({ jobId: job.id })}>Retry job</Button> : null}</li>)}</ul> : <p className="mt-2 text-xs text-muted">No Phase I or Phase II jobs have been run for this order.</p>}</div><div><p className="text-sm font-semibold text-ink">Webhook deliveries</p>{(deliveryLog.data?.rows ?? []).filter((delivery) => delivery.eventType === "P101" || delivery.eventType === "P201").length ? <ul className="mt-2 space-y-2">{(deliveryLog.data?.rows ?? []).filter((delivery) => delivery.eventType === "P101" || delivery.eventType === "P201").map((delivery) => <li key={delivery.id} className="rounded border border-line p-2.5 text-xs"><div className="flex items-center justify-between gap-2"><span className="font-medium text-ink">{delivery.eventType} · {formatDateTime(delivery.createdAt)}</span><Badge tone={delivery.status === "delivered" ? "success" : delivery.status === "failed" ? "danger" : "warning"}>{delivery.status}</Badge></div><p className="mt-1 text-muted">Attempts: {delivery.attempts}{delivery.responseCode ? ` · HTTP ${delivery.responseCode}` : ""}{delivery.deliveredAt ? ` · delivered ${formatDateTime(delivery.deliveredAt)}` : ""}</p>{delivery.lastError ? <p className="mt-1 text-danger">{delivery.lastError}</p> : null}<div className="mt-2 flex gap-2">{delivery.status !== "delivered" ? <Button size="sm" variant="outline" busy={retryDelivery.isPending} onClick={() => retryDelivery.mutate({ deliveryId: delivery.id })}>Retry</Button> : null}<Button size="sm" variant="outline" busy={redeliver.isPending} onClick={() => redeliver.mutate({ deliveryId: delivery.id })}>Redeliver</Button></div></li>)}</ul> : <p className="mt-2 text-xs text-muted">No Phase I or Phase II webhook deliveries have been queued for this order.</p>}</div></div>
        </Card>

        <Card>
          <CardHeader title="SharePoint Sync Configuration" />
          <div className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between border-b border-line pb-2">
              <span className="text-muted">Customer Folder</span>
              <span className="font-mono text-ink">{p101Payload.customer_id}</span>
            </div>
            <div className="flex justify-between border-b border-line pb-2">
              <span className="text-muted">Order Folder</span>
              <span className="font-mono text-ink">{order.orderNumber}</span>
            </div>
            <div className="flex justify-between pb-2">
              <span className="text-muted">Status</span>
              <Badge tone="success">Sync enabled</Badge>
            </div>
            <div className="pt-2 grid gap-2">
              {graphConfig.data?.siteUrl ? (
                <a
                  href={graphConfig.data.siteUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex w-full items-center justify-center rounded-lg border border-line px-3 py-2 text-sm font-semibold text-teal-dark no-underline hover:border-teal hover:text-teal"
                >
                  Open SharePoint site for this order
                </a>
              ) : null}
              <LinkButton
                href={`/admin/integrations?tab=sync&orderId=${order.id}`}
                variant="outline"
                className="w-full justify-center"
              >
                View this order’s SharePoint sync log
              </LinkButton>
              <LinkButton
                href="/admin/integrations?tab=sharepoint"
                variant="outline"
                className="w-full justify-center"
              >
                Edit SharePoint settings
              </LinkButton>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
