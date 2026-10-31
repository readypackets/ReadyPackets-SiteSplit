import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, Download, FolderOpen, RefreshCw, ShieldCheck, Upload } from "lucide-react";
import { trpc, errorMessage } from "@/lib/trpc";
import { Button } from "@/components/ui/Button";
import { Checkbox, FieldShell, Input, Select, Textarea } from "@/components/ui/Field";
import { Alert, Badge, Card, CardHeader } from "@/components/ui/Surface";
import { PageHeader } from "@/components/layout/PortalLayout";
import { useToast } from "@/components/ui/Toast";

const steps = ["Welcome", "Email", "Microsoft Entra ID", "SharePoint sync", "Stripe", "Phase webhooks", "Access controls", "Backups", "Finish"];
const validPublicId = /^RP\d{2}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/i;

export function AdminPlatformSetupPage() {
  const toast = useToast();
  const utils = trpc.useUtils();
  const status = trpc.platformSetup.status.useQuery();
  const [step, setStep] = useState(0);
  const [transport, setTransport] = useState<"none" | "smtp" | "graph">("none");
  const [smtp, setSmtp] = useState({ host: "", port: "587", user: "", password: "", from: "no-reply@readypackets.com", replyTo: "", secure: false });
  const [graph, setGraph] = useState({ tenantId: "", clientId: "", clientSecret: "", sender: "" });
  const [entra, setEntra] = useState({ enabled: false, name: "Microsoft Entra ID", entryPoint: "", issuer: "", certificate: "", autoProvision: false, defaultRole: "staff" as "customer" | "staff" | "admin" });
  const [stripe, setStripe] = useState({ secretKey: "", publishableKey: "", webhookSecret: "" });
  const [p101, setP101] = useState({ enabled: false, url: "", secret: "" });
  const [p201, setP201] = useState({ enabled: false, url: "", secret: "" });
  const [ipText, setIpText] = useState("");
  const [loginWhitelistEnabled, setLoginWhitelistEnabled] = useState(false);
  const [loginWhitelistText, setLoginWhitelistText] = useState("");
  const [sharePoint, setSharePoint] = useState({ tenantId: "", clientId: "", clientSecret: "", siteId: "", driveId: "", siteUrl: "", rootFolderPath: "ReadyPackets/Orders", audioFallbackMode: "mp3" as "none" | "mp3" });
  const [sharePointLibraries, setSharePointLibraries] = useState<Array<{ id: string; name: string; webUrl: string | null; isDefault: boolean }>>([]);
  const [sharePointFolderPath, setSharePointFolderPath] = useState("");
  const [sharePointVerified, setSharePointVerified] = useState(false);
  const [backupScheduleTime, setBackupScheduleTime] = useState("02:30");
  const profileInput = useRef<HTMLInputElement>(null);
  const initialNonSecretValuesLoaded = useRef(false);

  useEffect(() => {
    if (!status.data || initialNonSecretValuesLoaded.current) return;
    initialNonSecretValuesLoaded.current = true;
    setSharePoint((value) => ({ ...value, ...status.data!.sharePoint }));
    setSharePointFolderPath(status.data.sharePoint.rootFolderPath);
    if (status.data.backupScheduleTime) setBackupScheduleTime(status.data.backupScheduleTime);
  }, [status.data]);

  const refresh = async () => { await utils.platformSetup.status.invalidate(); };
  const saveEmail = trpc.platformSetup.saveEmail.useMutation({ onSuccess: async () => { await refresh(); toast.success("Email configuration saved"); setStep(2); }, onError: (error) => toast.error("Email configuration could not be saved", errorMessage(error)) });
  const saveEntra = trpc.platformSetup.saveEntra.useMutation({ onSuccess: async () => { await refresh(); toast.success("Microsoft Entra ID configuration saved"); setStep(3); }, onError: (error) => toast.error("Microsoft Entra ID configuration could not be saved", errorMessage(error)) });
  const testSharePoint = trpc.integrations.testGraphConnection.useMutation({ onSuccess: (result) => { setSharePointVerified(true); toast.success("SharePoint read preflight passed", `${result.siteName} · ${result.driveName} · ${result.rootFolderPath}`); }, onError: (error) => { setSharePointVerified(false); toast.error("SharePoint connection test failed", errorMessage(error)); } });
  const saveSharePoint = trpc.platformSetup.saveSharePoint.useMutation({ onSuccess: async (result) => { await refresh(); setSharePoint((value) => ({ ...value, clientSecret: "" })); setSharePointFolderPath(result.rootFolderPath); setSharePointVerified(false); toast.success("SharePoint settings saved", "Running the read-only connection preflight now."); testSharePoint.mutate(); }, onError: (error) => toast.error("SharePoint settings could not be saved", errorMessage(error)) });
  const discoverSharePoint = trpc.integrations.discoverGraphConfig.useMutation({ onSuccess: (result) => { setSharePoint((value) => ({ ...value, siteId: result.siteId, driveId: result.driveId, siteUrl: result.siteUrl })); setSharePointLibraries(result.drives); setSharePointVerified(false); toast.success("SharePoint site and libraries discovered", `${result.siteName} · choose the document library to use.`); }, onError: (error) => toast.error("SharePoint discovery failed", errorMessage(error)) });
  const browseSharePointFolders = trpc.integrations.browseGraphFolders.useQuery({ path: sharePointFolderPath }, { enabled: step === 3 && Boolean(status.data?.sharePointReady), retry: false });
  const saveStripe = trpc.platformSetup.saveStripe.useMutation({ onSuccess: async () => { await refresh(); toast.success("Stripe configuration saved"); setStep(5); }, onError: (error) => toast.error("Stripe configuration could not be saved", errorMessage(error)) });
  const saveWebhooks = trpc.platformSetup.savePhaseWebhooks.useMutation({ onSuccess: async () => { await refresh(); toast.success("Phase webhook configuration saved"); setStep(6); }, onError: (error) => toast.error("Phase webhooks could not be saved", errorMessage(error)) });
  const saveAccess = trpc.platformSetup.saveAccess.useMutation({ onSuccess: async () => { await refresh(); toast.success("Access controls saved"); setStep(7); }, onError: (error) => toast.error("Access controls could not be saved", errorMessage(error)) });
  const saveBackup = trpc.platformSetup.saveBackup.useMutation({ onSuccess: async () => { await refresh(); toast.success("Backup schedule saved"); setStep(8); }, onError: (error) => toast.error("Backup configuration could not be saved", errorMessage(error)) });
  const exportProfile = trpc.platformSetup.exportProfile.useMutation({
    onSuccess(profile) {
      const content = `${JSON.stringify(profile, null, 2)}\n`;
      const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "readypackets-platform-setup-profile-v1.json";
      link.click();
      URL.revokeObjectURL(url);
      toast.success("Platform Setup profile downloaded", "It contains no credentials, private keys, tokens, or passwords.");
    },
    onError: (error) => toast.error("Could not export setup profile", errorMessage(error)),
  });
  const importProfile = trpc.platformSetup.importProfile.useMutation({
    onSuccess(result) {
      void refresh();
      const followUp = [
        result.secretsRequired.length ? `Add or replace: ${result.secretsRequired.join(", ")}.` : "",
        result.backupTargetsRequireReconfiguration.length ? `Reconfigure credentials for backup target(s): ${result.backupTargetsRequireReconfiguration.join(", ")}.` : "",
        result.webhookDestinationConfigurationRequired ? "Re-enter and review phase webhook destinations before enabling them." : "",
        "Webhooks remain disabled until reviewed.",
      ].filter(Boolean).join(" ");
      toast.success("Platform Setup profile imported", followUp);
      setStep(1);
    },
    onError: (error) => toast.error("Could not import setup profile", errorMessage(error)),
  });
  const complete = trpc.platformSetup.complete.useMutation({ onSuccess: async () => { await refresh(); toast.success("Platform setup marked complete", "You can return to this wizard any time from the administrator menu."); }, onError: (error) => toast.error("Setup completion could not be saved", errorMessage(error)) });

  const next = () => setStep((value) => Math.min(value + 1, steps.length - 1));
  const previous = () => setStep((value) => Math.max(value - 1, 0));
  const stepLabel = `${step + 1} of ${steps.length}`;
  const parseLines = (value: string) => value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
  const importSetupProfile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 256 * 1024 || !file.name.toLowerCase().endsWith(".json")) {
      toast.error("Choose a Platform Setup JSON profile smaller than 256 KB.");
      return;
    }
    try {
      importProfile.mutate(JSON.parse(await file.text()));
    } catch {
      toast.error("The selected file is not valid JSON.");
    } finally {
      if (profileInput.current) profileInput.current.value = "";
    }
  };

  return <>
    <PageHeader title="Platform setup wizard" description="Configure essential ReadyPackets integrations and access controls from one guided administrator-only workflow." />
    <Alert tone="warning" className="mb-6" title="Keep a recovery path">Do not enable Microsoft Entra ID, an IP allowlist, or the account login whitelist until you have confirmed that your local administrator account and current address can still sign in.</Alert>
    <div className="mb-6 overflow-x-auto"><ol className="flex min-w-max items-center gap-2">{steps.map((label, index) => <li key={label} className={`flex items-center gap-2 ${index === step ? "text-teal-dark" : index < step ? "text-success" : "text-muted"}`}><span className={`flex size-7 items-center justify-center rounded-full border text-xs font-bold ${index === step ? "border-teal bg-teal text-white" : index < step ? "border-success bg-success text-white" : "border-line bg-surface"}`}>{index < step ? <CheckCircle2 className="size-4" /> : index + 1}</span><span className="text-sm font-medium">{label}</span>{index < steps.length - 1 ? <span className="mx-1 h-px w-7 bg-line" /> : null}</li>)}</ol></div>
    {status.data?.completedAt ? <Alert tone="success" className="mb-6" title="Initial setup previously completed">Completed {new Date(status.data.completedAt).toLocaleString()}. You can safely revisit and revise any configuration step.</Alert> : null}

    {step === 0 ? <Card><CardHeader title="Welcome to ReadyPackets setup" description="Configure integrations and access controls from one administrator-only workflow. Export a standard setup profile to reuse non-secret values on a future deployment." /><div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{[{ label: "Email", ready: status.data?.emailTransport !== "none" }, { label: "Entra", ready: status.data?.entraEnabled }, { label: "SharePoint sync", ready: status.data?.sharePointReady }, { label: "Stripe", ready: status.data?.stripeReady }, { label: "P101 webhook", ready: status.data?.p101Configured }, { label: "P201 webhook", ready: status.data?.p201Configured }, { label: "Backups", ready: status.data?.backupControlAvailable }, { label: "Login allowlist", ready: status.data?.loginWhitelistEnabled }].map((item) => <div key={item.label} className="flex items-center justify-between rounded-lg border border-line p-3"><span className="text-sm font-medium text-ink">{item.label}</span><Badge tone={item.ready ? "success" : "neutral"}>{item.ready ? "configured" : "optional"}</Badge></div>)}</div><Alert tone="info" className="mt-5" title="Portable setup profile">The JSON profile contains setup choices and identifiers only. It never contains passwords, client secrets, OAuth tokens, certificates, private keys, or current portal network settings. Re-enter secrets after importing and review Entra and access controls before enabling them.</Alert><input ref={profileInput} type="file" accept="application/json,.json" className="sr-only" onChange={(event) => { void importSetupProfile(event.target.files?.[0]); }} /><div className="mt-6 flex flex-wrap justify-between gap-3"><div className="flex gap-3"><Button variant="outline" busy={exportProfile.isPending} onClick={() => exportProfile.mutate()} leadingIcon={<Download className="size-4" />}>Download setup profile</Button><Button variant="outline" busy={importProfile.isPending} onClick={() => profileInput.current?.click()} leadingIcon={<Upload className="size-4" />}>Import setup profile</Button></div><Button onClick={next} trailingIcon={<ChevronRight className="size-4" />}>Start setup</Button></div></Card> : null}

    {step === 1 ? <Card><CardHeader title="Outbound email" description="Choose SMTP or Microsoft Graph. Select not configured only when you intentionally want to defer sending portal notifications." /><div className="mt-5 space-y-4"><FieldShell label="Delivery method"><Select value={transport} onChange={(event) => setTransport(event.target.value as typeof transport)} options={[{ value: "none", label: "Not configured yet" }, { value: "smtp", label: "SMTP" }, { value: "graph", label: "Microsoft Graph API" }]} /></FieldShell>{transport === "smtp" ? <div className="grid gap-4 sm:grid-cols-2"><Input label="SMTP host" value={smtp.host} onChange={(event) => setSmtp({ ...smtp, host: event.target.value })} placeholder="smtp.example.com" /><Input label="Port" type="number" value={smtp.port} onChange={(event) => setSmtp({ ...smtp, port: event.target.value })} /><Input label="Username" value={smtp.user} onChange={(event) => setSmtp({ ...smtp, user: event.target.value })} /><Input label="Password" type="password" value={smtp.password} onChange={(event) => setSmtp({ ...smtp, password: event.target.value })} placeholder="Leave blank to preserve an existing secret" /><Input label="From address" type="email" value={smtp.from} onChange={(event) => setSmtp({ ...smtp, from: event.target.value })} /><Input label="Reply-to address" type="email" value={smtp.replyTo} onChange={(event) => setSmtp({ ...smtp, replyTo: event.target.value })} /><Checkbox label="Use implicit TLS" checked={smtp.secure} onChange={(event) => setSmtp({ ...smtp, secure: event.target.checked })} /></div> : null}{transport === "graph" ? <div className="grid gap-4 sm:grid-cols-2"><Input label="Tenant ID" value={graph.tenantId} onChange={(event) => setGraph({ ...graph, tenantId: event.target.value })} /><Input label="Client ID" value={graph.clientId} onChange={(event) => setGraph({ ...graph, clientId: event.target.value })} /><Input label="Client secret" type="password" value={graph.clientSecret} onChange={(event) => setGraph({ ...graph, clientSecret: event.target.value })} placeholder="Leave blank to preserve an existing secret" /><Input label="Sender address" type="email" value={graph.sender} onChange={(event) => setGraph({ ...graph, sender: event.target.value })} /></div> : null}</div><WizardButtons onBack={previous} onSkip={next} skipLabel="Skip for now" onSave={() => saveEmail.mutate({ transport, smtp: { ...smtp, port: Number(smtp.port) || 587 }, graph })} busy={saveEmail.isPending} saveLabel="Save email setup" /></Card> : null}

    {step === 2 ? <Card><CardHeader title="Microsoft Entra ID" description="Configure SAML single sign-on. Keep this disabled until a local administrator sign-in and an Entra assertion are both tested." /><div className="mt-5 space-y-4"><Alert tone="info" title="Keep Portal and Entra URLs distinct">In Entra Basic SAML Configuration, use <code>{window.location.origin}/api/saml/metadata</code> as the Identifier, <code>{window.location.origin}/api/saml/acs</code> as the Reply URL, and <code>{window.location.origin}/api/saml/login</code> as the ReadyPackets Sign-on URL. The field below instead requires Entra’s Login URL from its Set up application pane.</Alert><Checkbox label="Enable Microsoft Entra ID sign-in after saving" checked={entra.enabled} onChange={(event) => setEntra({ ...entra, enabled: event.target.checked })} /><div className="grid gap-4 sm:grid-cols-2"><Input label="Configuration name" value={entra.name} onChange={(event) => setEntra({ ...entra, name: event.target.value })} /><Input label="Microsoft Entra Login URL (IdP SSO endpoint)" help="Copy Login URL from Entra’s Set up application pane. Do not enter ReadyPackets’ Sign-on URL here." type="url" value={entra.entryPoint} onChange={(event) => setEntra({ ...entra, entryPoint: event.target.value })} placeholder="https://login.microsoftonline.com/.../saml2" /><Input label="Microsoft Entra Identifier (IdP issuer)" help="Copy Microsoft Entra Identifier from Entra’s Set up application pane." value={entra.issuer} onChange={(event) => setEntra({ ...entra, issuer: event.target.value })} /><Select label="Automatic new-user role" value={entra.defaultRole} onChange={(event) => setEntra({ ...entra, defaultRole: event.target.value as typeof entra.defaultRole })} options={[{ value: "customer", label: "Customer" }, { value: "staff", label: "Staff" }, { value: "admin", label: "Administrator" }]} /><Checkbox label="Automatically provision assigned SAML users" checked={entra.autoProvision} onChange={(event) => setEntra({ ...entra, autoProvision: event.target.checked })} /></div><Textarea label="Base64 certificate" rows={7} value={entra.certificate} onChange={(event) => setEntra({ ...entra, certificate: event.target.value })} placeholder="Paste the certificate; leave blank only to retain the existing value." /></div><WizardButtons onBack={previous} onSkip={next} skipLabel="Skip for now" onSave={() => saveEntra.mutate(entra)} busy={saveEntra.isPending} saveLabel="Save Entra setup" /></Card> : null}


    {step === 3 ? (
      <Card>
        <CardHeader
          title="SharePoint site synchronization"
          description="Discover the selected SharePoint site, choose a document library, save the intended base folder, then run a read-only connection preflight."
        />
        <div className="mt-5 space-y-5">
          <Alert tone="info" title="Least-privilege connection">
            Use a Microsoft Graph application with tenant consent and an explicit write grant for this SharePoint site. Discovery and the connection test are read-only; synchronization later writes only below the base folder you select.
          </Alert>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Microsoft Entra tenant ID" value={sharePoint.tenantId} onChange={(event) => { setSharePoint({ ...sharePoint, tenantId: event.target.value }); setSharePointVerified(false); }} />
            <Input label="Application (client) ID" value={sharePoint.clientId} onChange={(event) => { setSharePoint({ ...sharePoint, clientId: event.target.value }); setSharePointVerified(false); }} />
            <Input label="Application client secret" type="password" value={sharePoint.clientSecret} onChange={(event) => { setSharePoint({ ...sharePoint, clientSecret: event.target.value }); setSharePointVerified(false); }} placeholder="Leave blank only to preserve an existing secret" />
            <Input label="SharePoint site URL" type="url" value={sharePoint.siteUrl} onChange={(event) => { setSharePoint({ ...sharePoint, siteUrl: event.target.value }); setSharePointLibraries([]); setSharePointVerified(false); }} placeholder="https://tenant.sharepoint.com/sites/ReadyPackets" />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              busy={discoverSharePoint.isPending}
              disabled={!sharePoint.tenantId || !sharePoint.clientId || !sharePoint.siteUrl || (!sharePoint.clientSecret && !status.data?.sharePointReady)}
              onClick={() => discoverSharePoint.mutate({ tenantId: sharePoint.tenantId || undefined, clientId: sharePoint.clientId || undefined, clientSecret: sharePoint.clientSecret || undefined, siteUrl: sharePoint.siteUrl })}
              leadingIcon={<RefreshCw className="size-4" aria-hidden="true" />}
            >
              Discover site & libraries
            </Button>
            <span className="text-xs text-muted">Discovery does not save settings or change SharePoint content.</span>
          </div>
          {sharePointLibraries.length > 0 ? (
            <FieldShell label="Document library" help="Choose the library that will contain the ReadyPackets customer and order hierarchy.">
              <Select value={sharePoint.driveId} onChange={(event) => { setSharePoint({ ...sharePoint, driveId: event.target.value }); setSharePointVerified(false); }}>
                {sharePointLibraries.map((library) => <option key={library.id} value={library.id}>{library.name}{library.isDefault ? " (default)" : ""}</option>)}
              </Select>
            </FieldShell>
          ) : null}
          <details className="rounded-lg border border-line bg-surface-soft p-4">
            <summary className="cursor-pointer font-semibold text-ink">Advanced recovery: enter known Site and library IDs</summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Input label="SharePoint site ID" value={sharePoint.siteId} onChange={(event) => { setSharePoint({ ...sharePoint, siteId: event.target.value }); setSharePointVerified(false); }} />
              <Input label="Document library / drive ID" value={sharePoint.driveId} onChange={(event) => { setSharePoint({ ...sharePoint, driveId: event.target.value }); setSharePointVerified(false); }} />
            </div>
          </details>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Existing base folder" help="Choose a folder above ReadyPackets customers. The portal never changes an existing folder while browsing or testing." value={sharePoint.rootFolderPath} onChange={(event) => { setSharePoint({ ...sharePoint, rootFolderPath: event.target.value }); setSharePointVerified(false); }} placeholder="RP_Intake_Raw/ReadyPackets" />
            <Select label="WebM audio fallback" value={sharePoint.audioFallbackMode} onChange={(event) => setSharePoint({ ...sharePoint, audioFallbackMode: event.target.value as "none" | "mp3" })} options={[{ value: "mp3", label: "Also upload an MP3 compatibility copy" }, { value: "none", label: "Keep original WebM only" }]} />
          </div>
          {status.data?.sharePointReady ? (
            <div className="rounded-lg border border-line p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-ink">Select existing sync folder</h3>
                  <p className="mt-1 text-sm text-body">Browsing is read-only. Save the form after selecting a folder to activate it.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => setSharePointFolderPath("")} leadingIcon={<FolderOpen className="size-4" aria-hidden="true" />}>Browse library root</Button>
                  <Button size="sm" variant="outline" busy={testSharePoint.isPending} onClick={() => testSharePoint.mutate()} leadingIcon={<RefreshCw className="size-4" aria-hidden="true" />}>Run read preflight</Button>
                </div>
              </div>
              {browseSharePointFolders.error ? <Alert tone="warning" className="mt-4">{errorMessage(browseSharePointFolders.error)}</Alert> : null}
              {browseSharePointFolders.data ? (
                <div className="mt-4 space-y-3">
                  <p className="text-sm text-body">Current folder: <code>{browseSharePointFolders.data.currentPath || "/"}</code></p>
                  <div className="flex flex-wrap gap-2">
                    {browseSharePointFolders.data.parentPath !== null ? <Button size="sm" variant="ghost" onClick={() => setSharePointFolderPath(browseSharePointFolders.data!.parentPath ?? "")}>Up one folder</Button> : null}
                    {browseSharePointFolders.data.currentPath ? <Button size="sm" variant="secondary" onClick={() => { setSharePoint({ ...sharePoint, rootFolderPath: browseSharePointFolders.data!.currentPath }); setSharePointVerified(false); }}>Use current folder as base</Button> : null}
                  </div>
                  {browseSharePointFolders.data.folders.length ? <div className="grid gap-2 sm:grid-cols-2">{browseSharePointFolders.data.folders.map((folder) => <Button key={folder.id} variant="outline" className="justify-start" onClick={() => setSharePointFolderPath(folder.path)} leadingIcon={<FolderOpen className="size-4" aria-hidden="true" />}>{folder.name}</Button>)}</div> : <p className="text-sm text-muted">No child folders are available here.</p>}
                </div>
              ) : null}
            </div>
          ) : <Alert tone="info">Save the discovered site, library, and an existing base-folder path once to unlock the read-only folder browser and connection preflight.</Alert>}
          {sharePointVerified ? <Alert tone="success">The configured site, library, and base folder passed the read-only Graph preflight.</Alert> : null}
        </div>
        <WizardButtons onBack={previous} onSkip={next} skipLabel="Continue to Stripe" onSave={() => saveSharePoint.mutate(sharePoint)} busy={saveSharePoint.isPending} saveLabel="Save & test SharePoint sync" />
      </Card>
    ) : null}


    {step === 4 ? <Card><CardHeader title="Stripe payments" description="Enter the Stripe API keys and webhook signing secret. The webhook secret is required before ReadyPackets treats a returned checkout as paid." /><div className="mt-5 grid gap-4 sm:grid-cols-2"><Input label="Secret key" type="password" value={stripe.secretKey} onChange={(event) => setStripe({ ...stripe, secretKey: event.target.value })} placeholder="sk_live_… or sk_test_…" /><Input label="Publishable key" value={stripe.publishableKey} onChange={(event) => setStripe({ ...stripe, publishableKey: event.target.value })} placeholder="pk_live_… or pk_test_…" /><Input className="sm:col-span-2" label="Webhook signing secret" type="password" value={stripe.webhookSecret} onChange={(event) => setStripe({ ...stripe, webhookSecret: event.target.value })} placeholder="whsec_…" /></div><Alert tone="info" className="mt-4">Register this webhook in Stripe: <code>{window.location.origin}/api/stripe/webhook</code></Alert><WizardButtons onBack={previous} onSkip={next} skipLabel="Skip for now" onSave={() => saveStripe.mutate(stripe)} busy={saveStripe.isPending} saveLabel="Save Stripe setup" /></Card> : null}

    {step === 5 ? <Card><CardHeader title="Phase-start webhooks" description="Optionally deliver signed P101 and P201 lifecycle payloads to downstream systems. Only HTTPS endpoints are accepted." /><div className="mt-5 grid gap-5 lg:grid-cols-2"><WebhookFields title="Phase I Start — P101" value={p101} onChange={setP101} /><WebhookFields title="Phase II Start — P201" value={p201} onChange={setP201} /></div><WizardButtons onBack={previous} onSkip={next} skipLabel="Skip for now" onSave={() => saveWebhooks.mutate({ p101: p101.enabled ? p101 : undefined, p201: p201.enabled ? p201 : undefined })} busy={saveWebhooks.isPending} saveLabel="Save phase webhooks" disabled={!p101.enabled && !p201.enabled} /></Card> : null}

    {step === 6 ? <Card><CardHeader title="IP and account login allowlists" description="IP allowlist entries are added with all-access scope. The optional account login whitelist blocks local password, customer magic-link, and SAML sign-in for accounts not listed." /><div className="mt-5 space-y-5"><Textarea label="IP addresses, CIDR blocks, or IPv4 ranges" help="Enter one per line. Examples: 203.0.113.8, 203.0.113.0/24, 203.0.113.10-203.0.113.25." rows={5} value={ipText} onChange={(event) => setIpText(event.target.value)} /><Checkbox label="Enable the account login whitelist" checked={loginWhitelistEnabled} onChange={(event) => setLoginWhitelistEnabled(event.target.checked)} /><Textarea label="Allowed public customer / user IDs" help="One ReadyPackets ID per line, for example RP26-2UH4D3OT. Include your current administrator ID before enabling the control." rows={5} value={loginWhitelistText} onChange={(event) => setLoginWhitelistText(event.target.value.toUpperCase())} /><Alert tone="warning">Do not enable the account login whitelist until the current administrator account’s public ID is included. Existing sessions remain active, but future sign-in will be restricted.</Alert></div><WizardButtons onBack={previous} onSkip={next} skipLabel="Skip for now" onSave={() => { const ids = parseLines(loginWhitelistText); const invalid = ids.find((id) => !validPublicId.test(id)); if (invalid) { toast.error("Invalid public customer / user ID", invalid); return; } saveAccess.mutate({ ipPatterns: parseLines(ipText), loginWhitelistEnabled, loginWhitelistPublicIds: ids }); }} busy={saveAccess.isPending} saveLabel="Save access controls" /></Card> : null}

    {step === 7 ? <Card><CardHeader title="Backup configuration" description="Choose the daily schedule for encrypted, verified self-hosted backups. Cloud targets and recovery operations remain available in Backup management after this wizard." /><div className="mt-5 space-y-4"><Alert tone={status.data?.backupControlAvailable ? "info" : "warning"} title={status.data?.backupControlAvailable ? "Protected backup controller available" : "Backup controller needs attention"}>{status.data?.backupControlAvailable ? "The schedule is enforced by a root-controlled local socket service. Backup archives, recovery history, and cloud credentials remain outside browser-accessible storage." : "The protected backup controller is unavailable. Apply the current installer update on the VPS before scheduling or running backups."}</Alert><Input label="Daily backup time (server local time)" type="time" value={backupScheduleTime} onChange={(event) => setBackupScheduleTime(event.target.value)} /></div><WizardButtons onBack={previous} onSkip={next} skipLabel="Skip for now" onSave={() => saveBackup.mutate({ scheduleTime: backupScheduleTime })} busy={saveBackup.isPending} disabled={!status.data?.backupControlAvailable} saveLabel="Save backup schedule" /></Card> : null}

    {step === 8 ? <Card><CardHeader title="Setup review" description="You can modify any section later from the relevant administrator workspace or by reopening this wizard." /><div className="mt-5 space-y-3">{[{ label: "Email delivery", value: status.data?.emailTransport === "none" ? "not configured" : status.data?.emailTransport }, { label: "Microsoft Entra ID", value: status.data?.entraEnabled ? "enabled" : "not enabled" }, { label: "SharePoint synchronization", value: status.data?.sharePointReady ? "configured" : "not configured" }, { label: "Stripe", value: status.data?.stripeReady ? "ready" : "not fully configured" }, { label: "Phase webhooks", value: `${status.data?.p101Configured ? "P101" : ""}${status.data?.p101Configured && status.data?.p201Configured ? ", " : ""}${status.data?.p201Configured ? "P201" : ""}` || "not configured" }, { label: "Backup controller", value: status.data?.backupControlAvailable ? "available" : "needs attention" }, { label: "Account login whitelist", value: status.data?.loginWhitelistEnabled ? "enabled" : "not enabled" }].map((item) => <div key={item.label} className="flex justify-between rounded-lg border border-line p-3"><span className="font-medium text-ink">{item.label}</span><span className="text-body">{item.value}</span></div>)}</div><div className="mt-6 flex flex-wrap justify-between gap-3"><Button variant="outline" onClick={() => setStep(0)} leadingIcon={<ChevronLeft className="size-4" />}>Review steps</Button><Button busy={complete.isPending} onClick={() => complete.mutate()} leadingIcon={<ShieldCheck className="size-4" />}>Mark setup complete</Button></div></Card> : null}
    <p className="mt-5 text-center text-xs text-muted">{stepLabel} · Setup changes are recorded in the activity trail. Secret values are not returned to the browser after saving.</p>
  </>;
}

function WizardButtons({ onBack, onSkip, onSave, busy, saveLabel, skipLabel, disabled = false }: { onBack: () => void; onSkip: () => void; onSave: () => void; busy: boolean; saveLabel: string; skipLabel: string; disabled?: boolean }) {
  return <div className="mt-6 flex flex-wrap justify-between gap-3"><Button variant="outline" onClick={onBack} leadingIcon={<ChevronLeft className="size-4" />}>Back</Button><div className="flex gap-3"><Button variant="ghost" onClick={onSkip}>{skipLabel}</Button><Button onClick={onSave} busy={busy} disabled={disabled} trailingIcon={<ChevronRight className="size-4" />}>{saveLabel}</Button></div></div>;
}

function WebhookFields({ title, value, onChange }: { title: string; value: { enabled: boolean; url: string; secret: string }; onChange: (value: { enabled: boolean; url: string; secret: string }) => void }) {
  return <div className="rounded-lg border border-line p-4"><h3 className="font-semibold text-ink">{title}</h3><div className="mt-4 space-y-4"><Checkbox label="Enable this phase-start webhook" checked={value.enabled} onChange={(event) => onChange({ ...value, enabled: event.target.checked })} /><Input label="Destination URL" type="url" disabled={!value.enabled} value={value.url} onChange={(event) => onChange({ ...value, url: event.target.value })} placeholder="https://automation.example.com/webhooks/readypackets" /><Input label="HMAC secret" type="password" disabled={!value.enabled} value={value.secret} onChange={(event) => onChange({ ...value, secret: event.target.value })} placeholder="Leave blank to preserve an existing secret" /></div></div>;
}
