import { useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { FileAudio, FileText, Mic, Upload } from "lucide-react";
import { trpc, errorMessage, refreshCsrfToken, csrfToken } from "@/lib/trpc";
import { normalizeAudioRecordingFormat, recordingFileName, selectAudioRecordingFormat } from "@/lib/audioRecording";
import { Button, LinkButton } from "@/components/ui/Button";
import { AudioPlayback } from "@/components/ui/AudioPlayback";
import { Alert, Badge, Card, CardHeader, EmptyState, Skeleton } from "@/components/ui/Surface";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { PageHeader } from "@/components/layout/PortalLayout";

const PHASE_2_STATUSES = new Set(["phase_2_synthesis", "phase_3_review", "phase_4_delivery", "delivered"]);

export function Phase2ArtifactsPage() {
  const params = useParams<{ id: string }>();
  const orderId = Number(params.id);
  const [, navigate] = useLocation();
  const toast = useToast();
  const utils = trpc.useUtils();
  const detail = trpc.orders.detail.useQuery({ orderId }, { enabled: Number.isFinite(orderId) });
  const filesQuery = trpc.files.listForOrder.useQuery({ orderId }, { enabled: Number.isFinite(orderId) });
  const fileInput = useRef<HTMLInputElement>(null);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const audioChunks = useRef<Blob[]>([]);
  const interval = useRef<ReturnType<typeof setInterval> | null>(null);
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [microphoneOpen, setMicrophoneOpen] = useState(false);
  const [submissionOpen, setSubmissionOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const deleteFile = trpc.files.delete.useMutation({
    async onSuccess() { await filesQuery.refetch(); toast.success("File removed"); },
    onError(error) { toast.error("Could not remove file", errorMessage(error)); },
  });

  const submitPhase = trpc.orders.submitWorkflowPhase.useMutation({
    async onSuccess() {
      await Promise.all([detail.refetch(), filesQuery.refetch(), utils.orders.detail.invalidate({ orderId }), utils.orders.list.invalidate(), utils.orders.summary.invalidate()]);
      setSubmissionOpen(false);
      setAcknowledged(false);
      toast.success("Phase 2 submitted and locked", "An administrator must confirm an unlock before you can change this phase.");
    },
    onError(error) { toast.error("Could not submit Phase 2", errorMessage(error)); },
  });

  const phase2Ready = Boolean(detail.data && PHASE_2_STATUSES.has(detail.data.order.status));
  const phaseFiles = (filesQuery.data ?? []).filter((file) => file.phase === "phase_2");
  const audioFiles = phaseFiles.filter((file) => ["webm", "wav", "mp3", "m4a", "ogg"].includes((file.extension ?? "").toLowerCase()));
  const documentFiles = phaseFiles.filter((file) => !audioFiles.includes(file));
  const phaseLock = detail.data?.phaseLocks?.find((lock) => lock.phaseKey === "phase_2");
  const phaseLocked = Boolean(phaseLock);
  const submissionNotice = "You are about to submit Phase 2. This locks your customer documents and recordings in this phase. Only an administrator can confirm an unlock.";

  async function upload(selected: FileList | File[] | null, recordedPitch = false) {
    if (!selected || selected.length === 0) return;
    setUploading(true);
    try {
      const post = async (token: string) => {
        const body = new FormData();
        for (const file of Array.from(selected)) body.append("files", file);
        body.append("orderId", String(orderId));
        body.append("category", "intake_attachment");
        body.append("phase", "phase_2");
        if (recordedPitch) body.append("recordedPitch", "true");
        const response = await fetch("/api/files/upload", { method: "POST", credentials: "same-origin", headers: { "x-rp-csrf": token, ...(recordedPitch ? { "x-rp-recorded-pitch": "true" } : {}) }, body });
        let payload: { error?: string; files?: { originalName: string }[]; rejected?: { name: string; reason: string }[] } = {};
        try { payload = await response.json() as typeof payload; } catch { /* response status below provides the outcome */ }
        return { response, payload };
      };
      let token = await refreshCsrfToken();
      let result = await post(token ?? csrfToken() ?? "");
      if (result.response.status === 403 && /csrf|security token/i.test(result.payload.error ?? "")) {
        token = await refreshCsrfToken();
        if (token) result = await post(token);
      }
      if (!result.response.ok) {
        toast.error("Upload rejected", result.payload.error ?? "The file could not be processed.");
        return;
      }
      const accepted = result.payload.files?.length ?? 0;
      toast.success(`${accepted} file${accepted === 1 ? "" : "s"} added to Phase 2`);
      for (const rejected of result.payload.rejected ?? []) toast.warning(`Not uploaded: ${rejected.name}`, rejected.reason);
      await filesQuery.refetch();
    } catch {
      toast.error("Upload failed", "A network error occurred. Please try again.");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  function stopRecording() {
    if (mediaRecorder.current && mediaRecorder.current.state !== "inactive") mediaRecorder.current.stop();
    setRecording(false);
    if (interval.current) clearInterval(interval.current);
  }

  async function beginRecording() {
    setMicrophoneOpen(false);
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("This browser does not support microphone recording.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
        const actualFormat = normalizeAudioRecordingFormat(recorder.mimeType, selectedFormat);
        const blob = new Blob(audioChunks.current, { type: actualFormat.mimeType });
        stream.getTracks().forEach((track) => track.stop());
        if (blob.size > 0) void upload([new File([blob], recordingFileName("phase-2-recording", Date.now(), actualFormat), { type: actualFormat.mimeType })], true);
      };
      recorder.start();
      setSeconds(0);
      setRecording(true);
      interval.current = setInterval(() => setSeconds((value) => value + 1), 1000);
    } catch (error) {
      toast.error("Microphone access is needed", error instanceof Error ? error.message : "Allow microphone access in your browser, then try again.");
    }
  }

  if (detail.isLoading || filesQuery.isLoading) return <div className="space-y-4"><Skeleton className="h-10 w-64" /><Skeleton className="h-72 w-full" /></div>;
  if (!detail.data) return <EmptyState icon={FileText} title="Order not found" description="This order is unavailable or is not associated with your account." action={<LinkButton href="/portal/orders" variant="outline">Back to my orders</LinkButton>} />;
  const { order } = detail.data;
  if (!phase2Ready) return <><PageHeader title="Phase 2 materials" breadcrumb={{ href: `/portal/orders/${orderId}`, label: "Back to order" }} /><Card className="max-w-2xl"><CardHeader title="Phase 2 is not open yet" description="Phase 2 documents and recordings become available after your Phase 1 intake is reviewed and the engagement enters Phase 2." /><LinkButton className="mt-5" href={`/portal/orders/${orderId}`} variant="outline">Back to order</LinkButton></Card></>;

  return <><PageHeader title="Phase 2 materials" description={`Add supporting documents and a recorded audio update for ${order.orderNumber}.`} breadcrumb={{ href: `/portal/orders/${orderId}`, label: "Back to order" }} />
    <Alert tone={phaseLocked ? "warning" : "info"} className="mb-6">{phaseLocked ? "Phase 2 is submitted and locked. Contact your project team if it must be reopened." : "Your files are stored only after successful upload confirmation. You may remove your own materials until you submit and lock this phase."}</Alert>
    <div className="grid gap-6 lg:grid-cols-2"><Card><CardHeader title="Phase 2 documents" description="Upload supporting documents requested by your project team." />{!phaseLocked ? <><input ref={fileInput} type="file" className="hidden" multiple onChange={(event) => void upload(event.target.files)} /><Button className="mt-4" leadingIcon={<Upload className="size-4" />} busy={uploading} onClick={() => fileInput.current?.click()}>Upload Phase 2 documents</Button></> : null}<ul className="mt-4 space-y-2">{documentFiles.length ? documentFiles.map((file) => <li key={file.id} className="flex items-center justify-between gap-3 rounded border border-line px-3 py-2 text-sm"><span className="truncate">{file.originalName}</span>{!phaseLocked ? <Button size="sm" variant="ghost" onClick={() => deleteFile.mutate({ fileId: file.id })}>Remove</Button> : <Badge tone="neutral">Locked</Badge>}</li>) : <li className="text-sm text-muted">No Phase 2 documents yet.</li>}</ul></Card>
      <Card><CardHeader title="Phase 2 audio recording" description="Record an in-browser audio update in the format supported by your browser. Audio files cannot be uploaded from your device." />{!phaseLocked ? <Button className={`mt-4 ${recording ? "animate-pulse ring-2 ring-danger/40 shadow-lg shadow-danger/20" : ""}`} leadingIcon={recording ? <span className="relative flex size-4 items-center justify-center"><span className="absolute size-3 animate-ping rounded-full bg-white/80" /><span className="relative size-2 rounded-full bg-white" /></span> : <Mic className="size-4" />} variant={recording ? "danger" : "primary"} busy={uploading} onClick={() => recording ? stopRecording() : setMicrophoneOpen(true)}>{recording ? `Recording — stop (${seconds}s)` : "Record Phase 2 audio"}</Button> : null}<ul className="mt-4 space-y-2">{audioFiles.length ? audioFiles.map((file) => <li key={file.id} className="rounded border border-line px-3 py-2 text-sm"><div className="flex flex-wrap items-center justify-between gap-3"><span className="min-w-0 truncate"><FileAudio className="mr-1 inline size-4" />{file.originalName} <Badge tone="teal">Browser recording</Badge></span>{!phaseLocked ? <Button size="sm" variant="ghost" onClick={() => deleteFile.mutate({ fileId: file.id })}>Remove</Button> : <Badge tone="neutral">Locked</Badge>}</div><div className="mt-2"><AudioPlayback fileId={file.id} /></div></li>) : <li className="text-sm text-muted">No Phase 2 audio recording yet.</li>}</ul></Card>{!phaseLocked ? <Card className="lg:col-span-2"><CardHeader title="Submit Phase 2" description="Review your files and recording before submitting. Submission locks this phase." /><Button className="mt-4" onClick={() => { setAcknowledged(false); setSubmissionOpen(true); }}>Submit and lock Phase 2</Button></Card> : null}</div>
    <Modal open={microphoneOpen} onClose={() => setMicrophoneOpen(false)} title="Allow microphone access" description="Your browser will ask for microphone permission for this Phase 2 recording."><div className="space-y-4"><Alert tone="info">Select <strong>Allow microphone</strong> in the browser prompt. The recording is not uploaded until you stop it.</Alert><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setMicrophoneOpen(false)}>Cancel</Button><Button onClick={() => void beginRecording()}>Allow microphone and record</Button></div></div></Modal>
    <Modal open={submissionOpen} onClose={() => setSubmissionOpen(false)} title="Submit and lock Phase 2" description="Only an administrator can reopen this phase after confirmation."><div className="space-y-4"><Alert tone="warning">{submissionNotice}</Alert><label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line p-3 text-sm"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-1" /><span>I acknowledge that I cannot undo this submission myself.</span></label><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setSubmissionOpen(false)}>Cancel</Button><Button busy={submitPhase.isPending} disabled={!acknowledged} onClick={() => submitPhase.mutate({ orderId, phaseKey: "phase_2", acknowledgementText: submissionNotice })}>Submit and lock</Button></div></div></Modal>
  </>;
}
