/**
 * System administration: settings, feature flags, API keys, SAML, health, and
 * housekeeping.
 *
 * Secret settings report presence only — the server never returns their value —
 * so an administrator can confirm a credential is configured without being able
 * to read it back out of the database through the UI.
 */
import { useEffect, useState } from "react";
import {
  Activity,
  Cookie,
  Database,
  Flag,
  Globe2,
  KeyRound,
  LockKeyhole,
  MapPin,
  Plus,
  RefreshCw,
  Save,
  Server,
  Trash2,
  Users,
} from "lucide-react";
import { trpc, errorMessage } from "@/lib/trpc";
import { formatBytes, formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/Field";
import {
  Alert,
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Skeleton,
} from "@/components/ui/Surface";
import { TabStrip } from "@/components/ui/DataDisplay";
import { ConfirmDialog, Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { PageHeader } from "@/components/layout/PortalLayout";

export function AdminSystemPage() {
  const [tab, setTab] = useState("health");

  return (
    <>
      <PageHeader
        title="System"
        description="Runtime health, platform settings, feature flags, integrations, and housekeeping."
      />

            <TabStrip
        tabs={[
          { id: "health", label: "Health" },
          { id: "settings", label: "Settings" },
          { id: "privacy", label: "Privacy & cookies" },
          { id: "flags", label: "Feature flags" },
          { id: "keys", label: "API keys" },
          { id: "saml", label: "SAML" },
          { id: "certificates", label: "Certificates" },
          { id: "domain", label: "Domain & URL" },
          { id: "maintenance", label: "Housekeeping" },
          { id: "launch", label: "Launch countdown" },
          { id: "intake", label: "Intake controls" },
        ]}
        active={tab}
        onChange={setTab}
      />
      <div className="mt-6">
        {tab === "health" ? <HealthPanel /> : null}
        {tab === "settings" ? <><BusinessProfilePanel /><SettingsPanel /></> : null}
        {tab === "privacy" ? <><CookieConsentAdminPanel /><AnalyticsProviderPanel /></> : null}
        {tab === "flags" ? <FlagsPanel /> : null}
        {tab === "keys" ? <ApiKeysPanel /> : null}
        {tab === "saml" ? <SamlPanel /> : null}
        {tab === "certificates" ? <CertificatePanel /> : null}
        {tab === "domain" ? <DomainPanel /> : null}
        {tab === "maintenance" ? <><AdministratorOnlyAccessPanel /><MaintenanceAccessPanel /><MaintenancePanel /></> : null}
        {tab === "launch" ? <LaunchCountdownPanel /> : null}
        {tab === "intake" ? <IntakeControlsPanel /> : null}
      </div>
    </>
  );
}

function HealthPanel() {
  const health = trpc.adminSecurity.health.useQuery();
  const storage = trpc.adminFiles.storageUsage.useQuery();

  if (health.isLoading) return <Skeleton className="h-64 w-full" />;

  const uptimeSeconds = health.data?.uptimeSeconds ?? 0;
  const days = Math.floor(uptimeSeconds / 86_400);
  const hours = Math.floor((uptimeSeconds % 86_400) / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);

  return (
    <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Server className="size-4 text-teal" aria-hidden="true" />
              Runtime
            </span>
          }
        />
        <dl className="mt-4 space-y-3 text-sm">
          <Row label="Environment" value={<Badge tone="teal">{health.data?.environment}</Badge>} />
          <Row label="Node version" value={health.data?.nodeVersion ?? "—"} />
          <Row
            label="Uptime"
            value={`${days > 0 ? `${days}d ` : ""}${hours}h ${minutes}m`}
          />
          <Row label="Memory (RSS)" value={`${health.data?.memoryMb?.rss ?? 0} MB`} />
          <Row label="Heap used" value={`${health.data?.memoryMb?.heapUsed ?? 0} MB`} />
        </dl>
      </Card>

      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Database className="size-4 text-teal" aria-hidden="true" />
              Dependencies
            </span>
          }
        />
        <dl className="mt-4 space-y-3 text-sm">
          <Row
            label="Database"
            value={
              <Badge tone={health.data?.database ? "success" : "danger"}>
                {health.data?.database ? "connected" : "unreachable"}
              </Badge>
            }
          />
          <Row
            label="SMTP"
            value={
              <Badge tone={health.data?.smtpConfigured ? "success" : "warning"}>
                {health.data?.smtpConfigured ? "configured" : "not configured"}
              </Badge>
            }
          />
          <Row
            label="Payments"
            value={
              <Badge tone={health.data?.stripeConfigured ? "success" : "neutral"}>
                {health.data?.stripeConfigured ? "configured" : "manual invoicing"}
              </Badge>
            }
          />
          <Row label="Storage driver" value={health.data?.storageDriver ?? "—"} />
          <Row
            label="Email queue"
            value={`${health.data?.emailQueue?.pending ?? 0} pending, ${health.data?.emailQueue?.failed ?? 0} failed`}
          />
        </dl>
      </Card>

      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Users className="size-4 text-teal" aria-hidden="true" />
              Platform
            </span>
          }
        />
        <dl className="mt-4 space-y-3 text-sm">
          <Row label="Accounts" value={health.data?.users ?? 0} />
          <Row label="Active sessions" value={health.data?.activeSessions ?? 0} />
          <Row
            label="Open alerts"
            value={
              <Badge tone={(health.data?.openAlerts ?? 0) > 0 ? "warning" : "success"}>
                {health.data?.openAlerts ?? 0}
              </Badge>
            }
          />
        </dl>
      </Card>

      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Activity className="size-4 text-teal" aria-hidden="true" />
              Storage
            </span>
          }
        />
        {storage.isLoading ? (
          <Skeleton className="mt-4 h-24 w-full" />
        ) : (
          <dl className="mt-4 space-y-3 text-sm">
            <Row label="Files stored" value={storage.data?.fileCount ?? 0} />
            <Row label="Total size" value={formatBytes(storage.data?.totalBytes ?? 0)} />
            {(storage.data?.byCategory ?? []).map((entry) => (
              <Row
                key={entry.category}
                label={entry.category.replace(/_/g, " ")}
                value={formatBytes(entry.bytes)}
              />
            ))}
          </dl>
        )}
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-body">{label}</dt>
      <dd className="text-right font-medium text-ink">{value}</dd>
    </div>
  );
}

function CookieConsentAdminPanel() {
  const toast = useToast();
  const consent = trpc.adminSecurity.cookieConsent.useQuery();
  const [cookieConsentEnabled, setCookieConsentEnabled] = useState(true);
  const [analyticsEnabled, setAnalyticsEnabled] = useState(false);
  const [marketingEnabled, setMarketingEnabled] = useState(false);
  const [confirm, setConfirm] = useState("");
  useEffect(() => {
    if (!consent.data) return;
    setCookieConsentEnabled(consent.data.config.enabled);
    setAnalyticsEnabled(consent.data.config.analyticsAvailable);
    setMarketingEnabled(consent.data.config.marketingAvailable);
  }, [consent.data]);
  const update = trpc.adminSecurity.updateCookieConsentConfig.useMutation({
    async onSuccess() {
      await consent.refetch();
      setConfirm("");
      toast.success("Cookie consent settings updated", "Essential security cookies remain active. Optional categories still require each visitor’s consent when the banner is enabled.");
    },
    onError(error) { toast.error("Cookie consent settings were not updated", errorMessage(error)); },
  });
  const overview = consent.data?.overview;
  return <Card>
    <CardHeader title={<span className="flex items-center gap-2"><Cookie className="size-4 text-teal" aria-hidden="true" />Cookie consent and privacy preferences</span>} description="Visitors can accept, reject, or customize optional categories. Essential session and security cookies are always required and cannot be disabled." actions={<Button size="sm" variant="outline" busy={consent.isFetching} onClick={() => void consent.refetch()} leadingIcon={<RefreshCw className="size-4" />}>Refresh</Button>} />
    {consent.isLoading ? <Skeleton className="mt-5 h-52 w-full" /> : <>
      <Alert tone={cookieConsentEnabled ? "info" : "warning"} className="mt-5" title={cookieConsentEnabled ? "Consent-before-tracking enforcement" : "Cookie preference center is turned off"}>{cookieConsentEnabled ? "Analytics and marketing remain disabled by default. Enabling a category only makes it available in the preference center; it does not grant permission until each visitor opts in. No tracking integration is currently configured." : "Visitors will not see the cookie preference banner or the Manage cookie preferences button. Essential session, CSRF, security, and requested portal-function cookies remain active and cannot be disabled."}</Alert>
      <div className="mt-5 grid gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4"><p className="text-xs uppercase tracking-wide text-body">Consent version</p><p className="mt-1 text-lg font-semibold text-ink">{consent.data?.config.version}</p></div>
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4"><p className="text-xs uppercase tracking-wide text-body">Recorded decisions</p><p className="mt-1 text-lg font-semibold text-ink">{overview?.total ?? 0}</p></div>
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4"><p className="text-xs uppercase tracking-wide text-body">Essential-only choices</p><p className="mt-1 text-lg font-semibold text-ink">{overview?.essentialOnly ?? 0}</p></div>
      </div>
      <div className="mt-6 space-y-4">
        <label className="flex items-start gap-3 rounded-xl border border-teal/40 bg-teal/10 p-4"><input type="checkbox" className="mt-1 h-4 w-4 accent-teal" checked={cookieConsentEnabled} onChange={(event) => setCookieConsentEnabled(event.target.checked)} /><span><span className="font-semibold text-ink">Show cookie preference banner and management controls</span><span className="mt-1 block text-sm text-body">Turn this on to display the visitor cookie preference banner, collect consent records, and show the persistent Manage cookie preferences button. Turn it off only when cookie consent management is not required for your current deployment.</span></span></label>
        <label className={`flex items-start gap-3 rounded-xl border p-4 ${cookieConsentEnabled ? "border-white/10" : "border-white/10 opacity-60"}`}><input type="checkbox" className="mt-1 h-4 w-4 accent-teal" checked={analyticsEnabled} disabled={!cookieConsentEnabled} onChange={(event) => setAnalyticsEnabled(event.target.checked)} /><span><span className="font-medium text-ink">Make analytics consent available</span><span className="mt-1 block text-sm text-body">Only enable this immediately before installing a separately approved analytics integration. Visitors must still opt in before it may run.</span></span></label>
        <label className={`flex items-start gap-3 rounded-xl border p-4 ${cookieConsentEnabled ? "border-white/10" : "border-white/10 opacity-60"}`}><input type="checkbox" className="mt-1 h-4 w-4 accent-teal" checked={marketingEnabled} disabled={!cookieConsentEnabled} onChange={(event) => setMarketingEnabled(event.target.checked)} /><span><span className="font-medium text-ink">Make marketing consent available</span><span className="mt-1 block text-sm text-body">Only enable this immediately before installing a separately approved marketing or advertising integration. Visitors must still opt in before it may run.</span></span></label>
      </div>
      <div className="mt-5 max-w-lg"><Input label="Type to confirm" placeholder="UPDATE COOKIE CONSENT SETTINGS" value={confirm} onChange={(event) => setConfirm(event.target.value)} /><p className="mt-2 text-xs text-body">Changing categories is audited. This does not itself activate a tracking script.</p></div>
      <div className="mt-5 flex flex-wrap gap-3"><Button busy={update.isPending} disabled={confirm !== "UPDATE COOKIE CONSENT SETTINGS"} onClick={() => update.mutate({ cookieConsentEnabled, analyticsTrackingEnabled: cookieConsentEnabled && analyticsEnabled, marketingTrackingEnabled: cookieConsentEnabled && marketingEnabled, confirm: "UPDATE COOKIE CONSENT SETTINGS" })} leadingIcon={<Save className="size-4" />}>Save cookie consent settings</Button><a href="/privacy" className="inline-flex items-center rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-ink hover:bg-white/5">Review Privacy Policy</a></div>
    </>}
  </Card>;
}

function AnalyticsProviderPanel() {
  const toast = useToast();
  const providers = trpc.adminSecurity.analyticsProviders.useQuery();
  const consent = trpc.adminSecurity.cookieConsent.useQuery();
  const [clarityEnabled, setClarityEnabled] = useState(false);
  const [clarityProjectId, setClarityProjectId] = useState("");
  const [posthogEnabled, setPosthogEnabled] = useState(false);
  const [posthogProjectKey, setPosthogProjectKey] = useState("");
  const [posthogHost, setPosthogHost] = useState("https://us.i.posthog.com");
  const [crossSiteEnabled, setCrossSiteEnabled] = useState(false);
  const [confirm, setConfirm] = useState("");

  useEffect(() => {
    if (!providers.data) return;
    setClarityEnabled(providers.data.clarityEnabled);
    setPosthogEnabled(providers.data.posthogEnabled);
    setPosthogHost(providers.data.posthogHost ?? "https://us.i.posthog.com");
    setCrossSiteEnabled(providers.data.crossSiteEnabled);
  }, [providers.data]);

  const update = trpc.adminSecurity.updateAnalyticsProviders.useMutation({
    async onSuccess() {
      setClarityProjectId("");
      setPosthogProjectKey("");
      setConfirm("");
      await providers.refetch();
      toast.success("Analytics provider settings saved", "Providers can load only after ReadyPackets records a visitor’s analytics opt-in.");
    },
    onError(error) { toast.error("Analytics provider settings were not saved", errorMessage(error)); },
  });
  const analyticsAvailable = consent.data?.config.analyticsAvailable === true;

  return <Card className="mb-6">
    <CardHeader
      title={<span className="flex items-center gap-2"><Activity className="size-4 text-teal" aria-hidden="true" />Consent-gated analytics providers</span>}
      description="Optional Microsoft Clarity and PostHog support with local consent enforcement. The application sends only curated path and surface events; it does not send account, order, document, message, form, or e-mail values."
      actions={<Button size="sm" variant="outline" busy={providers.isFetching} onClick={() => void providers.refetch()} leadingIcon={<RefreshCw className="size-4" />}>Refresh</Button>}
    />
    {!analyticsAvailable ? <Alert tone="warning" className="mt-5" title="Analytics consent category is unavailable">First enable the Analytics category above and save it. Provider scripts remain blocked unless each visitor separately selects Analytics.</Alert> : null}
    <Alert tone="info" className="mt-5" title="Privacy-preserving default">Autocapture and session replay are disabled in the ReadyPackets PostHog client. Cross-site continuity is optional, requires this control plus analytics consent, and uses only a random navigation handoff identifier—never an e-mail address or ReadyPackets account/order identifier.</Alert>
    <div className="mt-5 grid gap-5 lg:grid-cols-2">
      <section className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <Checkbox checked={clarityEnabled} onChange={(event) => setClarityEnabled(event.target.checked)} label="Enable Microsoft Clarity after analytics opt-in" disabled={!analyticsAvailable} />
        <Input className="mt-4" label={providers.data?.clarityConfigured ? "Clarity project ID (configured — leave blank to retain)" : "Clarity project ID"} value={clarityProjectId} onChange={(event) => setClarityProjectId(event.target.value)} placeholder="Example: abc123xyz0" disabled={!clarityEnabled || !analyticsAvailable} />
        <p className="mt-3 text-xs leading-5 text-body">Configure Clarity’s ConsentV2 requirement and privacy masking in the Microsoft Clarity project as well. The stored project value is write-only in this panel.</p>
      </section>
      <section className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <Checkbox checked={posthogEnabled} onChange={(event) => setPosthogEnabled(event.target.checked)} label="Enable PostHog after analytics opt-in" disabled={!analyticsAvailable} />
        <Input className="mt-4" label={providers.data?.posthogConfigured ? "PostHog project API key (configured — leave blank to retain)" : "PostHog project API key"} value={posthogProjectKey} onChange={(event) => setPosthogProjectKey(event.target.value)} type="password" placeholder="phc_…" disabled={!posthogEnabled || !analyticsAvailable} />
        <Select className="mt-4" label="PostHog ingestion region" value={posthogHost} onChange={(event) => setPosthogHost(event.target.value)} disabled={!posthogEnabled || !analyticsAvailable}><option value="https://us.i.posthog.com">United States</option><option value="https://eu.i.posthog.com">European Union</option></Select>
        <p className="mt-3 text-xs leading-5 text-body">Use the region that matches the organization’s data-residency and legal requirements. Configure IP capture and retention in PostHog’s project settings.</p>
      </section>
    </div>
    <div className="mt-5 rounded-xl border border-amber-400/30 bg-amber-400/5 p-4">
      <Checkbox checked={crossSiteEnabled} onChange={(event) => setCrossSiteEnabled(event.target.checked)} label="Allow consented analytics continuity between the public site and portal" disabled={!analyticsAvailable || (!clarityEnabled && !posthogEnabled)} />
      <p className="mt-2 text-xs leading-5 text-body">Use only after the privacy notice is updated for the two-hostname deployment. It passes a random analytics handoff only on a public-to-portal navigation; it does not share ReadyPackets session cookies, authentication, access, or customer data.</p>
    </div>
    <div className="mt-5 grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
      <Input label="Type to confirm" placeholder="SAVE ANALYTICS CONFIGURATION" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
      <Button busy={update.isPending} disabled={!analyticsAvailable || confirm !== "SAVE ANALYTICS CONFIGURATION"} onClick={() => update.mutate({ clarityEnabled, clarityProjectId: clarityProjectId || undefined, posthogEnabled, posthogProjectKey: posthogProjectKey || undefined, posthogHost: posthogHost as "https://us.i.posthog.com" | "https://eu.i.posthog.com", crossSiteEnabled, confirm: "SAVE ANALYTICS CONFIGURATION" })} leadingIcon={<Save className="size-4" />}>Save analytics configuration</Button>
    </div>
  </Card>;
}

function BusinessProfilePanel() {
  const toast = useToast();
  const profile = trpc.adminSecurity.businessProfile.useQuery();
  const [form, setForm] = useState({ legalName: "", publicName: "", addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", country: "US" });
  useEffect(() => {
    if (!profile.data) return;
    setForm({
      legalName: profile.data.legalName,
      publicName: profile.data.publicName,
      addressLine1: profile.data.addressLine1,
      addressLine2: profile.data.addressLine2 ?? "",
      city: profile.data.city,
      state: profile.data.state,
      postalCode: profile.data.postalCode,
      country: profile.data.country,
    });
  }, [profile.data]);
  const update = trpc.adminSecurity.updateBusinessProfile.useMutation({
    async onSuccess() {
      await profile.refetch();
      toast.success("Business profile updated", "The new address is now used by public pages, future emails, invoices, and generated documents.");
    },
    onError(error) { toast.error("Business profile was not updated", errorMessage(error)); },
  });
  const set = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));

  return <Card className="mb-6">
    <CardHeader title={<span className="flex items-center gap-2"><MapPin className="size-4 text-teal" aria-hidden="true" />Business profile and mailing address</span>} description="This is the single source for the address displayed on the public website and used in future email footers, invoices, and generated business documents." actions={<Button size="sm" variant="outline" busy={profile.isFetching} onClick={() => void profile.refetch()} leadingIcon={<RefreshCw className="size-4" />}>Refresh</Button>} />
    {profile.isLoading ? <Skeleton className="mt-5 h-48 w-full" /> : <>
      <Alert tone="info" className="mt-5" title="Future-use content updates automatically">Saving this profile updates new website responses, emails, and invoices immediately. Previously issued invoices, sent emails, accepted policies, and signed documents retain their historical address as evidence.</Alert>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <Input label="Legal entity name" value={form.legalName} onChange={(event) => set("legalName", event.target.value)} required />
        <Input label="Public business name" value={form.publicName} onChange={(event) => set("publicName", event.target.value)} required />
        <Input label="Address line 1" value={form.addressLine1} onChange={(event) => set("addressLine1", event.target.value)} required />
        <Input label="Address line 2" value={form.addressLine2} onChange={(event) => set("addressLine2", event.target.value)} />
        <Input label="City" value={form.city} onChange={(event) => set("city", event.target.value)} required />
        <Input label="State or region" value={form.state} onChange={(event) => set("state", event.target.value)} required />
        <Input label="Postal code" value={form.postalCode} onChange={(event) => set("postalCode", event.target.value)} required />
        <Input label="Country" value={form.country} onChange={(event) => set("country", event.target.value)} required />
      </div>
      <div className="mt-5 flex justify-end"><Button busy={update.isPending} onClick={() => update.mutate({ ...form, addressLine2: form.addressLine2.trim() || null })} leadingIcon={<Save className="size-4" />}>Save business profile</Button></div>
    </>}
  </Card>;
}

function DomainPanel() {
  const toast = useToast();
  const status = trpc.adminSecurity.domainStatus.useQuery();
  const [open, setOpen] = useState(false);
  const [hostname, setHostname] = useState("");
  const [email, setEmail] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const update = trpc.adminSecurity.updateDomainAndRequestLetsEncrypt.useMutation({
    async onSuccess(result) {
      await status.refetch();
      setOpen(false); setConfirmation("");
      toast.success("Portal domain updated", `Let's Encrypt is active for ${result.hostname}. Opening the new portal address.`);
      window.setTimeout(() => window.location.assign(`https://${result.hostname}`), 1_000);
    },
    onError(error) { toast.error("Domain change was not applied", errorMessage(error)); },
  });
  const current = status.data;
  const currentHostname = current?.hostname ?? window.location.hostname;

  return <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Globe2 className="size-4 text-teal" aria-hidden="true" />Public portal domain</span>} description="The canonical HTTPS origin used for authentication, CSRF checks, outbound email links, and browser metadata." actions={<Button size="sm" variant="outline" busy={status.isFetching} onClick={() => void status.refetch()} leadingIcon={<RefreshCw className="size-4" />}>Refresh</Button>} />
      {status.isLoading ? <Skeleton className="mt-5 h-40 w-full" /> : <dl className="mt-5 space-y-3 text-sm">
        <Row label="Canonical URL" value={<code className="text-xs">{current?.appUrl ?? "—"}</code>} />
        <Row label="Active hostname" value={currentHostname} />
        <Row label="Certificate provider" value={<Badge tone={current?.certificate.provider === "letsencrypt" ? "success" : "warning"}>{current?.certificate.provider === "letsencrypt" ? "Let's Encrypt" : current?.certificate.provider ?? "unknown"}</Badge>} />
        <Row label="Certificate expiry" value={current?.certificate.notAfter ?? "—"} />
      </dl>}
    </Card>

    <Card>
      <CardHeader title="Change domain and request Let’s Encrypt" description="Use only after the requested hostname’s public DNS record points to this server and port 80 is reachable for ACME validation." />
      <Alert tone="warning" className="mt-5" title="High-impact operation">This updates nginx, `APP_URL`, allowed browser origins, email-link destinations, and the active certificate. Existing sessions on the former hostname will need a new sign-in. A root-only rollback snapshot is created before the change.</Alert>
      <div className="mt-5 flex flex-wrap gap-3">
        <Button variant="danger" onClick={() => { setHostname(""); setEmail(""); setConfirmation(""); setOpen(true); }} leadingIcon={<Globe2 className="size-4" />}>Change domain and request certificate</Button>
      </div>
      <p className="mt-4 text-xs leading-relaxed text-muted">The portal uses HTTP-01 validation through the existing nginx ACME location. Keep the DNS record reachable and do not enable an incompatible Cloudflare certificate mode during issuance.</p>
    </Card>

    <Modal open={open} onClose={() => { if (!update.isPending) setOpen(false); }} title="Change the public portal domain" description="The action first validates nginx, requests a certificate for the new hostname, validates that certificate, applies the new application origin, reloads nginx, restarts the portal, and rolls back all modified server files if any step fails." footer={<><Button variant="outline" disabled={update.isPending} onClick={() => setOpen(false)}>Cancel</Button><Button variant="danger" busy={update.isPending} disabled={!hostname.trim() || !email.trim() || confirmation !== "CHANGE DOMAIN AND REQUEST CERTIFICATE"} onClick={() => update.mutate({ hostname: hostname.trim().toLowerCase(), email: email.trim(), confirmation: "CHANGE DOMAIN AND REQUEST CERTIFICATE" })}>Request certificate and change domain</Button></>}>
      <div className="mt-4 space-y-4">
        <Alert tone="info" title="Before continuing">Create the DNS record for the new hostname first. If Cloudflare proxies it, use Full (strict) and ensure the ACME challenge can reach this server. The prior hostname remains recoverable through the protected rollback snapshot, but the portal will begin issuing links on the new hostname immediately after success.</Alert>
        <Input label="New public hostname" type="text" autoComplete="off" value={hostname} onChange={(event) => setHostname(event.target.value)} placeholder="www.example.com" required />
        <Input label="Let’s Encrypt certificate-contact email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="operations@example.com" required />
        <Input label="Type to confirm" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="CHANGE DOMAIN AND REQUEST CERTIFICATE" required />
      </div>
    </Modal>
  </div>;
}

function CertificatePanel() {
  const toast = useToast();
  const status = trpc.adminSecurity.tlsCertificateStatus.useQuery();
  const install = trpc.adminSecurity.installCloudflareOriginCertificate.useMutation({
    async onSuccess() {
      await status.refetch();
      setInstallOpen(false);
      setCertificate(""); setPrivateKey(""); setCaRoot(""); setConfirmation("");
      toast.success("Cloudflare Origin CA installed", "nginx was validated and reloaded. The private key was not retained in the browser.");
    },
    onError(error) { toast.error("Could not install certificate", errorMessage(error)); },
  });
  const activateLetsEncrypt = trpc.adminSecurity.activateLetsEncryptCertificate.useMutation({
    async onSuccess() { await status.refetch(); setLetsEncryptOpen(false); toast.success("Let's Encrypt certificate activated"); },
    onError(error) { toast.error("Could not activate Let's Encrypt", errorMessage(error)); },
  });
  const [installOpen, setInstallOpen] = useState(false);
  const [letsEncryptOpen, setLetsEncryptOpen] = useState(false);
  const [certificate, setCertificate] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [caRoot, setCaRoot] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const hostname = window.location.hostname;
  const current = status.data;

  return (
    <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
      <Card>
        <CardHeader title={<span className="flex items-center gap-2"><LockKeyhole className="size-4 text-teal" aria-hidden="true" />Active origin certificate</span>} description="Certificate metadata is visible; private keys and certificate bodies are never returned to the portal." actions={<Button size="sm" variant="outline" busy={status.isFetching} onClick={() => void status.refetch()} leadingIcon={<RefreshCw className="size-4" />}>Refresh</Button>} />
        {status.isLoading ? <Skeleton className="mt-5 h-48 w-full" /> : !current?.configured ? <Alert tone="warning" className="mt-5" title="Certificate control unavailable">The protected certificate-control service could not read an active certificate. Use the deployment guide or restore the local control daemon before changing TLS.</Alert> : <dl className="mt-5 space-y-3 text-sm">
          <Row label="Provider" value={<Badge tone={current.provider === "cloudflare_origin" ? "teal" : "success"}>{current.provider === "cloudflare_origin" ? "Cloudflare Origin CA" : "Let's Encrypt"}</Badge>} />
          <Row label="Subject" value={current.subject ?? "—"} />
          <Row label="Issuer" value={current.issuer ?? "—"} />
          <Row label="Valid from" value={current.notBefore ?? "—"} />
          <Row label="Expires" value={current.notAfter ?? "—"} />
          <Row label="SHA-256 fingerprint" value={<code className="text-xs">{current.fingerprint ?? "—"}</code>} />
          <Row label="Cloudflare CA root stored" value={<Badge tone={current.rootPresent ? "success" : "neutral"}>{current.rootPresent ? "yes" : "no"}</Badge>} />
        </dl>}
      </Card>

      <Card>
        <CardHeader title="Origin certificate actions" description="Use a Cloudflare Origin CA certificate only when this hostname remains proxied through Cloudflare in Full (strict) mode." />
        <Alert tone="info" className="mt-5" title="Secure handling">The certificate, private key, and optional CA root travel once over the authenticated local control channel. They are written only to root-owned server files, are never stored in portal settings, and are never returned by this page.</Alert>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button onClick={() => setInstallOpen(true)} leadingIcon={<LockKeyhole className="size-4" />}>Install Cloudflare Origin CA</Button>
          <Button variant="outline" onClick={() => setLetsEncryptOpen(true)}>Use existing Let's Encrypt certificate</Button>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-muted">Cloudflare Origin CA certificates are trusted between Cloudflare and this server, not directly by visitor browsers. Do not pause proxying or change the record to DNS-only while this certificate is active.</p>
      </Card>

      <Modal open={installOpen} onClose={() => setInstallOpen(false)} title="Install Cloudflare Origin CA certificate" description="Paste the PEM values created in Cloudflare. This validates the hostname and key pair, creates a protected TLS rollback copy, tests nginx, and reloads only after validation." footer={<><Button variant="outline" onClick={() => setInstallOpen(false)}>Cancel</Button><Button busy={install.isPending} disabled={!certificate.trim() || !privateKey.trim() || confirmation !== "INSTALL CLOUDFLARE ORIGIN CA"} onClick={() => install.mutate({ hostname, certificate, privateKey, caRoot: caRoot || undefined, confirmation: "INSTALL CLOUDFLARE ORIGIN CA" })} leadingIcon={<Save className="size-4" />}>Install and reload nginx</Button></>}>
        <div className="mt-4 space-y-4">
          <Alert tone="warning" title="Before continuing">In Cloudflare, create an Origin Server certificate covering <code>{hostname}</code>, retain the private key immediately, and keep SSL/TLS mode set to Full (strict). The optional root is stored as a reference chain; nginx serves the leaf certificate and key.</Alert>
          <Input label="Hostname" value={hostname} disabled help="The installed certificate must match this portal hostname." />
          <Textarea label="Origin certificate PEM" rows={7} value={certificate} onChange={(event) => setCertificate(event.target.value)} placeholder="-----BEGIN CERTIFICATE-----" required />
          <Textarea label="Private key PEM" rows={7} value={privateKey} onChange={(event) => setPrivateKey(event.target.value)} placeholder="-----BEGIN PRIVATE KEY-----" required />
          <Textarea label="Cloudflare Origin CA root PEM (optional)" rows={5} value={caRoot} onChange={(event) => setCaRoot(event.target.value)} placeholder="-----BEGIN CERTIFICATE-----" help="This is retained in root-owned server storage; it is not placed in the general operating-system trust store." />
          <Input label="Type to confirm" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="INSTALL CLOUDFLARE ORIGIN CA" required />
        </div>
      </Modal>

      <ConfirmDialog open={letsEncryptOpen} onClose={() => setLetsEncryptOpen(false)} onConfirm={() => activateLetsEncrypt.mutate({ hostname, confirmation: "USE LETS ENCRYPT" })} title="Activate existing Let's Encrypt certificate?" message="This switches nginx back to the existing local Let's Encrypt certificate for the current hostname after validating its hostname and configuration. A protected TLS rollback copy is retained." confirmLabel="Use Let's Encrypt" cancelLabel="Cancel" variant="danger" busy={activateLetsEncrypt.isPending} />
    </div>
  );
}

function SettingsPanel() {
  const toast = useToast();
  const settings = trpc.adminSecurity.settings.useQuery();
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const update = trpc.adminSecurity.updateSetting.useMutation({
    async onSuccess() {
      await settings.refetch();
      toast.success("Setting saved");
    },
    onError(error) {
      toast.error("Could not save the setting", errorMessage(error));
    },
  });

  if (settings.isLoading) return <Skeleton className="h-64 w-full" />;

  const categories = new Map<string, NonNullable<typeof settings.data>>();
  for (const setting of settings.data ?? []) {
    const list = categories.get(setting.category) ?? [];
    list.push(setting);
    categories.set(setting.category, list);
  }

  return (
    <div className="space-y-6">
      <Alert tone="info" title="Secrets are write-only">
        Settings marked as secret never leave the server. The panel reports only whether a value is
        present.
      </Alert>

      {[...categories.entries()].map(([category, items]) => (
        <Card key={category}>
          <CardHeader title={category.replace(/_/g, " ")} />
          <ul className="mt-4 space-y-5">
            {items.map((setting) => (
              <li key={setting.key} className="border-b border-line pb-5 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-muted">{setting.key}</p>
                    {setting.description ? (
                      <p className="mt-1 text-sm text-body">{setting.description}</p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone="neutral">{setting.valueType}</Badge>
                    {setting.isSecret ? (
                      <Badge tone={setting.hasValue ? "success" : "warning"}>
                        {setting.hasValue ? "set" : "empty"}
                      </Badge>
                    ) : null}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-end gap-3">
                  {setting.valueType === "boolean" ? (
                    <Select
                      label="Value"
                      className="sm:w-40"
                      value={drafts[setting.key] ?? setting.value ?? "false"}
                      onChange={(event) =>
                        setDrafts((current) => ({ ...current, [setting.key]: event.target.value }))
                      }
                      options={[
                        { value: "true", label: "Enabled" },
                        { value: "false", label: "Disabled" },
                      ]}
                    />
                  ) : setting.valueType === "json" ? (
                    <Textarea
                      label="Value"
                      className="flex-1"
                      rows={3}
                      value={drafts[setting.key] ?? setting.value ?? ""}
                      onChange={(event) =>
                        setDrafts((current) => ({ ...current, [setting.key]: event.target.value }))
                      }
                    />
                  ) : (
                    <Input
                      label="Value"
                      className="flex-1"
                      type={setting.isSecret ? "password" : setting.valueType === "number" ? "number" : "text"}
                      placeholder={setting.isSecret ? "unchanged" : undefined}
                      value={drafts[setting.key] ?? (setting.isSecret ? "" : setting.value ?? "")}
                      onChange={(event) =>
                        setDrafts((current) => ({ ...current, [setting.key]: event.target.value }))
                      }
                      autoComplete="off"
                    />
                  )}
                  <Button
                    size="sm"
                    busy={update.isPending}
                    onClick={() =>
                      update.mutate({
                        key: setting.key,
                        value: drafts[setting.key] ?? setting.value ?? null,
                      })
                    }
                    leadingIcon={<Save className="size-4" aria-hidden="true" />}
                  >
                    Save
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

function FlagsPanel() {
  const toast = useToast();
  const flags = trpc.adminSecurity.featureFlags.useQuery();

  const setFlag = trpc.adminSecurity.setFeatureFlag.useMutation({
    async onSuccess() {
      await flags.refetch();
      toast.success("Feature flag updated");
    },
    onError(error) {
      toast.error("Could not update the flag", errorMessage(error));
    },
  });

  if (flags.isLoading) return <Skeleton className="h-64 w-full" />;

  return (
    <Card padded={false}>
      <ul className="divide-y divide-line">
        {(flags.data ?? []).map((flag) => (
          <li key={flag.key} className="flex flex-wrap items-start justify-between gap-3 px-4 py-4">
            <div className="min-w-0">
              <p className="flex items-center gap-2 font-medium text-ink">
                <Flag className="size-4 text-teal" aria-hidden="true" />
                {flag.name}
              </p>
              <p className="mt-0.5 font-mono text-xs text-muted">{flag.key}</p>
              {flag.description ? (
                <p className="mt-1 text-sm text-body">{flag.description}</p>
              ) : null}
              {flag.scheduledEnableAt || flag.scheduledDisableAt ? (
                <p className="mt-1 text-xs text-muted">
                  {flag.scheduledEnableAt
                    ? `Scheduled to enable ${formatDateTime(flag.scheduledEnableAt)}. `
                    : ""}
                  {flag.scheduledDisableAt
                    ? `Scheduled to disable ${formatDateTime(flag.scheduledDisableAt)}.`
                    : ""}
                </p>
              ) : null}
            </div>
            <Button
              size="sm"
              variant={flag.enabled ? "outline" : "primary"}
              busy={setFlag.isPending}
              onClick={() => setFlag.mutate({ key: flag.key, enabled: !flag.enabled })}
            >
              {flag.enabled ? "Disable" : "Enable"}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ApiKeysPanel() {
  const toast = useToast();
  const keys = trpc.adminSecurity.apiKeys.useQuery();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  const [revokeId, setRevokeId] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const create = trpc.adminSecurity.createApiKey.useMutation({
    async onSuccess(result) {
      setOpen(false);
      setName("");
      setScopes("");
      setExpiresInDays("");
      setIssued(result.apiKey);
      await keys.refetch();
    },
    onError(error) {
      setFormError(errorMessage(error));
    },
  });

  const revoke = trpc.adminSecurity.revokeApiKey.useMutation({
    async onSuccess() {
      setRevokeId(null);
      await keys.refetch();
      toast.success("Key revoked");
    },
    onError(error) {
      toast.error("Could not revoke the key", errorMessage(error));
    },
  });

  return (
    <>
      <Alert tone="warning" className="mb-5" title="Treat keys as passwords">
        A key is displayed once at creation and stored only as a hash. If it is lost, revoke it and
        issue a new one rather than attempting recovery.
      </Alert>

      <div className="mb-5 flex justify-end">
        <Button
          onClick={() => {
            setFormError(null);
            setOpen(true);
          }}
          leadingIcon={<Plus className="size-4" aria-hidden="true" />}
        >
          New API key
        </Button>
      </div>

      {keys.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : (keys.data ?? []).length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No API keys"
          description="Issue a key only when an external system genuinely needs programmatic access."
        />
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-line">
            {(keys.data ?? []).map((key) => (
              <li key={key.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5">
                <div className="min-w-0">
                  <p className="font-medium text-ink">{key.name}</p>
                  <p className="mt-0.5 font-mono text-xs text-muted">{key.keyPrefix}…</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {key.lastUsedAt ? `Last used ${formatDateTime(key.lastUsedAt)}` : "Never used"}
                    {key.expiresAt ? ` · expires ${formatDateTime(key.expiresAt)}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={key.revokedAt ? "neutral" : "success"}>
                    {key.revokedAt ? "revoked" : "active"}
                  </Badge>
                  {key.revokedAt ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setRevokeId(key.id)}
                      leadingIcon={<Trash2 className="size-4" aria-hidden="true" />}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Create an API key"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              busy={create.isPending}
              onClick={() =>
                create.mutate({
                  name: name.trim(),
                  scopes: scopes
                    .split(",")
                    .map((scope) => scope.trim())
                    .filter(Boolean),
                  expiresInDays: expiresInDays ? Number(expiresInDays) : null,
                })
              }
            >
              Create key
            </Button>
          </>
        }
      >
        {formError ? <Alert tone="danger">{formError}</Alert> : null}
        <div className="mt-4 space-y-4">
          <Input
            label="Name"
            help="Describe the system that will use the key."
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
          <Input
            label="Scopes"
            help="Comma separated. Leave blank for read-only access."
            value={scopes}
            onChange={(event) => setScopes(event.target.value)}
          />
          <Input
            label="Expires in (days)"
            help="Leave blank for a non-expiring key, though a finite lifetime is safer."
            type="number"
            min={1}
            max={3_650}
            value={expiresInDays}
            onChange={(event) => setExpiresInDays(event.target.value)}
          />
        </div>
      </Modal>

      <Modal
        open={issued !== null}
        onClose={() => setIssued(null)}
        title="Your new API key"
        description="Copy it now. It cannot be displayed again."
        footer={<Button onClick={() => setIssued(null)}>I have stored it safely</Button>}
      >
        <code className="mt-2 block break-all rounded border border-line bg-surface-soft px-3 py-2.5 font-mono text-sm text-ink">
          {issued}
        </code>
        <Button
          className="mt-3"
          size="sm"
          variant="outline"
          onClick={() => {
            if (issued) void navigator.clipboard.writeText(issued);
            toast.success("Copied to clipboard");
          }}
        >
          Copy key
        </Button>
      </Modal>

      <ConfirmDialog
        open={revokeId !== null}
        onClose={() => setRevokeId(null)}
        onConfirm={() => {
          if (revokeId) revoke.mutate({ id: revokeId });
        }}
        title="Revoke this API key?"
        message="Any system using it will lose access immediately."
        confirmLabel="Revoke key"
        variant="danger"
        busy={revoke.isPending}
      />
    </>
  );
}

function SamlPanel() {
  const toast = useToast();
  const config = trpc.adminSecurity.samlConfig.useQuery();
  const mfaSource = trpc.adminSecurity.samlAdministratorMfaSource.useQuery();
  const [mfaDraft, setMfaDraft] = useState<{ source: "local" | "entra" | "both"; claimName: string; requiredValue: string } | null>(null);
  const [mfaConfirmation, setMfaConfirmation] = useState("");
  const [draft, setDraft] = useState<{
    name: string;
    enabled: boolean;
    entryPoint: string;
    issuer: string;
    idpCertificate: string;
    signatureAlgorithm: string;
    defaultRole: string;
    autoProvision: boolean;
  } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const upsert = trpc.adminSecurity.upsertSamlConfig.useMutation({
    async onSuccess() {
      await config.refetch();
      setDraft(null);
      toast.success("SAML configuration saved");
    },
    onError(error) {
      setFormError(errorMessage(error));
    },
  });
  const updateMfaSource = trpc.adminSecurity.updateSamlAdministratorMfaSource.useMutation({
    async onSuccess(result) {
      await mfaSource.refetch();
      setMfaDraft(null);
      setMfaConfirmation("");
      toast.success(result.source === "local" ? "SAML administrators will use ReadyPackets MFA" : `SAML administrator MFA source set to ${result.source}`);
    },
    onError(error) {
      setFormError(errorMessage(error));
    },
  });

  if (config.isLoading || mfaSource.isLoading) return <Skeleton className="h-64 w-full" />;

  const current = config.data;
  const currentMfa: { source: "local" | "entra" | "both"; claimName: string; requiredValue: string } = {
    source: (mfaSource.data?.source ?? "local") as "local" | "entra" | "both",
    claimName: mfaSource.data?.claimName ?? "http://schemas.microsoft.com/claims/authnmethodsreferences",
    requiredValue: mfaSource.data?.requiredValue ?? "http://schemas.microsoft.com/claims/multipleauthn",
  };
  const mfaForm = mfaDraft ?? currentMfa;
  const form =
    draft ??
    {
      name: current?.name ?? "Corporate identity provider",
      enabled: current?.enabled ?? false,
      entryPoint: current?.entryPoint ?? "",
      issuer: current?.issuer ?? "",
      idpCertificate: "",
      signatureAlgorithm: current?.signatureAlgorithm ?? "sha256",
      defaultRole: current?.defaultRole ?? "customer",
      autoProvision: current?.autoProvision ?? false,
    };

  return (
    <Card>
      <CardHeader
        title="SAML 2.0 single sign-on"
        description="Optional. Lets enterprise clients authenticate through their own identity provider instead of a local password."
        actions={
          <Badge tone={current?.enabled ? "success" : "neutral"}>
            {current?.enabled ? "enabled" : "disabled"}
          </Badge>
        }
      />

      {formError ? <Alert tone="danger" className="mt-4">{formError}</Alert> : null}

      <div className="mt-5 space-y-4">
        <Input
          label="Display name"
          value={form.name}
          onChange={(event) => setDraft({ ...form, name: event.target.value })}
        />
        <Input
          label="Sign-in URL (entry point)"
          type="url"
          value={form.entryPoint}
          onChange={(event) => setDraft({ ...form, entryPoint: event.target.value })}
          placeholder="https://idp.example.com/sso/saml"
        />
        <Input
          label="Issuer (entity ID)"
          value={form.issuer}
          onChange={(event) => setDraft({ ...form, issuer: event.target.value })}
        />
        <Textarea
          label="Identity provider certificate"
          help="PEM-encoded X.509 certificate used to verify assertion signatures."
          rows={8}
          value={form.idpCertificate}
          onChange={(event) => setDraft({ ...form, idpCertificate: event.target.value })}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Signature algorithm"
            value={form.signatureAlgorithm}
            onChange={(event) => setDraft({ ...form, signatureAlgorithm: event.target.value })}
            options={[
              { value: "sha256", label: "SHA-256" },
              { value: "sha512", label: "SHA-512" },
            ]}
          />
          <Select
            label="Default role for new users"
            value={form.defaultRole}
            onChange={(event) => setDraft({ ...form, defaultRole: event.target.value })}
            options={[
              { value: "customer", label: "Customer" },
              { value: "staff", label: "Staff" },
              { value: "admin", label: "Administrator" },
            ]}
          />
        </div>
        <Checkbox
          label="Create an account automatically on first successful assertion"
          checked={form.autoProvision}
          onChange={(event) => setDraft({ ...form, autoProvision: event.target.checked })}
        />
        <Checkbox
          label="Enable SAML sign-in"
          checked={form.enabled}
          onChange={(event) => setDraft({ ...form, enabled: event.target.checked })}
        />

        <Alert tone="info">
          New SAML accounts receive this role only when automatic provisioning is enabled. SAML is treated as the primary factor; every successful SAML account uses the MFA-source policy configured below before receiving portal access.
        </Alert>

        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900/40">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-semibold text-slate-900 dark:text-white">SAML SSO MFA source</p>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Choose whether every validated SAML SSO sign-in uses ReadyPackets MFA, Microsoft Entra MFA assurance, or both. Password and magic-link sign-ins keep their existing MFA policy.</p>
            </div>
            <Badge tone={mfaForm.source === "local" ? "neutral" : mfaForm.source === "entra" ? "success" : "warning"}>
              {mfaForm.source === "local" ? "ReadyPackets local MFA" : mfaForm.source === "entra" ? "Entra-managed SSO MFA" : "Entra + local MFA"}
            </Badge>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <Select
              label="MFA source"
              value={mfaForm.source}
              onChange={(event) => setMfaDraft({ ...mfaForm, source: event.target.value as "local" | "entra" | "both" })}
              options={[
                { value: "local", label: "ReadyPackets local MFA after SSO" },
                { value: "entra", label: "Microsoft Entra-managed MFA — no local prompt" },
                { value: "both", label: "Require both Entra and local MFA" },
              ]}
            />
            <Input
              label="Signed MFA claim name"
              value={mfaForm.claimName}
              disabled={mfaForm.source === "local"}
              onChange={(event) => setMfaDraft({ ...mfaForm, claimName: event.target.value })}
            />
            <Input
              label="Required claim value"
              value={mfaForm.requiredValue}
              disabled={mfaForm.source === "local"}
              onChange={(event) => setMfaDraft({ ...mfaForm, requiredValue: event.target.value })}
            />
          </div>
          {mfaForm.source === "entra" || mfaForm.source === "both" ? (
            <>
              <Alert tone="warning" className="mt-4">
                Entra trust is accepted only for a validated signed SAML assertion containing the configured assurance claim. Configure Microsoft Entra Conditional Access to require MFA for this enterprise application and retain a separate local break-glass administrator before enabling this mode. This policy applies to every SAML SSO user.
              </Alert>
              <Input
                className="mt-4"
                label="Type TRUST ENTRA MFA to save this mode"
                value={mfaConfirmation}
                onChange={(event) => setMfaConfirmation(event.target.value)}
              />
            </>
          ) : null}
          <Button
            className="mt-4"
            variant={mfaForm.source === "local" ? "secondary" : "danger"}
            busy={updateMfaSource.isPending}
            onClick={() => {
              setFormError(null);
              updateMfaSource.mutate({
                source: mfaForm.source,
                claimName: mfaForm.claimName.trim(),
                requiredValue: mfaForm.requiredValue.trim(),
                confirmation: mfaConfirmation,
              });
            }}
          >
            Save SAML SSO MFA source
          </Button>
        </div>

        <Button
          busy={upsert.isPending}
          onClick={() => {
            setFormError(null);
            upsert.mutate({
              name: form.name.trim(),
              enabled: form.enabled,
              entryPoint: form.entryPoint.trim(),
              issuer: form.issuer.trim(),
              idpCertificate: form.idpCertificate.trim(),
              signatureAlgorithm: form.signatureAlgorithm as never,
              defaultRole: form.defaultRole as never,
              autoProvision: form.autoProvision,
            });
          }}
          leadingIcon={<Save className="size-4" aria-hidden="true" />}
        >
          Save configuration
        </Button>
      </div>
    </Card>
  );
}

function AdministratorOnlyAccessPanel() {
  const toast = useToast();
  const config = trpc.adminSecurity.administratorOnlyAccess.useQuery();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const enabled = config.data?.enabled ?? false;
  const update = trpc.adminSecurity.updateAdministratorOnlyAccess.useMutation({
    async onSuccess(result) {
      setOpen(false);
      setConfirmation("");
      await config.refetch();
      toast.success(result.enabled ? "Administrator-only access enabled" : "Administrator-only access disabled");
    },
    onError(error) { toast.error("Could not update administrator-only access", errorMessage(error)); },
  });

  if (config.isLoading) return <Skeleton className="mb-6 h-48 w-full" />;

  return <Card className="mb-6">
    <CardHeader
      title="Administrator-only access"
      description="Emergency access mode that admits only active administrators. It is separate from maintenance mode and applies to password, SSO, magic-link, registration, and existing sessions."
      actions={<Badge tone={enabled ? "warning" : "success"}>{enabled ? "administrator-only active" : "normal access"}</Badge>}
    />
    <div className="mt-5 space-y-4">
      <Alert tone={enabled ? "danger" : "warning"} title={enabled ? "Customer and staff access is blocked" : "Use only for controlled launch or incident response"}>
        {enabled
          ? "Existing non-administrator sessions are revoked on their next request. Only active administrator accounts can complete sign-in, and administrator MFA remains required."
          : "Before enabling this gate, confirm that at least two active administrators have enrolled MFA and have verified their ability to sign in."}
      </Alert>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-xs leading-relaxed text-muted">Public registration, customer magic links, non-administrator password sign-ins, and non-administrator SSO completion are blocked while this mode is active.</p>
        <Button variant={enabled ? "outline" : "danger"} onClick={() => setOpen(true)} leadingIcon={<LockKeyhole className="size-4" aria-hidden="true" />}>
          {enabled ? "Disable administrator-only access" : "Enable administrator-only access"}
        </Button>
      </div>
    </div>
    <Modal
      open={open}
      onClose={() => { if (!update.isPending) { setOpen(false); setConfirmation(""); } }}
      title={enabled ? "Disable administrator-only access?" : "Enable administrator-only access?"}
      description={enabled ? "Normal eligible customer and staff sign-in paths will be restored. Existing session and account policies remain unchanged." : "This immediately restricts ReadyPackets to active administrator accounts and revokes non-administrator sessions when they next make a request."}
      footer={<><Button variant="outline" disabled={update.isPending} onClick={() => { setOpen(false); setConfirmation(""); }}>Cancel</Button><Button variant={enabled ? "primary" : "danger"} busy={update.isPending} disabled={!enabled && confirmation !== "ADMINISTRATOR ONLY"} onClick={() => update.mutate({ enabled: !enabled, confirmation: enabled ? undefined : confirmation })}>{enabled ? "Restore normal access" : "Enable administrator-only access"}</Button></>}
    >
      {!enabled ? <Input label="Type ADMINISTRATOR ONLY to confirm" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /> : <Alert tone="info">Administrators remain protected by their configured MFA policy after normal access is restored.</Alert>}
    </Modal>
  </Card>;
}

function MaintenanceAccessPanel() {
  const toast = useToast();
  const config = trpc.adminSecurity.maintenanceConfig.useQuery();
  const [draft, setDraft] = useState<{ enabled: boolean; blocksLogin: boolean; blocksRegistration: boolean; showOnHomepage: boolean; message: string; estimatedCompletion: string } | null>(null);
  useEffect(() => { if (config.data) setDraft(config.data); }, [config.data]);
  const update = trpc.adminSecurity.updateMaintenanceConfig.useMutation({
    async onSuccess() { await config.refetch(); toast.success("Maintenance controls saved", "The selected public, login, and registration gates are now active."); },
    onError(error) { toast.error("Could not save maintenance controls", errorMessage(error)); },
  });
  if (config.isLoading || !draft) return <Skeleton className="mb-6 h-80 w-full" />;
  return <Card className="mb-6"><CardHeader title="Maintenance access controls" description="Use a planned maintenance window to gate the public website, sign-in, and new-account creation. Maintenance allowlist entries continue to bypass the login and registration gates." actions={<Badge tone={draft.enabled ? "warning" : "success"}>{draft.enabled ? "maintenance active" : "normal operation"}</Badge>} />
    <div className="mt-5 space-y-4"><Alert tone="warning" title="Use with care">When enabling a login gate, keep your administrator address in the maintenance allowlist before saving. Existing browser sessions are not forcibly revoked.</Alert><Textarea label="Maintenance message" rows={3} value={draft.message} onChange={(event) => setDraft({ ...draft, message: event.target.value })} /><Input label="Estimated completion (optional)" placeholder="Example: 2026-08-13 02:00 UTC" value={draft.estimatedCompletion} onChange={(event) => setDraft({ ...draft, estimatedCompletion: event.target.value })} /><div className="grid gap-3 sm:grid-cols-2"><Checkbox label="Enable maintenance mode" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><Checkbox label="Show the maintenance notice on the public website" checked={draft.showOnHomepage} onChange={(event) => setDraft({ ...draft, showOnHomepage: event.target.checked })} /><Checkbox label="Restrict new logins during maintenance" checked={draft.blocksLogin} onChange={(event) => setDraft({ ...draft, blocksLogin: event.target.checked })} /><Checkbox label="Restrict new account creation during maintenance" checked={draft.blocksRegistration} onChange={(event) => setDraft({ ...draft, blocksRegistration: event.target.checked })} /></div><div className="flex justify-end"><Button busy={update.isPending} onClick={() => update.mutate(draft)} leadingIcon={<Save className="size-4" aria-hidden="true" />}>Save maintenance controls</Button></div></div>
  </Card>;
}

function MaintenancePanel() {
  const toast = useToast();
  const backups = trpc.adminSecurity.backups.useQuery();
  const [retentionDays, setRetentionDays] = useState("365");
  const [pruneOpen, setPruneOpen] = useState(false);

  const retryEmails = trpc.adminSecurity.retryFailedEmails.useMutation({
    onSuccess(result) {
      toast.success(
        "Failed messages requeued",
        `${result.requeued} message${result.requeued === 1 ? "" : "s"} will be retried.`,
      );
    },
    onError(error) {
      toast.error("Could not requeue messages", errorMessage(error));
    },
  });

  const pruneLogs = trpc.adminSecurity.pruneLogs.useMutation({
    onSuccess(result) {
      setPruneOpen(false);
      toast.success("Logs pruned", `${result.securityLogs + result.activityLogs + result.emailLog} record(s) removed.`);
    },
    onError(error) {
      toast.error("Could not prune logs", errorMessage(error));
    },
  });

  return (
    <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
      <Card>
        <CardHeader
          title="Email queue"
          description="Requeue messages that failed delivery, for example after an SMTP outage."
        />
        <Button
          className="mt-4"
          variant="outline"
          busy={retryEmails.isPending}
          onClick={() => retryEmails.mutate()}
          leadingIcon={<RefreshCw className="size-4" aria-hidden="true" />}
        >
          Retry failed messages
        </Button>
      </Card>

      <Card>
        <CardHeader
          title="Log retention"
          description="Remove log records older than the retention window. Security logs are the last line of evidence, so prune conservatively."
        />
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Input
            label="Retention (days)"
            type="number"
            min={7}
            max={3_650}
            className="sm:w-40"
            value={retentionDays}
            onChange={(event) => setRetentionDays(event.target.value)}
          />
          <Button variant="outline" onClick={() => setPruneOpen(true)}>
            Prune logs
          </Button>
        </div>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader
          title="Backup history"
          description="Recorded by the backup script shipped with the deployment tooling."
        />
        {backups.isLoading ? (
          <Skeleton className="mt-4 h-32 w-full" />
        ) : (backups.data ?? []).length === 0 ? (
          <Alert tone="info" className="mt-4">
            No backup runs have been recorded yet. Schedule <code>scripts/ops/backup.sh</code> from
            cron and it will register each run here.
          </Alert>
        ) : (
          <ul className="mt-4 divide-y divide-line">
            {(backups.data ?? []).map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium text-ink">
                    <Badge
                      tone={
                        entry.status === "success"
                          ? "success"
                          : entry.status === "failed"
                            ? "danger"
                            : "warning"
                      }
                    >
                      {entry.status}
                    </Badge>
                    {entry.backupType}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-xs text-muted">
                    {entry.location ?? "location not recorded"}
                  </p>
                </div>
                <div className="text-right text-xs text-muted">
                  <p>{formatDateTime(entry.startedAt)}</p>
                  {entry.sizeBytes ? <p>{formatBytes(Number(entry.sizeBytes))}</p> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={pruneOpen}
        onClose={() => setPruneOpen(false)}
        onConfirm={() => pruneLogs.mutate({ retentionDays: Number(retentionDays) })}
        title="Prune log records?"
        message={`Records older than ${retentionDays} days will be deleted permanently. This cannot be undone, and it may reduce your ability to investigate historical incidents.`}
        confirmLabel="Prune logs"
        variant="danger"
        busy={pruneLogs.isPending}
      />
    </div>
  );
}

function LaunchCountdownPanel() {
  const toast = useToast();
  const utils = trpc.useUtils();

  const flags = trpc.adminSecurity.featureFlags.useQuery();
  const countdownEnabled = (flags.data ?? []).find((f) => f.key === "launch_countdown")?.enabled ?? false;

  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [loaded, setLoaded] = useState(false);

  const settings = trpc.adminSecurity.getSettings.useQuery({ category: "launch" });

  // Populate form fields once settings load.
  useEffect(() => {
    if (!loaded && settings.data) {
      setTitle(settings.data.find((s) => s.key === "launch.countdown_title")?.value ?? "Coming Soon");
      setMessage(settings.data.find((s) => s.key === "launch.countdown_message")?.value ?? "");
      setTargetDate(settings.data.find((s) => s.key === "launch.countdown_target")?.value ?? "");
      setLoaded(true);
    }
  }, [loaded, settings.data]);

  const updateSetting = trpc.adminSecurity.updateSetting.useMutation();

  const setFlag = trpc.adminSecurity.setFeatureFlag.useMutation({
    async onSuccess() {
      await flags.refetch();
      toast.success("Countdown updated");
    },
  });

  const handleSave = async () => {
    await Promise.all([
      updateSetting.mutateAsync({ key: "launch.countdown_title", value: title }),
      updateSetting.mutateAsync({ key: "launch.countdown_message", value: message }),
      updateSetting.mutateAsync({ key: "launch.countdown_target", value: targetDate }),
    ]);
    toast.success("Launch countdown settings saved");
  };

  // Live countdown display
  const [now, setNow] = useState(Date.now());
  const target = targetDate ? new Date(targetDate).getTime() : null;
  const diff = target ? Math.max(0, target - now) : null;
  const days = diff !== null ? Math.floor(diff / 86400000) : null;
  const hours = diff !== null ? Math.floor((diff % 86400000) / 3600000) : null;
  const minutes = diff !== null ? Math.floor((diff % 3600000) / 60000) : null;
  const seconds = diff !== null ? Math.floor((diff % 60000) / 1000) : null;

  return (
    <div className="space-y-6">
      <Alert tone="info" title="Launch countdown">
        When enabled, a countdown banner is shown on the public homepage and login page.
        Admins and staff can always bypass it. Configure the target date, title, and message below.
      </Alert>

      <Card>
        <CardHeader
          title="Countdown status"
          actions={
            <Button
              size="sm"
              variant={countdownEnabled ? "outline" : "primary"}
              busy={setFlag.isPending}
              onClick={() => setFlag.mutate({ key: "launch_countdown", enabled: !countdownEnabled })}
            >
              {countdownEnabled ? "Disable countdown" : "Enable countdown"}
            </Button>
          }
        />
        {countdownEnabled && target && diff !== null && diff > 0 ? (
          <div className="mt-4 flex gap-4 text-center">
            {[
              { label: "Days", value: days },
              { label: "Hours", value: hours },
              { label: "Minutes", value: minutes },
              { label: "Seconds", value: seconds },
            ].map(({ label, value }) => (
              <div key={label} className="flex-1 rounded-lg bg-surface-raised p-3">
                <p className="text-2xl font-bold tabular-nums text-ink">{String(value).padStart(2, "0")}</p>
                <p className="text-xs text-muted">{label}</p>
              </div>
            ))}
          </div>
        ) : countdownEnabled && diff === 0 ? (
          <p className="mt-4 text-sm text-success font-medium">🎉 Launch date has passed!</p>
        ) : (
          <p className="mt-4 text-sm text-muted">Countdown is currently disabled.</p>
        )}
      </Card>

      <Card>
        <CardHeader title="Countdown settings" />
        <div className="mt-4 space-y-4">
          <Input
            label="Launch date & time"
            type="datetime-local"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
            help="The countdown will reach zero at this date and time (your local timezone)."
          />
          <Input
            label="Countdown title"
            placeholder="Coming Soon"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Textarea
            label="Message"
            rows={3}
            placeholder="We are launching soon. Stay tuned!"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="flex justify-end">
            <Button
              variant="primary"
              busy={updateSetting.isPending}
              leadingIcon={<Save className="size-4" />}
              onClick={handleSave}
            >
              Save countdown settings
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function IntakeControlsPanel() {
  const toast = useToast();
  const settings = trpc.adminSecurity.getSettings.useQuery({ category: "intake" });
  const [maxDocuments, setMaxDocuments] = useState("5");
  const [allowedTypes, setAllowedTypes] = useState(".pdf,.doc,.docx,.txt");
  const [maxPitchRecordings, setMaxPitchRecordings] = useState("1");
  const [maxPitchLengthSeconds, setMaxPitchLengthSeconds] = useState("300");
  const [microphonePreflightEnabled, setMicrophonePreflightEnabled] = useState(true);

  useEffect(() => {
    if (!settings.data) return;
    const values = new Map(settings.data.map((entry) => [entry.key, entry.value]));
    setMaxDocuments(values.get("intake.max_documents") || "5");
    setAllowedTypes(values.get("intake.allowed_document_types") || ".pdf,.doc,.docx,.txt");
    setMaxPitchRecordings(values.get("intake.max_pitch_recordings") || "1");
    setMaxPitchLengthSeconds(values.get("intake.max_pitch_length_seconds") || "300");
    setMicrophonePreflightEnabled(values.get("intake.microphone_preflight_enabled") !== "false");
  }, [settings.data]);

  const update = trpc.adminSecurity.updateSetting.useMutation();
  const save = async () => {
    const docCount = Number(maxDocuments);
    const pitchCount = Number(maxPitchRecordings);
    const pitchSeconds = Number(maxPitchLengthSeconds);
    if (!Number.isInteger(docCount) || docCount < 0 || docCount > 25) {
      toast.error("Invalid document limit", "Enter a whole number from 0 to 25.");
      return;
    }
    if (!Number.isInteger(pitchCount) || pitchCount < 0 || pitchCount > 10) {
      toast.error("Invalid recording limit", "Enter a whole number from 0 to 10.");
      return;
    }
    if (!Number.isInteger(pitchSeconds) || pitchSeconds < 15 || pitchSeconds > 3600) {
      toast.error("Invalid pitch length", "Enter a duration from 15 to 3,600 seconds.");
      return;
    }
    try {
      await Promise.all([
        update.mutateAsync({ key: "intake.max_documents", value: String(docCount) }),
        update.mutateAsync({ key: "intake.allowed_document_types", value: allowedTypes.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean).join(",") }),
        update.mutateAsync({ key: "intake.max_pitch_recordings", value: String(pitchCount) }),
        update.mutateAsync({ key: "intake.max_pitch_length_seconds", value: String(pitchSeconds) }),
        update.mutateAsync({ key: "intake.microphone_preflight_enabled", value: String(microphonePreflightEnabled) }),
      ]);
      await settings.refetch();
      toast.success("Intake controls saved", "The new limits apply to future intake uploads and submissions.");
    } catch (error) {
      toast.error("Could not save intake controls", errorMessage(error));
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
      <Card>
        <CardHeader
          title="Supporting documents"
          description="Limit the supporting documents each customer may attach to an order intake."
        />
        <div className="mt-4 space-y-4">
          <Input
            label="Maximum documents per intake"
            type="number"
            min={0}
            max={25}
            value={maxDocuments}
            onChange={(event) => setMaxDocuments(event.target.value)}
          />
          <Input
            label="Allowed file extensions"
            value={allowedTypes}
            onChange={(event) => setAllowedTypes(event.target.value)}
            help="Comma-separated. Files are also checked against the platform's server-side content validation."
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Business pitch recordings"
          description="Control browser-recorded or uploaded audio pitch submissions for each intake."
        />
        <div className="mt-4 space-y-4">
          <Input
            label="Maximum pitch recordings per intake"
            type="number"
            min={0}
            max={10}
            value={maxPitchRecordings}
            onChange={(event) => setMaxPitchRecordings(event.target.value)}
          />
          <Input
            label="Maximum recording length (seconds)"
            type="number"
            min={15}
            max={3600}
            value={maxPitchLengthSeconds}
            onChange={(event) => setMaxPitchLengthSeconds(event.target.value)}
            help="The browser stops in-app recordings at this duration."
          />
          <Checkbox
            label="Run microphone preflight before Business Pitch recording"
            checked={microphonePreflightEnabled}
            onChange={(event) => setMicrophonePreflightEnabled(event.target.checked)}
            help="When enabled, customers verify browser support, microphone permission, a live input track, and an approved recording format before they begin a pitch. Safari uses M4A/AAC when WebM is unavailable."
          />
        </div>
      </Card>

      <div className="lg:col-span-2 flex justify-end">
        <Button busy={update.isPending} onClick={() => void save()} leadingIcon={<Save className="size-4" />}>Save intake controls</Button>
      </div>
    </div>
  );
}
