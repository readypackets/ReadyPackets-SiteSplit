/**
 * Public site chrome: skip link, header, maintenance banner, content, footer.
 *
 * The skip link is the first focusable element on every page, which is a WCAG
 * 2.4.1 requirement for keyboard users who would otherwise tab through the whole
 * navigation on each page.
 */
import type { ReactNode } from "react";
import { Link } from "wouter";
import { Mail, MapPin } from "lucide-react";
import { BRAND, BRAND_ASSETS } from "@shared/brand";
import { useSession } from "@/lib/session";
import { trpc } from "@/lib/trpc";
import { Alert } from "@/components/ui/Surface";
import { useCookieConsent } from "@/components/privacy/CookieConsent";
import { PublicHeader } from "./PublicHeader";

const FOOTER_SECTIONS = [
  {
    title: "Packets",
    links: [
      { href: "/packets", label: "All packet groups" },
      { href: "/packets#bundle", label: "The All-In bundle" },
      { href: "/how-it-works", label: "How it works" },
      { href: "/changelog", label: "Changelog" },
    ],
  },
  {
    title: "Company",
    links: [
      { href: "/about", label: "About" },
      { href: "/reviews", label: "Client reviews" },
      { href: "/community", label: "Community" },
      { href: "/faq", label: "Frequently asked questions" },
      { href: "/contact", label: "Contact" },
    ],
  },
  {
    title: "Legal",
    links: [
      { href: "/privacy", label: "Privacy policy" },
      { href: "/terms", label: "Terms of service" },
      { href: "/refunds", label: "Refund policy" },
      { href: "/disclaimer", label: "Liability disclaimer" },
      { href: "/accessibility", label: "Accessibility" },
    ],
  },
] as const;

export function PublicLayout({ children }: { children: ReactNode }) {
  const { maintenance, businessProfile } = useSession();
  const publicStatus = trpc.public.siteStatus.useQuery();
  const { openPreferences } = useCookieConsent();
  const showBanner = maintenance?.enabled && maintenance.showOnHomepage;
  const businessAddress = businessProfile
    ? [businessProfile.addressLine1, businessProfile.addressLine2, `${businessProfile.city}, ${businessProfile.state} ${businessProfile.postalCode}`].filter(Boolean).join(", ")
    : BRAND.address;
  const navigation = publicStatus.data?.navigation;
  const footerSections = FOOTER_SECTIONS.map((section) => ({
    ...section,
    links: section.links.filter((link) => {
      if (link.href === "/reviews") return navigation?.reviewsVisible !== false;
      if (link.href === "/community") return navigation?.communityVisible !== false;
      return true;
    }),
  }));

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      <PublicHeader />

      {showBanner ? (
        <div className="border-b border-warning/30 bg-warning/8 px-4 py-3">
          <div className="mx-auto max-w-7xl">
            <Alert tone="warning" title="Scheduled maintenance" className="border-0 bg-transparent p-0">
              <p>{maintenance.message}</p>
              {maintenance.estimatedCompletion ? (
                <p className="mt-1 text-xs">
                  Estimated completion: {maintenance.estimatedCompletion}
                </p>
              ) : null}
            </Alert>
          </div>
        </div>
      ) : null}

      <main id="main-content" className="flex-1">
        {children}
      </main>

      <footer className="mt-16 border-t border-line bg-navy text-white/80">
        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
          <div className="grid gap-10 lg:grid-cols-[1.4fr_repeat(3,1fr)]">
            <div>
              <img
                src={BRAND_ASSETS.dark.webStandard}
                alt={`${BRAND.wordmark} logo`}
                width={180}
                height={43}
                className="h-9 w-auto"
                loading="lazy"
                decoding="async"
              />
              <p className="mt-4 max-w-sm text-sm leading-relaxed text-white/70">
                {BRAND.tagline}. Structured architecture, documentation, and strategy for founders
                who need their idea to hold up under scrutiny.
              </p>
              <div className="mt-5 space-y-2 text-sm">
                <p className="flex items-start gap-2 text-white/70">
                  <MapPin className="mt-0.5 size-4 shrink-0 text-teal-light" aria-hidden="true" />
                  <span>{businessAddress}</span>
                </p>
                <p className="flex items-start gap-2">
                  <Mail className="mt-0.5 size-4 shrink-0 text-teal-light" aria-hidden="true" />
                  <a
                    href={`mailto:${BRAND.emails.general}`}
                    className="text-white/80 no-underline hover:text-white hover:underline"
                  >
                    {BRAND.emails.general}
                  </a>
                </p>
              </div>
            </div>

            {footerSections.map((section) => (
              <nav key={section.title} aria-label={section.title}>
                <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-teal-light">
                  {section.title}
                </h2>
                <ul className="mt-4 space-y-2.5">
                  {section.links.map((link) => (
                    <li key={`${section.title}-${link.href}-${link.label}`}>
                      <Link
                        href={link.href}
                        className="text-sm text-white/70 no-underline transition-colors hover:text-white hover:underline"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>

          <div className="mt-10 flex flex-col gap-3 border-t border-white/12 pt-6 text-xs text-white/55 sm:flex-row sm:items-center sm:justify-between">
            <p>{BRAND.copyright()}</p>
            <button type="button" onClick={openPreferences} className="w-fit text-left text-white/70 underline underline-offset-4 hover:text-white">Manage cookie preferences</button>
            <p>
              {BRAND.wordmark} and “{BRAND.taglinePlain}” are trademarks of{" "}
              {BRAND.companyLegalName}.
            </p>
          </div>

          <p className="mt-6 border-t border-white/12 pt-6 text-xs leading-relaxed text-white/45">
            ReadyPackets provides structured architectural, strategic, and documentation support.
            We do not provide legal, tax, securities, or medical advice, nor licensed engineering
            certification. All filings and regulated decisions must be reviewed by the appropriate
            licensed professionals. See our{" "}
            <Link href="/disclaimer" className="text-white/70 underline">
              liability disclaimer
            </Link>
            .
          </p>
        </div>
      </footer>
    </div>
  );
}

/** Standard page container. */
export function PageSection({
  children,
  className,
  width = "default",
}: {
  children: ReactNode;
  className?: string;
  width?: "default" | "narrow" | "wide";
}) {
  const widths = {
    narrow: "max-w-3xl",
    default: "max-w-7xl",
    wide: "max-w-screen-2xl",
  } as const;
  return (
    <section className={`mx-auto ${widths[width]} px-4 sm:px-6 lg:px-8 ${className ?? ""}`}>
      {children}
    </section>
  );
}
