import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { ArrowDown, ArrowDownUp, ArrowUp, Bell, ClipboardList, Copy, Download, FileAudio, FileQuestion, FileText, Gauge, GripVertical, LayoutTemplate, Mail, Mic, Pencil, Plus, Save, Trash2, Upload, Webhook } from "lucide-react";
import { trpc, errorMessage } from "@/lib/trpc";
import { Button } from "@/components/ui/Button";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/Field";
import { Alert, Badge, Card, CardHeader, EmptyState, Skeleton } from "@/components/ui/Surface";
import { DataTable, type Column } from "@/components/ui/DataDisplay";
import { Markdown } from "@/lib/markdown";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { PageHeader } from "@/components/layout/PortalLayout";

type Workflow = { id: number; name: string; description: string | null; stages: unknown[]; customerPresentation: "cards" | "wizard"; isDefault: boolean; active: boolean; createdAt: Date | string };
type WorkflowConfiguration = { format: "readypackets.order-workflow"; version: 1; exportedAt?: string; workflow: { name: string; description?: string | null; customerPresentation: "wizard"; stages: Stage[]; active?: boolean } };
type StageCapability = "documents" | "questions" | "recording" | "audio_upload" | "review_space";
type OrderStatus = string;
type StageActions = {
  emailTemplateKey?: string;
  adminAlert?: { enabled?: boolean; message?: string; severity?: "warning" | "error" | "critical" };
  orderStatus?: OrderStatus;
  completionPercent?: number;
  completionMode?: "fixed" | "random";
  completionRangeMin?: number;
  completionRangeMax?: number;
  completionDelayMinutes?: number;
  webhookEndpointId?: number;
};
type UploadLimits = { documentMaxFiles?: number; documentMaxSizeMb?: number; audioMaxFiles?: number; audioMaxSizeMb?: number; recordingMaxDurationSeconds?: number; audioTotalDurationSeconds?: number };
type CustomerMessage = { kind: "instructions" | "announcement"; title?: string; bodyMarkdown: string };
type AdminTask = "upload_document" | "assign_questions" | "review_submission" | "run_automation";
type ConversionRouting = { conversionProfileIds?: number[]; originalsTargetBindingId?: number; stagingTargetBindingId?: number; intakeTargetBindingId?: number };
type Stage = { key: string; label: string; order: number; capabilities: StageCapability[]; actions: StageActions; adminTasks?: AdminTask[]; customerMessage?: CustomerMessage; advanceMode?: "next" | "submit_lock"; customerAcknowledgement?: "required" | "optional" | "none"; submissionNotice?: string; uploadLimits?: UploadLimits; sharePointDestination?: string; sharePointAudioDestination?: string; conversionRouting?: ConversionRouting };

const ADMIN_TASKS: { key: AdminTask; label: string; description: string }[] = [
  { key: "upload_document", label: "Upload team document", description: "Team uploads a document to the customer order workspace." },
  { key: "assign_questions", label: "Assign order questions", description: "Team sends or applies questions for this stage." },
  { key: "review_submission", label: "Review customer submission", description: "Team reviews the submitted files, audio, and answers." },
  { key: "run_automation", label: "Run stage automation", description: "Team runs approved email, status, alert, or webhook actions." },
];
const CAPABILITIES: { key: StageCapability; label: string; description: string; icon: typeof FileText }[] = [
  { key: "documents", label: "Upload documents", description: "Customer may upload supporting files.", icon: FileText },
  { key: "questions", label: "Answer questions", description: "Customer sees questions assigned to this stage.", icon: FileQuestion },
  { key: "recording", label: "Record audio", description: "Customer may record WebM audio in the browser.", icon: Mic },
  { key: "audio_upload", label: "Upload audio file", description: "Customer and staff may attach approved prerecorded audio.", icon: FileAudio },
  { key: "review_space", label: "Customer file review", description: "Customer can securely review and download team-selected files for this phase.", icon: Download },
];
const STANDARD_STAGES: Stage[] = [
  { key: "new", label: "Payment confirmed", order: 1, capabilities: ["questions"], actions: {} },
  { key: "phase_1_intake", label: "Phase 1 intake", order: 2, capabilities: ["documents", "questions", "recording"], actions: {} },
  { key: "phase_2_synthesis", label: "Phase 2 synthesis", order: 3, capabilities: ["documents", "questions", "recording"], actions: {} },
  { key: "phase_3_review", label: "Phase 3 review", order: 4, capabilities: ["documents", "questions"], actions: {} },
  { key: "phase_4_delivery", label: "Phase 4 delivery", order: 5, capabilities: ["review_space"], actions: {} },
  { key: "delivered", label: "Delivered", order: 6, capabilities: ["documents"], actions: {} },
  { key: "closed", label: "Closed", order: 7, capabilities: [], actions: {} },
];

function normalizeActions(value: unknown): StageActions {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const adminRaw = raw.adminAlert && typeof raw.adminAlert === "object" ? raw.adminAlert as Record<string, unknown> : null;
  const orderStatus = typeof raw.orderStatus === "string" && /^[a-z][a-z0-9_]{1,31}$/.test(raw.orderStatus) ? raw.orderStatus : undefined;
  return {
    emailTemplateKey: typeof raw.emailTemplateKey === "string" ? raw.emailTemplateKey : undefined,
    adminAlert: adminRaw ? {
      enabled: adminRaw.enabled === true,
      message: typeof adminRaw.message === "string" ? adminRaw.message : undefined,
      severity: ["warning", "error", "critical"].includes(String(adminRaw.severity)) ? String(adminRaw.severity) as "warning" | "error" | "critical" : "warning",
    } : undefined,
    orderStatus,
    completionPercent: typeof raw.completionPercent === "number" && Number.isFinite(raw.completionPercent) ? Math.max(0, Math.min(100, Math.round(raw.completionPercent))) : undefined,
    completionMode: raw.completionMode === "fixed" || raw.completionMode === "random" ? raw.completionMode : (typeof raw.completionPercent === "number" ? "fixed" : undefined),
    completionRangeMin: typeof raw.completionRangeMin === "number" && Number.isFinite(raw.completionRangeMin) ? Math.max(0, Math.min(100, Math.round(raw.completionRangeMin))) : undefined,
    completionRangeMax: typeof raw.completionRangeMax === "number" && Number.isFinite(raw.completionRangeMax) ? Math.max(0, Math.min(100, Math.round(raw.completionRangeMax))) : undefined,
    completionDelayMinutes: typeof raw.completionDelayMinutes === "number" && Number.isFinite(raw.completionDelayMinutes) ? Math.max(0, Math.min(43_200, Math.round(raw.completionDelayMinutes))) : undefined,
    webhookEndpointId: typeof raw.webhookEndpointId === "number" && raw.webhookEndpointId > 0 ? raw.webhookEndpointId : undefined,
  };
}
function normalizeCustomerMessage(value: unknown): CustomerMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const bodyMarkdown = typeof raw.bodyMarkdown === "string" ? raw.bodyMarkdown : "";
  if (!bodyMarkdown.trim()) return undefined;
  return { kind: raw.kind === "announcement" ? "announcement" : "instructions", title: typeof raw.title === "string" && raw.title.trim() ? raw.title : undefined, bodyMarkdown };
}

function normalizeUploadLimits(value: unknown): UploadLimits | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const number = (key: string) => typeof raw[key] === "number" && Number.isInteger(raw[key]) && raw[key] > 0 ? Math.min(key.includes("Size") ? 100 : key.includes("Duration") ? 7_200 : 50, raw[key] as number) : undefined;
  const limits = { documentMaxFiles: number("documentMaxFiles"), documentMaxSizeMb: number("documentMaxSizeMb"), audioMaxFiles: number("audioMaxFiles"), audioMaxSizeMb: number("audioMaxSizeMb"), recordingMaxDurationSeconds: number("recordingMaxDurationSeconds"), audioTotalDurationSeconds: number("audioTotalDurationSeconds") };
  return Object.values(limits).some((value) => value !== undefined) ? limits : undefined;
}
function normalizeConversionRouting(value: unknown): ConversionRouting | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const id = (candidate: unknown) => typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0 ? candidate : undefined;
  const conversionProfileIds = Array.isArray(raw.conversionProfileIds)
    ? [...new Set(raw.conversionProfileIds.map(id).filter((candidate): candidate is number => candidate !== undefined))].slice(0, 9)
    : [];
  const routing = { conversionProfileIds: conversionProfileIds.length ? conversionProfileIds : undefined, originalsTargetBindingId: id(raw.originalsTargetBindingId), stagingTargetBindingId: id(raw.stagingTargetBindingId), intakeTargetBindingId: id(raw.intakeTargetBindingId) };
  return Object.values(routing).some((candidate) => candidate !== undefined) ? routing : undefined;
}
function normalizeStages(value: unknown[]): Stage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is { key?: unknown; label?: unknown; order?: unknown; capabilities?: unknown; actions?: unknown; adminTasks?: unknown; customerMessage?: unknown; advanceMode?: unknown; customerAcknowledgement?: unknown; submissionNotice?: unknown; uploadLimits?: unknown; sharePointDestination?: unknown; sharePointAudioDestination?: unknown; conversionRouting?: unknown } => Boolean(item) && typeof item === "object")
    .filter((item) => typeof item.key === "string" && typeof item.label === "string")
    .map((item, index) => ({
      key: item.key as string,
      label: item.label as string,
      order: typeof item.order === "number" ? item.order : index + 1,
      capabilities: Array.isArray(item.capabilities) ? item.capabilities.filter((capability): capability is StageCapability => capability === "documents" || capability === "questions" || capability === "recording" || capability === "audio_upload" || capability === "review_space") : ["documents", "questions", "recording"] as StageCapability[],
      actions: normalizeActions(item.actions),
      adminTasks: Array.isArray(item.adminTasks) ? item.adminTasks.filter((task): task is AdminTask => task === "upload_document" || task === "assign_questions" || task === "review_submission" || task === "run_automation") : [],
      customerMessage: normalizeCustomerMessage(item.customerMessage),
      advanceMode: (item.advanceMode === "next" ? "next" : "submit_lock") as "next" | "submit_lock",
      customerAcknowledgement: (item.customerAcknowledgement === "required" || item.customerAcknowledgement === "optional" || item.customerAcknowledgement === "none" ? item.customerAcknowledgement : "required") as "required" | "optional" | "none",
      submissionNotice: typeof item.submissionNotice === "string" ? item.submissionNotice : undefined,
      uploadLimits: normalizeUploadLimits(item.uploadLimits),
      sharePointDestination: typeof item.sharePointDestination === "string" ? item.sharePointDestination : undefined,
      sharePointAudioDestination: typeof item.sharePointAudioDestination === "string" ? item.sharePointAudioDestination : undefined,
      conversionRouting: normalizeConversionRouting(item.conversionRouting),
    }))
    .sort((left, right) => left.order - right.order);
}
function cloneStages(stages: Stage[]): Stage[] {
  return stages.map((stage, index) => ({ ...stage, order: index + 1, capabilities: [...stage.capabilities], actions: { ...stage.actions, adminAlert: stage.actions.adminAlert ? { ...stage.actions.adminAlert } : undefined }, customerMessage: stage.customerMessage ? { ...stage.customerMessage } : undefined, advanceMode: stage.advanceMode ?? "submit_lock", uploadLimits: stage.uploadLimits ? { ...stage.uploadLimits } : undefined, sharePointDestination: stage.sharePointDestination, sharePointAudioDestination: stage.sharePointAudioDestination, conversionRouting: stage.conversionRouting ? { ...stage.conversionRouting, conversionProfileIds: [...(stage.conversionRouting.conversionProfileIds ?? [])] } : undefined }));
}
function stageKey(value: string, index: number) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || `stage_${index + 1}`;
}
function statusLabel(value: string) { return value.replaceAll("_", " "); }
function completionPolicyLabel(actions: StageActions) {
  const mode = actions.completionMode ?? (actions.completionPercent !== undefined ? "fixed" : undefined);
  if (mode === "fixed" && actions.completionPercent !== undefined) return `${actions.completionPercent}%${actions.completionDelayMinutes ? ` after ${actions.completionDelayMinutes}m` : ""}`;
  if (mode === "random" && actions.completionRangeMin !== undefined && actions.completionRangeMax !== undefined) return `${actions.completionRangeMin}%–${actions.completionRangeMax}% random${actions.completionDelayMinutes ? ` after ${actions.completionDelayMinutes}m` : ""}`;
  return null;
}
function actionCount(actions: StageActions) { return Number(Boolean(actions.emailTemplateKey)) + Number(Boolean(actions.adminAlert?.enabled)) + Number(Boolean(actions.orderStatus)) + Number(Boolean(completionPolicyLabel(actions))) + Number(Boolean(actions.webhookEndpointId)); }

function CompletionPolicyFields({ actions, onChange }: { actions: StageActions; onChange: (patch: StageActions) => void }) {
  const mode = actions.completionMode ?? (actions.completionPercent !== undefined ? "fixed" : "");
  const number = (value: string, maximum: number) => value === "" ? undefined : Math.max(0, Math.min(maximum, Math.round(Number(value))));
  return <>
    <Select label="Completion update policy" value={mode} onChange={(event) => {
      const next = event.target.value as "" | "fixed" | "random";
      if (!next) onChange({ completionMode: undefined, completionPercent: undefined, completionRangeMin: undefined, completionRangeMax: undefined, completionDelayMinutes: undefined });
      else if (next === "fixed") onChange({ completionMode: "fixed", completionRangeMin: undefined, completionRangeMax: undefined });
      else onChange({ completionMode: "random", completionPercent: undefined });
    }}>
      <option value="">Do not update completion</option>
      <option value="fixed">Set a fixed percentage</option>
      <option value="random">Choose a random percentage from a range</option>
    </Select>
    {mode === "fixed" ? <Input label="Fixed completion percentage" type="number" min="0" max="100" placeholder="0–100" value={actions.completionPercent ?? ""} onChange={(event) => onChange({ completionPercent: number(event.target.value, 100) })} /> : null}
    {mode === "random" ? <><Input label="Random range minimum" type="number" min="0" max="100" placeholder="0" value={actions.completionRangeMin ?? ""} onChange={(event) => onChange({ completionRangeMin: number(event.target.value, 100) })} /><Input label="Random range maximum" type="number" min="0" max="100" placeholder="100" value={actions.completionRangeMax ?? ""} onChange={(event) => onChange({ completionRangeMax: number(event.target.value, 100) })} /></> : null}
    {mode ? <Input label="Delay before update (minutes)" type="number" min="0" max="43200" placeholder="0 = immediately" value={actions.completionDelayMinutes ?? ""} onChange={(event) => onChange({ completionDelayMinutes: number(event.target.value, 43_200) })} help="A delay of 0 applies immediately; delayed changes are durable, audited, and checked every 15 seconds." /> : null}
  </>;
}

type ConversionProfileOption = { id: number; name: string; operation: string; operationLabel: string; active: boolean };
type SharepointTargetOption = { id: number; name: string; targetRole: string; connectionName: string; enabled: boolean };
function ConversionRoutingFields({ routing, onChange, profiles, targets }: { routing?: ConversionRouting; onChange: (next: ConversionRouting | undefined) => void; profiles: ConversionProfileOption[]; targets: SharepointTargetOption[] }) {
  const update = (patch: Partial<ConversionRouting>) => {
    const next: ConversionRouting = { ...(routing ?? {}), ...patch };
    const normalized = normalizeConversionRouting(next);
    onChange(normalized);
  };
  const activeProfiles = profiles.filter((profile) => profile.active);
  const optionRows = (role: string) => targets.filter((target) => target.enabled && target.targetRole === role);
  const targetSelect = (label: string, role: "originals" | "conversion_staging" | "intake_delivery", key: "originalsTargetBindingId" | "stagingTargetBindingId" | "intakeTargetBindingId", help: string) => <Select label={label} value={routing?.[key] ? String(routing[key]) : ""} onChange={(event) => update({ [key]: event.target.value ? Number(event.target.value) : undefined })} help={help}><option value="">Do not transfer to this target</option>{optionRows(role).map((target) => <option key={target.id} value={String(target.id)}>{target.name} — {target.connectionName}</option>)}</Select>;
  return <div className="rounded-lg border border-gold/30 bg-gold/5 p-3"><p className="text-sm font-semibold text-ink">Conversion and selected-site routing</p><p className="mt-1 text-xs text-muted">Each upload remains immutable. ReadyPackets copies the original to the selected originals target, creates separate derived artifacts from selected native-tool profiles, optionally copies artifacts to staging, then separately to intake delivery. Profile and target assignments are snapshotted when an upload is queued.</p><div className="mt-3"><p className="text-xs font-semibold uppercase tracking-wide text-muted">Run append-only conversions</p>{activeProfiles.length ? <div className="mt-2 grid gap-2 sm:grid-cols-2">{activeProfiles.map((profile) => <label key={profile.id} className={`flex cursor-pointer gap-2 rounded border p-2 text-xs ${(routing?.conversionProfileIds ?? []).includes(profile.id) ? "border-gold/60 bg-white" : "border-line bg-white/60"}`}><Checkbox checked={(routing?.conversionProfileIds ?? []).includes(profile.id)} onChange={() => { const selected = routing?.conversionProfileIds ?? []; update({ conversionProfileIds: selected.includes(profile.id) ? selected.filter((id) => id !== profile.id) : [...selected, profile.id] }); }} label="" /><span><strong>{profile.name}</strong><span className="block text-muted">{profile.operationLabel}</span></span></label>)}</div> : <p className="mt-2 text-xs text-muted">No active profiles yet. Create them in Admin → Integrations → Conversion Pipeline.</p>}</div><div className="mt-4 grid gap-3 md:grid-cols-3">{targetSelect("Original uploads target", "originals", "originalsTargetBindingId", "Original customer and staff uploads only; never overwritten.")}{targetSelect("Conversion staging target", "conversion_staging", "stagingTargetBindingId", "New conversion artifacts only; source originals are not copied here.")}{targetSelect("Intake delivery target", "intake_delivery", "intakeTargetBindingId", "Final conversion artifacts only; staff controls customer publication separately.")}</div><p className="mt-3 text-xs text-muted">Targets use the permanent hierarchy <span className="font-mono">CustomerName-CustomerID/OrderNumber</span>. Select only least-privilege Sites.Selected app identities configured in Integrations.</p></div>;
}

const GUIDED_DESIGNER_STEPS = ["Choose stage", "Customer tasks", "Uploads & SharePoint", "Instructions & navigation", "Administrator tasks", "Submission policy", "Review"] as const;

export function AdminOrderWorkflowsPage() {
  const toast = useToast();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const workflows = trpc.admin.orderWorkflows.useQuery();
  const templates = trpc.admin.emailTemplates.useQuery();
  const endpoints = trpc.integrations.webhookEndpoints.useQuery();
  const conversionProfiles = trpc.integrations.conversionProfiles.useQuery();
  const sharepointTargets = trpc.integrations.selectedSiteTargets.useQuery();
  const configuredStatuses = trpc.admin.orderStatusOptions.useQuery();
  const activeStatuses = (configuredStatuses.data ?? []).filter((status) => status.active);
  const configuredStatusLabel = (value: string) => activeStatuses.find((status) => status.key === value)?.label ?? (configuredStatuses.data ?? []).find((status) => status.key === value)?.label ?? statusLabel(value);
  const [editing, setEditing] = useState<Workflow | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [stages, setStages] = useState<Stage[]>([]);
  const [isDefault, setIsDefault] = useState(false);
  const [active, setActive] = useState(true);
  const customerPresentation: "wizard" = "wizard";
  const [draggedStage, setDraggedStage] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<Workflow | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [designerMode, setDesignerMode] = useState<"canvas" | "guided">("canvas");
  const [guidedStep, setGuidedStep] = useState(0);
  const [guidedStageIndex, setGuidedStageIndex] = useState(0);
  const [importConfiguration, setImportConfiguration] = useState<WorkflowConfiguration | null>(null);
  const [importFileName, setImportFileName] = useState("");
  const [importName, setImportName] = useState("");
  const [importConfirmation, setImportConfirmation] = useState("");

  const save = trpc.admin.upsertOrderWorkflow.useMutation({
    async onSuccess() { await utils.admin.orderWorkflows.invalidate(); setOpen(false); toast.success(editing ? "Workflow updated" : "Workflow created", "Assigned order workspaces refresh from the current workflow automatically."); },
    onError(error) { toast.error("Could not save workflow", errorMessage(error)); },
  });
  const deleteWorkflow = trpc.admin.deleteOrderWorkflow.useMutation({
    async onSuccess() { await utils.admin.orderWorkflows.invalidate(); setDeleting(null); setDeleteConfirmation(""); toast.success("Workflow deleted"); },
    onError(error) { toast.error("Could not delete workflow", errorMessage(error)); },
  });
  const exportWorkflow = trpc.admin.exportOrderWorkflow.useMutation();
  const importWorkflow = trpc.admin.importOrderWorkflow.useMutation({
    async onSuccess() { await utils.admin.orderWorkflows.invalidate(); setImportConfiguration(null); setImportFileName(""); setImportName(""); setImportConfirmation(""); toast.success("Workflow imported", "A new workflow definition was created. It was not made the default workflow."); },
    onError(error) { toast.error("Could not import workflow", errorMessage(error)); },
  });
  function resetImport() { setImportConfiguration(null); setImportFileName(""); setImportName(""); setImportConfirmation(""); }
  async function downloadWorkflowConfiguration(workflow: Workflow) {
    try {
      const configuration = await exportWorkflow.mutateAsync({ workflowId: workflow.id });
      const blob = new Blob([JSON.stringify(configuration, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const stem = workflow.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";
      anchor.href = url;
      anchor.download = `readypackets-order-workflow-${stem}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      toast.success("Workflow configuration exported", "The portable JSON file excludes environment-specific webhook endpoint assignments.");
    } catch (error) { toast.error("Could not export workflow", errorMessage(error)); }
  }
  async function selectWorkflowConfiguration(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!selected) return;
    if (selected.size > 250_000) { toast.error("Configuration file is too large", "Select a ReadyPackets workflow JSON file smaller than 250 KB."); return; }
    try {
      const candidate = JSON.parse(await selected.text()) as unknown;
      if (!candidate || typeof candidate !== "object") throw new Error("The file does not contain a workflow configuration object.");
      const configuration = candidate as WorkflowConfiguration;
      if (configuration.format !== "readypackets.order-workflow" || configuration.version !== 1 || !configuration.workflow || typeof configuration.workflow.name !== "string" || !Array.isArray(configuration.workflow.stages)) throw new Error("Select a ReadyPackets order workflow configuration export (format version 1).");
      setImportConfiguration(configuration);
      setImportFileName(selected.name);
      setImportName(`${configuration.workflow.name} imported`.slice(0, 120));
      setImportConfirmation("");
    } catch (error) { toast.error("Could not read workflow configuration", error instanceof Error ? error.message : "Select a valid JSON configuration file."); }
  }
  function reset(workflow: Workflow | null, clone = false) {
    setEditing(clone ? null : workflow);
    setName(workflow ? `${clone ? `${workflow.name} copy` : workflow.name}` : "");
    setDescription(workflow?.description ?? "");
    setStages(workflow ? cloneStages(normalizeStages(workflow.stages)) : cloneStages(STANDARD_STAGES));
    setIsDefault(clone ? false : workflow?.isDefault ?? false);
    setActive(clone ? true : workflow?.active ?? true);
    setDraggedStage(null); setDesignerMode("canvas"); setGuidedStep(0); setGuidedStageIndex(0); setOpen(true);
  }
  function updateStage(index: number, patch: Partial<Stage>) { setStages((current) => current.map((stage, stageIndex) => stageIndex === index ? { ...stage, ...patch } : stage)); }
  function updateActions(index: number, patch: StageActions) { setStages((current) => current.map((stage, stageIndex) => stageIndex === index ? { ...stage, actions: { ...stage.actions, ...patch, adminAlert: patch.adminAlert ? { ...stage.actions.adminAlert, ...patch.adminAlert } : stage.actions.adminAlert } } : stage)); }
  function toggleCapability(index: number, capability: StageCapability) { setStages((current) => current.map((stage, stageIndex) => stageIndex === index ? { ...stage, capabilities: stage.capabilities.includes(capability) ? stage.capabilities.filter((item) => item !== capability) : [...stage.capabilities, capability] } : stage)); }
  function toggleAdminTask(index: number, task: AdminTask) { setStages((current) => current.map((stage, stageIndex) => stageIndex === index ? { ...stage, adminTasks: (stage.adminTasks ?? []).includes(task) ? (stage.adminTasks ?? []).filter((item) => item !== task) : [...(stage.adminTasks ?? []), task] } : stage)); }
  function moveStage(from: number, to: number) { if (to < 0 || to >= stages.length || from === to) return; setStages((current) => { const next = [...current]; const [item] = next.splice(from, 1); if (!item) return current; next.splice(to, 0, item); return next.map((stage, index) => ({ ...stage, order: index + 1 })); }); }
  function addStage() { setStages((current) => [...current, { key: `stage_${current.length + 1}`, label: `New stage ${current.length + 1}`, order: current.length + 1, capabilities: ["documents"], actions: {} }]); }
  function removeStage(index: number) { setStages((current) => current.filter((_, stageIndex) => stageIndex !== index).map((stage, stageIndex) => ({ ...stage, order: stageIndex + 1 }))); }

  const normalizedStages = stages.map((stage, index) => ({ ...stage, key: stageKey(stage.key, index), label: stage.label.trim(), order: index + 1 }));
  const duplicateKeys = new Set(normalizedStages.map((stage) => stage.key)).size !== normalizedStages.length;
  const invalidStages = normalizedStages.some((stage) => stage.label.length < 2 || stage.key.length < 2);
  const guidedStage = stages[guidedStageIndex] ?? stages[0];
  const columns: Column<Workflow>[] = [
    { key: "name", header: "Workflow", cell: (row) => <div><p className="font-medium text-ink">{row.name}</p><p className="mt-0.5 max-w-xl text-xs text-muted">{row.description || "No description"}</p></div> },
    { key: "stages", header: "Stages", cell: (row) => <span className="text-sm text-body">{normalizeStages(row.stages).length}</span> },
    { key: "state", header: "State", cell: (row) => <div className="flex gap-1.5">{row.customerPresentation === "wizard" ? <Badge tone="gold">Wizard</Badge> : <Badge tone="neutral">Cards</Badge>}{row.isDefault ? <Badge tone="teal">Default</Badge> : null}<Badge tone={row.active ? "success" : "neutral"}>{row.active ? "Active" : "Inactive"}</Badge></div> },
    { key: "action", header: "", align: "right", cell: (row) => <div className="flex justify-end gap-2"><Button size="sm" variant="outline" busy={exportWorkflow.isPending} leadingIcon={<Download className="size-3.5" />} onClick={() => void downloadWorkflowConfiguration(row)}>Export</Button><Button size="sm" variant="outline" leadingIcon={<Copy className="size-3.5" />} onClick={() => reset(row, true)}>Clone</Button><Button size="sm" variant="outline" leadingIcon={<Pencil className="size-3.5" />} onClick={() => reset(row)}>Edit</Button><Button size="sm" variant="ghost" leadingIcon={<Trash2 className="size-3.5 text-danger" />} onClick={() => { setDeleting(row); setDeleteConfirmation(""); }} aria-label={`Delete ${row.name}`}>Delete</Button></div> },
  ];

  return <>
    <PageHeader title="Order workflows" description="Build connected wizard steps, customer requirements, and auditable actions that administrators can run for individual orders." actions={<div className="flex flex-wrap gap-2"><input id="workflow-configuration-import" className="sr-only" type="file" accept="application/json,.json" onChange={(event) => void selectWorkflowConfiguration(event)} aria-label="Select an order workflow configuration file" /><Button variant="outline" leadingIcon={<Upload className="size-4" />} onClick={() => document.getElementById("workflow-configuration-import")?.click()}>Import configuration</Button><Button variant="outline" onClick={() => navigate("/admin/order-statuses")}>Manage order statuses</Button><Button leadingIcon={<Plus className="size-4" />} onClick={() => reset(null)}>New workflow</Button></div>} />
    <Alert tone="info" className="mb-5">Workflow changes are live definitions: every assigned order refreshes its customer and administrator phase workspaces from the saved stage labels, capabilities, and available actions. Existing files and questions remain associated with their stable stage key.</Alert>
    {workflows.isLoading ? <div className="space-y-3">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-16 w-full" />)}</div> : (workflows.data ?? []).length ? <DataTable caption="Order workflows" columns={columns} rows={(workflows.data ?? []) as Workflow[]} rowKey={(row) => row.id} /> : <EmptyState icon={ClipboardList} title="No workflows" description="Create a workflow before assigning one to an order." action={<Button onClick={() => reset(null)}>New workflow</Button>} />}
    <Modal size="2xl" open={open} onClose={() => setOpen(false)} title={editing ? "Edit order workflow" : "New order workflow"} description="Use the visual stage builder to define customer workspaces and optional administrator-run actions." footer={<><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button busy={save.isPending} disabled={name.trim().length < 2 || normalizedStages.length === 0 || invalidStages || duplicateKeys} leadingIcon={<Save className="size-4" />} onClick={() => save.mutate({ id: editing?.id, name: name.trim(), description: description.trim() || undefined, customerPresentation, stages: normalizedStages, isDefault, active })}>Save workflow</Button></>}>
      <div className="space-y-5">
        <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]"><Input label="Workflow name" value={name} onChange={(event) => setName(event.target.value)} required /><Input label="Workflow description" value={description} onChange={(event) => setDescription(event.target.value)} /></div>
        <div className="rounded-lg border border-teal/20 bg-teal/5 p-4"><div className="flex items-center gap-2"><LayoutTemplate className="size-4 text-teal" /><p className="text-sm font-semibold text-ink">Customer workspace presentation</p></div><p className="mt-2 text-sm text-body">Every assigned workflow uses the guided wizard. Customers complete one step at a time, then may review locked completed steps without bypassing the current step.</p><input type="hidden" value={customerPresentation} /></div>
        <Alert tone="info">Stage keys are stable technical references. Rename a <strong>stage label</strong> freely; retain a key when it already has customer files or questions so those materials remain visible in its updated workspace.</Alert>
        <div className="rounded-xl border border-gold/30 bg-gold/5 p-4"><div><p className="text-base font-semibold text-ink">File conversion and selected-site SharePoint routing</p><p className="mt-1 text-sm text-muted">Configure the append-only conversion profiles and destination sites for each stage. This section is available regardless of which designer view is selected.</p></div><div className="mt-4 space-y-3">{stages.map((stage, index) => <details key={`conversion-routing-${stage.key}-${index}`} className="rounded-lg border border-line bg-white p-3"><summary className="cursor-pointer font-medium text-ink">{index + 1}. {stage.label || stage.key} <span className="ml-2 text-xs font-normal text-muted">{(stage.conversionRouting?.conversionProfileIds?.length ?? 0)} conversion profile(s)</span></summary><div className="mt-3"><ConversionRoutingFields routing={stage.conversionRouting} onChange={(conversionRouting) => updateStage(index, { conversionRouting })} profiles={(conversionProfiles.data ?? []) as ConversionProfileOption[]} targets={(sharepointTargets.data ?? []) as SharepointTargetOption[]} /></div></details>)}</div></div>
        <div className="rounded-xl border border-line bg-surface-soft p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-base font-semibold text-ink">Workflow designer type</p><p className="text-sm text-muted">Use the visual canvas for all stages at once, or the guided designer to configure customer and administrator work one step at a time.</p></div><Select className="w-full sm:w-64" label="Designer" value={designerMode} onChange={(event) => { setDesignerMode(event.target.value as "canvas" | "guided"); setGuidedStep(0); }}><option value="canvas">Visual stage canvas</option><option value="guided">Guided task wizard</option></Select></div></div>
        {designerMode === "guided" && guidedStage ? <div className="rounded-xl border border-teal/30 bg-teal/5 p-5"><div className="flex flex-wrap gap-2">{GUIDED_DESIGNER_STEPS.map((step, index) => <Button key={step} size="sm" variant={guidedStep === index ? "primary" : "outline"} onClick={() => setGuidedStep(index)}>{index + 1}. {step}</Button>)}</div><div className="mt-5 rounded-lg border border-line bg-white p-4"><div className="flex flex-wrap items-end justify-between gap-3"><Select className="min-w-56" label="Stage being designed" value={String(guidedStageIndex)} onChange={(event) => { const nextIndex = Number(event.target.value); setGuidedStageIndex(Number.isInteger(nextIndex) ? nextIndex : 0); }} >{stages.map((stage, index) => <option key={`${stage.order}-${stage.key}`} value={String(index)}>{index + 1}. {stage.label}</option>)}</Select><Button size="sm" variant="outline" leadingIcon={<Plus className="size-3.5" />} onClick={() => { addStage(); setGuidedStageIndex(stages.length); }}>Add stage</Button></div>{guidedStep === 0 ? <div className="mt-5 grid gap-3 md:grid-cols-2"><Input label="Stable stage key" value={guidedStage.key} onChange={(event) => updateStage(guidedStageIndex, { key: stageKey(event.target.value, guidedStageIndex) })} help="Lowercase letters, numbers, and underscores." /><Input label="Customer-facing stage label" value={guidedStage.label} onChange={(event) => updateStage(guidedStageIndex, { label: event.target.value })} /></div> : null}{guidedStep === 1 ? <div className="mt-5"><p className="text-sm font-semibold text-ink">Customer order workflow tasks</p><p className="mt-1 text-sm text-muted">Choose what the customer completes in this stage.</p><div className="mt-3 grid gap-2 sm:grid-cols-2">{CAPABILITIES.map((capability) => <label key={capability.key} className={`flex cursor-pointer gap-2 rounded-lg border p-3 ${(guidedStage.capabilities ?? []).includes(capability.key) ? "border-teal/50 bg-teal/5" : "border-line"}`}><Checkbox checked={(guidedStage.capabilities ?? []).includes(capability.key)} onChange={() => toggleCapability(guidedStageIndex, capability.key)} label="" /><span><span className="font-medium text-ink">{capability.label}</span><span className="mt-0.5 block text-xs text-muted">{capability.description}</span></span></label>)}</div></div> : null}{guidedStep === 2 ? <div className="mt-5 space-y-4"><div><p className="text-sm font-semibold text-ink">Upload governance and SharePoint destinations</p><p className="mt-1 text-sm text-muted">Set the folders used by every file added to this stage. This includes customer documents and recordings, plus documents and pre-recorded audio an administrator uploads using <strong>Order → Files → Upload phase documents</strong>.</p></div><div className="grid gap-3 md:grid-cols-2"><Input label="Document folder — staff and customer documents" placeholder="Phase I/Docs" value={guidedStage.sharePointDestination ?? ""} onChange={(event) => updateStage(guidedStageIndex, { sharePointDestination: event.target.value || undefined })} help="All non-audio files for this stage." /><Input label="Audio folder — staff and customer audio" placeholder="Phase I/Audio" value={guidedStage.sharePointAudioDestination ?? ""} onChange={(event) => updateStage(guidedStageIndex, { sharePointAudioDestination: event.target.value || undefined })} help="Browser recordings and pre-recorded audio for this stage." /></div><Alert tone="info">These paths are relative to the managed customer/order folder. Leave either field blank to use the safe phase default. ReadyPackets selects the destination by detected file type and records the final path in the order’s SharePoint Sync tab.</Alert></div> : null}{guidedStep === 3 ? <div className="mt-5 space-y-4"><div><p className="text-sm font-semibold text-ink">Customer instructions, announcement, and progression</p><p className="mt-1 text-sm text-muted">Optionally publish one stage-specific instruction or announcement. Use the safe live preview to confirm exactly what the customer will see.</p></div><div className="grid gap-3 md:grid-cols-2"><Select label="Customer content" value={guidedStage.customerMessage?.kind ?? ""} onChange={(event) => { const kind = event.target.value as "" | CustomerMessage["kind"]; updateStage(guidedStageIndex, { customerMessage: kind ? { kind, title: guidedStage.customerMessage?.title, bodyMarkdown: guidedStage.customerMessage?.bodyMarkdown ?? "" } : undefined }); }}><option value="">No stage message</option><option value="instructions">Instructions</option><option value="announcement">Announcement</option></Select><Select label="How the customer moves forward" value={guidedStage.advanceMode ?? "submit_lock"} onChange={(event) => updateStage(guidedStageIndex, { advanceMode: event.target.value as "next" | "submit_lock" })}><option value="submit_lock">Submit and lock before next phase</option><option value="next">Next button; keep this phase editable</option></Select></div>{guidedStage.customerMessage ? <div className="space-y-3 rounded-lg border border-teal/20 bg-teal/5 p-4"><Input label="Message title" value={guidedStage.customerMessage.title ?? ""} onChange={(event) => updateStage(guidedStageIndex, { customerMessage: { ...guidedStage.customerMessage!, title: event.target.value || undefined } })} placeholder={guidedStage.customerMessage.kind === "announcement" ? "e.g., Important update" : "e.g., What to prepare"} /><Textarea label="Message content" value={guidedStage.customerMessage.bodyMarkdown} onChange={(event) => updateStage(guidedStageIndex, { customerMessage: { ...guidedStage.customerMessage!, bodyMarkdown: event.target.value } })} rows={8} help="Supports safe Markdown. Script and unsafe-link markup is displayed as text rather than executed." /><Card><CardHeader title="Customer preview" description={guidedStage.customerMessage.kind === "announcement" ? "Announcement appearance in the customer workflow." : "Instruction appearance in the customer workflow."} />{guidedStage.customerMessage.bodyMarkdown.trim() ? <Markdown className="prose-rp mt-4 max-w-none" source={guidedStage.customerMessage.bodyMarkdown} /> : <p className="mt-4 text-sm text-muted">Start typing to preview this customer message.</p>}</Card></div> : <Alert tone="info">This stage has no customer instruction or announcement. You can still choose its progression behavior above.</Alert>}{guidedStage.advanceMode === "next" ? <Alert tone="warning">The customer will use a Next button. This opens the following workflow stage but does not lock files, recordings, or answers in this stage.</Alert> : <Alert tone="info">The customer will use Submit and lock. Existing acknowledgement policy applies before the following stage opens.</Alert>}</div> : null}{guidedStep === 4 ? <div className="mt-5"><p className="text-sm font-semibold text-ink">Administrator order workflow tasks</p><p className="mt-1 text-sm text-muted">Document the team work required for this stage, then choose actions the portal should execute when an administrator runs it.</p><div className="mt-3 grid gap-2 sm:grid-cols-2">{ADMIN_TASKS.map((task) => <label key={task.key} className={`flex cursor-pointer gap-2 rounded-lg border p-3 ${(guidedStage.adminTasks ?? []).includes(task.key) ? "border-navy/40 bg-navy/5" : "border-line"}`}><Checkbox checked={(guidedStage.adminTasks ?? []).includes(task.key)} onChange={() => toggleAdminTask(guidedStageIndex, task.key)} label="" /><span><span className="font-medium text-ink">{task.label}</span><span className="mt-0.5 block text-xs text-muted">{task.description}</span></span></label>)}</div><div className="mt-4 grid gap-3 md:grid-cols-2"><Select label="Order status update" value={guidedStage.actions.orderStatus ?? ""} onChange={(event) => updateActions(guidedStageIndex, { orderStatus: event.target.value || undefined })}><option value="">Do not change status</option>{activeStatuses.map((status) => <option key={status.key} value={status.key}>{status.label}</option>)}</Select><CompletionPolicyFields actions={guidedStage.actions} onChange={(patch) => updateActions(guidedStageIndex, patch)} /></div></div> : null}{guidedStep === 5 ? <div className="mt-5"><p className="text-sm font-semibold text-ink">Customer phase-lock acknowledgement</p><Select className="mt-3" label="Acknowledgement policy" value={guidedStage.customerAcknowledgement ?? "required"} onChange={(event) => updateStage(guidedStageIndex, { customerAcknowledgement: event.target.value as "required" | "optional" | "none" })}><option value="required">Required acknowledgement</option><option value="optional">Optional acknowledgement</option><option value="none">No acknowledgement prompt</option></Select>{(guidedStage.customerAcknowledgement ?? "required") !== "none" ? <Textarea className="mt-3" label="Acknowledgement message template" value={guidedStage.submissionNotice ?? ""} onChange={(event) => updateStage(guidedStageIndex, { submissionNotice: event.target.value || undefined })} help="Optional. The default irreversible-lock notice is used when blank." /> : <Alert tone="warning" className="mt-3">Customers can submit and lock this stage without an acknowledgement prompt. Administrators must still confirm an unlock.</Alert>}</div> : null}{guidedStep === 6 ? <div className="mt-5 space-y-3"><p className="text-sm font-semibold text-ink">Review this workflow stage</p><div className="grid gap-3 sm:grid-cols-2"><Card><CardHeader title="Customer tasks" description={(guidedStage.capabilities ?? []).length ? (guidedStage.capabilities ?? []).join(", ") : "No customer action configured"} /></Card><Card><CardHeader title="Administrator tasks" description={(guidedStage.adminTasks ?? []).length ? (guidedStage.adminTasks ?? []).map((task) => ADMIN_TASKS.find((item) => item.key === task)?.label ?? task).join(", ") : "No documented administrator task"} /></Card><Card><CardHeader title="Status action" description={guidedStage.actions.orderStatus ? configuredStatusLabel(guidedStage.actions.orderStatus) : "No status change"} /></Card><Card><CardHeader title="Acknowledgement" description={guidedStage.customerAcknowledgement ?? "required"} /></Card></div></div> : null}<div className="mt-6 flex justify-between gap-2"><Button variant="outline" disabled={guidedStep === 0} onClick={() => setGuidedStep((current) => Math.max(0, current - 1))}>Previous</Button><Button disabled={guidedStep === GUIDED_DESIGNER_STEPS.length - 1} onClick={() => setGuidedStep((current) => Math.min(GUIDED_DESIGNER_STEPS.length - 1, current + 1))}>Next</Button></div></div></div> : null}
        <div className={designerMode === "canvas" ? "rounded-xl border border-line bg-surface-soft p-4" : "hidden"}><div className="mb-4 flex items-center justify-between gap-3"><div><p className="text-base font-semibold text-ink">Connected phase canvas</p><p className="text-sm text-muted">Drag a stage card to reorder it. Configure customer requirements and optional order actions per stage.</p></div><Button size="sm" variant="outline" leadingIcon={<Plus className="size-3.5" />} onClick={addStage}>Add phase</Button></div>
          <div className="space-y-3">{stages.map((stage, index) => <div key={`stage-editor-${stage.order}`} draggable onDragStart={() => setDraggedStage(index)} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (draggedStage !== null) moveStage(draggedStage, index); setDraggedStage(null); }} className={`rounded-xl border bg-white p-5 shadow-sm ${draggedStage === index ? "border-teal ring-2 ring-teal/20" : "border-line"}`}>
            <div className="flex gap-4"><div className="flex flex-col items-center text-muted"><GripVertical className="mt-1 size-5 cursor-grab" /><span className="mt-2 rounded-full bg-teal px-2 py-0.5 text-xs font-bold text-white">{index + 1}</span>{index < stages.length - 1 ? <ArrowDown className="mt-2 size-4 text-teal" /> : null}</div><div className="min-w-0 flex-1 space-y-4">
              <div className="grid gap-3 lg:grid-cols-[minmax(10rem,0.55fr)_minmax(14rem,1fr)]"><Input label="Stable stage key" value={stage.key} onChange={(event) => updateStage(index, { key: stageKey(event.target.value, index) })} help="Lowercase letters, numbers, and underscores." /><Input label="Customer-facing stage label" value={stage.label} onChange={(event) => updateStage(index, { label: event.target.value })} /></div>
              <div><p className="text-xs font-semibold uppercase tracking-wide text-muted">Customer actions enabled in this phase</p><div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{CAPABILITIES.map((capability) => { const Icon = capability.icon; return <label key={capability.key} className={`flex cursor-pointer gap-2 rounded-lg border p-2.5 text-sm ${stage.capabilities.includes(capability.key) ? "border-teal/50 bg-teal/5" : "border-line"}`}><Checkbox checked={stage.capabilities.includes(capability.key)} onChange={() => toggleCapability(index, capability.key)} label="" /><span><span className="flex items-center gap-1.5 font-medium text-ink"><Icon className="size-3.5 text-teal" />{capability.label}</span><span className="mt-0.5 block text-xs text-muted">{capability.description}</span></span></label>; })}</div>{stage.capabilities.includes("review_space") ? <Alert tone="info" className="mt-3">This is a read-only customer review step. In each assigned order, upload or assign team files to this stage and use the Files tab’s <strong>Publish</strong> control. Only published team files for this stage appear for the customer to review and download.</Alert> : null}</div>
                            <div className="rounded-lg border border-teal/20 bg-teal/5 p-3"><p className="text-sm font-semibold text-ink">Upload governance</p><p className="mt-1 text-xs text-muted">Optional limits apply to every customer and staff upload in this phase. Leave a field blank to use the platform limit.</p><div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3"><Input label="Document count" type="number" min="1" max="50" placeholder="Platform" value={stage.uploadLimits?.documentMaxFiles ?? ""} onChange={(event) => updateStage(index, { uploadLimits: { ...stage.uploadLimits, documentMaxFiles: event.target.value ? Math.max(1, Math.min(50, Number(event.target.value))) : undefined } })} /><Input label="Document MB each" type="number" min="1" max="100" placeholder="Platform" value={stage.uploadLimits?.documentMaxSizeMb ?? ""} onChange={(event) => updateStage(index, { uploadLimits: { ...stage.uploadLimits, documentMaxSizeMb: event.target.value ? Math.max(1, Math.min(100, Number(event.target.value))) : undefined } })} /><Input label="Audio count" type="number" min="1" max="50" placeholder="Platform" value={stage.uploadLimits?.audioMaxFiles ?? ""} onChange={(event) => updateStage(index, { uploadLimits: { ...stage.uploadLimits, audioMaxFiles: event.target.value ? Math.max(1, Math.min(50, Number(event.target.value))) : undefined } })} /><Input label="Audio MB each" type="number" min="1" max="100" placeholder="Platform" value={stage.uploadLimits?.audioMaxSizeMb ?? ""} onChange={(event) => updateStage(index, { uploadLimits: { ...stage.uploadLimits, audioMaxSizeMb: event.target.value ? Math.max(1, Math.min(100, Number(event.target.value))) : undefined } })} /><Input label="WebM recording seconds each" type="number" min="1" max="7200" placeholder="No limit" value={stage.uploadLimits?.recordingMaxDurationSeconds ?? ""} onChange={(event) => updateStage(index, { uploadLimits: { ...stage.uploadLimits, recordingMaxDurationSeconds: event.target.value ? Math.max(1, Math.min(7200, Number(event.target.value))) : undefined } })} /><Input label="Total audio seconds" type="number" min="1" max="7200" placeholder="No limit" value={stage.uploadLimits?.audioTotalDurationSeconds ?? ""} onChange={(event) => updateStage(index, { uploadLimits: { ...stage.uploadLimits, audioTotalDurationSeconds: event.target.value ? Math.max(1, Math.min(7200, Number(event.target.value))) : undefined } })} /></div></div>
                            <div className="rounded-lg border border-teal/20 bg-teal/5 p-3"><p className="text-sm font-semibold text-ink">SharePoint destinations for Order → Files → Upload phase documents</p><p className="mt-1 text-xs text-muted">These folders control where an administrator’s <strong>Order → Files → Upload phase documents</strong> uploads synchronize. They also apply to customer uploads and browser recordings in this stage. ReadyPackets detects the file type and sends documents and audio to separate destinations.</p><div className="mt-3 grid gap-3 md:grid-cols-2"><Input label="Document folder — staff and customer documents" placeholder="Phase I/Docs" value={stage.sharePointDestination ?? ""} onChange={(event) => updateStage(index, { sharePointDestination: event.target.value || undefined })} help="All non-audio files uploaded to this stage." /><Input label="Audio folder — staff and customer audio" placeholder="Phase I/Audio" value={stage.sharePointAudioDestination ?? ""} onChange={(event) => updateStage(index, { sharePointAudioDestination: event.target.value || undefined })} help="Browser recordings and pre-recorded audio uploaded to this stage." /></div><p className="mt-2 text-xs text-muted">Leave a field blank to use the phase’s safe default subfolder. Folders are relative to the managed customer/order root; use letters, numbers, spaces, underscores, dashes, parentheses, periods, and forward slashes.</p></div>
                            <div className="rounded-lg border border-teal/20 bg-teal/5 p-3"><p className="text-sm font-semibold text-ink">Customer submission acknowledgement</p><p className="mt-1 text-xs text-muted">Choose whether a customer must acknowledge the phase lock, may acknowledge it, or submits without an acknowledgement prompt.</p><Select className="mt-3" label="Acknowledgement policy" value={stage.customerAcknowledgement ?? "required"} onChange={(event) => updateStage(index, { customerAcknowledgement: event.target.value as "required" | "optional" | "none" })}><option value="required">Required acknowledgement</option><option value="optional">Optional acknowledgement</option><option value="none">No acknowledgement prompt</option></Select>{(stage.customerAcknowledgement ?? "required") !== "none" ? <Textarea className="mt-3" label="Acknowledgement message template" value={stage.submissionNotice ?? ""} onChange={(event) => updateStage(index, { submissionNotice: event.target.value || undefined })} help="Optional. When blank, the portal uses the standard irreversible-lock warning." /> : <p className="mt-3 text-xs text-muted">The customer can submit and lock this phase without a prompt. The lock remains server-enforced and administrators must still confirm an unlock.</p>}</div>
                            <div className="rounded-lg border border-gold/30 bg-gold/5 p-3"><p className="text-sm font-semibold text-ink">Customer instructions, announcement, and progression</p><p className="mt-1 text-xs text-muted">Optionally publish one safe Markdown message in this stage, then choose whether the customer uses Next or Submit and lock.</p><div className="mt-3 grid gap-3 md:grid-cols-2"><Select label="Customer content" value={stage.customerMessage?.kind ?? ""} onChange={(event) => { const kind = event.target.value as "" | CustomerMessage["kind"]; updateStage(index, { customerMessage: kind ? { kind, title: stage.customerMessage?.title, bodyMarkdown: stage.customerMessage?.bodyMarkdown ?? "" } : undefined }); }}><option value="">No stage message</option><option value="instructions">Instructions</option><option value="announcement">Announcement</option></Select><Select label="Customer progression" value={stage.advanceMode ?? "submit_lock"} onChange={(event) => updateStage(index, { advanceMode: event.target.value as "next" | "submit_lock" })}><option value="submit_lock">Submit and lock before next phase</option><option value="next">Next button; keep this phase editable</option></Select></div>{stage.customerMessage ? <div className="mt-3 space-y-3"><Input label="Message title" value={stage.customerMessage.title ?? ""} onChange={(event) => updateStage(index, { customerMessage: { ...stage.customerMessage!, title: event.target.value || undefined } })} placeholder={stage.customerMessage.kind === "announcement" ? "e.g., Important update" : "e.g., What to prepare"} /><Textarea label="Message content" value={stage.customerMessage.bodyMarkdown} onChange={(event) => updateStage(index, { customerMessage: { ...stage.customerMessage!, bodyMarkdown: event.target.value } })} rows={7} help="Safe Markdown is supported; scripts and unsafe links are rendered as text." /><Card><CardHeader title="Customer preview" description={stage.customerMessage.kind === "announcement" ? "Announcement shown in this stage." : "Instructions shown in this stage."} />{stage.customerMessage.bodyMarkdown.trim() ? <Markdown className="prose-rp mt-4 max-w-none" source={stage.customerMessage.bodyMarkdown} /> : <p className="mt-4 text-sm text-muted">Start typing to preview this customer message.</p>}</Card></div> : null}{stage.advanceMode === "next" ? <Alert tone="warning" className="mt-3">Next opens the following stage but leaves this stage editable. No phase lock is created.</Alert> : <Alert tone="info" className="mt-3">Submit and lock uses the acknowledgement policy below and creates an administrator-unlock-only phase lock.</Alert>}</div>
              <div><p className="text-xs font-semibold uppercase tracking-wide text-muted">Administrator tasks documented in this phase</p><div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{ADMIN_TASKS.map((task) => <label key={task.key} className={`flex cursor-pointer gap-2 rounded-lg border p-2.5 text-sm ${(stage.adminTasks ?? []).includes(task.key) ? "border-navy/40 bg-navy/5" : "border-line"}`}><Checkbox checked={(stage.adminTasks ?? []).includes(task.key)} onChange={() => toggleAdminTask(index, task.key)} label="" /><span><span className="font-medium text-ink">{task.label}</span><span className="mt-0.5 block text-xs text-muted">{task.description}</span></span></label>)}</div></div>
              <div className="rounded-lg border border-navy/15 bg-surface-soft p-3"><div className="flex items-center justify-between gap-3"><div><p className="text-sm font-semibold text-ink">Administrator-run stage actions</p>
<p className="text-xs text-muted">These execute only when an administrator runs this stage on an assigned order.</p></div><Badge tone={actionCount(stage.actions) ? "teal" : "neutral"}>{actionCount(stage.actions)} configured</Badge></div>
                <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  <Select label="Email alert template" value={stage.actions.emailTemplateKey ?? ""} onChange={(event) => updateActions(index, { emailTemplateKey: event.target.value || undefined })}><option value="">No customer email</option>{(templates.data ?? []).filter((template) => template.enabled).map((template) => <option key={template.templateKey} value={template.templateKey}>{template.name}</option>)}</Select>
                  <Select label="Order status update" value={stage.actions.orderStatus ?? ""} onChange={(event) => updateActions(index, { orderStatus: event.target.value || undefined })}><option value="">Do not change status</option>{activeStatuses.map((status) => <option key={status.key} value={status.key}>{status.label}</option>)}</Select>
                  <CompletionPolicyFields actions={stage.actions} onChange={(patch) => updateActions(index, patch)} />
                  <Select label="Webhook trigger" value={stage.actions.webhookEndpointId ? String(stage.actions.webhookEndpointId) : ""} onChange={(event) => updateActions(index, { webhookEndpointId: event.target.value ? Number(event.target.value) : undefined })}><option value="">No webhook</option>{(endpoints.data ?? []).filter((endpoint) => endpoint.enabled).map((endpoint) => <option key={endpoint.id} value={String(endpoint.id)}>{endpoint.name}</option>)}</Select>
                  <label className={`flex cursor-pointer gap-2 rounded-lg border p-3 text-sm ${stage.actions.adminAlert?.enabled ? "border-teal/50 bg-teal/5" : "border-line"}`}><Checkbox checked={stage.actions.adminAlert?.enabled === true} onChange={(event) => updateActions(index, { adminAlert: { enabled: event.target.checked } })} label="" /><span><span className="flex items-center gap-1.5 font-medium text-ink"><Bell className="size-4 text-teal" />Administrator dashboard alert</span><span className="mt-0.5 block text-xs text-muted">Create an operational alert when this stage is run.</span></span></label>
                  {stage.actions.adminAlert?.enabled ? <Select label="Alert severity" value={stage.actions.adminAlert.severity ?? "warning"} onChange={(event) => updateActions(index, { adminAlert: { severity: event.target.value as "warning" | "error" | "critical" } })}><option value="warning">Warning</option><option value="error">Error</option><option value="critical">Critical</option></Select> : <div className="rounded-lg border border-dashed border-line p-3 text-xs text-muted">Enable the dashboard alert to select severity and custom text.</div>}
                </div>
                {stage.actions.adminAlert?.enabled ? <Textarea className="mt-3" label="Administrator alert message" value={stage.actions.adminAlert.message ?? ""} onChange={(event) => updateActions(index, { adminAlert: { message: event.target.value } })} help="Optional. A stage and order reference is used when blank." /> : null}
                <div className="mt-3 flex flex-wrap gap-2 text-xs">{stage.actions.emailTemplateKey ? <Badge tone="teal"><Mail className="mr-1 inline size-3" />Email</Badge> : null}{stage.actions.orderStatus ? <Badge tone="teal"><ArrowDownUp className="mr-1 inline size-3" />Status: {configuredStatusLabel(stage.actions.orderStatus)}</Badge> : null}{completionPolicyLabel(stage.actions) ? <Badge tone="teal"><Gauge className="mr-1 inline size-3" />{completionPolicyLabel(stage.actions)}</Badge> : null}{stage.actions.webhookEndpointId ? <Badge tone="teal"><Webhook className="mr-1 inline size-3" />Webhook</Badge> : null}{stage.actions.adminAlert?.enabled ? <Badge tone="teal"><Bell className="mr-1 inline size-3" />Admin alert</Badge> : null}</div>
              </div>
            </div><div className="flex flex-col gap-1"><Button size="sm" variant="ghost" aria-label="Move stage up" disabled={index === 0} onClick={() => moveStage(index, index - 1)}><ArrowUp className="size-4" /></Button><Button size="sm" variant="ghost" aria-label="Move stage down" disabled={index === stages.length - 1} onClick={() => moveStage(index, index + 1)}><ArrowDownUp className="size-4" /></Button><Button size="sm" variant="ghost" aria-label="Remove stage" disabled={stages.length === 1} onClick={() => removeStage(index)}><Trash2 className="size-4 text-danger" /></Button></div></div>
          </div>)}</div>
        </div>
        {duplicateKeys ? <Alert tone="danger">Each stage must use a unique stable key.</Alert> : null}{invalidStages ? <Alert tone="warning">Every stage needs a readable label and stable key. Customer actions are optional when a stage only performs administrator-run actions.</Alert> : null}
        <div className="grid gap-3 md:grid-cols-2"><Checkbox label="Use as the default workflow for new orders" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} /><Checkbox label="Active and available for assignment" checked={active} onChange={(event) => setActive(event.target.checked)} /></div>
      </div>
    </Modal>
    <Modal open={Boolean(importConfiguration)} onClose={() => { if (!importWorkflow.isPending) resetImport(); }} title="Import order workflow configuration" description="Review the portable workflow configuration before creating a separate new workflow definition."><div className="space-y-4">{importConfiguration ? <><Alert tone="info"><strong>{importFileName}</strong> contains <strong>{importConfiguration.workflow.stages.length}</strong> workflow stages. The import creates a new workflow and never overwrites an existing workflow or changes the default workflow.</Alert><Alert tone="warning">Environment-specific webhook assignments are intentionally excluded from exports. Review and select any applicable webhook endpoint after importing.</Alert><div className="grid gap-3 md:grid-cols-2"><Input label="New workflow name" value={importName} onChange={(event) => setImportName(event.target.value)} required /><Input label="Source workflow" value={importConfiguration.workflow.name} readOnly /></div><Input label="Type IMPORT WORKFLOW CONFIGURATION to confirm" value={importConfirmation} onChange={(event) => setImportConfirmation(event.target.value)} /><div className="flex justify-end gap-2"><Button variant="outline" onClick={resetImport} disabled={importWorkflow.isPending}>Cancel</Button><Button busy={importWorkflow.isPending} disabled={importName.trim().length < 2 || importConfirmation !== "IMPORT WORKFLOW CONFIGURATION"} leadingIcon={<Upload className="size-4" />} onClick={() => importWorkflow.mutate({ name: importName.trim(), confirmation: "IMPORT WORKFLOW CONFIGURATION", configuration: importConfiguration })}>Import as new workflow</Button></div></> : null}</div></Modal>
    <Modal open={Boolean(deleting)} onClose={() => { if (!deleteWorkflow.isPending) { setDeleting(null); setDeleteConfirmation(""); } }} title="Delete workflow" description="Deletion is permanent for the workflow definition. Assigned active orders and the current default workflow cannot be deleted."><div className="space-y-4"><Alert tone="warning">Delete <strong>{deleting?.name}</strong> only after all active orders have been reassigned. Historical order records remain protected by the server.</Alert><Input label="Type DELETE WORKFLOW to confirm" value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} /><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => { setDeleting(null); setDeleteConfirmation(""); }} disabled={deleteWorkflow.isPending}>Cancel</Button><Button variant="danger" busy={deleteWorkflow.isPending} disabled={!deleting || deleteConfirmation !== "DELETE WORKFLOW"} onClick={() => deleting && deleteWorkflow.mutate({ workflowId: deleting.id, confirmation: "DELETE WORKFLOW" })}>Delete workflow</Button></div></div></Modal>
  </>;
}
