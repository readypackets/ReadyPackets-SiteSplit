/**
 * Public site header.
 *
 * The mobile drawer is the fix for the gap-analysis finding that navigation was
 * unusable at 375px: below `lg` the links collapse into a full-height panel with
 * a focus trap, Escape handling and scroll lock, and every target is at least
 * 44px tall.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { LayoutDashboard, LogIn, Menu, X } from "lucide-react";
import { BRAND, BRAND_ASSETS } from "@shared/brand";
import { useSession } from "@/lib/session";
import { trpc } from "@/lib/trpc";
import { Button, LinkButton } from "@/components/ui/Button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { cn } from "@/lib/utils";

const NAV_LINKS = [
  { href: "/packets", label: "Packets" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/reviews", label: "Reviews" },
  { href: "/community", label: "Community" },
  { href: "/faq", label: "FAQ" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
] as const;

export function PublicHeader() {
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const { authenticated, user } = useSession();
  const siteStatus = trpc.public.siteStatus.useQuery();
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Close the drawer whenever the route changes.
  useEffect(() => setOpen(false), [location]);

  useEffect(() => {
    if (!open) return;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"));
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    panelRef.current?.querySelector<HTMLElement>("a,button")?.focus();

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = overflow;
    };
  }, [open]);

  const isActive = (href: string) => location === href || location.startsWith(`${href}/`);
  const navigation = siteStatus.data?.navigation;
  const visibleLinks = NAV_LINKS.filter((link) => {
    if (link.href === "/reviews") return navigation?.reviewsVisible !== false;
    if (link.href === "/community") return navigation?.communityVisible !== false;
    return true;
  });

  return (
    <header className="sticky top-0 z-40 border-b border-line/80 bg-white/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2 no-underline"
          aria-label={`${BRAND.companyShortName} home`}
        >
          <img
            src={BRAND_ASSETS.light.icon}
            alt={`${BRAND.wordmark} logo`}
            width={880}
            height={905}
            className="size-12 object-contain"
            // The logo is above the fold; loading it eagerly avoids a reflow.
            loading="eager"
            decoding="async"
          />
        </Link>

        <nav aria-label="Main navigation" className="hidden items-center gap-1 lg:flex">
          {visibleLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={isActive(link.href) ? "page" : undefined}
              className={cn(
                "inline-flex min-h-11 items-center rounded-lg px-3 py-2 text-sm font-medium no-underline transition-colors",
                isActive(link.href)
                  ? "bg-teal/10 text-teal-dark"
                  : "text-body hover:bg-surface-sunken hover:text-ink",
              )}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-2 lg:flex">
          <ThemeToggle />
          {authenticated ? (
            <LinkButton
              href={user?.role === "admin" || user?.role === "staff" ? "/admin" : "/portal"}
              size="sm"
              leadingIcon={<LayoutDashboard className="size-4" aria-hidden="true" />}
            >
              {user?.role === "admin" || user?.role === "staff" ? "Admin" : "My portal"}
            </LinkButton>
          ) : (
            <>
              <LinkButton
                href="/login"
                variant="ghost"
                size="sm"
                leadingIcon={<LogIn className="size-4" aria-hidden="true" />}
              >
                Sign in
              </LinkButton>
              <LinkButton href="/register" size="sm">
                Get started
              </LinkButton>
            </>
          )}
        </div>

        <Button
          ref={toggleRef}
          variant="ghost"
          size="icon"
          className="lg:hidden"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          aria-controls="mobile-navigation"
          aria-label={open ? "Close menu" : "Open menu"}
        >
          {open ? (
            <X className="size-5" aria-hidden="true" />
          ) : (
            <Menu className="size-5" aria-hidden="true" />
          )}
        </Button>
      </div>

      {open ? (
        <div className="lg:hidden">
          <div
            className="fixed inset-0 top-16 z-30 bg-navy/40"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            ref={panelRef}
            id="mobile-navigation"
            className="fixed inset-x-0 top-16 z-40 max-h-[calc(100vh-4rem)] overflow-y-auto border-b border-line bg-white px-4 pb-6 pt-2 shadow-[var(--shadow-raised)]"
          >
            <nav aria-label="Mobile navigation" className="flex flex-col">
              {visibleLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={isActive(link.href) ? "page" : undefined}
                  className={cn(
                    "flex min-h-11 items-center rounded-lg px-3 text-base font-medium no-underline",
                    isActive(link.href) ? "bg-teal/10 text-teal-dark" : "text-ink",
                  )}
                >
                  {link.label}
                </Link>
              ))}
            </nav>

            <div className="mt-4 border-t border-line pt-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Appearance</p>
              <ThemeToggle />
            </div>

            <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4">
              {authenticated ? (
                <LinkButton
                  href={user?.role === "admin" || user?.role === "staff" ? "/admin" : "/portal"}
                  fullWidth
                >
                  {user?.role === "admin" || user?.role === "staff" ? "Admin panel" : "My portal"}
                </LinkButton>
              ) : (
                <>
                  <LinkButton href="/register" fullWidth>
                    Get started
                  </LinkButton>
                  <LinkButton href="/login" variant="outline" fullWidth>
                    Sign in
                  </LinkButton>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}
