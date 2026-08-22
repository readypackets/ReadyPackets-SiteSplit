/**
 * Admin Integrations page.
 *
 * Covers: webhook endpoints, webhook delivery log, phase kickoff configuration,
 * phase job monitoring, SharePoint/Graph configuration status, and SAML SSO.
 */
import { useEffect, useState } from "react";
import { trpc } from "../../lib/trpc";
import { Card } from "../../components/ui/Surface";
import { Button } from "../../components/ui/Button";
import { FieldShell as Field, Input, Select } from "../../components/ui/Field";
import { Tabs } from "../../components/ui/DataDisplay";
import { ConfirmDialog, Modal } from "../../components/ui/Modal";
import { useToast } from "../../components/ui/Toast";

// ---------------------------------------------------------------------------
// Webhook endpoints tab
// ---------------------------------------------------------------------------

function WebhooksTab() {
  const { data: endpoints, refetch } = trpc.integrations.webhookEndpoints.useQuery();
  const upsert = trpc.integrations.upsertWebhookEndpoint.useMutation({ onSuccess: () => { refetch(); setOpen(false); } });
  const del = trpc.integrations.deleteWebhookEndpoint.useMutation({ onSuccess: () => refetch() });
  const test = trpc.integrations.testWebhookEndpoint.useMutation();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<NonNullable<typeof endpoints>[0] | null>(null);
  const [form, setForm] = useState({ name: "", url: "", events: "*", secret: "", enabled: true });

  function openNew() {
    setEditing(null);
    setForm({ name: "", url: "", events: "*", secret: "", enabled: true });
    setOpen(true);
  }

  function openEdit(ep: NonNullable<typeof endpoints>[0]) {
    setEditing(ep);
    const evts = ep.events as string[] | null;
    setForm({ name: ep.name, url: ep.url, events: evts?.join(", ") ?? "*", secret: "", enabled: ep.enabled });
    setOpen(true);
  }

  async function save() {
    try {
      await upsert.mutateAsync({
        id: editing?.id,
        name: form.name,
        url: form.url,
        events: form.events.split(",").map(e => e.trim()).filter(Boolean),
        secret: form.secret || undefined,
        enabled: form.enabled,
      });
      toast.success("Webhook endpoint saved.");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to save.");
    }
  }

  async function sendTest(id: number) {
    try {
      const result = await test.mutateAsync({ endpointId: id });
      if (result.success) {
        toast.success(`Test delivered (HTTP ${result.statusCode}).`);
      } else {
        toast.error(result.message);
      }
    } catch (e: any) {
      toast.error(e.message ?? "Test failed.");
    }
  }

  return (
    <div>
      <PhaseStartWebhookConfigPanel />
      <div className="flex justify-end mb-4 mt-6">
        <Button size="sm" onClick={openNew}>Add endpoint</Button>
      </div>

      <div className="space-y-3">
        {endpoints?.map((ep) => (
          <Card key={ep.id} className="flex items-start justify-between">
            <div>
              <p className="font-medium text-brand-navy">{ep.name}</p>
              <p className="text-sm font-mono text-gray-600 mt-0.5 break-all">{ep.url}</p>
              <p className="text-xs text-gray-400 mt-1">
                Events: {(ep.events as string[] | null)?.join(", ") ?? "*"} ·{" "}
                <span className={ep.enabled ? "text-green-700" : "text-gray-400"}>
                  {ep.enabled ? "Enabled" : "Disabled"}
                </span>
              </p>
            </div>
            <div className="flex gap-2 ml-4 shrink-0">
              <Button size="sm" variant="ghost" onClick={() => sendTest(ep.id)}>Test</Button>
              <Button size="sm" variant="ghost" onClick={() => openEdit(ep)}>Edit</Button>
              <Button size="sm" variant="ghost" onClick={() => del.mutate({ id: ep.id })} className="text-red-600">Delete</Button>
            </div>
          </Card>
        ))}
        {!endpoints?.length && (
          <p className="text-center text-gray-400 py-8">No webhook endpoints configured.</p>
        )}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? "Edit endpoint" : "New webhook endpoint"}>
        <div className="space-y-4">
          <Field label="Name">
            <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          </Field>
          <Field label="URL">
            <Input type="url" value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="https://your-server.com/webhook" />
          </Field>
          <Field label="Events (comma-separated, * for all)">
            <Input value={form.events} onChange={e => setForm(f => ({ ...f, events: e.target.value }))} placeholder="order.phase_changed, *" />
          </Field>
          <Field label="Secret (leave blank to keep existing)">
            <Input type="password" value={form.secret} onChange={e => setForm(f => ({ ...f, secret: e.target.value }))} placeholder="Optional HMAC signing secret" />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} />
            Enabled
          </label>
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={save} busy={upsert.isPending}>Save</Button>
        </div>
      </Modal>
    </div>
  );
}

function PhaseStartWebhookConfigPanel() {
  const toast = useToast();
  const configs = trpc.integrations.phaseStartWebhookConfigs.useQuery();
  const save = trpc.integrations.savePhaseStartWebhookConfig.useMutation({
    onSuccess: async () => {
      await configs.refetch();
      toast.success("Phase-start webhook saved", "The next matching phase kickoff will queue a signed payload to this URL.");
    },
    onError: (cause) => toast.error("Could not save phase-start webhook", cause.message),
  });
  const [forms, setForms] = useState<Record<"P101" | "P201", { url: string; secret: string; enabled: boolean }>>({
    P101: { url: "", secret: "", enabled: true },
    P201: { url: "", secret: "", enabled: true },
  });

  useEffect(() => {
    if (!configs.data) return;
    setForms((current) => {
      const next = { ...current };
      for (const config of configs.data) {
        next[config.eventType] = {
          url: config.endpoint?.url ?? "",
          secret: "",
          enabled: config.endpoint?.enabled ?? true,
        };
      }
      return next;
    });
  }, [configs.data]);

  const copy = (eventType: "P101" | "P201") => eventType === "P101"
    ? { title: "Phase I Start — P101", description: "Sends the Phase I intake-start payload when Phase I is kicked off for an order." }
    : { title: "Phase II Start — P201", description: "Sends the Phase II synthesis-start payload when Phase II is kicked off for an order." };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {(["P101", "P201"] as const).map((eventType) => {
        const details = copy(eventType);
        const form = forms[eventType];
        return (
          <Card key={eventType} className="space-y-3">
            <div>
              <h3 className="font-semibold text-brand-navy">{details.title}</h3>
              <p className="mt-1 text-sm text-gray-600">{details.description}</p>
            </div>
            <Input label="Destination URL" type="url" value={form.url} onChange={(event) => setForms((current) => ({ ...current, [eventType]: { ...current[eventType], url: event.target.value } }))} placeholder="https://automation.example.com/webhooks/readypackets" />
            <Input label="HMAC secret (leave blank to keep existing)" type="password" value={form.secret} onChange={(event) => setForms((current) => ({ ...current, [eventType]: { ...current[eventType], secret: event.target.value } }))} placeholder="Optional signing secret" />
            <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={form.enabled} onChange={(event) => setForms((current) => ({ ...current, [eventType]: { ...current[eventType], enabled: event.target.checked } }))} /> Enabled</label>
            <Button size="sm" busy={save.isPending} disabled={!form.url.trim()} onClick={() => save.mutate({ eventType, url: form.url.trim(), secret: form.secret || undefined, enabled: form.enabled })}>Save {eventType} webhook</Button>
          </Card>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delivery log tab
// ---------------------------------------------------------------------------

function DeliveryLogTab() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [stopping, setStopping] = useState<{ id: number; eventType: string } | null>(null);
  const { data, refetch } = trpc.integrations.webhookDeliveries.useQuery({ page, status: status || undefined });
  const toast = useToast();
  const retry = trpc.integrations.retryWebhookDelivery.useMutation({
    onSuccess: () => { void refetch(); toast.success("Retry queued", "The delivery will be attempted again immediately."); },
    onError: (cause) => toast.error("Could not retry delivery", cause.message),
  });
  const stop = trpc.integrations.stopWebhookDelivery.useMutation({
    onSuccess: () => { void refetch(); setStopping(null); toast.success("Delivery stopped", "The pending webhook will not be sent unless you retry or redeliver it."); },
    onError: (cause) => toast.error("Could not stop delivery", cause.message),
  });
  const redeliver = trpc.integrations.redeliverWebhook.useMutation({
    onSuccess: () => { void refetch(); toast.success("Redelivery queued", "A fresh delivery record has been created while preserving the original log."); },
    onError: (cause) => toast.error("Could not queue redelivery", cause.message),
  });

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }} className="w-40">
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="delivered">Delivered</option>
          <option value="failed">Failed</option>
          <option value="stopped">Stopped</option>
        </Select>
        <p className="text-xs text-gray-500">Retry reopens the current delivery; Stop cancels pending work; Redeliver creates a new audited delivery.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b text-left text-gray-500">
              <th className="py-2 pr-4">Date & time</th>
              <th className="py-2 pr-4">Customer</th>
              <th className="py-2 pr-4">Order ID</th>
              <th className="py-2 pr-4">Event</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">Attempts</th>
              <th className="py-2 pr-4">Response</th>
              <th className="py-2 pr-4">Diagnostic</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((d) => {
              const canRetry = d.status === "pending" || d.status === "failed" || d.status === "stopped";
              return (
                <tr key={d.id} className="border-b hover:bg-gray-50">
                  <td className="py-2 pr-4 whitespace-nowrap text-xs text-gray-500">{new Date(d.createdAt).toLocaleString()}</td>
                  <td className="py-2 pr-4">{d.customerName ?? "—"}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{d.orderNumber ?? "—"}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{d.eventType}</td>
                  <td className="py-2 pr-4">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      d.status === "delivered" ? "bg-green-100 text-green-800" :
                      d.status === "failed" ? "bg-red-100 text-red-800" :
                      d.status === "stopped" ? "bg-gray-100 text-gray-700" : "bg-yellow-100 text-yellow-800"
                    }`}>
                      {d.status}
                    </span>
                  </td>
                  <td className="py-2 pr-4">{d.attempts}</td>
                  <td className="py-2 pr-4">{d.responseCode ?? "—"}</td>
                  <td className="py-2 pr-4 max-w-xs"><span className="block truncate text-xs text-gray-600" title={d.lastError ?? d.responseDetail ?? ""}>{d.lastError ?? d.responseDetail ?? "—"}</span></td>
                  <td className="py-2">
                    <div className="flex flex-wrap gap-2">
                      {canRetry ? <Button variant="outline" size="sm" busy={retry.isPending} onClick={() => retry.mutate({ deliveryId: d.id })}>Retry</Button> : null}
                      {d.status === "pending" ? <Button variant="danger" size="sm" busy={stop.isPending && stopping?.id === d.id} onClick={() => setStopping({ id: d.id, eventType: d.eventType })}>Stop</Button> : null}
                      {d.status !== "pending" ? <Button variant="secondary" size="sm" busy={redeliver.isPending} onClick={() => redeliver.mutate({ deliveryId: d.id })}>Redeliver</Button> : null}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!data?.rows.length && <tr><td colSpan={9} className="py-8 text-center text-gray-400">No deliveries.</td></tr>}
          </tbody>
        </table>
      </div>
      {data && data.total > 50 && (
        <div className="flex justify-between items-center mt-4">
          <Button variant="ghost" size="sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Previous</Button>
          <span className="text-sm text-gray-500">Page {page} of {Math.ceil(data.total / 50)}</span>
          <Button variant="ghost" size="sm" disabled={page * 50 >= data.total} onClick={() => setPage(p => p + 1)}>Next</Button>
        </div>
      )}
      <ConfirmDialog
        open={Boolean(stopping)}
        onClose={() => setStopping(null)}
        onConfirm={() => { if (stopping) stop.mutate({ deliveryId: stopping.id }); }}
        title="Stop pending webhook delivery?"
        message={`Stop the ${stopping?.eventType ?? "selected"} webhook before its next attempt? You can retry or redeliver it later.`}
        confirmLabel="Stop delivery"
        cancelLabel="Keep pending"
        variant="danger"
        busy={stop.isPending}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase kickoff config tab
// ---------------------------------------------------------------------------

function PhaseKickoffTab() {
  const { data, refetch } = trpc.integrations.phaseKickoffConfigs.useQuery();
  const templates = trpc.integrations.phaseKickoffFolderTemplates.useQuery();
  const graph = trpc.integrations.graphConfig.useQuery();
  const upsert = trpc.integrations.upsertPhaseKickoffConfig.useMutation({ onSuccess: () => refetch() });
  const toast = useToast();
  const [folderDrafts, setFolderDrafts] = useState<Record<string, string[]>>({});

  useEffect(() => {
    if (!templates.data) return;
    setFolderDrafts(Object.fromEntries(templates.data.map((template) => [template.phase, [...template.folderTemplate]])));
  }, [templates.data]);

  const phases = [
    { key: "phase_1_intake", label: "Phase I — Intake" },
    { key: "phase_2_synthesis", label: "Phase II — Synthesis" },
    { key: "in_production", label: "In Production" },
    { key: "delivered", label: "Delivered" },
  ];

  async function toggle(phase: string, field: string, value: boolean) {
    const existing = data?.find(c => c.phase === phase);
    try {
      await upsert.mutateAsync({
        phase,
        createFolders: field === "createFolders" ? value : (existing?.createFolders ?? true),
        attachPlaceholders: field === "attachPlaceholders" ? value : (existing?.attachPlaceholders ?? false),
        notifyCustomer: field === "notifyCustomer" ? value : (existing?.notifyCustomer ?? true),
        notifyWebhooks: field === "notifyWebhooks" ? value : (existing?.notifyWebhooks ?? false),
        completionPercent: (existing as any)?.completionPercent ?? 0,
        enabled: field === "enabled" ? value : (existing?.enabled ?? true),
      });
      toast.success("Config updated.");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to update.");
    }
  }

  async function setCompletionPercent(phase: string, value: number) {
    const existing = data?.find(c => c.phase === phase);
    try {
      await upsert.mutateAsync({
        phase,
        createFolders: existing?.createFolders ?? true,
        attachPlaceholders: existing?.attachPlaceholders ?? false,
        notifyCustomer: existing?.notifyCustomer ?? true,
        notifyWebhooks: existing?.notifyWebhooks ?? false,
        completionPercent: value,
        enabled: existing?.enabled ?? true,
      });
      toast.success("Auto-completion % saved.");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to update.");
    }
  }

  function phasePayload(phase: string) {
    const existing = data?.find(c => c.phase === phase);
    return {
      phase,
      createFolders: existing?.createFolders ?? true,
      attachPlaceholders: existing?.attachPlaceholders ?? false,
      notifyCustomer: existing?.notifyCustomer ?? true,
      notifyWebhooks: existing?.notifyWebhooks ?? false,
      completionPercent: (existing as any)?.completionPercent ?? 0,
      enabled: existing?.enabled ?? true,
    };
  }

  async function saveFolderTemplate(phase: string) {
    const paths = (folderDrafts[phase] ?? []).map((path) => path.trim()).filter(Boolean);
    if (!paths.length) {
      toast.error("Add at least one folder path or restore the default structure.");
      return;
    }
    try {
      await upsert.mutateAsync({ ...phasePayload(phase), folderTemplate: paths });
      await Promise.all([refetch(), templates.refetch()]);
      toast.success("SharePoint folder structure saved.");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to save the SharePoint folder structure.");
    }
  }

  async function restoreDefaultFolderTemplate(phase: string) {
    try {
      await upsert.mutateAsync({ ...phasePayload(phase), folderTemplate: null });
      await Promise.all([refetch(), templates.refetch()]);
      toast.success("Default SharePoint folder structure restored.");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to restore the default structure.");
    }
  }

  return (
    <div className="space-y-4">
      {phases.map(({ key, label }) => {
        const config = data?.find(c => c.phase === key);
        return (
          <Card key={key}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-brand-navy">{label}</h3>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={config?.enabled ?? true}
                  onChange={e => toggle(key, "enabled", e.target.checked)}
                />
                Enabled
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              {[
                { field: "createFolders", label: "Create SharePoint folders" },
                { field: "attachPlaceholders", label: "Attach placeholder files" },
                { field: "notifyCustomer", label: "Send customer notification email" },
                { field: "notifyWebhooks", label: "Fire webhook notifications" },
              ].map(({ field, label: flabel }) => (
                <label key={field} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={(config as any)?.[field] ?? (field === "notifyWebhooks" || field === "attachPlaceholders" ? false : true)}
                    onChange={e => toggle(key, field, e.target.checked)}
                    disabled={!config?.enabled && config !== undefined}
                  />
                  {flabel}
                </label>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-3 text-sm">
              <label className="text-gray-600 shrink-0">Auto-set completion % on entry:</label>
              <input
                type="number"
                min={0}
                max={100}
                defaultValue={(config as any)?.completionPercent ?? 0}
                onBlur={e => setCompletionPercent(key, Math.min(100, Math.max(0, Number(e.target.value))))}
                className="w-20 rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
              <span className="text-gray-400 text-xs">% (0 = do not auto-set)</span>
            </div>
            <div className="mt-5 border-t border-gray-100 pt-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h4 className="font-medium text-brand-navy">SharePoint folder creation structure</h4>
                  <p className="mt-1 text-xs text-gray-600">These paths are created beneath <span className="font-mono">{graph.data?.rootFolderPath ?? "ReadyPackets/Orders"}/customers/{"{customerId}"}/orders/{"{orderNumber}"}</span>. Use relative paths only; ReadyPackets keeps the customer and order identity folders managed and collision-safe.</p>
                </div>
                <span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-600">{templates.data?.find((template) => template.phase === key)?.source === "custom" ? "Custom" : "Default"}</span>
              </div>
              <div className="mt-3 space-y-2">
                {(folderDrafts[key] ?? templates.data?.find((template) => template.phase === key)?.folderTemplate ?? []).map((path, index) => (
                  <div key={`${key}-${index}`} className="flex items-center gap-2">
                    <Input value={path} aria-label={`${label} folder path ${index + 1}`} onChange={(event) => setFolderDrafts((current) => { const paths = current[key] ?? templates.data?.find((template) => template.phase === key)?.folderTemplate ?? []; return { ...current, [key]: paths.map((item, itemIndex) => itemIndex === index ? event.target.value : item) }; })} placeholder="Phase I/Docs" />
                    <Button size="sm" variant="ghost" className="text-red-600" onClick={() => setFolderDrafts((current) => { const paths = current[key] ?? templates.data?.find((template) => template.phase === key)?.folderTemplate ?? []; return { ...current, [key]: paths.filter((_, itemIndex) => itemIndex !== index) }; })}>Remove</Button>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setFolderDrafts((current) => ({ ...current, [key]: [...(current[key] ?? templates.data?.find((template) => template.phase === key)?.folderTemplate ?? []), ""] }))}>Add folder</Button>
                <Button size="sm" busy={upsert.isPending} onClick={() => void saveFolderTemplate(key)}>Save structure</Button>
                <Button size="sm" variant="ghost" busy={upsert.isPending} onClick={() => void restoreDefaultFolderTemplate(key)}>Restore default</Button>
              </div>
              <p className="mt-3 rounded bg-slate-50 px-3 py-2 font-mono text-xs text-slate-600">Preview: {graph.data?.rootFolderPath ?? "ReadyPackets/Orders"}/customers/{"{customerId}"}/orders/{"{orderNumber}"}/{(folderDrafts[key] ?? templates.data?.find((template) => template.phase === key)?.folderTemplate ?? ["Phase/Folder"])[0] || "Phase/Folder"}</p>
              <p className="mt-2 text-xs text-gray-500">Changes create missing folders idempotently on future phase kickoffs. They do not rename, move, or delete existing SharePoint folders. Document and audio routing can still be overridden per workflow stage in Order Workflows.</p>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SharePoint status tab
// ---------------------------------------------------------------------------

function SharePointTab() {
  const { data, refetch } = trpc.integrations.graphConfig.useQuery();
  const samlConfig = trpc.adminSecurity.samlConfig.useQuery();
  const toast = useToast();
  const [form, setForm] = useState({
    tenantId: "",
    clientId: "",
    clientSecret: "",
    siteId: "",
    driveId: "",
    siteUrl: "",
    rootFolderPath: "ReadyPackets/Orders",
    audioFallbackMode: "mp3" as "none" | "mp3",
  });
  const [discoveredDrives, setDiscoveredDrives] = useState<Array<{ id: string; name: string; webUrl: string | null; isDefault: boolean }>>([]);
  const [browsePath, setBrowsePath] = useState("");
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnectConfirmation, setDisconnectConfirmation] = useState("");
  const folders = trpc.integrations.browseGraphFolders.useQuery({ path: browsePath }, { enabled: Boolean(data?.enabled) });

  useEffect(() => {
    if (!data) return;
    setForm((current) => ({
      ...current,
      // The API returns masked identifiers for display only. Never copy them
      // into editable state, otherwise a partial root-folder save overwrites
      // the real Entra values with `...suffix`.
      tenantId: current.tenantId,
      clientId: current.clientId,
      siteId: data.siteId ?? "",
      driveId: data.driveId ?? "",
      siteUrl: data.siteUrl ?? "",
      rootFolderPath: data.rootFolderPath ?? "ReadyPackets/Orders",
      audioFallbackMode: data.audioFallbackMode === "none" ? "none" : "mp3",
    }));
  }, [data]);

  const tenantReady = Boolean(form.tenantId.trim() || data?.tenantIdValid);
  const clientReady = Boolean(form.clientId.trim() || data?.clientIdValid);
  const secretReady = Boolean(form.clientSecret.trim() || data?.hasSecret);
  const selectedRootPath = (path: string) => {
    const segments = path.split("/").filter(Boolean);
    const customersIndex = segments.findIndex((segment) => segment.toLowerCase() === "customers");
    return (customersIndex >= 0 ? segments.slice(0, customersIndex) : segments).join("/");
  };

  const discover = trpc.integrations.discoverGraphConfig.useMutation({
    onSuccess(result) {
      setDiscoveredDrives(result.drives);
      setForm((current) => ({ ...current, siteId: result.siteId, driveId: result.driveId, siteUrl: result.siteUrl }));
      toast.success("SharePoint discovered", `${result.siteName} and its default document library have been selected. Review and save to activate sync.`);
    },
    onError(error) {
      toast.error("Could not discover SharePoint", error.message);
    },
  });

  const testConnection = trpc.integrations.testGraphConnection.useMutation({
    onSuccess(result) { toast.success("SharePoint connection succeeded", `${result.siteName} · ${result.driveName} · ${result.rootFolderPath || "/"} (${result.folderCount} immediate folder${result.folderCount === 1 ? "" : "s"}).`); },
    onError(error) { toast.error("SharePoint connection failed", error.message); },
  });

  const save = trpc.integrations.saveGraphConfig.useMutation({
    async onSuccess() {
      await refetch();
      setForm((current) => ({ ...current, clientSecret: "" }));
      toast.success("SharePoint settings saved", "The encrypted configuration is active immediately for new sync jobs.");
    },
    onError(error) {
      toast.error("Could not save SharePoint settings", error.message);
    },
  });

  const startDelegatedSync = trpc.integrations.startDelegatedGraphAudioSync.useMutation({
    onSuccess(result) {
      window.location.assign(result.authorizationUrl);
    },
    onError(error) {
      toast.error("Could not start Microsoft authorization", error.message);
    },
  });

  const disconnectDelegatedSync = trpc.integrations.disconnectDelegatedGraphAudioSync.useMutation({
    async onSuccess() {
      await refetch();
      setDisconnectOpen(false);
      setDisconnectConfirmation("");
      toast.success("Microsoft 365 sync identity disconnected", "The encrypted refresh token was removed. App-only document synchronization remains unchanged.");
    },
    onError(error) {
      toast.error("Could not disconnect the sync identity", error.message);
    },
  });

  return (
    <div className="space-y-6">
      <Card>
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <h3 className="font-semibold text-brand-navy">Microsoft Graph / SharePoint</h3>
            <p className="mt-1 text-sm text-gray-600">Store the Graph credentials and destination used for per-order file sync. The client secret is encrypted at rest and never shown again.</p>
          </div>
          <span className={data?.enabled ? "rounded-full bg-green-50 px-3 py-1 text-sm font-medium text-green-700" : "rounded-full bg-amber-50 px-3 py-1 text-sm font-medium text-amber-700"}>
            {data?.enabled ? "Configured" : "Not configured"}
          </span>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Input label={data?.tenantIdValid ? "Tenant ID (saved; enter only to replace)" : "Tenant ID (replacement required)"} value={form.tenantId} onChange={(e) => setForm({ ...form, tenantId: e.target.value })} placeholder={data?.tenantIdValid ? `${data.tenantId ?? "Saved"} — leave blank to preserve` : "Enter the complete Directory (tenant) ID or tenant domain"} help={data?.tenantIdValid ? "Saved value is masked and never copied into this field." : "The currently saved value is incomplete. Enter the full Directory (tenant) ID or a verified tenant domain."} />
          <Input label={data?.clientIdValid ? "Client ID (saved; enter only to replace)" : "Client ID (replacement required)"} value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} placeholder={data?.clientIdValid ? `${data.clientId ?? "Saved"} — leave blank to preserve` : "Enter the complete 36-character Application (client) ID"} help={data?.clientIdValid ? "Saved value is masked and never copied into this field." : "The currently saved value is incomplete. Enter the full Application (client) ID from Microsoft Entra."} />
          <Input label={data?.hasSecret ? "Client secret (leave blank to keep existing)" : "Client secret"} type="password" value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} placeholder={data?.hasSecret ? "Saved securely" : "Azure app client secret"} />
          <Input label="SharePoint site ID" value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })} placeholder="Filled automatically after discovery" help="Use Discover site & library to obtain this Microsoft Graph identifier." />
          <Input label="Drive ID" value={form.driveId} onChange={(e) => setForm({ ...form, driveId: e.target.value })} placeholder="Filled automatically after discovery" help="The default document library is selected automatically; you may choose another discovered library." />
          <Input label="SharePoint site URL" type="url" value={form.siteUrl} onChange={(e) => setForm({ ...form, siteUrl: e.target.value })} placeholder="https://contoso.sharepoint.com/sites/ReadyPackets" help="Enter the tenant root or a site URL, then use Discover site & library before saving." />
          {discoveredDrives.length > 0 ? (
            <div className="md:col-span-2">
              <Field label="Discovered document library">
                <Select value={form.driveId} onChange={(event) => setForm({ ...form, driveId: event.target.value })}>
                  {discoveredDrives.map((drive) => <option key={drive.id} value={drive.id}>{drive.name}{drive.isDefault ? " (default)" : ""}</option>)}
                </Select>
              </Field>
              <p className="mt-1 text-xs text-gray-500">The default library is selected automatically. Choose another discovered library before saving if needed.</p>
            </div>
          ) : null}
          <div className="md:col-span-2">
            <Field label="SharePoint audio transfer mode" help="MP3 fallback preserves the original WebM only in ReadyPackets and creates an MP3 copy solely for SharePoint. Original WebM only uses the connected delegated Microsoft 365 SharePoint sync identity.">
              <Select value={form.audioFallbackMode} onChange={(event) => setForm({ ...form, audioFallbackMode: event.target.value as "none" | "mp3" })}>
                <option value="mp3">MP3 fallback copy for SharePoint (used only when no delegated sync identity is connected)</option>
                <option value="none">Original WebM only (uses the connected delegated SharePoint sync identity)</option>
              </Select>
            </Field>
          </div>
          <div className="md:col-span-2">
            <Input label="ReadyPackets base folder" value={form.rootFolderPath} onChange={(e) => setForm({ ...form, rootFolderPath: e.target.value })} placeholder="RP_Intake_Raw/ReadyPackets" help="ReadyPackets creates customers/{customerId}/orders/{orderId} beneath this base. Selecting a folder named customers automatically uses its parent to prevent customers/customers." />
            {data?.enabled ? <div className="mt-3 rounded-lg border border-teal/20 bg-teal/5 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-semibold text-brand-navy">Select existing ReadyPackets base folder</p><p className="text-xs text-gray-600">Browsing is read-only. Select the folder above customers; if you browse into customers, the parent is automatically used as the base.</p></div><div className="flex gap-2">{folders.data?.parentPath !== null && folders.data ? <Button size="sm" variant="outline" onClick={() => setBrowsePath(folders.data.parentPath ?? "")}>Up</Button> : null}<Button size="sm" variant="outline" busy={folders.isFetching} onClick={() => void folders.refetch()}>Refresh</Button></div></div><p className="mt-2 font-mono text-xs text-gray-600">/{(folders.data?.currentPath ?? browsePath) || ""}</p>{folders.isError ? <p className="mt-2 text-xs text-danger">{folders.error.message}</p> : null}<div className="mt-3 flex flex-wrap gap-2">{(folders.data?.folders ?? []).length ? folders.data!.folders.map((folder) => <Button key={folder.id} size="sm" variant="outline" onClick={() => setBrowsePath(folder.path)}>{folder.name}</Button>) : <span className="text-xs text-gray-500">No child folders found at this location.</span>}</div><div className="mt-3"><Button size="sm" variant="primary" disabled={!folders.data?.currentPath} onClick={() => setForm((current) => ({ ...current, rootFolderPath: selectedRootPath(folders.data?.currentPath ?? current.rootFolderPath) || current.rootFolderPath }))}>Use current folder as base</Button></div></div> : <p className="mt-2 text-xs text-gray-500">Save valid tenant, client, site, and document-library settings first, then the read-only folder browser will be available.</p>}
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-gray-100 pt-4">
          <Button
            variant="outline"
            busy={discover.isPending}
            disabled={!tenantReady || !clientReady || !form.siteUrl.trim() || !secretReady}
            onClick={() => discover.mutate({
              tenantId: form.tenantId.trim() || undefined,
              clientId: form.clientId.trim() || undefined,
              clientSecret: form.clientSecret.trim() || undefined,
              siteUrl: form.siteUrl.trim(),
            })}
          >
            Discover site & library
          </Button>
          <Button variant="outline" busy={testConnection.isPending} disabled={!data?.enabled} onClick={() => testConnection.mutate()}>Test SharePoint connection</Button>
          <Button
            busy={save.isPending}
            disabled={!tenantReady || !clientReady || !form.siteId.trim() || !form.driveId.trim() || !form.rootFolderPath.trim() || !secretReady}
            onClick={() => save.mutate({
              tenantId: form.tenantId.trim() || undefined,
              clientId: form.clientId.trim() || undefined,
              clientSecret: form.clientSecret.trim() || undefined,
              siteId: form.siteId.trim(),
              driveId: form.driveId.trim(),
              siteUrl: form.siteUrl.trim(),
              rootFolderPath: form.rootFolderPath.trim(),
              audioFallbackMode: form.audioFallbackMode,
            })}
          >
            Save SharePoint settings
          </Button>
          {data?.siteUrl ? <a className="text-sm font-medium text-teal-700 hover:underline" href={data.siteUrl} target="_blank" rel="noreferrer">Open SharePoint site</a> : null}
          <p className="basis-full text-xs text-gray-500">Step 1: enter complete Microsoft Entra values only when replacing saved credentials; masked values are display-only and are preserved on partial saves. Step 2: use discovery to populate site and library IDs. Step 3: save a base folder above customers. Step 4: select the audio transfer mode and run Test SharePoint connection. Discovery and testing use credentials only on the server and never display the client secret.</p>
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-brand-navy">Microsoft 365 audio sync identity</h3>
            <p className="mt-1 max-w-3xl text-sm text-gray-600">Use a dedicated Microsoft 365 account to upload original WebM recordings with delegated Microsoft 365 SharePoint authorization. The encrypted renewable token is used only for audio binary uploads; the existing app-only configuration continues to manage document and folder synchronization.</p>
          </div>
          <span className={data?.delegatedSync?.connected ? "rounded-full bg-green-50 px-3 py-1 text-sm font-medium text-green-700" : "rounded-full bg-amber-50 px-3 py-1 text-sm font-medium text-amber-700"}>{data?.delegatedSync?.connected ? "Connected" : "Authorization required"}</span>
        </div>
        {data?.delegatedSync?.connected ? (
          <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-4 text-sm">
            <p className="font-semibold text-green-800">Connected sync account</p>
            <p className="mt-1 text-green-700">{data.delegatedSync.account ?? "Microsoft 365 sync account"}</p>
            {data.delegatedSync.connectedAt ? <p className="mt-1 text-xs text-green-700">Authorized {new Date(data.delegatedSync.connectedAt).toLocaleString()}.</p> : null}
            <div className="mt-3"><Button variant="danger" size="sm" onClick={() => setDisconnectOpen(true)}>Disconnect sync account</Button></div>
          </div>
        ) : (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <p className="font-semibold">Before connecting</p>
            <p className="mt-1">Register the exact callback URL shown below as a Web redirect URI in Microsoft Entra, add delegated Microsoft Graph `Files.ReadWrite.All` and `User.Read` plus SharePoint `AllSites.Write`, grant consent, and sign in with the dedicated account that has access to this document library.</p>
            <p className="mt-2 break-all rounded bg-white/70 p-2 font-mono text-xs">{window.location.origin}/api/integrations/sharepoint/delegated/callback</p>
          </div>
        )}
        {data?.delegatedSync?.lastError ? <p className="mt-3 text-sm text-danger">Last delegated authorization issue: {data.delegatedSync.lastError}</p> : null}
        <div className="mt-4 flex flex-wrap gap-3">
          <Button variant="primary" busy={startDelegatedSync.isPending} disabled={!data?.enabled} onClick={() => startDelegatedSync.mutate()}>Connect Microsoft 365 sync account</Button>
          <p className="self-center text-xs text-gray-500">Authorization opens Microsoft sign-in in this browser. The service account password and Microsoft tokens are never shown in ReadyPackets.</p>
        </div>
      </Card>

      <Modal
        open={disconnectOpen}
        onClose={() => { if (!disconnectDelegatedSync.isPending) { setDisconnectOpen(false); setDisconnectConfirmation(""); } }}
        title="Disconnect Microsoft 365 sync account"
        description="This removes the encrypted renewable token from ReadyPackets. It does not change the Microsoft account or the existing SharePoint files."
        footer={<><Button variant="outline" onClick={() => { setDisconnectOpen(false); setDisconnectConfirmation(""); }} disabled={disconnectDelegatedSync.isPending}>Cancel</Button><Button variant="danger" busy={disconnectDelegatedSync.isPending} disabled={disconnectConfirmation !== "DISCONNECT SYNC"} onClick={() => disconnectDelegatedSync.mutate({ typedConfirmation: "DISCONNECT SYNC" })}>Disconnect</Button></>}
      >
        <Input label="Type DISCONNECT SYNC to continue" value={disconnectConfirmation} onChange={(event) => setDisconnectConfirmation(event.target.value)} autoComplete="off" />
      </Modal>

      <Card>
        <h3 className="font-semibold text-brand-navy mb-3">SAML SSO</h3>
        {samlConfig.data ? (
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Status</span>
              <span className={samlConfig.data.enabled ? "text-green-700 font-medium" : "text-gray-500"}>
                {samlConfig.data.enabled ? "Enabled" : "Disabled"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Name</span>
              <span>{samlConfig.data.name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Entry point</span>
              <span className="font-mono text-xs truncate max-w-xs">{samlConfig.data.entryPoint}</span>
            </div>
            <div className="mt-3 p-3 bg-gray-50 rounded text-xs font-mono">
              <p className="text-gray-500 mb-1">SP Metadata URL (register with your IdP):</p>
              <p>{window.location.origin}/api/saml/metadata</p>
              <p className="text-gray-500 mt-2 mb-1">ACS URL:</p>
              <p>{window.location.origin}/api/saml/acs</p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-600">
            No SAML configuration found. Configure it in Admin → Security → SAML SSO.
          </p>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SharePoint sync log center
// ---------------------------------------------------------------------------

function SharePointSyncLogTab({ orderId }: { orderId?: number }) {
  const toast = useToast();
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const logs = trpc.integrations.sharepointSyncLogs.useQuery({
    orderId,
    status: status as "pending" | "running" | "succeeded" | "failed" | undefined,
    search: search.trim() || undefined,
    page,
  });
  const retry = trpc.integrations.retrySharepointSync.useMutation({
    async onSuccess() {
      await logs.refetch();
      toast.success("File sync requeued", "The background SharePoint worker will retry this transfer shortly.");
    },
    onError(error) {
      toast.error("Could not requeue file sync", error.message);
    },
  });
  const rows = logs.data?.rows ?? [];
  const total = logs.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 50));
  const statusClass = (value: string) => value === "succeeded" ? "bg-green-100 text-green-800" : value === "failed" ? "bg-red-100 text-red-800" : value === "running" ? "bg-blue-100 text-blue-800" : "bg-amber-100 text-amber-800";
  const classify = (mime: string | null, extension: string | null) => (mime?.startsWith("audio/") || mime === "video/webm" || ["webm", "wav", "mp3", "m4a", "ogg", "aac", "flac"].includes((extension ?? "").toLowerCase())) ? "Audio" : "Document";

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-brand-navy">SharePoint Sync Log Center</h2>
            <p className="mt-1 max-w-3xl text-sm text-gray-600">Track each order document and recording transfer. Retry is available only for failed items; pending and running transfers are already being processed.{orderId ? ` Showing transfers for order #${orderId}.` : ""}</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => void logs.refetch()} busy={logs.isFetching}>Refresh</Button>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_220px]">
          <Input label="Search order, file, or SharePoint path" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="RP-C…, recording.webm, or Phase I/Audio" />
          <Select label="Transfer status" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} options={[
            { value: "", label: "All statuses" },
            { value: "failed", label: "Failed" },
            { value: "pending", label: "Pending" },
            { value: "running", label: "Running" },
            { value: "succeeded", label: "Succeeded" },
          ]} />
        </div>
      </Card>

      <Card className="overflow-hidden" padded={false}>
        {logs.isLoading ? <p className="px-5 py-8 text-sm text-gray-500">Loading SharePoint transfer records…</p> : rows.length === 0 ? <p className="px-5 py-8 text-sm text-gray-500">No SharePoint file transfers match this filter.</p> : (
          <div className="overflow-x-auto">
            <table className="min-w-[1080px] w-full text-left text-sm">
              <thead className="bg-surface-soft text-xs uppercase tracking-wide text-gray-500"><tr><th className="px-4 py-3 font-semibold">Order / file</th><th className="px-4 py-3 font-semibold">Type / phase</th><th className="px-4 py-3 font-semibold">Destination</th><th className="px-4 py-3 font-semibold">Status</th><th className="px-4 py-3 font-semibold">Attempts</th><th className="px-4 py-3 font-semibold">Updated</th><th className="px-4 py-3 font-semibold text-right">Action</th></tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((row) => <tr key={row.id} className="align-top"><td className="px-4 py-3"><p className="font-medium text-brand-navy">{row.orderNumber ?? `Order #${row.orderId}`}</p><p className="mt-1 max-w-[250px] break-all text-xs text-gray-600">{row.fileName ?? "Source file unavailable"}</p></td><td className="px-4 py-3"><p>{classify(row.detectedMime, row.extension)}</p><p className="mt-1 text-xs text-gray-500">{row.phase?.replace(/_/g, " ") ?? "Unassigned"}</p></td><td className="px-4 py-3"><p className="max-w-[310px] break-all font-mono text-xs text-gray-600">{row.sharepointPath}</p>{row.errorMessage ? <details className="mt-2 max-w-[310px]"><summary className="cursor-pointer text-xs font-medium text-red-700">View sanitized error</summary><p className="mt-1 break-words text-xs text-red-700">{row.errorMessage}</p></details> : null}</td><td className="px-4 py-3"><span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${statusClass(row.status)}`}>{row.status}</span></td><td className="px-4 py-3">{row.attempts}</td><td className="px-4 py-3 text-xs text-gray-600">{row.updatedAt ? new Date(row.updatedAt).toLocaleString() : "—"}</td><td className="px-4 py-3 text-right">{row.status === "failed" ? <Button size="sm" variant="outline" busy={retry.isPending && retry.variables?.logId === row.id} onClick={() => retry.mutate({ logId: row.id })}>Retry</Button> : <span className="text-xs text-gray-400">{row.status === "succeeded" ? "Completed" : "Queued"}</span>}</td></tr>)}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm text-gray-600"><span>{total} transfer{total === 1 ? "" : "s"} · page {page} of {totalPages}</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>Previous</Button><Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((current) => current + 1)}>Next</Button></div></div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function AdminIntegrationsPage() {
  const query = new URLSearchParams(window.location.search);
  const initialTab = query.get("tab") === "sync" ? "sync" : "webhooks";
  const parsedOrderId = Number(query.get("orderId"));
  const syncOrderId = Number.isSafeInteger(parsedOrderId) && parsedOrderId > 0 ? parsedOrderId : undefined;
  const [tab, setTab] = useState(initialTab);

  return (
          <div className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-brand-navy mb-6">Integrations</h1>
        <Tabs
          items={[
            { id: "webhooks", label: "Webhook Endpoints" },
            { id: "deliveries", label: "Delivery Log" },
            { id: "kickoff", label: "Phase Kickoff" },
            { id: "sync", label: "SharePoint Sync Log" },
            { id: "sharepoint", label: "SharePoint & SAML" },
          ]}
          initialId={tab}
          onChange={setTab}
        />
        <div className="mt-6">
          {tab === "webhooks" && <WebhooksTab />}
          {tab === "deliveries" && <DeliveryLogTab />}
          {tab === "kickoff" && <PhaseKickoffTab />}
          {tab === "sync" && <SharePointSyncLogTab orderId={syncOrderId} />}
          {tab === "sharepoint" && <SharePointTab />}
        </div>
      </div>
      );
}
