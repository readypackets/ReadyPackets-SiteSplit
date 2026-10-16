/**
 * Admin shell.
 *
 * Visually distinct from the customer portal — darker chrome, explicit role badge
 * — so staff always know which surface they are operating in. The navigation is
 * filtered by role, and the server enforces the same boundary independently.
 *
 * The sidebar uses `fixed inset-y-0` so it stays in place while the main content
 * scrolls. The nav list itself is `overflow-y-auto` so it scrolls independently
 * when there are more items than screen height allows.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  BarChart3,
  Bot,
  Calendar,
  ChevronDown,
  ClipboardList,
  CreditCard,
  FileText,
  FlaskConical,
  Gauge,
  Gift,
  History,
  Key,
  LayoutDashboard,
  LifeBuoy,
  Link2,
  LogIn,
  LogOut,
  Mail,
  MessageSquare,
  Menu,
  Newspaper,
  Package,
  Plug,
  RefreshCw,
  ScrollText,
  Server,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Star,
  Subscript,
  Tag,
  Users,
  Webhook,
  X,
  Zap,
} from "lucide-react";
import { BRAND, BRAND_ASSETS } from "@shared/brand";
import { trpc, errorMessage } from "@/lib/trpc";
import { useSession } from "@/lib/session";
import { Badge } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  adminOnly?: boolean;
}

const NAV: { section: string; items: NavItem[] }[] = [
  { section: "Order operations", items: [
    { href: "/admin", label: "Operations dashboard", icon: LayoutDashboard },
    { href: "/admin/orders", label: "Orders", icon: ClipboardList },
    { href: "/admin/order-workflows", label: "Order workflows", icon: ClipboardList, adminOnly: true },
    { href: "/admin/order-statuses", label: "Order status options", icon: ClipboardList, adminOnly: true },
    { href: "/admin/order-automations", label: "Order automations", icon: Zap, adminOnly: true },
    { href: "/admin/question-templates", label: "Order Question Banks", icon: ClipboardList, adminOnly: true },
    { href: "/admin/files", label: "Order files", icon: FileText },
    { href: "/admin/reports", label: "Reports", icon: BarChart3, adminOnly: true },
  ] },
  { section: "Customers & support", items: [
    { href: "/admin/customers", label: "Customers", icon: Users },
    { href: "/admin/crm", label: "CRM", icon: Users, adminOnly: true },
    { href: "/admin/tickets", label: "Support", icon: LifeBuoy },
    { href: "/admin/messages", label: "Message center", icon: MessageSquare },
    { href: "/admin/scheduling", label: "Scheduling", icon: Calendar, adminOnly: true },
    { href: "/admin/referrals", label: "Referrals", icon: Gift, adminOnly: true },
    { href: "/admin/moderation", label: "Moderation", icon: Star },
    { href: "/admin/knowledge-base", label: "Knowledge base", icon: FileText, adminOnly: true },
  ] },
  { section: "Finance & payments", items: [
    { href: "/admin/finance", label: "Finance dashboard", icon: CreditCard, adminOnly: true },
    { href: "/admin/coupons", label: "Coupons", icon: Tag, adminOnly: true },
    { href: "/admin/subscriptions", label: "Subscriptions", icon: Subscript, adminOnly: true },
    { href: "/admin/payouts", label: "Payouts", icon: Gift, adminOnly: true },
  ] },
  { section: "Email & marketing", items: [
    { href: "/admin/email-settings", label: "Email settings", icon: Mail, adminOnly: true },
    { href: "/admin/email-center", label: "Email Template Center", icon: Mail, adminOnly: true },
    { href: "/admin/email-automations", label: "Email automations", icon: Zap, adminOnly: true },
    { href: "/admin/marketing", label: "Marketing", icon: Newspaper, adminOnly: true },
    { href: "/admin/newsletter", label: "Newsletter", icon: Mail, adminOnly: true },
    { href: "/admin/announcements", label: "Announcements", icon: Mail, adminOnly: true },
  ] },
  { section: "Content & policies", items: [
    { href: "/admin/catalog", label: "Catalogue", icon: Package, adminOnly: true },
    { href: "/admin/content", label: "Site content", icon: ScrollText, adminOnly: true },
    { href: "/admin/faqs", label: "Public FAQs", icon: LifeBuoy, adminOnly: true },
    { href: "/admin/policy-center", label: "Policy center", icon: Shield, adminOnly: true },
    { href: "/admin/changelog", label: "Changelog", icon: Newspaper, adminOnly: true },
  ] },
  { section: "Platform, security & administration", items: [
    { href: "/admin/platform-setup", label: "Platform setup", icon: Server, adminOnly: true },
    { href: "/admin/integrations", label: "Integrations", icon: Link2, adminOnly: true },
    { href: "/admin/entra-setup", label: "Microsoft Entra ID", icon: ShieldCheck, adminOnly: true },
    { href: "/admin/api-keys", label: "API keys", icon: Key, adminOnly: true },
    { href: "/admin/inbound-webhooks", label: "Inbound webhooks", icon: Webhook, adminOnly: true },
    { href: "/admin/outbound", label: "Outbound connections", icon: Plug, adminOnly: true },
    { href: "/admin/backups", label: "Backups", icon: Server, adminOnly: true },
    { href: "/admin/platform-updates", label: "Platform updates", icon: RefreshCw, adminOnly: true },
    { href: "/admin/security", label: "Security centre", icon: ShieldAlert, adminOnly: true },
    { href: "/admin/siem-export", label: "SIEM export", icon: ShieldAlert, adminOnly: true },
    { href: "/admin/activity-replay", label: "Activity replay", icon: History, adminOnly: true },
    { href: "/admin/login-config", label: "Login page", icon: LogIn, adminOnly: true },
    { href: "/admin/wizard-slides", label: "Wizard slides", icon: ScrollText, adminOnly: true },
    { href: "/admin/support-permissions", label: "Support permissions", icon: ShieldCheck, adminOnly: true },
    { href: "/admin/navigation", label: "Navigation menu", icon: Menu, adminOnly: true },
    { href: "/admin/preferences", label: "My preferences", icon: Gauge, adminOnly: true },
    { href: "/admin/system", label: "System", icon: Server, adminOnly: true },
  ] },
];

export function AdminLayout({ children }: { children: ReactNode }) {
  const [location, navigate] = useLocation();
  const session = useSession();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem("readypackets.admin.collapsedGroups") ?? "{}"); } catch { return {}; }
  });
  const toggleGroup = (section: string) => setCollapsedGroups((current) => {
    const next = { ...current, [section]: !current[section] };
    localStorage.setItem("readypackets.admin.collapsedGroups", JSON.stringify(next));
    return next;
  });
  const navigationConfig = trpc.adminNavigation.get.useQuery(undefined, { enabled: session.isAdmin });
  const navigationGroups = useMemo(() => {
    const overrides = new Map((navigationConfig.data ?? []).filter((item) => !item.custom).map((item) => [item.href, item]));
    const defaults = NAV.flatMap((group, groupIndex) => group.items.map((item, itemIndex) => {
      const override = overrides.get(item.href);
      return { ...item, label: override?.label ?? item.label, section: override?.section ?? group.section, hidden: override?.hidden ?? false, order: override?.order ?? groupIndex * 100 + itemIndex };
    }));
    const custom = (navigationConfig.data ?? []).filter((item) => item.custom).map((item) => ({ ...item, icon: Link2, adminOnly: true }));
    const grouped = new Map<string, Array<(NavItem & { section: string; hidden: boolean; order: number })>>();
    for (const item of [...defaults, ...custom].filter((item) => !item.hidden)) {
      const entries = grouped.get(item.section) ?? [];
      entries.push(item);
      grouped.set(item.section, entries);
    }
    return [...grouped.entries()].map(([section, items]) => ({ section, items: items.sort((a, b) => a.order - b.order) }));
  }, [navigationConfig.data]);

  const logout = trpc.auth.logout.useMutation({
    async onSuccess() {
      await session.refresh();
      navigate("/login");
    },
    onError(error) {
      toast.error("Could not sign out", errorMessage(error));
    },
  });

  useEffect(() => {
    setOpen(false);
  }, [location]);

  const isActive = (href: string) =>
    href === "/admin" ? location === "/admin" : location.startsWith(href);

  const navigation = (
    <nav aria-label="Administration">
      {navigationGroups.map((group) => {
        const items = group.items.filter((item) => !item.adminOnly || session.isAdmin);
        if (items.length === 0) return null;
        return (
          <div key={group.section} className="mb-4">
            <button type="button" onClick={() => toggleGroup(group.section)} className="flex w-full items-center justify-between rounded px-3 pb-1.5 text-left text-xs font-semibold uppercase tracking-wider text-white/50 hover:text-white" aria-expanded={!collapsedGroups[group.section]}>
              {group.section}<ChevronDown className={`size-3 transition-transform ${collapsedGroups[group.section] ? "-rotate-90" : ""}`} aria-hidden="true" />
            </button>
            <ul className={`space-y-0.5 overflow-hidden transition-all ${collapsedGroups[group.section] ? "max-h-0 opacity-0" : "max-h-[1200px] opacity-100"}`}>
              {items.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);
                return (
                  <li key={item.href}>
                    {item.href.startsWith("http") ? <a href={item.href} target="_blank" rel="noreferrer" className="flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm text-white/70 no-underline transition-colors hover:bg-white/5 hover:text-white"><Icon className="size-4 shrink-0" aria-hidden="true" />{item.label}</a> : <Link href={item.href} aria-current={active ? "page" : undefined} className={`flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm no-underline transition-colors ${active ? "bg-teal/20 font-semibold text-white" : "text-white/70 hover:bg-white/5 hover:text-white"}`}><Icon className="size-4 shrink-0" aria-hidden="true" />{item.label}</Link>}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );

  const userFooter = (
    <div className="shrink-0 border-t border-white/10 px-4 py-4">
      <p className="truncate text-sm font-medium text-white">
        {session.user?.preferredName ?? session.user?.firstName ?? session.user?.email}
      </p>
      <p className="mt-1">
        <Badge tone={session.isAdmin ? "danger" : "teal"}>{session.user?.role}</Badge>
      </p>
      <div className="mt-3 space-y-0.5">
        <Link
          href="/portal"
          className="block rounded-lg px-3 py-1.5 text-sm text-white/70 no-underline hover:bg-white/5 hover:text-white"
        >
          Customer portal
        </Link>
        <button
          type="button"
          onClick={() => logout.mutate()}
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-white/70 transition-colors hover:bg-white/5 hover:text-white"
        >
          <LogOut className="size-4" aria-hidden="true" />
          Sign out
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-dvh bg-surface-soft">
      {/* Desktop sidebar — fixed so it stays while main content scrolls */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 flex-col bg-navy lg:flex">
        {/* Logo */}
        <div className="shrink-0 px-4 py-5">
          <Link href="/admin" className="flex items-center gap-2.5 px-2 no-underline">
            <img
              src={BRAND_ASSETS.dark.compactMark}
              alt=""
              width={491}
              height={508}
              className="size-10 object-contain"
              aria-hidden="true"
            />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-white">
                {BRAND.companyShortName}
              </span>
              <span className="block text-xs text-white/50">Administration</span>
            </span>
          </Link>
        </div>

        {/* Scrollable nav */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">{navigation}</div>

        {/* User footer — always visible */}
        {userFooter}
      </aside>

      {/* Mobile drawer */}
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-navy/70"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute inset-y-0 left-0 flex w-72 flex-col bg-navy">
            <div className="shrink-0 flex items-center justify-between px-4 py-4">
              <span className="text-sm font-semibold text-white">Administration</span>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="text-white hover:bg-white/10"
              >
                <X className="size-5" aria-hidden="true" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">{navigation}</div>
            <div className="shrink-0 border-t border-white/10 px-4 py-4">
              <button
                type="button"
                onClick={() => logout.mutate()}
                className="flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm text-white/70 hover:bg-white/5 hover:text-white"
              >
                <LogOut className="size-4" aria-hidden="true" />
                Sign out
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Main column — offset by sidebar width on desktop */}
      <div className="flex min-w-0 flex-1 flex-col lg:pl-64">
        <header className="flex items-center gap-3 border-b border-line bg-white px-4 py-3 lg:hidden">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="size-5" aria-hidden="true" />
          </Button>
          <span className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Gauge className="size-4 text-teal" aria-hidden="true" />
            Administration
          </span>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <div className="mx-auto max-w-7xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
