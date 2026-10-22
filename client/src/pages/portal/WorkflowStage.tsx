import { useEffect, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { CheckCircle2, Download, FileAudio, FileQuestion, FileText, Megaphone, Mic, Upload } from "lucide-react";
import { trpc, errorMessage, refreshCsrfToken, csrfToken } from "@/lib/trpc";
import { formatBytes, formatDate } from "@/lib/utils";
import { normalizeAudioRecordingFormat, recordingFileName, selectAudioRecordingFormat } from "@/lib/audioRecording";
import { Button, LinkButton } from "@/components/ui/Button";
import { AudioPlayback } from "@/components/ui/AudioPlayback";
import { Textarea } from "@/components/ui/Field";
import { Alert, Badge, Card, CardHeader, EmptyState, Skeleton } from "@/components/ui/Surface";
import { Modal } from "@/components/ui/Modal";
import { ProgressBar } from "@/components/ui/DataDisplay";
import { useToast } from "@/components/ui/Toast";
import { PageHeader } from "@/components/layout/PortalLayout";
import { Markdown } from "@/lib/markdown";

type Capability = "documents" | "questions" | "recording" | "audio_upload" | "review_space";
type UploadLimits = { documentMaxFiles?: number; documentMaxSizeMb?: number; audioMaxFiles?: number; audioMaxSizeMb?: number; recordingMaxDurationSeconds?: number; audioTotalDurationSeconds?: number };
type CustomerMessage = { kind: "instructions" | "announcement"; title?: string; bodyMarkdown: string };
type WorkflowStage = { key: string; label: string; order: number; capabilities?: Capability[]; customerMessage?: CustomerMessage; advanceMode?: "next" | "submit_lock"; customerAcknowledgement?: "required" | "optional" | "none"; submissionNotice?: string; uploadLimits?: UploadLimits };
const AUDIO_EXTENSIONS = new Set(["webm", "wav", "mp3", "m4a", "ogg"]);

function customerMessageFromUnknown(value: unknown): CustomerMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const bodyMarkdown = typeof raw.bodyMarkdown === "string" ? raw.bodyMarkdown.trim() : "";
  if (!bodyMarkdown) return undefined;
  return { kind: raw.kind === "announcement" ? "announcement" : "instructions", title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : undefined, bodyMarkdown };
}

function stagesFromUnknown(value: unknown): WorkflowStage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is { key?: unknown; label?: unknown; order?: unknown; capabilities?: unknown; customerMessage?: unknown; advanceMode?: unknown; customerAcknowledgement?: unknown; submissionNotice?: unknown; uploadLimits?: unknown } => Boolean(item) && typeof item === "object")
    .filter((item) => typeof item.key === "string" && typeof item.label === "string")
    .map((item, index) => ({
      key: item.key as string,
      label: item.label as string,
      order: typeof item.order === "number" ? item.order : index + 1,
      capabilities: Array.isArray(item.capabilities)
        ? item.capabilities.filter((capability): capability is Capability => capability === "documents" || capability === "questions" || capability === "recording" || capability === "audio_upload" || capability === "review_space")
        : ["documents", "questions", "recording"] as Capability[],
      customerMessage: customerMessageFromUnknown(item.customerMessage),
      advanceMode: (item.advanceMode === "next" ? "next" : "submit_lock") as "next" | "submit_lock",
      customerAcknowledgement: (item.customerAcknowledgement === "required" || item.customerAcknowledgement === "optional" || item.customerAcknowledgement === "none" ? item.customerAcknowledgement : "required") as "required" | "optional" | "none",
      submissionNotice: typeof item.submissionNotice === "string" ? item.submissionNotice : undefined,
      uploadLimits: item.uploadLimits && typeof item.uploadLimits === "object" ? item.uploadLimits as UploadLimits : undefined,
    }))
    .sort((left, right) => left.order - right.order);
}

export function WorkflowStagePage() {
  const params = useParams<{ id: string; phaseKey: string }>();
  const orderId = Number(params.id);
  const phaseKey = params.phaseKey ?? "";
  const [, navigate] = useLocation();
  const toast = useToast();
  const utils = trpc.useUtils();
  const detail = trpc.orders.detail.useQuery({ orderId }, { enabled: Number.isFinite(orderId) });
  const stageAccess = trpc.orders.workflowStageAccess.useQuery({ orderId, phaseKey }, { enabled: Number.isFinite(orderId) && phaseKey.length > 0 });
  const filesQuery = trpc.files.listForOrder.useQuery({ orderId }, { enabled: Number.isFinite(orderId) });
  const questions = trpc.orders.questions.useQuery({ orderId }, { enabled: Number.isFinite(orderId) });
  const fileInput = useRef<HTMLInputElement>(null);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const audioChunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingLimitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingSecondsRef = useRef(0);
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [microphoneOpen, setMicrophoneOpen] = useState(false);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [submissionOpen, setSubmissionOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("focus") !== "documents") return;
    const timeout = window.setTimeout(() => {
      const target = document.getElementById("workflow-documents");
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      window.history.replaceState(window.history.state, "", window.location.pathname);
      target.focus({ preventScroll: true });
    }, 160);
    return () => window.clearTimeout(timeout);
  }, [phaseKey, detail.isSuccess, stageAccess.isSuccess]);

  const deleteFile = trpc.files.delete.useMutation({
    async onSuccess() { await filesQuery.refetch(); toast.success("File removed"); },
    onError(error) { toast.error("Could not remove file", errorMessage(error)); },
  });
  const answerQuestion = trpc.orders.answerQuestion.useMutation({
    async onSuccess() { await questions.refetch(); toast.success("Answer saved"); },
    onError(error) { toast.error("Could not save answer", errorMessage(error)); },
  });
  const requestDownload = trpc.files.requestDownload.useMutation({
    onSuccess(data) { window.open(data.url, "_blank", "noopener,noreferrer"); },
    onError(error) { toast.error("Could not prepare file download", errorMessage(error)); },
  });
  const bulkDownload = trpc.files.bulkDownload.useMutation({
    onSuccess(data) {
      window.open(data.url, "_blank", "noopener,noreferrer");
      toast.success("Phase download prepared", `${data.fileCount} file${data.fileCount === 1 ? "" : "s"} will download as a ZIP archive.`);
    },
    onError(error) { toast.error("Could not prepare phase download", errorMessage(error)); },
  });
  const submitPhase = trpc.orders.submitWorkflowPhase.useMutation({
    async onSuccess() {
      await Promise.all([detail.refetch(), filesQuery.refetch(), questions.refetch(), utils.orders.detail.invalidate({ orderId }), utils.orders.list.invalidate(), utils.orders.summary.invalidate()]);
      setSubmissionOpen(false);
      setAcknowledged(false);
      const ordered = stagesFromUnknown(detail.data?.workflow?.stages ?? []);
      const currentIndex = ordered.findIndex((candidate) => candidate.key === phaseKey);
      const next = currentIndex >= 0 ? ordered[currentIndex + 1] : undefined;
      toast.success("Phase submitted and locked", next ? `Continue to ${next.label} when you are ready.` : "Your project team must confirm an unlock before this phase can be changed.");
      if (next) navigate(`/portal/orders/${orderId}/workflow/${next.key}`);
    },
    onError(error) { toast.error("Could not submit phase", errorMessage(error)); },
  });
  const advanceStage = trpc.orders.advanceWorkflowStage.useMutation({
    async onSuccess() {
      await Promise.all([detail.refetch(), filesQuery.refetch(), questions.refetch(), utils.orders.detail.invalidate({ orderId }), utils.orders.list.invalidate(), utils.orders.summary.invalidate()]);
      const ordered = stagesFromUnknown(detail.data?.workflow?.stages ?? []);
      const currentIndex = ordered.findIndex((candidate) => candidate.key === phaseKey);
      const next = currentIndex >= 0 ? ordered[currentIndex + 1] : undefined;
      toast.success("Moved to the next phase", next ? `${phaseKey === next.key ? "" : `${next.label} is now open. `}This phase remains editable because it was not locked.` : "This workflow is complete. This phase remains editable because it was not locked.");
      if (next) navigate(`/portal/orders/${orderId}/workflow/${next.key}`);
    },
    onError(error) { toast.error("Could not move to the next phase", errorMessage(error)); },
  });

  async function upload(selected: FileList | File[] | null, recordedPitch = false, prerecordedAudio = false) {
    if (!selected || selected.length === 0) return;
    setUploading(true);
    try {
      const post = async (token: string) => {
        const body = new FormData();
        for (const file of Array.from(selected)) body.append("files", file);
        body.append("orderId", String(orderId));
        body.append("category", "intake_attachment");
        body.append("phase", phaseKey);
        if (recordedPitch) body.append("recordedPitch", "true");
        if (prerecordedAudio) body.append("prerecordedAudio", "true");
        const response = await fetch("/api/files/upload", {
          method: "POST", credentials: "same-origin",
          headers: { "x-rp-csrf": token, ...(recordedPitch ? { "x-rp-recorded-pitch": "true" } : {}) }, body,
        });
        let payload: { error?: string; files?: { originalName: string }[]; rejected?: { name: string; reason: string }[] } = {};
        try { payload = await response.json() as typeof payload; } catch { /* status below explains the failure */ }
        return { response, payload };
      };
      let token = await refreshCsrfToken();
      let result = await post(token ?? csrfToken() ?? "");
      if (result.response.status === 403 && /csrf|security token/i.test(result.payload.error ?? "")) {
        token = await refreshCsrfToken();
        if (token) result = await post(token);
      }
      if (!result.response.ok) { toast.error("Upload rejected", result.payload.error ?? "The file could not be processed."); return; }
      toast.success(`${result.payload.files?.length ?? 0} file(s) added to this phase`);
      for (const rejected of result.payload.rejected ?? []) toast.warning(`Not uploaded: ${rejected.name}`, rejected.reason);
      await filesQuery.refetch();
    } catch { toast.error("Upload failed", "A network error occurred. Please try again."); }
    finally { setUploading(false); if (fileInput.current) fileInput.current.value = ""; }
  }

  function stopRecording() {
    if (mediaRecorder.current && mediaRecorder.current.state !== "inactive") mediaRecorder.current.stop();
    if (timer.current) clearInterval(timer.current);
    if (recordingLimitTimer.current) clearTimeout(recordingLimitTimer.current);
    setRecording(false);
  }

  async function startRecording() {
    setMicrophoneOpen(false);
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("This browser does not support in-browser audio recording.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const selectedFormat = selectAudioRecordingFormat(MediaRecorder);
      if (!selectedFormat) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("This browser cannot create an approved M4A, WebM, or Ogg recording.");
      }
      const recorder = new MediaRecorder(stream, { mimeType: selectedFormat.mimeType });
      mediaRecorder.current = recorder;
      audioChunks.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size > 0) audioChunks.current.push(event.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const actualFormat = normalizeAudioRecordingFormat(recorder.mimeType, selectedFormat);
        const blob = new Blob(audioChunks.current, { type: actualFormat.mimeType });
        if (blob.size > 0) void upload([new File([blob], recordingFileName(`${phaseKey}-recording`, Date.now(), actualFormat), { type: actualFormat.mimeType })], true);
      };
      recorder.start();
      recordingSecondsRef.current = 0;
      setRecordingSeconds(0);
      setRecording(true);
      timer.current = setInterval(() => {
        recordingSecondsRef.current += 1;
        setRecordingSeconds(recordingSecondsRef.current);
      }, 1000);
      if (effectiveRecordingLimitSeconds) {
        recordingLimitTimer.current = setTimeout(() => {
          toast.info("Recording limit reached", `This phase allows up to ${formatDuration(effectiveRecordingLimitSeconds)} for this recording.`);
          stopRecording();
        }, effectiveRecordingLimitSeconds * 1000);
      }
    } catch (error) {
      toast.error("Could not start recording", error instanceof Error ? error.message : "Allow microphone access and try again.");
    }
  }

  if (detail.isLoading || stageAccess.isLoading || filesQuery.isLoading || questions.isLoading) return <div className="space-y-4"><Skeleton className="h-10 w-64" /><Skeleton className="h-72 w-full" /></div>;
  if (!detail.data) return <EmptyState icon={FileText} title="Order not found" description="This order is unavailable or is not associated with your account." action={<LinkButton href="/portal/orders" variant="outline">Back to my orders</LinkButton>} />;
  if (stageAccess.isError) return <><PageHeader title="Complete the current workflow step first" breadcrumb={{ href: `/portal/orders/${orderId}`, label: "Back to order" }} /><Card className="max-w-2xl"><CardHeader title="This step is not available yet" description={errorMessage(stageAccess.error)} /><LinkButton className="mt-5" href={`/portal/orders/${orderId}`} variant="primary">Return to guided order workspace</LinkButton></Card></>;

  const stages = stagesFromUnknown(detail.data.workflow?.stages);
  const stage = stages.find((item) => item.key === phaseKey);
  if (!stage) return <><PageHeader title="Workflow phase unavailable" breadcrumb={{ href: `/portal/orders/${orderId}`, label: "Back to order" }} /><Card className="max-w-2xl"><CardHeader title="This phase is not part of the assigned workflow" description="Ask your project team to review the order workflow assignment." /><LinkButton className="mt-5" href={`/portal/orders/${orderId}`} variant="outline">Back to order</LinkButton></Card></>;

  const capabilities = new Set(stage.capabilities ?? []);
  const stageIsCompleted = (stageKey: string, keys: Set<string>) => keys.has(stageKey) || (stageKey === "phase_1_intake" && keys.has("phase_1")) || (stageKey === "phase_2_synthesis" && keys.has("phase_2"));
  const phaseLock = detail.data.phaseLocks?.find((lock) => lock.phaseKey === stage.key || (stage.key === "phase_1_intake" && lock.phaseKey === "phase_1") || (stage.key === "phase_2_synthesis" && lock.phaseKey === "phase_2"));
  const phaseLocked = Boolean(phaseLock);
  const stageCompleted = Boolean(stageAccess.data?.completed);
  const advanceMode = stage.advanceMode ?? "submit_lock";
  const nextStage = stages[stages.findIndex((candidate) => candidate.key === stage.key) + 1];
  const acknowledgementPolicy = stage.customerAcknowledgement ?? "required";
  const submissionNotice = stage.submissionNotice?.trim() || `You are about to submit ${stage.label}. This locks all files, recordings, and answers in this phase. An administrator must confirm an unlock.`;
  const submitCurrentPhase = (acknowledgedByCustomer: boolean) => submitPhase.mutate({ orderId, phaseKey: stage.key, acknowledgementText: acknowledgementPolicy === "none" ? undefined : submissionNotice, acknowledged: acknowledgedByCustomer });
  const formatDuration = (seconds: number) => `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const uploadLimitText = [stage.uploadLimits?.documentMaxFiles ? `${stage.uploadLimits.documentMaxFiles} document${stage.uploadLimits.documentMaxFiles === 1 ? "" : "s"}` : null, stage.uploadLimits?.documentMaxSizeMb ? `${stage.uploadLimits.documentMaxSizeMb} MB per document` : null, stage.uploadLimits?.audioMaxFiles ? `${stage.uploadLimits.audioMaxFiles} audio file${stage.uploadLimits.audioMaxFiles === 1 ? "" : "s"}` : null, stage.uploadLimits?.audioMaxSizeMb ? `${stage.uploadLimits.audioMaxSizeMb} MB per audio file` : null, stage.uploadLimits?.recordingMaxDurationSeconds ? `${formatDuration(stage.uploadLimits.recordingMaxDurationSeconds)} per browser recording` : null, stage.uploadLimits?.audioTotalDurationSeconds ? `${formatDuration(stage.uploadLimits.audioTotalDurationSeconds)} total audio` : null].filter(Boolean).join(" · ");
  const phaseFiles = (filesQuery.data ?? []).filter((file) => file.phase === stage.key && file.category !== "deliverable");
  const downloadablePhaseFiles = phaseFiles.filter((file) => !file.isPlaceholder);
  const audioFiles = phaseFiles.filter((file) => AUDIO_EXTENSIONS.has((file.extension ?? "").toLowerCase()));
  const documentFiles = phaseFiles.filter((file) => !audioFiles.includes(file));
  const downloadCurrentPhase = () => {
    if (downloadablePhaseFiles.length === 0) return;
    bulkDownload.mutate({
      fileIds: downloadablePhaseFiles.map((file) => file.id),
      archiveName: `${order.orderNumber}-${stage.key}-files`,
    });
  };
  const audioUsedSeconds = audioFiles.reduce((total, file) => total + Math.max(0, file.durationSeconds ?? 0), 0);
  const totalAudioRemainingSeconds = stage.uploadLimits?.audioTotalDurationSeconds === undefined ? undefined : Math.max(0, stage.uploadLimits.audioTotalDurationSeconds - audioUsedSeconds);
  const effectiveRecordingLimitSeconds = [stage.uploadLimits?.recordingMaxDurationSeconds, totalAudioRemainingSeconds].filter((value): value is number => typeof value === "number" && value > 0).reduce<number | undefined>((current, value) => current === undefined ? value : Math.min(current, value), undefined);
  const phaseQuestions = (questions.data ?? []).filter((question) => question.phase === stage.key);
  const reviewFiles = phaseFiles.filter((file) => file.uploadedByStaff && file.visibleToCustomer && !file.isPlaceholder);
  const { order } = detail.data;
  const completedKeys = new Set((detail.data.phaseLocks ?? []).map((lock) => lock.phaseKey));
  const currentStageKey = stageAccess.data?.currentStageKey ?? null;

  return <>
    <PageHeader title={stage.label} description={`Order ${order.orderNumber} · guided step ${stage.order} of ${stages.length}`} breadcrumb={{ href: `/portal/orders/${orderId}`, label: "Back to order" }} />
    <Card className="mb-5 border-teal/30 bg-teal/5"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wide text-muted">Current order status</p><Badge className="mt-1" tone="teal">{order.statusLabel ?? order.status}</Badge></div><div className="text-right"><p className="text-xs font-semibold uppercase tracking-wide text-muted">Order completion</p><p className="mt-1 text-2xl font-bold tabular-nums text-teal-dark">{detail.data.workflowProgress?.completionPercent ?? order.completionPercent}%</p></div></div><ProgressBar className="mt-3" value={detail.data.workflowProgress?.completionPercent ?? order.completionPercent} label={`${detail.data.workflowProgress?.completionPercent ?? order.completionPercent}% complete${detail.data.workflowProgress ? ` · ${detail.data.workflowProgress.completedStages}/${detail.data.workflowProgress.totalStages} workflow phases submitted` : ""}`} /></Card>
    <Card className="mb-5"><CardHeader title="Order workflow" description="Complete the current step before the next step becomes available. Stages completed with Next remain editable; submitted stages are locked for review." /><ol className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">{(() => { const currentIndex = stages.findIndex((candidate) => candidate.key === currentStageKey); const advancedKeys = new Set((detail.data.workflowAdvances ?? []).map((advance) => advance.phaseKey)); return stages.map((candidate, index) => { const lockedComplete = stageIsCompleted(candidate.key, completedKeys); const advancedComplete = advancedKeys.has(candidate.key); const systemComplete = !lockedComplete && !advancedComplete && currentIndex > index; const completed = lockedComplete || advancedComplete || systemComplete; const current = candidate.key === currentStageKey && !completed; const available = completed || current; const completionLabel = lockedComplete ? "Review" : advancedComplete ? "Reopen" : "Open"; return <li key={candidate.key} className={`flex items-center justify-between gap-3 rounded-lg border p-3 ${candidate.key === stage.key ? "border-teal bg-teal/5" : completed ? "border-success/30 bg-success/5" : "border-line bg-surface-soft"}`}><span className="min-w-0 text-sm"><span className={`mr-2 inline-flex size-6 items-center justify-center rounded-full text-xs font-bold ${completed ? "bg-success text-white" : current ? "bg-teal text-white" : "bg-surface-sunken text-muted"}`}>{completed ? <CheckCircle2 className="size-3.5" /> : candidate.order}</span>{candidate.label}</span>{systemComplete ? <Badge tone="success">Confirmed</Badge> : available ? <LinkButton size="sm" variant={current ? "primary" : "outline"} href={`/portal/orders/${orderId}/workflow/${candidate.key}?focus=documents`}>{completionLabel}</LinkButton> : <Badge tone="neutral">Upcoming</Badge>}</li>; }); })()}</ol></Card>
    {uploadLimitText ? <Alert tone="info" className="mb-4">This phase allows: {uploadLimitText}.</Alert> : null}
    {stage.customerMessage ? <Card className={`mb-5 ${stage.customerMessage.kind === "announcement" ? "border-gold/40 bg-gold/5" : "border-teal/30 bg-teal/5"}`}><CardHeader title={stage.customerMessage.title ?? (stage.customerMessage.kind === "announcement" ? "Announcement" : "Instructions")} description={stage.customerMessage.kind === "announcement" ? "An update from your ReadyPackets project team." : "Please review these instructions before completing this workflow step."} actions={<Badge tone={stage.customerMessage.kind === "announcement" ? "gold" : "teal"}>{stage.customerMessage.kind === "announcement" ? <><Megaphone className="mr-1 inline size-3" />Announcement</> : "Instructions"}</Badge>} /><Markdown className="prose-rp mt-4 max-w-none" source={stage.customerMessage.bodyMarkdown} /></Card> : null}
    <Alert tone={phaseLocked ? "warning" : "info"} className="mb-6">{phaseLocked ? <>This phase was submitted on {formatDate(phaseLock?.lockedAt ?? new Date())} and is locked. Contact your project team if it must be reopened.</> : stageCompleted ? <>You moved past this phase with Next. It remains editable because it was not submitted and locked.</> : <>Files, questions, and recordings in this area belong only to <strong>{stage.label}</strong>. You may remove your own materials until you submit and lock this phase. Final deliverables are published separately in My Business Packets.</>}</Alert>
    {downloadablePhaseFiles.length > 0 ? <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-teal/30 bg-teal/5 px-4 py-3"><div><p className="text-sm font-semibold text-ink">Downloads for {stage.label}</p><p className="mt-0.5 text-xs text-muted">Download every document and recording currently available in this phase as one ZIP archive.</p></div><Button size="sm" variant="outline" leadingIcon={<Download className="size-4" />} busy={bulkDownload.isPending} onClick={downloadCurrentPhase}>Download this phase ({downloadablePhaseFiles.length})</Button></div> : null}
    <div className="grid gap-6 lg:grid-cols-2">
      <div id="workflow-documents" tabIndex={-1} className="scroll-mt-6 outline-none">
      <Card>
        <CardHeader title={`${stage.label} documents`} description={capabilities.has("documents") ? "Upload supporting documents requested by your project team." : "Documents published by your project team for this phase."} />
        {capabilities.has("documents") && !phaseLocked ? <><input ref={fileInput} type="file" className="hidden" multiple onChange={(event) => void upload(event.target.files)} /><Button className="mt-4" leadingIcon={<Upload className="size-4" />} busy={uploading} onClick={() => fileInput.current?.click()}>Upload documents</Button></> : null}
        <ul className="mt-4 space-y-2">{documentFiles.length ? documentFiles.map((file) => <li key={file.id} className="flex flex-wrap items-center justify-between gap-3 rounded border border-line px-3 py-2 text-sm"><span className="min-w-0 truncate"><FileText className="mr-1 inline size-4" />{file.originalName} <span className="text-xs text-muted">· {formatBytes(file.sizeBytes)} · {formatDate(file.createdAt)}</span></span><div className="flex flex-wrap items-center gap-2">{!file.isPlaceholder ? <Button size="sm" variant="outline" leadingIcon={<Download className="size-3.5" />} busy={requestDownload.isPending} onClick={() => requestDownload.mutate({ fileId: file.id })}>Download</Button> : null}{!file.uploadedByStaff && !phaseLocked ? <Button size="sm" variant="ghost" onClick={() => deleteFile.mutate({ fileId: file.id })}>Remove</Button> : file.uploadedByStaff ? <Badge tone="teal">Team document</Badge> : <Badge tone="neutral">Locked</Badge>}</div></li>) : <li className="text-sm text-muted">No documents for this phase yet.</li>}</ul>
      </Card>
      </div>
      <Card>
        <CardHeader title={`${stage.label} audio recording`} description={capabilities.has("recording") || capabilities.has("audio_upload") ? "Record an in-browser audio update in the format supported by your browser, or upload approved prerecorded audio when this phase enables the relevant action." : "No customer audio action is enabled for this phase."} />
        <div className="mt-4 flex flex-wrap gap-2">{capabilities.has("recording") && !phaseLocked ? <Button disabled={!recording && totalAudioRemainingSeconds === 0} leadingIcon={recording ? <span className="relative flex size-4 items-center justify-center"><span className="absolute size-3 animate-ping rounded-full bg-white/80" /><span className="relative size-2 rounded-full bg-white" /></span> : <Mic className="size-4" />} className={recording ? "animate-pulse ring-2 ring-danger/40 shadow-lg shadow-danger/20" : ""} variant={recording ? "danger" : "primary"} busy={uploading} onClick={() => recording ? stopRecording() : setMicrophoneOpen(true)}>{recording ? `Recording — stop (${recordingSeconds}s${effectiveRecordingLimitSeconds ? ` / ${formatDuration(effectiveRecordingLimitSeconds)}` : ""})` : totalAudioRemainingSeconds === 0 ? "Audio time limit reached" : `Record ${stage.label} audio`}</Button> : null}{capabilities.has("audio_upload") && !phaseLocked ? <><input id={`audio-upload-${stage.key}`} className="hidden" type="file" accept="audio/*,.webm,.ogg" onChange={(event) => void upload(event.target.files, false, true)} /><Button variant="outline" leadingIcon={<Upload className="size-4" />} busy={uploading} onClick={() => document.getElementById(`audio-upload-${stage.key}`)?.click()}>Upload audio file</Button></> : null}</div>
        {stage.uploadLimits?.audioTotalDurationSeconds !== undefined ? <p className="mt-3 text-xs text-muted">Audio time used: {formatDuration(audioUsedSeconds)} of {formatDuration(stage.uploadLimits.audioTotalDurationSeconds)}{totalAudioRemainingSeconds !== undefined ? ` · ${formatDuration(totalAudioRemainingSeconds)} remaining` : ""}.</p> : null}<ul className="mt-4 space-y-2">{audioFiles.length ? audioFiles.map((file) => <li key={file.id} className="rounded border border-line px-3 py-2 text-sm"><div className="flex flex-wrap items-center justify-between gap-3"><span className="min-w-0 truncate"><FileAudio className="mr-1 inline size-4" />{file.originalName}{file.durationSeconds ? <span className="text-xs text-muted"> · {formatDuration(file.durationSeconds)}</span> : null}</span><div className="flex flex-wrap items-center gap-2">{!file.isPlaceholder ? <Button size="sm" variant="outline" leadingIcon={<Download className="size-3.5" />} busy={requestDownload.isPending} onClick={() => requestDownload.mutate({ fileId: file.id })}>Download</Button> : null}{!file.uploadedByStaff && !phaseLocked ? <Button size="sm" variant="ghost" onClick={() => deleteFile.mutate({ fileId: file.id })}>Remove</Button> : file.uploadedByStaff ? <Badge tone="teal">Team recording</Badge> : <Badge tone="neutral">Locked</Badge>}</div></div><div className="mt-2"><AudioPlayback fileId={file.id} /></div></li>) : <li className="text-sm text-muted">No recordings for this phase yet.</li>}</ul>
      </Card>
      {capabilities.has("review_space") ? <Card className="lg:col-span-2"><CardHeader title={`${stage.label} file review`} description="Your project team selects and publishes the files available in this review step. You can review the file list and securely download each selected file." /><div className="mt-4 space-y-2">{reviewFiles.length ? reviewFiles.map((file) => <div key={file.id} className="flex flex-wrap items-center justify-between gap-3 rounded border border-line px-3 py-3 text-sm"><span className="min-w-0"><FileText className="mr-1 inline size-4 text-teal" />{file.originalName}<span className="ml-2 text-xs text-muted">· {formatBytes(file.sizeBytes)} · published {formatDate(file.createdAt)}</span></span><Button size="sm" variant="outline" leadingIcon={<Download className="size-4" />} busy={requestDownload.isPending} onClick={() => requestDownload.mutate({ fileId: file.id })}>Download</Button></div>) : <EmptyState icon={FileText} title="No review files have been published yet" description="Your project team will add files to this step when they are ready for review." />}</div></Card> : null}
      {capabilities.has("questions") ? <Card className="lg:col-span-2"><CardHeader title={`${stage.label} questions`} description="Questions assigned by your project team for this specific workflow phase." /><div className="mt-4 space-y-4">{phaseQuestions.length ? phaseQuestions.map((question) => <div key={question.id} className="rounded border border-line p-4"><p className="text-sm font-medium text-ink">{question.question}</p>{question.status === "answered" || question.status === "resolved" ? <p className="mt-2 flex items-center gap-1.5 text-sm text-success"><CheckCircle2 className="size-4" /> Answer received</p> : phaseLocked ? <p className="mt-2 text-sm text-muted">This phase is locked and answers can no longer be changed.</p> : <><Textarea className="mt-3" label="Your answer" value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} rows={3} /><Button className="mt-3" size="sm" busy={answerQuestion.isPending} disabled={(answers[question.id] ?? "").trim().length === 0} onClick={() => answerQuestion.mutate({ questionId: question.id, body: (answers[question.id] ?? "").trim() })}>Save answer</Button></>}</div>) : <p className="text-sm text-muted">No questions have been assigned to this phase yet.</p>}</div></Card> : null}
      {!phaseLocked && !stageCompleted ? <Card className="lg:col-span-2"><CardHeader title={advanceMode === "next" ? `Continue from ${stage.label}` : `Submit ${stage.label}`} description={advanceMode === "next" ? `Continue${nextStage ? ` to ${nextStage.label}` : " and complete this workflow"} without locking this phase. You may return to edit its customer materials later.` : "Review your files, recordings, and answers before submitting. Submission locks this phase."} /><Button className="mt-4" variant="primary" busy={advanceMode === "next" ? advanceStage.isPending : submitPhase.isPending} onClick={() => { if (advanceMode === "next") advanceStage.mutate({ orderId, phaseKey: stage.key }); else if (acknowledgementPolicy === "none") submitCurrentPhase(false); else { setAcknowledged(false); setSubmissionOpen(true); } }}>{advanceMode === "next" ? (nextStage ? `Next: ${nextStage.label}` : "Complete workflow") : "Submit and lock this phase"}</Button></Card> : null}
    </div>
    <Modal open={microphoneOpen} onClose={() => setMicrophoneOpen(false)} title="Allow microphone access" description={`Your browser will ask for microphone permission for ${stage.label}.`}><div className="space-y-4"><Alert tone="info">Select <strong>Allow microphone</strong> in the browser prompt. The recording is not uploaded until you stop it.</Alert><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setMicrophoneOpen(false)}>Cancel</Button><Button onClick={() => void startRecording()}>Allow microphone and record</Button></div></div></Modal>
    <Modal open={submissionOpen} onClose={() => setSubmissionOpen(false)} title={`Submit and lock ${stage.label}`} description="This action locks the phase. Only an administrator can reopen it after confirmation."><div className="space-y-4"><Alert tone="warning">{submissionNotice}</Alert><label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line p-3 text-sm"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-1" /><span>I acknowledge that submitting this phase locks its files, recordings, and answers. I understand that I cannot undo this action myself.</span></label>{acknowledgementPolicy === "optional" ? <p className="text-xs text-muted">Acknowledgement is optional for this phase. You may submit without selecting the checkbox.</p> : null}<div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setSubmissionOpen(false)}>Cancel</Button><Button busy={submitPhase.isPending} disabled={acknowledgementPolicy === "required" && !acknowledged} onClick={() => submitCurrentPhase(acknowledged)}>Submit and lock</Button></div></div></Modal>
  </>;
}
