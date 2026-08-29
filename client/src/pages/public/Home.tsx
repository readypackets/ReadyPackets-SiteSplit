/**
 * Public homepage.
 *
 * Content blocks come from the database so an administrator can edit the copy
 * without a redeploy, with sensible fallbacks if a block has been disabled.
 */
import { Link } from "wouter";
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  FileText,
  Handshake,
  LineChart,
  Rocket,
  Settings2,
  ShieldCheck,
  Star,
  Vault,
  type LucideIcon,
} from "lucide-react";
import { BRAND } from "@shared/brand";
import { trpc } from "@/lib/trpc";
import { formatMoney } from "@/lib/utils";
import { Markdown } from "@/lib/markdown";
import { LinkButton } from "@/components/ui/Button";
import { Badge, Card, SectionHeading, Skeleton } from "@/components/ui/Surface";
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

export function HomePage() {
  const content = trpc.public.homeContent.useQuery();
  const catalog = trpc.public.catalog.useQuery();
  const presentation = trpc.public.catalogPresentation.useQuery();
  const reviews = trpc.public.reviews.useQuery({ limit: 3 });

  const blocks = content.data ?? [];
  const block = (key: string) => blocks.find((item) => item.blockKey === key);

  const hero = block("hero");
  const values = blocks.filter((item) => item.blockType === "value_prop");
  const process = block("process");
  const integrity = block("integrity");
  const cta = block("cta_footer");

  const groups = (catalog.data ?? []).filter((group) => group.groupNumber <= 6);
  const bundle = (catalog.data ?? []).find((group) => group.groupNumber === 7);

  // Reducing with an infinite seed returns Infinity for an empty list, which on
  // the first paint -- before the catalogue query resolves -- rendered a dash in
  // the hero while the cards below already showed the correct entry price. The
  // loading state is therefore distinguished from a genuinely priceless catalogue
  // rather than collapsing both into the same fallback.
  const listedPrices = groups
    .flatMap((group) => group.products.map((product) => product.priceCents))
    .filter((price): price is number => typeof price === "number");
  const entryPrice = listedPrices.length > 0 ? Math.min(...listedPrices) : null;
  const pricingMode = presentation.data?.pricingMode ?? "show";
  const publicDeliveryEstimatesVisible = presentation.data?.publicDeliveryEstimatesVisible ?? true;

  return (
    <>
      {/* Hero */}
      <div className="relative overflow-hidden bg-navy text-white">
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background:
              "radial-gradient(60rem 30rem at 15% -10%, rgba(32,160,144,0.28), transparent 60%), radial-gradient(45rem 25rem at 95% 10%, rgba(201,168,76,0.16), transparent 65%)",
          }}
          aria-hidden="true"
        />
        <PageSection className="relative py-16 sm:py-20 lg:py-28">
          <div className="grid items-center gap-12 lg:grid-cols-[1.15fr_0.85fr]">
            <div>
              <Badge tone="teal" className="bg-white/10 text-teal-light">
                {BRAND.tagline}
              </Badge>
              <h1 className="mt-5 text-balance text-3xl font-bold leading-[1.15] sm:text-4xl lg:text-5xl">
                {hero?.heading ?? "Your business, professionally packeted."}
              </h1>
              <p className="mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-white/80">
                {hero?.subheading ??
                  "Structured architecture, documentation, and strategy for founders who need their idea to hold up under scrutiny."}
              </p>
              {hero?.body ? (
                <p className="mt-4 max-w-2xl text-base leading-relaxed text-white/65">
                  {hero.body}
                </p>
              ) : null}

              <div className="mt-8 flex flex-wrap gap-3">
                <LinkButton
                  href={hero?.linkHref ?? "/packets"}
                  size="lg"
                  trailingIcon={<ArrowRight className="size-4" aria-hidden="true" />}
                >
                  {hero?.linkLabel ?? "Explore the packets"}
                </LinkButton>
                <LinkButton
                  href="/how-it-works"
                  size="lg"
                  variant="outline"
                  className="border-white/25 bg-transparent text-white hover:border-teal-light hover:text-teal-light"
                >
                  How it works
                </LinkButton>
              </div>

              <dl className={`mt-10 grid max-w-lg grid-cols-2 gap-6 border-t border-white/12 pt-6 ${pricingMode === "hidden" ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-white/50">Packet groups</dt>
                  {/* Derived, not hardcoded: an administrator who lists an eighth
                      group in Admin -> Catalogue should not have to edit code for
                      the homepage to agree with the catalogue below it. */}
                  <dd className="mt-1 text-2xl font-semibold tabular-nums">
                    {catalog.isLoading ? (
                      <span
                        className="inline-block h-7 w-10 animate-pulse rounded bg-white/15"
                        aria-label="Loading packet group count"
                      />
                    ) : (
                      (catalog.data ?? []).length
                    )}
                  </dd>
                </div>
                {pricingMode !== "hidden" ? (
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-white/50">{pricingMode === "show" ? "From" : "Pricing"}</dt>
                    <dd className="mt-1 text-2xl font-semibold tabular-nums">
                      {catalog.isLoading || presentation.isLoading ? (
                        <span
                          className="inline-block h-7 w-24 animate-pulse rounded bg-white/15"
                          aria-label="Loading pricing preference"
                        />
                      ) : pricingMode === "on_request" ? (
                        "On request"
                      ) : entryPrice === null ? (
                        "—"
                      ) : (
                        formatMoney(entryPrice)
                      )}
                    </dd>
                  </div>
                ) : null}
                {publicDeliveryEstimatesVisible ? (
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-white/50">Fastest delivery</dt>
                    <dd className="mt-1 text-2xl font-semibold">48h</dd>
                  </div>
                ) : null}
              </dl>
            </div>

            <Card className="border-white/12 bg-white/[0.06] backdrop-blur-sm">
              <h2 className="text-base font-semibold text-white">What you receive</h2>
              <ul className="mt-4 space-y-3">
                {[
                  "A structured intake that forces the hard questions early",
                  "A focused Logic Synthesis call with the lead architect",
                  "Documents written to survive review by counsel and investors",
                  "Versioned deliverables in a portal you control",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2.5 text-sm text-white/80">
                    <CheckCircle2
                      className="mt-0.5 size-4 shrink-0 text-teal-light"
                      aria-hidden="true"
                    />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-5 rounded-lg border border-gold/30 bg-gold/10 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gold">
                  Confidential by default
                </p>
                <p className="mt-1 text-sm text-white/75">
                  A mutual NDA is signed before we see your concept, and your material is never
                  used to train external systems.
                </p>
              </div>
            </Card>
          </div>
        </PageSection>
      </div>

      {/* Value propositions */}
      {values.length > 0 ? (
        <PageSection className="py-16 sm:py-20">
          <div className="grid gap-6 md:grid-cols-3">
            {values.map((value) => (
              <Card key={value.blockKey}>
                <h2 className="text-lg font-semibold text-ink">{value.heading}</h2>
                <p className="mt-2.5 text-sm leading-relaxed text-body">{value.body}</p>
              </Card>
            ))}
          </div>
        </PageSection>
      ) : null}

      {/* Packet groups */}
      <div className="bg-surface-soft py-16 sm:py-20">
        <PageSection>
          <SectionHeading
            eyebrow="The catalogue"
            title="Seven packet groups, three tiers each"
            description="Buy a single packet, or commit to the full six-group programme and receive a 15% reduction across the engagement."
            align="center"
          />

          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {catalog.isLoading
              ? Array.from({ length: 6 }, (_, index) => (
                  <Skeleton key={index} className="h-64 w-full rounded-[var(--radius-card)]" />
                ))
              : groups.map((group) => {
                  const Icon = GROUP_ICONS[group.icon] ?? FileText;
                  const cheapest = group.products
                    .map((product) => product.priceCents)
                    .filter((price): price is number => typeof price === "number")
                    .sort((left, right) => left - right)[0];

                  return (
                    <Card key={group.id} className="flex flex-col">
                      <div className="flex items-start justify-between gap-3">
                        <span className="flex size-10 items-center justify-center rounded-lg bg-teal/10 text-teal-dark">
                          <Icon className="size-5" aria-hidden="true" />
                        </span>
                        <Badge tone="neutral">Packet {group.groupNumber}</Badge>
                      </div>
                      <h3 className="mt-4 text-lg font-semibold text-ink">{group.name}</h3>
                      <p className="mt-1 text-xs font-medium uppercase tracking-wide text-teal-dark">
                        {group.category}
                      </p>
                      <p className="mt-3 flex-1 text-sm leading-relaxed text-body">
                        {group.summary}
                      </p>
                      <div className={`mt-5 flex items-end gap-3 border-t border-line pt-4 ${pricingMode === "hidden" ? "justify-end" : "justify-between"}`}>
                        {pricingMode !== "hidden" ? (
                          <div>
                            <p className="text-xs text-muted">{pricingMode === "show" ? "From" : "Pricing"}</p>
                            <p className="text-xl font-semibold tabular-nums text-ink">
                              {pricingMode === "show" ? formatMoney(cheapest ?? null) : "On request"}
                            </p>
                          </div>
                        ) : null}
                        <Link
                          href={`/packets/${group.slug}`}
                          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-teal/35 bg-teal/5 px-3 text-sm font-semibold text-teal-dark no-underline transition-colors hover:border-teal hover:bg-teal hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2"
                        >
                          View tiers
                          <ArrowRight className="size-4" aria-hidden="true" />
                        </Link>
                      </div>
                    </Card>
                  );
                })}
          </div>

          {bundle ? (
            <Card className="mt-6 border-gold/40 bg-gradient-to-br from-navy to-navy-elevated text-white">
              <div className="flex flex-wrap items-start justify-between gap-6">
                <div className="min-w-0 max-w-2xl">
                  <Badge tone="gold">Packet 7 — Master bundle</Badge>
                  <h3 className="mt-3 text-xl font-semibold text-white">{bundle.name}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-white/75">{bundle.summary}</p>
                  <p className="mt-3 text-sm text-white/60">
                    Mix and match tiers across all six packet groups. A full commitment earns a 15%
                    reduction{publicDeliveryEstimatesVisible ? ", with a 30 to 45 business day programme timeline." : "."}
                  </p>
                </div>
                <LinkButton href="/packets/the-all-in-master-bundle" variant="gold" size="lg">
                  Configure the bundle
                </LinkButton>
              </div>
            </Card>
          ) : null}
        </PageSection>
      </div>

      {/* Process */}
      {process ? (
        <PageSection className="py-16 sm:py-20">
          <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr]">
            <SectionHeading
              eyebrow="Process"
              title={process.heading ?? "How an engagement runs"}
              description={process.subheading ?? undefined}
            />
            <div>
              <Markdown source={process.body ?? ""} className="prose-rp" />
            </div>
          </div>
        </PageSection>
      ) : null}

      {/* Integrity clause */}
      {integrity ? (
        <div className="border-y border-line bg-navy py-14 text-white">
          <PageSection>
            <div className="mx-auto max-w-3xl text-center">
              <Badge tone="gold">Our commitment</Badge>
              <h2 className="mt-4 text-2xl font-semibold text-white sm:text-3xl">
                {integrity.heading}
              </h2>
              <p className="mt-4 text-pretty leading-relaxed text-white/75">{integrity.body}</p>
              {integrity.linkHref ? (
                <LinkButton
                  href={integrity.linkHref}
                  variant="outline"
                  className="mt-6 border-white/25 bg-transparent text-white hover:border-gold hover:text-gold"
                >
                  {integrity.linkLabel ?? "Read more"}
                </LinkButton>
              ) : null}
            </div>
          </PageSection>
        </div>
      ) : null}

      {/* Reviews */}
      {reviews.data?.enabled && reviews.data.items.length > 0 ? (
        <PageSection className="py-16 sm:py-20">
          <SectionHeading
            eyebrow="Client reviews"
            title="What founders say"
            align="center"
            description={
              reviews.data.average
                ? `Averaging ${reviews.data.average.toFixed(1)} out of 5 across published reviews.`
                : undefined
            }
          />
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {reviews.data.items.slice(0, 3).map((review) => (
              <Card key={review.id} className="flex flex-col">
                <div className="flex items-center gap-0.5" aria-label={`${review.rating} out of 5`}>
                  {Array.from({ length: 5 }, (_, index) => (
                    <Star
                      key={index}
                      className={
                        index < review.rating
                          ? "size-4 fill-gold text-gold"
                          : "size-4 text-line"
                      }
                      aria-hidden="true"
                    />
                  ))}
                </div>
                {review.title ? (
                  <h3 className="mt-3 text-base font-semibold text-ink">{review.title}</h3>
                ) : null}
                <p className="mt-2 flex-1 text-sm leading-relaxed text-body">{review.body}</p>
                <p className="mt-4 border-t border-line pt-3 text-xs font-medium text-muted">
                  {review.author}
                </p>
              </Card>
            ))}
          </div>
          {presentation.data?.publicReviewsNavigationVisible !== false ? (
            <div className="mt-8 text-center">
              <LinkButton href="/reviews" variant="outline">
                Read all reviews
              </LinkButton>
            </div>
          ) : null}
        </PageSection>
      ) : null}

      {/* Closing call to action */}
      {cta ? (
        <div className="bg-surface-soft py-16">
          <PageSection>
            <Card className="flex flex-wrap items-center justify-between gap-6 border-teal/25 bg-white">
              <div className="min-w-0 max-w-xl">
                <h2 className="text-xl font-semibold text-ink sm:text-2xl">{cta.heading}</h2>
                <p className="mt-2 text-sm leading-relaxed text-body">{cta.subheading}</p>
              </div>
              <LinkButton
                href={cta.linkHref ?? "/register"}
                size="lg"
                trailingIcon={<ArrowRight className="size-4" aria-hidden="true" />}
              >
                {cta.linkLabel ?? "Get started"}
              </LinkButton>
            </Card>
          </PageSection>
        </div>
      ) : null}
    </>
  );
}
