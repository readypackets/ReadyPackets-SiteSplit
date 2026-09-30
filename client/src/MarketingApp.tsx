/**
 * Public-site router.
 *
 * This entrypoint deliberately imports only public pages and shared presentation
 * primitives. Customer, staff, order, file, and administrative code is omitted
 * from the marketing bundle and is served only by the portal host.
 */
import { useMemo } from "react";
import { Route, Switch, useLocation } from "wouter";
import { useSession } from "@/lib/session";
import { trpc } from "@/lib/trpc";
import { BRAND, BRAND_ASSETS } from "@shared/brand";
import { Seo } from "@/components/Seo";
import { PublicLayout } from "@/components/layout/PublicLayout";
import { HomePage } from "@/pages/public/Home";
import { PacketsPage, PacketDetailPage } from "@/pages/public/Packets";
import {
  AboutPage,
  ChangelogPage,
  CommunityTeaserPage,
  HowItWorksPage,
  MaintenancePage,
  NotFoundPage,
  PolicyPage,
  ReviewsPage,
} from "@/pages/public/Content";
import { ContactPage } from "@/pages/public/Contact";
import { FaqPage } from "@/pages/public/Faq";
import { AccessibilityPage } from "@/pages/public/Accessibility";

export function MarketingApp() {
  const session = useSession();
  const [location] = useLocation();
  const publicFaqs = trpc.faqs.visible.useQuery(undefined, { enabled: location === "/faq" });
  const seo = useMemo<{ title: string; description: string; structuredData?: unknown }>(() => {
    const pages: Record<string, { title: string; description: string }> = {
      "/": { title: "ReadyPackets — Your Business, Professionally Packeted", description: "ReadyPackets turns an idea into a defensible, documented business package: invention architecture, business foundation, operating design, and a launch system." },
      "/packets": { title: "Business packets | ReadyPackets", description: "Explore ReadyPackets business packet groups, selected tiers, and the All-In bundle for a structured business foundation." },
      "/how-it-works": { title: "How ReadyPackets works", description: "Understand the ReadyPackets process, from selecting a business packet to intake, collaboration, and completed materials." },
      "/about": { title: "About ReadyPackets", description: "Learn about ReadyPackets and its approach to creating clear, structured business documentation and operating foundations." },
      "/reviews": { title: "Client reviews | ReadyPackets", description: "Read client feedback about the ReadyPackets business documentation and strategy experience." },
      "/community": { title: "ReadyPackets community", description: "Explore the ReadyPackets community and resources for founders building durable business foundations." },
      "/contact": { title: "Contact ReadyPackets", description: "Contact ReadyPackets for questions about business packets, orders, or customer support." },
      "/faq": { title: "Frequently asked questions | ReadyPackets", description: "Find clear answers about ReadyPackets, business packets, orders, accounts, collaboration, and payment." },
      "/accessibility": { title: "Accessibility | ReadyPackets", description: "Learn about ReadyPackets’ accessibility approach, keyboard support, and how to report an accessibility barrier." },
    };
    const page = pages[location] ?? { title: "ReadyPackets", description: "ReadyPackets provides structured business documentation and strategy support." };
    const origin = typeof window === "undefined" ? "https://www.readypackets.com" : window.location.origin;
    const businessProfile = session.businessProfile;
    const organization = {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: businessProfile?.publicName ?? BRAND.companyShortName,
      legalName: businessProfile?.legalName ?? BRAND.companyLegalName,
      url: origin,
      logo: `${origin}${BRAND_ASSETS.light.full}`,
      email: BRAND.emails.general,
      address: {
        "@type": "PostalAddress",
        streetAddress: [businessProfile?.addressLine1, businessProfile?.addressLine2].filter(Boolean).join(", ") || BRAND.address,
        addressLocality: businessProfile?.city ?? "Lanham",
        addressRegion: businessProfile?.state ?? "MD",
        postalCode: businessProfile?.postalCode ?? "20706",
        addressCountry: businessProfile?.country ?? "US",
      },
      contactPoint: { "@type": "ContactPoint", contactType: "Customer Service", email: BRAND.emails.general },
    };
    const visibleFaqs = publicFaqs.data ?? [];
    if (location === "/") {
      return {
        ...page,
        structuredData: {
          "@context": "https://schema.org",
          "@graph": [organization, { "@type": "WebSite", name: businessProfile?.publicName ?? BRAND.companyShortName, url: origin }],
        },
      };
    }
    if (location === "/faq" && visibleFaqs.length > 0) {
      return {
        ...page,
        structuredData: {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: visibleFaqs.map((faq) => ({
            "@type": "Question",
            name: faq.question,
            acceptedAnswer: { "@type": "Answer", text: faq.answerMarkdown },
          })),
        },
      };
    }
    return page;
  }, [location, publicFaqs.data, session.businessProfile]);

  const maintenanceLocked =
    session.maintenance?.enabled === true &&
    session.maintenance.showOnHomepage &&
    !session.isStaff;

  if (maintenanceLocked) return <MaintenancePage />;

  return (
    <PublicLayout>
      <Seo title={seo.title} description={seo.description} path={location} structuredData={seo.structuredData} />
      <Switch>
        <Route path="/" component={HomePage} />
        <Route path="/packets" component={PacketsPage} />
        <Route path="/packets/:slug" component={PacketDetailPage} />
        <Route path="/how-it-works" component={HowItWorksPage} />
        <Route path="/about" component={AboutPage} />
        <Route path="/reviews" component={ReviewsPage} />
        <Route path="/community" component={CommunityTeaserPage} />
        <Route path="/changelog" component={ChangelogPage} />
        <Route path="/contact" component={ContactPage} />
        <Route path="/faq" component={FaqPage} />
        <Route path="/accessibility" component={AccessibilityPage} />
        <Route path="/legal/:slug" component={PolicyPage} />
        <Route path="/privacy" component={PolicyPage} />
        <Route path="/terms" component={PolicyPage} />
        <Route path="/refunds" component={PolicyPage} />
        <Route path="/disclaimer" component={PolicyPage} />
        <Route component={NotFoundPage} />
      </Switch>
    </PublicLayout>
  );
}
