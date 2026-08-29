/**
 * Packet catalogue and packet detail.
 *
 * Prices are rendered from the integer cents the server returns; the client
 * performs no pricing arithmetic, so what a visitor sees always matches what the
 * order will be recorded as.
 */
import { Link, useParams } from "wouter";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  Clock,
  FileText,
  Handshake,
  LineChart,
  Rocket,
  Settings2,
  ShieldCheck,
  Vault,
  type LucideIcon,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { formatMoney } from "@/lib/utils";
import { LinkButton } from "@/components/ui/Button";
import { Badge, Card, EmptyState, SectionHeading, Skeleton } from "@/components/ui/Surface";
import { PageSection } from "@/components/layout/PublicLayout";

const GROUP_ICONS: Record<string, LucideIcon> = {
  ShieldCheck,
  Building2,
  FileText,
  Settings2,
  Handshake,
  Rocket,
  Vault,
  LineChart,
};

const TIER_LABELS: Record<string, string> = {
  basic: "Basic",
  standard: "Standard",
  premium: "Premium",
  custom: "Custom",
};

export function PacketsPage() {
  const catalog = trpc.public.catalog.useQuery();
  const presentation = trpc.public.catalogPresentation.useQuery();
  const pricingMode = presentation.data?.pricingMode ?? "show";
  const publicDeliveryEstimatesVisible = presentation.data?.publicDeliveryEstimatesVisible ?? true;
  const groups = catalog.data ?? [];
  const tiered = groups.filter((group) => group.groupNumber <= 6);
  const bundle = groups.find((group) => group.groupNumber === 7);

  return (
    <>
      <div className="border-b border-line bg-surface-soft py-14">
        <PageSection>
          <SectionHeading
            eyebrow="Catalogue"
            title="Choose the packets your business needs"
            description="Every packet group is offered at three tiers. Higher tiers include everything in the tier below, so you can start small and extend later without duplicating work."
          />
        </PageSection>
      </div>

      <PageSection className="py-14">
        {catalog.isLoading ? (
          <div className="space-y-10">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-80 w-full rounded-[var(--radius-card)]" />
            ))}
          </div>
        ) : (
          <div className="space-y-16">
            {tiered.map((group) => {
              const Icon = GROUP_ICONS[group.icon] ?? FileText;
              return (
                <section key={group.id} id={group.slug} aria-labelledby={`${group.slug}-heading`}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex items-start gap-4">
                      <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-teal/10 text-teal-dark">
                        <Icon className="size-5" aria-hidden="true" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-teal-dark">
                          Packet {group.groupNumber} · {group.category}
                        </p>
                        <h2
                          id={`${group.slug}-heading`}
                          className="mt-1 text-2xl font-semibold text-ink"
                        >
                          {group.name}
                        </h2>
                        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-body">
                          {group.summary}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="mt-7 grid gap-5 lg:grid-cols-3">
                    {group.products.map((product) => (
                      <Card
                        key={product.id}
                        className={
                          product.tier === "standard"
                            ? "flex flex-col border-teal/40 ring-1 ring-teal/20"
                            : "flex flex-col"
                        }
                      >
                        <div className="flex items-center justify-between gap-2">
                          <Badge tone={product.tier === "premium" ? "gold" : product.tier === "standard" ? "teal" : "neutral"}>
                            {TIER_LABELS[product.tier] ?? product.tier}
                          </Badge>
                          {product.tier === "standard" ? (
                            <span className="text-xs font-semibold uppercase tracking-wide text-teal-dark">
                              Most chosen
                            </span>
                          ) : null}
                        </div>

                        {pricingMode !== "hidden" ? (
                          <p className="mt-4 text-3xl font-semibold tabular-nums text-ink">
                            {pricingMode === "show" ? formatMoney(product.priceCents) : "Pricing on request"}
                          </p>
                        ) : null}
                        {publicDeliveryEstimatesVisible ? (
                          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
                            <Clock className="size-3.5" aria-hidden="true" />
                            {product.deliveryEstimate}
                          </p>
                        ) : null}

                        <p className="mt-4 text-sm leading-relaxed text-body">
                          {product.description}
                        </p>

                        <ul className="mt-5 flex-1 space-y-2">
                          {product.features.map((feature, index) => (
                            <li
                              key={`${product.id}-${index}`}
                              className="flex items-start gap-2 text-sm text-body"
                            >
                              {feature.inheritedFromTier ? (
                                <span className="mt-0.5 shrink-0 text-xs font-semibold uppercase tracking-wide text-teal-dark">
                                  ↳
                                </span>
                              ) : (
                                <Check
                                  className="mt-0.5 size-4 shrink-0 text-teal"
                                  aria-hidden="true"
                                />
                              )}
                              <span
                                className={
                                  feature.inheritedFromTier ? "font-medium text-ink" : undefined
                                }
                              >
                                {feature.label}
                              </span>
                            </li>
                          ))}
                        </ul>

                        <LinkButton
                          href={`/register?product=${encodeURIComponent(product.sku)}`}
                          variant={product.tier === "standard" ? "primary" : "outline"}
                          fullWidth
                          className="mt-6"
                        >
                          Start this packet
                        </LinkButton>
                      </Card>
                    ))}
                  </div>

                  <div className="mt-4">
                    <Link
                      href={`/packets/${group.slug}`}
                      className="inline-flex items-center gap-1 text-sm font-semibold text-teal-dark no-underline hover:text-teal"
                    >
                      Full detail for {group.name}
                      <ArrowRight className="size-4" aria-hidden="true" />
                    </Link>
                  </div>
                </section>
              );
            })}

            {bundle ? (
              <section id="bundle" aria-labelledby="bundle-heading">
                <Card className="border-gold/40 bg-gradient-to-br from-navy to-navy-elevated text-white">
                  <Badge tone="gold">Packet 7 — Master bundle</Badge>
                  <h2 id="bundle-heading" className="mt-3 text-2xl font-semibold text-white">
                    {bundle.name}
                  </h2>
                  <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/75">
                    {bundle.summary}
                  </p>

                  <div className="mt-6 grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
                    <div>
                      {bundle.products.map((product) => (
                        <div key={product.id}>
                          <p className="text-sm leading-relaxed text-white/80">
                            {product.description}
                          </p>
                          <ul className="mt-4 space-y-2.5">
                            {product.features.map((feature, index) => (
                              <li key={index} className="flex items-start gap-2 text-sm text-white/80">
                                <Check
                                  className="mt-0.5 size-4 shrink-0 text-gold"
                                  aria-hidden="true"
                                />
                                <span>{feature.label}</span>
                              </li>
                            ))}
                          </ul>
                          {publicDeliveryEstimatesVisible ? (
                            <p className="mt-4 flex items-center gap-1.5 text-xs text-white/60">
                              <Clock className="size-3.5" aria-hidden="true" />
                              {product.deliveryEstimate}
                            </p>
                          ) : null}
                        </div>
                      ))}
                    </div>

                    <div className="rounded-lg border border-gold/30 bg-white/[0.06] p-5">
                      <p className="text-xs font-semibold uppercase tracking-wide text-gold">
                        How bundle pricing works
                      </p>
                      <ol className="mt-3 space-y-2.5 text-sm text-white/75">
                        <li>1. Choose a tier for each of the six packet groups.</li>
                        <li>2. Commit to all six and a 15% reduction is applied to the total.</li>
                        {publicDeliveryEstimatesVisible ? <li>3. The programme runs across 30 to 45 business days.</li> : null}
                      </ol>
                      <LinkButton href="/register?bundle=1" variant="gold" fullWidth className="mt-5">
                        Configure your bundle
                      </LinkButton>
                      <p className="mt-3 text-center text-xs text-white/50">
                        Sign in to see your live quote before committing.
                      </p>
                    </div>
                  </div>
                </Card>
              </section>
            ) : null}
          </div>
        )}
      </PageSection>
    </>
  );
}

export function PacketDetailPage() {
  const params = useParams<{ slug: string }>();
  const catalog = trpc.public.catalog.useQuery();
  const presentation = trpc.public.catalogPresentation.useQuery();
  const pricingMode = presentation.data?.pricingMode ?? "show";
  const publicDeliveryEstimatesVisible = presentation.data?.publicDeliveryEstimatesVisible ?? true;
  const group = (catalog.data ?? []).find((item) => item.slug === params.slug);

  if (catalog.isLoading) {
    return (
      <PageSection className="py-14">
        <Skeleton className="h-96 w-full rounded-[var(--radius-card)]" />
      </PageSection>
    );
  }

  if (!group) {
    return (
      <PageSection className="py-20">
        <EmptyState
          icon={FileText}
          title="That packet group could not be found"
          description="It may have been renamed or withdrawn from the catalogue."
          action={
            <LinkButton href="/packets" variant="outline">
              Back to the catalogue
            </LinkButton>
          }
        />
      </PageSection>
    );
  }

  const Icon = GROUP_ICONS[group.icon] ?? FileText;

  return (
    <>
      <div className="border-b border-line bg-surface-soft py-12">
        <PageSection>
          <Link
            href="/packets"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-teal-dark no-underline hover:text-teal"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            All packets
          </Link>
          <div className="mt-5 flex items-start gap-4">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-white text-teal-dark shadow-sm">
              <Icon className="size-6" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-teal-dark">
                Packet {group.groupNumber} · {group.category}
              </p>
              <h1 className="mt-1.5 text-3xl font-semibold text-ink">{group.name}</h1>
              <p className="mt-3 max-w-3xl text-base leading-relaxed text-body">{group.summary}</p>
            </div>
          </div>
        </PageSection>
      </div>

      <PageSection className="py-14">
        <div className="space-y-6">
          {group.products.map((product) => (
            <Card key={product.id}>
              <div className="grid gap-6 lg:grid-cols-[0.85fr_1.15fr]">
                <div>
                  <Badge tone={product.tier === "premium" ? "gold" : product.tier === "standard" ? "teal" : "neutral"}>
                    {TIER_LABELS[product.tier] ?? product.tier}
                  </Badge>
                  {pricingMode !== "hidden" ? (
                    <p className="mt-4 text-3xl font-semibold tabular-nums text-ink">
                      {pricingMode === "show" ? formatMoney(product.priceCents) : "Pricing on request"}
                    </p>
                  ) : null}
                  {publicDeliveryEstimatesVisible ? (
                    <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
                      <Clock className="size-3.5" aria-hidden="true" />
                      {product.deliveryEstimate}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-muted">SKU {product.sku}</p>
                  <p className="mt-4 text-sm leading-relaxed text-body">{product.description}</p>
                  <LinkButton
                    href={`/register?product=${encodeURIComponent(product.sku)}`}
                    fullWidth
                    className="mt-5"
                    variant={product.tier === "standard" ? "primary" : "outline"}
                  >
                    Start this packet
                  </LinkButton>
                </div>

                <div className="lg:border-l lg:border-line lg:pl-6">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
                    What is included
                  </h2>
                  <ul className="mt-4 grid gap-2.5 sm:grid-cols-2">
                    {product.features.map((feature, index) => (
                      <li key={index} className="flex items-start gap-2 text-sm text-body">
                        {feature.inheritedFromTier ? (
                          <span className="mt-0.5 shrink-0 text-teal-dark" aria-hidden="true">
                            ↳
                          </span>
                        ) : (
                          <Check className="mt-0.5 size-4 shrink-0 text-teal" aria-hidden="true" />
                        )}
                        <span
                          className={feature.inheritedFromTier ? "font-medium text-ink" : undefined}
                        >
                          {feature.label}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </Card>
          ))}
        </div>

        <Card className="mt-10 border-teal/25">
          <div className="flex flex-wrap items-center justify-between gap-5">
            <div className="min-w-0 max-w-xl">
              <h2 className="text-lg font-semibold text-ink">Need more than one packet group?</h2>
              <p className="mt-1.5 text-sm text-body">
                Commit to all six groups and a 15% reduction applies across the engagement, with a
                single 30 to 45 business day programme.
              </p>
            </div>
            <LinkButton href="/packets#bundle" variant="outline">
              See the All-In bundle
            </LinkButton>
          </div>
        </Card>
      </PageSection>
    </>
  );
}
