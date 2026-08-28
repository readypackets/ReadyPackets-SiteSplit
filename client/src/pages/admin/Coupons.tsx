/**
 * Coupon management — create, edit, and deactivate discount codes.
 */
import { useState } from "react";
import { Percent, Plus, Tag } from "lucide-react";
import { trpc, errorMessage } from "@/lib/trpc";
import { formatDate, formatMoney } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Checkbox, FieldShell, Input, Select } from "@/components/ui/Field";
import { Badge, Card, EmptyState, Skeleton } from "@/components/ui/Surface";
import { DataTable, StatTile, type Column } from "@/components/ui/DataDisplay";
import { ConfirmDialog, Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { PageHeader } from "@/components/layout/PortalLayout";

interface CouponRow {
  id: number;
  code: string;
  description: string | null;
  discountType: string;
  discountValue: number;
  maxRedemptions: number | null;
  redemptionCount: number;
  startsAt: string | Date | null;
  expiresAt: string | Date | null;
  active: boolean;
  createdAt: string | Date;
}

const emptyForm = {
  id: null as number | null,
  code: "",
  description: "",
  discountType: "percent",
  discountValue: "",
  maxRedemptions: "",
  startsAt: "",
  expiresAt: "",
  active: true,
};

/** Avoid floating-point rounding: fixed coupon values are stored as integer cents. */
function centsToDollarInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

function dollarInputToCents(value: string): number | null {
  const normalized = value.trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return null;
  const whole = Number(match[1]);
  if (!Number.isSafeInteger(whole) || whole > 10_000_000) return null;
  const fractional = (match[2] ?? "").padEnd(2, "0");
  const cents = whole * 100 + Number(fractional || "0");
  return Number.isSafeInteger(cents) ? cents : null;
}

function isFixedAmount(discountType: string): boolean {
  return discountType === "fixed" || discountType === "cart_price";
}

export function AdminCouponsPage() {
  const toast = useToast();
  const utils = trpc.useUtils();
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [deactivateId, setDeactivateId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<CouponRow | null>(null);

  const list = trpc.stripe.coupons.useQuery();
  const upsertMut = trpc.stripe.upsertCoupon.useMutation({
    async onSuccess() {
      toast.success(form.id ? "Coupon updated" : "Coupon created");
      setModalOpen(false);
      setForm({ ...emptyForm });
      await utils.stripe.coupons.invalidate();
    },
    onError(error) {
      toast.error("Could not save coupon", errorMessage(error));
    },
  });
  const deactivateMut = trpc.stripe.setCouponActive.useMutation({
    async onSuccess() {
      toast.success("Coupon deactivated");
      setDeactivateId(null);
      await utils.stripe.coupons.invalidate();
    },
    onError(error) {
      toast.error("Could not deactivate coupon", errorMessage(error));
    },
  });
  const deleteMut = trpc.stripe.deleteCoupon.useMutation({
    async onSuccess() {
      toast.success("Coupon deleted");
      setDeleting(null);
      await utils.stripe.coupons.invalidate();
    },
    onError(error) {
      toast.error("Could not delete coupon", errorMessage(error));
    },
  });

  const rows = (list.data ?? []) as unknown as CouponRow[];
  const active = rows.filter((r) => r.active).length;
  const totalRedemptions = rows.reduce((sum, r) => sum + r.redemptionCount, 0);

  function openCreate() {
    setForm({ ...emptyForm });
    setModalOpen(true);
  }

  function openEdit(row: CouponRow) {
    setForm({
      id: row.id,
      code: row.code,
      description: row.description ?? "",
      discountType: row.discountType,
      discountValue: isFixedAmount(row.discountType) ? centsToDollarInput(row.discountValue) : String(row.discountValue),
      maxRedemptions: row.maxRedemptions != null ? String(row.maxRedemptions) : "",
      startsAt: row.startsAt ? new Date(row.startsAt).toISOString().slice(0, 10) : "",
      expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString().slice(0, 10) : "",
      active: row.active,
    });
    setModalOpen(true);
  }

  function handleSave() {
    const discountValue = isFixedAmount(form.discountType)
      ? dollarInputToCents(form.discountValue)
      : Number(form.discountValue);
    if (discountValue === null || !Number.isInteger(discountValue) || discountValue < (form.discountType === "cart_price" ? 0 : 1)) {
      toast.error("Enter a valid discount amount", form.discountType === "percent" ? "Use a whole percentage between 1 and 100." : "Use dollars and cents, for example 25.00.");
      return;
    }
    upsertMut.mutate({
      id: form.id ?? undefined,
      code: form.code.trim().toUpperCase(),
      description: form.description.trim() || undefined,
      discountType: form.discountType as "percent" | "fixed" | "cart_price",
      discountValue,
      maxRedemptions: form.maxRedemptions ? Number(form.maxRedemptions) : undefined,
      startsAt: form.startsAt || undefined,
      expiresAt: form.expiresAt || undefined,
      active: form.active,
    });
  }

  const columns: Column<CouponRow>[] = [
    {
      key: "code",
      header: "Code",
      cell: (row) => (
        <div>
          <p className="font-mono font-semibold text-ink">{row.code}</p>
          {row.description ? (
            <p className="mt-0.5 text-xs text-muted">{row.description}</p>
          ) : null}
        </div>
      ),
    },
    {
      key: "discount",
      header: "Discount",
      cell: (row) => (
        <span className="font-semibold text-ink">
          {row.discountType === "percent"
            ? `${row.discountValue}% off`
            : row.discountType === "cart_price"
            ? `Cart price ${formatMoney(row.discountValue)}`
            : `${formatMoney(row.discountValue)} off`}
        </span>
      ),
    },
    {
      key: "redemptions",
      header: "Redemptions",
      hideOnMobile: true,
      cell: (row) => (
        <span className="tabular-nums text-sm text-ink">
          {row.redemptionCount}
          {row.maxRedemptions != null ? ` / ${row.maxRedemptions}` : ""}
        </span>
      ),
    },
    {
      key: "expires",
      header: "Expires",
      hideOnMobile: true,
      cell: (row) => (
        <span className="text-xs text-muted">
          {row.expiresAt ? formatDate(row.expiresAt) : "Never"}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => (
        <Badge tone={row.active ? "success" : "neutral"}>
          {row.active ? "Active" : "Inactive"}
        </Badge>
      ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (row) => (
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
            Edit
          </Button>
          {row.active ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDeactivateId(row.id)}
            >
              Deactivate
            </Button>
          ) : row.redemptionCount === 0 ? (
            <Button variant="link" size="sm" className="text-danger" onClick={() => setDeleting(row)}>
              Delete
            </Button>
          ) : (
            <span className="text-xs text-muted" title="Coupons with redemption history are retained for audit purposes">Retained</span>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={form.id ? "Edit coupon" : "Create coupon"}
      >
        <div className="space-y-4">
          <Input
            label="Code"
            placeholder="SUMMER25"
            required
            value={form.code}
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
          />
          <Input
            label="Description"
            placeholder="Optional internal note"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Type"
              value={form.discountType}
              onChange={(e) => setForm((f) => ({ ...f, discountType: e.target.value }))}
              options={[
                { value: "percent", label: "Percentage off" },
                { value: "fixed", label: "Fixed amount off" },
                { value: "cart_price", label: "Fixed cart price" },
              ]}
            />
            <Input
              label={form.discountType === "percent" ? "Percent off" : form.discountType === "cart_price" ? "Final cart price (USD)" : "Amount off (USD)"}
              type="number"
              min={form.discountType === "cart_price" ? 0 : isFixedAmount(form.discountType) ? 0.01 : 1}
              step={isFixedAmount(form.discountType) ? "0.01" : "1"}
              inputMode={isFixedAmount(form.discountType) ? "decimal" : "numeric"}
              required
              value={form.discountValue}
              onChange={(e) => setForm((f) => ({ ...f, discountValue: e.target.value }))}
              help={isFixedAmount(form.discountType) ? "Enter dollars and cents, for example 25.00. ReadyPackets stores this securely as cents." : undefined}
            />
          </div>
          <Input
            label="Max redemptions"
            type="number"
            min={1}
            help="Leave blank for unlimited."
            value={form.maxRedemptions}
            onChange={(e) => setForm((f) => ({ ...f, maxRedemptions: e.target.value }))}
          />
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Starts"
              type="date"
              value={form.startsAt}
              onChange={(e) => setForm((f) => ({ ...f, startsAt: e.target.value }))}
            />
            <Input
              label="Expires"
              type="date"
              value={form.expiresAt}
              onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))}
            />
          </div>
          <Checkbox
            label="Active"
            checked={form.active}
            onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
          />
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button
              busy={upsertMut.isPending}
              disabled={!form.code.trim() || !form.discountValue}
              onClick={handleSave}
            >
              {form.id ? "Save changes" : "Create coupon"}
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={deactivateId !== null}
        onClose={() => setDeactivateId(null)}
        onConfirm={() => {
          if (deactivateId !== null) {
            deactivateMut.mutate({ id: deactivateId, active: false });
          }
        }}
        title="Deactivate coupon"
        message="This coupon will no longer be accepted at checkout."
        confirmLabel="Deactivate"
        variant="danger"
        busy={deactivateMut.isPending}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) deleteMut.mutate({ id: deleting.id });
        }}
        title="Delete coupon permanently?"
        message={`Delete ${deleting?.code ?? "this coupon"}? This cannot be undone. Only inactive coupons with no redemption history can be deleted.`}
        confirmLabel="Delete coupon"
        cancelLabel="Keep coupon"
        variant="danger"
        busy={deleteMut.isPending}
      />

      <PageHeader
        title="Coupons"
        description="Manage discount codes for checkout."
        actions={
          <Button
            onClick={openCreate}
            leadingIcon={<Plus className="size-4" aria-hidden="true" />}
          >
            Create coupon
          </Button>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatTile icon={Tag} label="Total coupons" value={String(rows.length)} />
        <StatTile icon={Percent} label="Active" value={String(active)} />
        <StatTile icon={Tag} label="Total redemptions" value={String(totalRedemptions)} />
      </div>

      {list.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : (
        <DataTable
          caption="Coupons"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          empty={
            <EmptyState
              icon={Tag}
              title="No coupons"
              description="Create a discount code to get started."
              action={
                <Button
                  onClick={openCreate}
                  leadingIcon={<Plus className="size-4" aria-hidden="true" />}
                >
                  Create coupon
                </Button>
              }
            />
          }
        />
      )}
    </>
  );
}
