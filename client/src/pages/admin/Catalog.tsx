/**
 * Catalogue management.
 *
 * Prices are entered in whole dollars and converted to integer cents by the
 * server, so no floating-point value is ever persisted. Deactivating a product
 * withdraws it from sale without deleting the historical orders that reference it.
 */
import { useState } from "react";
import { Layers, Package, Pencil, Plus, PowerOff, Power } from "lucide-react";
import { trpc, errorMessage } from "@/lib/trpc";
import { formatMoney } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/Field";
import { Alert, Badge, Card, CardHeader, Skeleton } from "@/components/ui/Surface";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { PageHeader } from "@/components/layout/PortalLayout";

const TIERS = ["essential", "professional", "enterprise", "bundle", "institutional"] as const;

const TIER_TONES: Record<string, "neutral" | "teal" | "navy" | "gold" | "info"> = {
  essential: "neutral",
  professional: "teal",
  enterprise: "navy",
  bundle: "gold",
  institutional: "info",
};

interface GroupForm {
  id?: number;
  slug: string;
  groupNumber: number;
  name: string;
  category: string;
  summary: string;
  icon: string;
  listed: boolean;
  sortOrder: number;
}

interface ProductForm {
  id?: number;
  packetGroupId: number;
  sku: string;
  name: string;
  tier: string;
  priceDollars: string;
  customPricing: boolean;
  deliveryEstimate: string;
  outcome: string;
  description: string;
  listed: boolean;
  active: boolean;
  sortOrder: number;
}

function CatalogPresentationPanel({
  value,
  loading,
  saving,
  onChange,
  onSave,
}: {
  value: {
    pricingMode: "show" | "on_request" | "hidden";
    publicDeliveryEstimatesVisible: boolean;
    customerPortalDeliveryEstimatesVisible: boolean;
    publicReviewsNavigationVisible: boolean;
    publicCommunityNavigationVisible: boolean;
  };
  loading: boolean;
  saving: boolean;
  onChange: (value: {
    pricingMode: "show" | "on_request" | "hidden";
    publicDeliveryEstimatesVisible: boolean;
    customerPortalDeliveryEstimatesVisible: boolean;
    publicReviewsNavigationVisible: boolean;
    publicCommunityNavigationVisible: boolean;
  }) => void;
  onSave: () => void;
}) {
  const disabled = loading || saving;
  const pricingLabels: Record<typeof value.pricingMode, string> = {
    show: "Prices shown",
    on_request: "Pricing on request",
    hidden: "Pricing hidden",
  };

  return (
    <Card>
      <CardHeader
        title="Public presentation"
        description="Control catalog display and public navigation without changing protected checkout pricing, customer quotes, order totals, invoices, or community access rules."
        actions={<Badge tone={value.pricingMode === "show" ? "success" : value.pricingMode === "on_request" ? "warning" : "neutral"}>{pricingLabels[value.pricingMode]}</Badge>}
      />
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Select
          label="Public pricing"
          value={value.pricingMode}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, pricingMode: event.target.value as typeof value.pricingMode })}
          options={[
            { value: "show", label: "Show numeric prices" },
            { value: "on_request", label: "Show “Pricing on request”" },
            { value: "hidden", label: "Hide the pricing area" },
          ]}
          help="This affects public catalog pages only. Signed-in customers still receive server-calculated quotes before an order is placed."
        />
        <div className="grid content-start gap-3 rounded-lg border border-line bg-surface-soft p-4">
          <p className="text-sm font-semibold text-ink">Delivery estimates</p>
          <Checkbox
            label="Show on the public website"
            checked={value.publicDeliveryEstimatesVisible}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, publicDeliveryEstimatesVisible: event.target.checked })}
          />
          <Checkbox
            label="Show in the customer portal"
            checked={value.customerPortalDeliveryEstimatesVisible}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, customerPortalDeliveryEstimatesVisible: event.target.checked })}
          />
        </div>
        <div className="grid content-start gap-3 rounded-lg border border-line bg-surface-soft p-4 lg:col-span-2">
          <p className="text-sm font-semibold text-ink">Public navigation</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Checkbox
              label="Show Reviews in public navigation"
              checked={value.publicReviewsNavigationVisible}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, publicReviewsNavigationVisible: event.target.checked })}
            />
            <Checkbox
              label="Show Community in public navigation"
              checked={value.publicCommunityNavigationVisible}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, publicCommunityNavigationVisible: event.target.checked })}
            />
          </div>
          <p className="text-xs leading-relaxed text-muted">When hidden, the corresponding public links are removed from both desktop/mobile header navigation and the footer. This does not change feature moderation or direct-link access.</p>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <p className="max-w-2xl text-xs leading-relaxed text-muted">All changes are administrator-only and written to the audit trail.</p>
        <Button busy={saving} disabled={loading} onClick={onSave}>Save presentation settings</Button>
      </div>
    </Card>
  );
}

const emptyGroup: GroupForm = {
  slug: "",
  groupNumber: 1,
  name: "",
  category: "",
  summary: "",
  icon: "Layers",
  listed: true,
  sortOrder: 0,
};

export function AdminCatalogPage() {
  const toast = useToast();
    const catalog = trpc.admin.catalog.useQuery();
  const publicPresentation = trpc.admin.publicCatalogPresentation.useQuery();
  const [presentationDraft, setPresentationDraft] = useState<{
    pricingMode: "show" | "on_request" | "hidden";
    publicDeliveryEstimatesVisible: boolean;
    customerPortalDeliveryEstimatesVisible: boolean;
    publicReviewsNavigationVisible: boolean;
    publicCommunityNavigationVisible: boolean;
  } | null>(null);
  const setPublicPresentation = trpc.admin.setPublicCatalogPresentation.useMutation({
    async onSuccess() {
      setPresentationDraft(null);
      await publicPresentation.refetch();
      toast.success("Public presentation settings saved");
    },
    onError(error) {
      toast.error("Could not update public presentation settings", errorMessage(error));
    },
  });
  const [groupForm, setGroupForm] = useState<GroupForm | null>(null);
  const [productForm, setProductForm] = useState<ProductForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const upsertGroup = trpc.admin.upsertPacketGroup.useMutation({
    async onSuccess() {
      setGroupForm(null);
      await catalog.refetch();
      toast.success("Packet group saved");
    },
    onError(error) {
      setFormError(errorMessage(error));
    },
  });

  const upsertProduct = trpc.admin.upsertProduct.useMutation({
    async onSuccess() {
      setProductForm(null);
      await catalog.refetch();
      toast.success("Product saved");
    },
    onError(error) {
      setFormError(errorMessage(error));
    },
  });

  const setActive = trpc.admin.setProductActive.useMutation({
    async onSuccess() {
      await catalog.refetch();
    },
    onError(error) {
      toast.error("Could not change availability", errorMessage(error));
    },
  });

  return (
    <>
      <PageHeader
        title="Catalogue"
        description="Packet groups, products, pricing, and availability."
        actions={
          <Button
            onClick={() => {
              setFormError(null);
              setGroupForm({
                ...emptyGroup,
                groupNumber: (catalog.data ?? []).length + 1,
                sortOrder: (catalog.data ?? []).length,
              });
            }}
            leadingIcon={<Plus className="size-4" aria-hidden="true" />}
          >
            New packet group
          </Button>
        }
      />

      <CatalogPresentationPanel
        value={presentationDraft ?? {
          pricingMode: publicPresentation.data?.pricingMode ?? "show",
          publicDeliveryEstimatesVisible: publicPresentation.data?.publicDeliveryEstimatesVisible ?? true,
          customerPortalDeliveryEstimatesVisible: publicPresentation.data?.customerPortalDeliveryEstimatesVisible ?? true,
          publicReviewsNavigationVisible: publicPresentation.data?.publicReviewsNavigationVisible ?? true,
          publicCommunityNavigationVisible: publicPresentation.data?.publicCommunityNavigationVisible ?? true,
        }}
        loading={publicPresentation.isLoading}
        saving={setPublicPresentation.isPending}
        onChange={setPresentationDraft}
        onSave={() => {
          const value = presentationDraft ?? {
            pricingMode: publicPresentation.data?.pricingMode ?? "show",
            publicDeliveryEstimatesVisible: publicPresentation.data?.publicDeliveryEstimatesVisible ?? true,
            customerPortalDeliveryEstimatesVisible: publicPresentation.data?.customerPortalDeliveryEstimatesVisible ?? true,
            publicReviewsNavigationVisible: publicPresentation.data?.publicReviewsNavigationVisible ?? true,
            publicCommunityNavigationVisible: publicPresentation.data?.publicCommunityNavigationVisible ?? true,
          };
          setPublicPresentation.mutate(value);
        }}
      />

      {catalog.isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-48 w-full" />
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          {(catalog.data ?? []).map((group) => (
            <Card key={group.id} padded={false}>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="teal">Packet {group.groupNumber}</Badge>
                    <span className="text-xs uppercase tracking-wide text-muted">
                      {group.category}
                    </span>
                  </div>
                  <h2 className="mt-1.5 flex items-center gap-2 text-lg font-semibold text-ink">
                    <Layers className="size-4 text-teal" aria-hidden="true" />
                    {group.name}
                  </h2>
                  {group.summary ? (
                    <p className="mt-1 max-w-2xl text-sm text-body">{group.summary}</p>
                  ) : null}
                  <p className="mt-1 font-mono text-xs text-muted">/{group.slug}</p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setFormError(null);
                      setGroupForm({
                        id: group.id,
                        slug: group.slug,
                        groupNumber: group.groupNumber,
                        name: group.name,
                        category: group.category,
                        summary: group.summary ?? "",
                        icon: group.icon,
                        listed: true,
                        sortOrder: 0,
                      });
                    }}
                    leadingIcon={<Pencil className="size-4" aria-hidden="true" />}
                  >
                    Edit group
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      setFormError(null);
                      setProductForm({
                        packetGroupId: group.id,
                        sku: "",
                        name: "",
                        tier: "essential",
                        priceDollars: "",
                        customPricing: false,
                        deliveryEstimate: "5-7 business days",
                        outcome: "",
                        description: "",
                        listed: true,
                        active: true,
                        sortOrder: group.products.length,
                      });
                    }}
                    leadingIcon={<Plus className="size-4" aria-hidden="true" />}
                  >
                    Add product
                  </Button>
                </div>
              </div>

              {group.products.length === 0 ? (
                <p className="px-5 py-4 text-sm text-body">
                  No products in this group yet.
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {group.products.map((product) => (
                    <li
                      key={product.id}
                      className="flex flex-wrap items-start justify-between gap-3 px-5 py-4"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={TIER_TONES[product.tier] ?? "neutral"}>{product.tier}</Badge>
                          <span className="font-mono text-xs text-muted">{product.sku}</span>
                          {product.listed ? null : <Badge tone="warning">unlisted</Badge>}
                        </div>
                        <p className="mt-1.5 flex items-center gap-2 font-medium text-ink">
                          <Package className="size-4 shrink-0 text-muted" aria-hidden="true" />
                          {product.name}
                        </p>
                        {product.outcome ? (
                          <p className="mt-1 max-w-2xl text-sm text-body">{product.outcome}</p>
                        ) : null}
                        <p className="mt-1 text-xs text-muted">
                          Delivery: {product.deliveryEstimate} · {product.features.length} feature
                          {product.features.length === 1 ? "" : "s"}
                        </p>
                      </div>

                      <div className="flex shrink-0 flex-col items-end gap-2">
                        <p className="text-lg font-semibold tabular-nums text-ink">
                          {product.customPricing
                            ? "Custom"
                            : formatMoney(product.priceCents ?? 0)}
                        </p>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setFormError(null);
                              setProductForm({
                                id: product.id,
                                packetGroupId: group.id,
                                sku: product.sku,
                                name: product.name,
                                tier: product.tier,
                                priceDollars:
                                  product.priceCents === null
                                    ? ""
                                    : String(product.priceCents / 100),
                                customPricing: product.customPricing,
                                deliveryEstimate: product.deliveryEstimate,
                                outcome: product.outcome ?? "",
                                description: product.description ?? "",
                                listed: product.listed,
                                active: true,
                                sortOrder: 0,
                              });
                            }}
                            leadingIcon={<Pencil className="size-4" aria-hidden="true" />}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            busy={setActive.isPending}
                            onClick={() =>
                              setActive.mutate({ productId: product.id, active: false })
                            }
                            leadingIcon={<PowerOff className="size-4" aria-hidden="true" />}
                          >
                            Withdraw
                          </Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Group editor */}
      <Modal
        open={groupForm !== null}
        onClose={() => setGroupForm(null)}
        title={groupForm?.id ? "Edit packet group" : "New packet group"}
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setGroupForm(null)}>
              Cancel
            </Button>
            <Button
              busy={upsertGroup.isPending}
              onClick={() => {
                if (!groupForm) return;
                setFormError(null);
                upsertGroup.mutate({
                  id: groupForm.id,
                  slug: groupForm.slug.trim(),
                  groupNumber: groupForm.groupNumber,
                  name: groupForm.name.trim(),
                  category: groupForm.category.trim(),
                  summary: groupForm.summary.trim() || undefined,
                  icon: groupForm.icon.trim() || "Layers",
                  listed: groupForm.listed,
                  sortOrder: groupForm.sortOrder,
                });
              }}
            >
              Save group
            </Button>
          </>
        }
      >
        {formError ? <Alert tone="danger">{formError}</Alert> : null}
        {groupForm ? (
          <div className="mt-4 space-y-4">
            <Input
              label="Name"
              value={groupForm.name}
              onChange={(event) => setGroupForm({ ...groupForm, name: event.target.value })}
              required
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Slug"
                help="Lower-case letters, numbers, and hyphens only."
                value={groupForm.slug}
                onChange={(event) => setGroupForm({ ...groupForm, slug: event.target.value })}
                required
              />
              <Input
                label="Category"
                value={groupForm.category}
                onChange={(event) => setGroupForm({ ...groupForm, category: event.target.value })}
                required
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Input
                label="Packet number"
                type="number"
                min={1}
                max={99}
                value={String(groupForm.groupNumber)}
                onChange={(event) =>
                  setGroupForm({ ...groupForm, groupNumber: Number(event.target.value) })
                }
              />
              <Input
                label="Sort order"
                type="number"
                min={0}
                max={999}
                value={String(groupForm.sortOrder)}
                onChange={(event) =>
                  setGroupForm({ ...groupForm, sortOrder: Number(event.target.value) })
                }
              />
              <Input
                label="Icon"
                help="Lucide icon name"
                value={groupForm.icon}
                onChange={(event) => setGroupForm({ ...groupForm, icon: event.target.value })}
              />
            </div>
            <Textarea
              label="Summary"
              rows={3}
              maxLength={2000}
              value={groupForm.summary}
              onChange={(event) => setGroupForm({ ...groupForm, summary: event.target.value })}
            />
            <Checkbox
              label="Listed publicly on the website"
              checked={groupForm.listed}
              onChange={(event) => setGroupForm({ ...groupForm, listed: event.target.checked })}
            />
          </div>
        ) : null}
      </Modal>

      {/* Product editor */}
      <Modal
        open={productForm !== null}
        onClose={() => setProductForm(null)}
        title={productForm?.id ? "Edit product" : "New product"}
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setProductForm(null)}>
              Cancel
            </Button>
            <Button
              busy={upsertProduct.isPending}
              onClick={() => {
                if (!productForm) return;
                setFormError(null);
                upsertProduct.mutate({
                  id: productForm.id,
                  packetGroupId: productForm.packetGroupId,
                  sku: productForm.sku.trim(),
                  name: productForm.name.trim(),
                  tier: productForm.tier as never,
                  priceDollars: productForm.customPricing
                    ? null
                    : Number(productForm.priceDollars || 0),
                  customPricing: productForm.customPricing,
                  deliveryEstimate: productForm.deliveryEstimate.trim(),
                  outcome: productForm.outcome.trim() || undefined,
                  description: productForm.description.trim() || undefined,
                  listed: productForm.listed,
                  active: productForm.active,
                  sortOrder: productForm.sortOrder,
                });
              }}
            >
              Save product
            </Button>
          </>
        }
      >
        {formError ? <Alert tone="danger">{formError}</Alert> : null}
        {productForm ? (
          <div className="mt-4 space-y-4">
            <Input
              label="Name"
              value={productForm.name}
              onChange={(event) => setProductForm({ ...productForm, name: event.target.value })}
              required
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="SKU"
                help="Letters, numbers, dots, hyphens, and underscores."
                value={productForm.sku}
                onChange={(event) => setProductForm({ ...productForm, sku: event.target.value })}
                required
              />
              <Select
                label="Tier"
                value={productForm.tier}
                onChange={(event) => setProductForm({ ...productForm, tier: event.target.value })}
                options={TIERS.map((tier) => ({ value: tier, label: tier }))}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Price (USD)"
                type="number"
                min={0}
                step={1}
                disabled={productForm.customPricing}
                value={productForm.priceDollars}
                onChange={(event) =>
                  setProductForm({ ...productForm, priceDollars: event.target.value })
                }
                help="Whole dollars; stored as integer cents."
              />
              <Input
                label="Delivery estimate"
                value={productForm.deliveryEstimate}
                onChange={(event) =>
                  setProductForm({ ...productForm, deliveryEstimate: event.target.value })
                }
                required
              />
            </div>
            <Checkbox
              label="Custom pricing — quoted individually rather than listed"
              checked={productForm.customPricing}
              onChange={(event) =>
                setProductForm({ ...productForm, customPricing: event.target.checked })
              }
            />
            <Textarea
              label="Outcome"
              help="The single sentence describing what the client receives."
              rows={2}
              maxLength={4000}
              value={productForm.outcome}
              onChange={(event) => setProductForm({ ...productForm, outcome: event.target.value })}
            />
            <Textarea
              label="Description"
              rows={4}
              maxLength={8000}
              value={productForm.description}
              onChange={(event) =>
                setProductForm({ ...productForm, description: event.target.value })
              }
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Checkbox
                label="Listed publicly"
                checked={productForm.listed}
                onChange={(event) =>
                  setProductForm({ ...productForm, listed: event.target.checked })
                }
              />
              <Checkbox
                label="Available for purchase"
                checked={productForm.active}
                onChange={(event) =>
                  setProductForm({ ...productForm, active: event.target.checked })
                }
              />
            </div>
            <Alert tone="info">
              Features are inherited by tier and edited through the seed data or a direct migration;
              this keeps the tier ladder consistent across every packet.
            </Alert>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
