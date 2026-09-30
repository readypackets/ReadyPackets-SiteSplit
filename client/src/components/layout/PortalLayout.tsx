/**
 * Authenticated shell for both the customer portal and the admin panel.
 *
 * Route guarding happens here as a convenience for the user, not as a security
 * boundary: every procedure the pages call is independently authorised on the
 * server, so hiding a link never stands in for an access check.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { ChevronLeft, LogOut, Menu, PanelTopOpen, X } from "lucide-react";
import { BRAND, BRAND_ASSETS } from "@shared/brand";
import { trpc, errorMessage } from "@/lib/trpc";
import { useSession, type UserRole } from "@/lib/session";
import { Button } from "@/components/ui/Button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Alert, Skeleton } from "@/components/ui/Surface";
import { useToast } from "@/components/ui/Toast";
import { cn, initialsOf } from "@/lib/utils";

export interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
  badgeCount?: number;
  /** Exact match only; used for index routes such as /portal. */
  exact?: boolean;
}

export interface NavSection {
  title?: string;
  items: NavItem[];
}

export function PortalLayout({
  sections,
  children,
  variant = "portal",
}: {
  sections: NavSection[];
  children: ReactNode;
  variant?: "portal" | "admin";
}) {
  const [location, navigate] = useLocation();
  const session = useSession();
  const toast = useToast();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const logout = trpc.auth.logout.useMutation({
    async onSuccess() {
      await session.refresh();
      navigate("/login");
    },
    onError(error) {
      toast.error("Could not sign out", errorMessage(error));
    },
  });

  useEffect(() => setDrawerOpen(false), [location]);

  useEffect(() => {
    if (drawerOpen) {
      const { overflow } = document.body.style;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = overflow;
      };
    }
    return undefined;
  }, [drawerOpen]);

  // Redirect an unauthenticated visitor once the session has actually loaded.
  useEffect(() => {
    if (session.loading) return;
    if (!session.authenticated) {
      navigate("/login");
      return;
    }
    if (session.mfaPending) {
      navigate("/login");
      return;
    }
    if (session.restricted && !location.startsWith("/portal/mfa-setup")) {
      navigate("/portal/mfa-setup");
    }
  }, [session.loading, session.authenticated, session.mfaPending, session.restricted, location, navigate]);

  if (session.loading) {
    return (
      <div className="min-h-screen bg-surface-soft p-6">
        <div className="mx-auto max-w-6xl space-y-4">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (!session.authenticated || !session.user) return null;

  const user = session.user;
  const isActive = (item: NavItem) =>
    item.exact ? location === item.href : location === item.href || location.startsWith(`${item.href}/`);

  const navigation = (
    <nav aria-label="Portal navigation" className="flex flex-col gap-6">
      {sections.map((section, sectionIndex) => (
        <div key={section.title ?? sectionIndex}>
          {section.title ? (
            <h2 className="px-3 text-xs font-semibold uppercase tracking-[0.12em] text-white/40">
              {section.title}
            </h2>
          ) : null}
          <ul className={cn("space-y-0.5", section.title && "mt-2")}>
            {section.items.map((item) => {
              const Icon = item.icon;
              const active = isActive(item);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium no-underline transition-colors",
                      active
                        ? "bg-teal/18 text-white"
                        : "text-white/70 hover:bg-white/8 hover:text-white",
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.badgeCount && item.badgeCount > 0 ? (
                      <span className="rounded-full bg-gold px-1.5 py-0.5 text-xs font-bold tabular-nums text-navy">
                        {item.badgeCount > 99 ? "99+" : item.badgeCount}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen bg-surface-soft">
      <a href="#portal-main" className="skip-link">
        Skip to main content
      </a>

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col overflow-y-auto bg-navy px-3 py-5 lg:flex">
        <Link href="/" className="mx-1 mb-6 block" aria-label={`${BRAND.companyShortName} home`}>
          <img
            src={BRAND_ASSETS.dark.wordmark}
            alt={`${BRAND.wordmark} logo`}
            width={2300}
            height={760}
            className="h-10 w-auto"
          />
        </Link>

        {variant === "admin" ? (
          <p className="mx-3 mb-4 rounded-md bg-gold/15 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-gold">
            Administration
          </p>
        ) : null}

        <div className="flex-1">{navigation}</div>

        <div className="mt-6 border-t border-white/10 pt-4">
          <div className="flex items-center gap-3 px-2">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-teal/25 text-sm font-semibold text-white">
              {initialsOf(user.displayName)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-white">{user.displayName}</p>
              <p className="truncate text-xs text-white/50">{user.email}</p>
            </div>
          </div>
          {variant === "portal" && session.user?.role === "admin" ? (
            <Link href="/admin" className="mt-3 flex min-h-11 w-full items-center gap-3 rounded-lg bg-teal/20 px-3 text-sm font-semibold text-white no-underline transition-colors hover:bg-teal/30">
              <PanelTopOpen className="size-4" aria-hidden="true" />
              Switch to admin panel
            </Link>
          ) : null}
          <button
            type="button"
            onClick={() => logout.mutate()}
            className="mt-3 flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-white/70 transition-colors hover:bg-white/8 hover:text-white"
          >
            <LogOut className="size-4" aria-hidden="true" />
            Sign out
          </button>
        </div>
      </aside>

      {/* Mobile drawer */}
      {drawerOpen ? (
        <>
          <div
            className="fixed inset-0 z-40 bg-navy/50 lg:hidden"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <aside className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col overflow-y-auto bg-navy px-3 py-5 lg:hidden">
            <div className="mb-6 flex items-center justify-between px-1">
              <img
                src={BRAND_ASSETS.dark.wordmark}
                alt={`${BRAND.wordmark} logo`}
                width={2300}
                height={760}
                className="h-9 w-auto"
              />
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="rounded-lg p-2 text-white/70 hover:bg-white/10 hover:text-white"
                aria-label="Close navigation"
              >
                <X className="size-5" aria-hidden="true" />
              </button>
            </div>
            <div className="flex-1">{navigation}</div>
            {variant === "portal" && session.user?.role === "admin" ? (
              <Link href="/admin" className="mt-5 flex min-h-11 items-center gap-3 rounded-lg bg-teal/20 px-3 text-sm font-semibold text-white no-underline hover:bg-teal/30">
                <PanelTopOpen className="size-4" aria-hidden="true" />
                Switch to admin panel
              </Link>
            ) : null}
            <button
              type="button"
              onClick={() => logout.mutate()}
              className="mt-6 flex min-h-11 w-full items-center gap-3 rounded-lg border-t border-white/10 px-3 pt-4 text-sm font-medium text-white/70 hover:text-white"
            >
              <LogOut className="size-4" aria-hidden="true" />
              Sign out
            </button>
          </aside>
        </>
      ) : null}

      <div className="lg:pl-64">
        {/* Top bar */}
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line bg-white/95 px-4 backdrop-blur sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
          >
            <Menu className="size-5" aria-hidden="true" />
          </Button>

          <Link
            href="/"
            className="hidden items-center gap-1.5 text-sm font-medium text-body no-underline hover:text-ink sm:flex"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
            Public site
          </Link>

          <div className="flex-1" />

          <ThemeToggle />

          {variant === "portal" && session.user?.role === "admin" ? (
            <Link href="/admin" className="hidden items-center gap-2 rounded-lg bg-teal px-3 py-2 text-sm font-semibold text-white no-underline hover:bg-teal-dark sm:flex">
              <PanelTopOpen className="size-4" aria-hidden="true" />
              Admin panel
            </Link>
          ) : null}

          {variant === "portal" && !user.emailVerified ? (
            <span className="hidden rounded-full bg-warning/12 px-3 py-1 text-xs font-semibold text-warning sm:inline">
              Email not confirmed
            </span>
          ) : null}

          <span className="flex size-9 items-center justify-center rounded-full bg-teal/12 text-sm font-semibold text-teal-dark lg:hidden">
            {initialsOf(user.displayName)}
          </span>
        </header>

        {/* Session expiry warning */}
        {session.expiryWarning ? (
          <div className="border-b border-warning/30 bg-warning/8 px-4 py-3 sm:px-6">
            <Alert
              tone="warning"
              title="Your session is about to expire"
              className="border-0 bg-transparent p-0"
              actions={
                <>
                  <Button size="sm" onClick={() => void session.refresh()}>
                    Stay signed in
                  </Button>
                  <Button size="sm" variant="outline" onClick={session.dismissExpiryWarning}>
                    Dismiss
                  </Button>
                </>
              }
            >
              Save any work in progress. Choosing “Stay signed in” extends your session.
            </Alert>
          </div>
        ) : null}

        <main id="portal-main" className="px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

/** Page header used inside the portal and admin panel. */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  breadcrumb?: { href: string; label: string };
}) {
  return (
    <div className="mb-6">
      {breadcrumb ? (
        <Link
          href={breadcrumb.href}
          className="mb-2 inline-flex items-center gap-1.5 text-sm font-medium text-teal-dark no-underline hover:text-teal"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          {breadcrumb.label}
        </Link>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-ink">{title}</h1>
          {description ? (
            <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-body">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

/** Guard that renders children only for the allowed roles. */
export function RequireRole({
  roles,
  children,
}: {
  roles: UserRole[];
  children: ReactNode;
}) {
  const session = useSession();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (session.loading) return;
    if (!session.authenticated) {
      navigate("/login");
      return;
    }
    if (session.user && !roles.includes(session.user.role)) {
      navigate("/portal");
    }
  }, [session.loading, session.authenticated, session.user, roles, navigate]);

  if (session.loading || !session.user || !roles.includes(session.user.role)) return null;
  return <>{children}</>;
}
