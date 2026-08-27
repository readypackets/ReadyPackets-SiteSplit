/**
 * Phase I intake form and mutual NDA signature.
 *
 * The form is deliberately sectioned and saved as a draft, because the questions
 * demand considered answers rather than a single sitting. Drafts save without
 * validation; the minimum lengths are enforced only at submission, which is also
 * where the server re-validates every field.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useLocation } from "wouter";
import {
  CheckCircle2,
  ClipboardCheck,
  FileSignature,
  Mic,
  Save,
  Send,
  ShieldCheck,
} from "lucide-react";
import { INTAKE_OUTCOMES, INTEGRITY_CHOICES, INTEGRITY_CHOICE_LABELS } from "@shared/domain";
import { BRAND } from "@shared/brand";
import { trpc, errorMessage, refreshCsrfToken } from "@/lib/trpc";
import { formatDateTime } from "@/lib/utils";
import { normalizeAudioRecordingFormat, recordingFileName, selectAudioRecordingFormat } from "@/lib/audioRecording";
import { Markdown } from "@/lib/markdown";
import { Button, LinkButton } from "@/components/ui/Button";
import { Checkbox, Input, Textarea } from "@/components/ui/Field";
import { Alert, Badge, Card, CardHeader, Skeleton } from "@/components/ui/Surface";
import { ProgressBar } from "@/components/ui/DataDisplay";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { PageHeader } from "@/components/layout/PortalLayout";

export function IntakePage() {
  const params = useParams<{ id: string }>();
  const orderId = Number(params.id);
  const toast = useToast();
  const [, navigate] = useLocation();

  const utils = trpc.useUtils();
  const questions = trpc.intake.questions.useQuery();
  const outcomes = trpc.intake.outcomes.useQuery();
  const existing = trpc.intake.get.useQuery({ orderId }, { enabled: Number.isFinite(orderId) });
    const mnda = trpc.intake.mndaStatus.useQuery({ orderId }, { enabled: Number.isFinite(orderId) });
  const orderFiles = trpc.files.listForOrder.useQuery({ orderId }, { enabled: Number.isFinite(orderId) });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [projectName, setProjectName] = useState("");
  const [desiredOutcomes, setDesiredOutcomes] = useState<string[]>([]);
  const [integrityChoice, setIntegrityChoice] = useState<string>("");
  const [confirmAccurate, setConfirmAccurate] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const hydrated = useRef(false);

  // File upload state
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  
  // Audio recording state
  const [recording, setRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [microphonePromptOpen, setMicrophonePromptOpen] = useState(false);
  const [microphonePermission, setMicrophonePermission] = useState<PermissionState | "unknown">("unknown");
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [preflightStatus, setPreflightStatus] = useState<"idle" | "running" | "passed" | "failed">("idle");
  const [preflightMessage, setPreflightMessage] = useState("");
  const [preflightForRecording, setPreflightForRecording] = useState(false);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const audioChunks = useRef<Blob[]>([]);
  const recordingInterval = useRef<NodeJS.Timeout | null>(null);
  const [pendingPitch, setPendingPitch] = useState<{ file: File; previewUrl: string } | null>(null);
  const [saveChoiceOpen, setSaveChoiceOpen] = useState(false);
  const [saveReturningLater, setSaveReturningLater] = useState(false);

  useEffect(() => {
    let permissionStatus: PermissionStatus | undefined;
    let cancelled = false;
    if (!navigator.permissions?.query) return;
    void navigator.permissions.query({ name: "microphone" as PermissionName }).then((status) => {
      if (cancelled) return;
      permissionStatus = status;
      setMicrophonePermission(status.state);
      status.onchange = () => setMicrophonePermission(status.state);
    }).catch(() => setMicrophonePermission("unknown"));
    return () => { cancelled = true; if (permissionStatus) permissionStatus.onchange = null; };
  }, []);

  useEffect(() => () => {
    if (pendingPitch) URL.revokeObjectURL(pendingPitch.previewUrl);
  }, [pendingPitch]);

  // Hydrate the form once from the saved draft.
  useEffect(() => {
    if (hydrated.current || !existing.data) return;
    hydrated.current = true;
    setAnswers(existing.data.answers ?? {});
    setProjectName(existing.data.projectName ?? "");
    setDesiredOutcomes(existing.data.desiredOutcomes ?? []);
    setIntegrityChoice(existing.data.integrityChoice ?? "");
  }, [existing.data]);

  const save = trpc.intake.save.useMutation({
    async onSuccess() {
      setDirty(false);
      await existing.refetch();
    },
    onError(error) {
      toast.error("Could not save your draft", errorMessage(error));
    },
  });

  const submit = trpc.intake.submit.useMutation({
    async onSuccess() {
      await Promise.all([existing.refetch(), utils.orders.detail.invalidate({ orderId }), utils.orders.list.invalidate(), utils.orders.summary.invalidate()]);
      toast.success(
        "Intake submitted",
        "Your Phase II Logic Synthesis call will be scheduled shortly.",
      );
      navigate(`/portal/orders/${orderId}`);
    },
    onError(error) {
      toast.error("Could not submit your intake", errorMessage(error));
    },
  });

  const sections = useMemo(() => {
    const grouped = new Map<string, typeof questions.data>();
    for (const question of questions.data ?? []) {
      const list = grouped.get(question.section) ?? [];
      grouped.set(question.section, [...(list ?? []), question] as typeof questions.data);
    }
    return [...grouped.entries()];
  }, [questions.data]);

  const submitted = existing.data?.status === "submitted";
  const readOnly = submitted;

  const csrfToken = () => {
    const match = document.cookie.match(/(?:^|;\s*)rp_csrf=([^;]+)/);
    return match && match[1] ? decodeURIComponent(match[1]) : null;
  };

  const handleUpload = async (selected: FileList | File[] | null, isAudio = false): Promise<boolean> => {
    if (!selected || selected.length === 0) return false;
    setUploading(true);
    try {
      type UploadPayload = {
        error?: string;
        files?: { originalName: string }[];
        rejected?: { name: string; reason: string }[];
      };
      const post = async (token: string) => {
        const body = new FormData();
        for (const file of Array.from(selected)) body.append("files", file);
        body.append("orderId", String(orderId));
        body.append("category", "intake_attachment");
        if (isAudio) body.append("recordedPitch", "true");
        const response = await fetch("/api/files/upload", {
          method: "POST",
          credentials: "same-origin",
          headers: { "x-rp-csrf": token, ...(isAudio ? { "x-rp-recorded-pitch": "true" } : {}) },
          body,
        });
        let payload: UploadPayload = {};
        try { payload = (await response.json()) as UploadPayload; } catch { /* handled by response status below */ }
        return { response, payload };
      };
      let token = await refreshCsrfToken();
      let result = await post(token ?? csrfToken() ?? "");
      const csrfRejected = result.response.status === 403 && /csrf|security token/i.test(result.payload.error ?? "");
      if (csrfRejected) {
        // A browser tab can retain a stale readable cookie after a session rotation.
        // Refresh the server-issued cookie and retry the in-memory files once; CSRF
        // rejections occur before file validation or persistence.
        token = await refreshCsrfToken();
        if (token) result = await post(token);
      }

      if (!result.response.ok) {
        toast.error("Upload rejected", result.payload.error ?? "The upload could not be processed.");
        return false;
      } else {
        const accepted = result.payload.files?.length ?? 0;
        toast.success(`${accepted} file${accepted === 1 ? "" : "s"} uploaded`);
        if (result.payload.rejected && result.payload.rejected.length > 0) {
          toast.error(
            "Some files were rejected",
            result.payload.rejected.map((r) => `${r.name}: ${r.reason}`).join("\n"),
          );
        }
        await orderFiles.refetch();
        return accepted > 0;
      }
    } catch (err) {
      toast.error("Upload failed", "A network error occurred. Please try again.");
      return false;
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const deleteFileMut = trpc.files.delete.useMutation({
    onSuccess() {
      toast.success("File deleted");
      void orderFiles.refetch();
    },
    onError(err: any) {
      toast.error("Could not delete file", errorMessage(err));
    },
  });

  const requestMicrophone = () => {
    setMicrophonePromptOpen(false);
    void startRecording();
  };

  const microphonePreflightEnabled = (existing.data?.limits as { microphonePreflightEnabled?: boolean } | undefined)?.microphonePreflightEnabled !== false;

  const openPreflight = (forRecording: boolean) => {
    setPreflightForRecording(forRecording);
    setPreflightStatus("idle");
    setPreflightMessage("");
    setPreflightOpen(true);
  };

  const runMicrophonePreflight = async () => {
    setPreflightStatus("running");
    setPreflightMessage("Checking browser recording support, microphone permission, and a live audio input…");
    if (!navigator.mediaDevices?.getUserMedia) {
      setPreflightStatus("failed");
      setPreflightMessage("This browser does not support secure microphone recording. Use a current Chrome, Edge, Firefox, or Safari browser.");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setPreflightStatus("failed");
      setPreflightMessage("This browser can access a microphone but cannot create a Business Pitch recording. Use a current Chrome, Edge, Firefox, or Safari browser.");
      return;
    }
    const recordingFormat = selectAudioRecordingFormat(MediaRecorder);
    if (!recordingFormat) {
      setPreflightStatus("failed");
      setPreflightMessage("This browser cannot create a supported audio recording. Use a current Chrome, Edge, Firefox, or Safari browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const liveTrack = stream.getAudioTracks().find((track) => track.readyState === "live" && track.enabled);
      stream.getTracks().forEach((track) => track.stop());
      if (!liveTrack) {
        setPreflightStatus("failed");
        setPreflightMessage("No enabled microphone was detected. Choose an input device in your browser or operating-system settings, then test again.");
        return;
      }
      setPreflightStatus("passed");
      setPreflightMessage("Microphone check passed. Browser recording support, permission, and a live audio input are ready.");
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      setPreflightStatus("failed");
      if (name === "NotAllowedError" || name === "SecurityError") {
        setPreflightMessage("Microphone access is blocked. Allow microphone access for myportal.readypackets.com in your browser and operating-system privacy settings, then test again.");
      } else if (name === "NotFoundError" || name === "NotReadableError") {
        setPreflightMessage("No microphone is currently available. Connect or select a working microphone, and close any application that is using it, then test again.");
      } else {
        setPreflightMessage("The microphone check could not complete. Confirm your browser and device settings, then test again.");
      }
    }
  };

  const beginPitchRecording = () => {
    if (microphonePreflightEnabled) {
      openPreflight(true);
      return;
    }
    if (microphonePermission === "granted") {
      void startRecording();
      return;
    }
    if (microphonePermission === "denied") {
      toast.error("Microphone is blocked", "Allow microphone access for myportal.readypackets.com in your browser site settings, then try again.");
      return;
    }
    setMicrophonePromptOpen(true);
  };

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error("Recording is not supported", "Use a current browser with microphone recording support.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (!stream.getAudioTracks().some((track) => track.readyState === "live" && track.enabled)) {
        stream.getTracks().forEach((track) => track.stop());
        toast.error("Microphone unavailable", "No enabled microphone was found. Choose an input device in your browser or operating-system settings and try again.");
        return;
      }
      if (typeof MediaRecorder === "undefined") {
        stream.getTracks().forEach((track) => track.stop());
        toast.error("Recording is not supported", "Use a current Chrome, Edge, Firefox, or Safari browser with in-browser audio recording enabled.");
        return;
      }
      const selectedFormat = selectAudioRecordingFormat(MediaRecorder);
      if (!selectedFormat) {
        stream.getTracks().forEach((track) => track.stop());
        toast.error("Recording format is not supported", "This browser cannot create an approved M4A, WebM, or Ogg recording.");
        return;
      }
      const recorder = new MediaRecorder(stream, { mimeType: selectedFormat.mimeType });
      mediaRecorder.current = recorder;
      audioChunks.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.current.push(e.data);
      };

      recorder.onstop = () => {
        const actualFormat = normalizeAudioRecordingFormat(recorder.mimeType, selectedFormat);
        const audioBlob = new Blob(audioChunks.current, { type: actualFormat.mimeType });
        stream.getTracks().forEach(track => track.stop());
        if (audioBlob.size === 0) {
          toast.error("Recording was empty", "No audio data was captured. Check your selected microphone and try again.");
          return;
        }
        const file = new File(
          [audioBlob],
          recordingFileName("pitch-recording", formatDateTime(new Date()).replace(/[^a-zA-Z0-9]/g, "-"), actualFormat),
          { type: actualFormat.mimeType },
        );
        setPendingPitch((current) => {
          if (current) URL.revokeObjectURL(current.previewUrl);
          return { file, previewUrl: URL.createObjectURL(audioBlob) };
        });
        toast.success("Recording ready to review", "Play it back, then upload it or discard and record again.");
      };

      recorder.start();
      setRecording(true);
      setRecordingTime(0);
      
      recordingInterval.current = setInterval(() => {
        setRecordingTime(prev => {
          const limits = existing.data?.limits;
          const maxTime = limits?.maxPitchLengthSeconds ?? 300;
          if (prev >= maxTime - 1) {
            stopRecording();
            return prev;
          }
          return prev + 1;
        });
      }, 1000);
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        toast.error("Microphone access was not available", "Confirm that microphone access is allowed for myportal.readypackets.com and that no operating-system privacy control is blocking your browser.");
      } else if (name === "NotFoundError" || name === "NotReadableError") {
        toast.error("Microphone device unavailable", "Connect or select a working microphone, and close any other application that is using it before trying again.");
      } else if (name === "NotSupportedError") {
        toast.error("Recording is not supported", "Use a current Chrome, Edge, Firefox, or Safari browser to record this Business Pitch Idea.");
      } else {
        toast.error("Could not start recording", "Please try again. If the problem continues, verify your browser microphone and device settings.");
      }
    }
  };

  const stopRecording = () => {
    if (mediaRecorder.current && mediaRecorder.current.state !== "inactive") {
      mediaRecorder.current.stop();
    }
    setRecording(false);
    if (recordingInterval.current) clearInterval(recordingInterval.current);
  };

  const files = orderFiles.data?.filter(f => f.category === "intake_attachment") ?? [];
  // listForUser doesn't return detectedMime, so we infer from extension
  const isAudio = (f: any) => f.extension && ["mp3", "wav", "webm", "ogg", "m4a", "aac", "flac"].includes(f.extension.toLowerCase());
  const documents = files.filter(f => !isAudio(f));
  const pitches = files.filter(f => isAudio(f));
  const limits = existing.data?.limits;

  const requiresMnda = useMemo(() => {
    if (existing.data?.status === "submitted") return false;
    if (mnda.isLoading) return true;
    if (mnda.data?.acceptedAt) return false;
    return true;
  }, [existing.data?.status, mnda.isLoading, mnda.data?.acceptedAt]);

  const totalRequired = (questions.data ?? []).filter((question) => question.required).length;
  const completedRequired = (questions.data ?? []).filter(
    (question) =>
      question.required && (answers[question.key] ?? "").trim().length >= question.minLength,
  ).length;

  const setAnswer = (key: string, value: string) => {
    setAnswers((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: "" }));
    setDirty(true);
  };

  const draftPayload = () => ({
    orderId,
    projectName: projectName.trim() || undefined,
    desiredOutcomes: desiredOutcomes as (typeof INTAKE_OUTCOMES)[number][],
    integrityChoice: (integrityChoice || undefined) as (typeof INTEGRITY_CHOICES)[number] | undefined,
    answers,
  });

  const persistDraft = async (returnLater: boolean, includePendingRecording: boolean) => {
    if (includePendingRecording && pendingPitch) {
      const uploaded = await handleUpload([pendingPitch.file], true);
      if (!uploaded) return;
      URL.revokeObjectURL(pendingPitch.previewUrl);
      setPendingPitch(null);
    }
    try {
      await save.mutateAsync(draftPayload());
      if (returnLater) {
        toast.success("Order workspace saved", "Your form, uploaded files, and recording have been saved. You can return to this order at any time.");
        navigate(`/portal/orders/${orderId}`);
      } else {
        toast.success("Order workspace saved", "Your current form, uploaded files, and recording are saved. You can continue working.");
      }
    } catch {
      // The mutation-level error message is already shown by the shared handler.
    }
  };

  const openSaveChoices = () => {
    setSaveReturningLater(false);
    setSaveChoiceOpen(true);
  };

  // Autosave saves all typed draft fields. A locally held recording remains private
  // until the customer explicitly chooses a save option that includes it.
  useEffect(() => {
    if (readOnly || !dirty) return;
    const timer = setTimeout(() => { void persistDraft(false, false); }, 45_000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, projectName, readOnly]);

  const validateAndSubmit = () => {
    const next: Record<string, string> = {};
    if (!confirmAccurate) {
      next.confirmAccurate = "Please confirm your answers are accurate.";
    }
    setErrors(next);
    if (Object.keys(next).length > 0) {
      const firstKey = Object.keys(next)[0];
      document.getElementById(`intake-${firstKey}`)?.scrollIntoView({ block: "center" });
      toast.error("Some answers need attention", "Review the highlighted fields and try again.");
      return;
    }
    if (pendingPitch) {
      toast.warning("Review the recording first", "Upload or discard the locally held browser recording before submitting Phase 1.");
      return;
    }
    // Persist all typed draft fields, then submit.
    save.mutate(draftPayload(), { onSuccess() { submit.mutate({ orderId, confirmAccurate: true }); } });
  };

  if (questions.isLoading || existing.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!mnda.data?.accepted && !submitted) {
    return (
      <>
        <PageHeader
          title="Phase I intake"
          breadcrumb={{ href: `/portal/orders/${orderId}`, label: "Back to order" }}
        />
        <Card className="max-w-2xl">
          <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
            <ShieldCheck className="size-4 text-teal" aria-hidden="true" />
            Sign the mutual NDA first
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-body">
            The intake form asks for confidential detail about your concept. We require a mutual NDA
            to be in place before you provide it — that protects you, and it is why we ask for the
            signature first.
          </p>
          <LinkButton
            href={`/portal/orders/${orderId}/nda`}
            className="mt-5"
            leadingIcon={<FileSignature className="size-4" aria-hidden="true" />}
          >
            Review and sign the NDA
          </LinkButton>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Phase I — Intake form"
        description="Upload supporting materials and record a Business Pitch Idea. Your project team will send the specific Phase 1 questions needed for this order."
        breadcrumb={{ href: `/portal/orders/${orderId}`, label: "Back to order" }}
        actions={
          readOnly ? (
            <Badge tone="success">Submitted {formatDateTime(existing.data?.submittedAt ?? null)}</Badge>
          ) : (
            <>
              <Button
                variant="outline"
                busy={save.isPending}
                onClick={openSaveChoices}
                leadingIcon={<Save className="size-4" aria-hidden="true" />}
              >
                Save draft
              </Button>
              <Button
                busy={submit.isPending}
                onClick={validateAndSubmit}
                leadingIcon={<Send className="size-4" aria-hidden="true" />}
              >
                Submit and lock Phase 1
              </Button>
            </>
          )
        }
      />

      {readOnly ? (
        <Alert tone="success" className="mb-6" title="This intake has been submitted">
          Your answers are locked. If something needs to change, add a message to the order and the
          team will amend the record.
        </Alert>
      ) : (
        <Card className="mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-ink">
                {completedRequired} of {totalRequired} required answers complete
              </p>
              <p className="mt-0.5 text-xs text-muted">
                Drafts save automatically. Nothing is submitted until you choose to submit.
              </p>
            </div>
            {dirty ? <Badge tone="warning">Unsaved changes</Badge> : <Badge tone="neutral">Saved</Badge>}
          </div>
          <ProgressBar className="mt-3" value={completedRequired} max={Math.max(totalRequired, 1)} />
        </Card>
      )}

      <div className="max-w-3xl space-y-6">
        <Card>
          <CardHeader title="Project" />
          <Input
            label="Project name"
            className="mt-4"
            value={projectName}
            onChange={(event) => {
              setProjectName(event.target.value);
              setDirty(true);
            }}
            disabled={readOnly}
            maxLength={190}
            help="Optional. A short internal label for this engagement."
          />
        </Card>

        {sections.map(([section, sectionQuestions]) => (
          <Card key={section}>
            <CardHeader title={section} />
            <div className="mt-5 space-y-6">
              {(sectionQuestions ?? []).map((question) => {
                const value = answers[question.key] ?? "";
                const belowMinimum =
                  value.trim().length > 0 && value.trim().length < question.minLength;
                return (
                  <div key={question.key} id={`intake-${question.key}`}>
                    <Textarea
                      label={question.label}
                      help={
                        question.help
                          ? `${question.help} Minimum ${question.minLength} characters.`
                          : `Minimum ${question.minLength} characters.`
                      }
                      value={value}
                      onChange={(event) => setAnswer(question.key, event.target.value)}
                      error={errors[question.key] || undefined}
                      required={question.required}
                      disabled={readOnly}
                      rows={5}
                      maxLength={question.maxLength}
                      showCount
                    />
                    {!readOnly && belowMinimum && !errors[question.key] ? (
                      <p className="mt-1 text-xs text-warning">
                        {question.minLength - value.trim().length} more characters needed.
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Card>
        ))}

        <Card id="intake-supporting-materials">
          <CardHeader
            title="Supporting documents & Business Pitch Idea"
            description="Upload reference documents for this order and, if useful, record a short Business Pitch Idea directly in this browser. Audio files cannot be uploaded from your device."
          />
          <div className="mt-4 grid gap-5 lg:grid-cols-2">
            <div>
              <p className="text-sm font-medium text-ink">Supporting documents</p>
              <p className="mt-1 text-xs text-muted">Up to {limits?.maxDocuments ?? 5} documents. Allowed types: {limits?.allowedDocumentTypes ?? ".pdf,.doc,.docx,.txt"}.</p>
              {!readOnly && documents.length < (limits?.maxDocuments ?? 5) ? (
                <label className="mt-3 inline-flex cursor-pointer items-center rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-ink hover:border-teal">
                  <input ref={fileInput} className="sr-only" type="file" multiple accept={limits?.allowedDocumentTypes ?? ".pdf,.doc,.docx,.txt"} onChange={(event) => void handleUpload(event.target.files, false)} disabled={uploading} />
                  {uploading ? "Uploading…" : "Upload documents"}
                </label>
              ) : null}
              <ul className="mt-3 space-y-2 text-sm">{documents.map((file) => <li key={file.id} className="flex items-center justify-between gap-2 rounded border border-line px-3 py-2"><span className="truncate">{file.originalName}</span>{!readOnly && <Button size="sm" variant="ghost" onClick={() => deleteFileMut.mutate({ fileId: file.id })}>Remove</Button>}</li>)}</ul>
            </div>
            <div>
              <p className="text-sm font-medium text-ink">Business Pitch Idea</p>
              <p className="mt-1 text-xs text-muted">Record directly from your microphone in WebM format. Up to {limits?.maxPitchRecordings ?? 1} recording{(limits?.maxPitchRecordings ?? 1) === 1 ? "" : "s"}, maximum {Math.ceil((limits?.maxPitchLengthSeconds ?? 300) / 60)} minutes each.</p>
              {!readOnly && pitches.length < (limits?.maxPitchRecordings ?? 1) && !pendingPitch ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button variant={recording ? "danger" : "primary"} className={recording ? "animate-pulse ring-2 ring-danger/40 shadow-lg shadow-danger/20" : ""} leadingIcon={recording ? <span className="relative flex size-4 items-center justify-center"><span className="absolute size-3 animate-ping rounded-full bg-white/80" /><span className="relative size-2 rounded-full bg-white" /></span> : <Mic className="size-4" />} onClick={() => recording ? stopRecording() : beginPitchRecording()} disabled={uploading}>{recording ? `Recording — stop (${recordingTime}s)` : "Record Business Pitch Idea"}</Button>
                  {microphonePreflightEnabled && !recording ? <Button variant="outline" onClick={() => openPreflight(false)} disabled={uploading}>Test microphone</Button> : null}
                </div>
              ) : null}
              {pendingPitch ? <div className="mt-3 space-y-3 rounded-lg border border-teal/40 bg-teal/5 p-3"><div><p className="text-sm font-semibold text-ink">Review your browser recording</p><p className="mt-1 text-xs text-muted">This recording remains in your browser until you choose Upload. You may discard it and record again.</p></div><audio className="w-full" controls preload="metadata" src={pendingPitch.previewUrl}>Your browser cannot play this recording.</audio><div className="flex flex-wrap gap-2"><Button busy={uploading} onClick={() => void (async () => { const uploaded = await handleUpload([pendingPitch.file], true); if (uploaded) { URL.revokeObjectURL(pendingPitch.previewUrl); setPendingPitch(null); } })()}>Upload recording</Button><Button variant="outline" disabled={uploading} onClick={() => { URL.revokeObjectURL(pendingPitch.previewUrl); setPendingPitch(null); }}>Discard recording</Button></div></div> : null}
              <ul className="mt-3 space-y-2 text-sm">{pitches.map((file) => <li key={file.id} className="flex items-center justify-between gap-2 rounded border border-line px-3 py-2"><span className="truncate">{file.originalName} <Badge tone="teal">Browser recording</Badge></span>{!readOnly && <Button size="sm" variant="ghost" onClick={() => deleteFileMut.mutate({ fileId: file.id })}>Remove</Button>}</li>)}</ul>
            </div>
          </div>
        </Card>

        <Modal open={preflightOpen} onClose={() => setPreflightOpen(false)} title="Microphone check" description="Verify your browser, permission, and microphone before recording a Business Pitch Idea.">
          <div className="space-y-4">
            {preflightStatus === "idle" ? <Alert tone="info">The check requests microphone access, confirms a live audio input, and verifies a supported browser recording format. It does not save or upload audio.</Alert> : null}
            {preflightStatus === "running" ? <Alert tone="info">{preflightMessage}</Alert> : null}
            {preflightStatus === "passed" ? <Alert tone="success">{preflightMessage}</Alert> : null}
            {preflightStatus === "failed" ? <Alert tone="danger">{preflightMessage}</Alert> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => setPreflightOpen(false)}>{preflightStatus === "passed" && preflightForRecording ? "Cancel" : "Close"}</Button>
              {preflightStatus !== "passed" ? <Button busy={preflightStatus === "running"} onClick={() => void runMicrophonePreflight()}>Run microphone check</Button> : null}
              {preflightStatus === "passed" && preflightForRecording ? <Button onClick={() => { setPreflightOpen(false); void startRecording(); }}>Start recording</Button> : null}
            </div>
          </div>
        </Modal>
        <Modal open={microphonePromptOpen} onClose={() => setMicrophonePromptOpen(false)} title="Allow microphone access" description="ReadyPackets needs microphone access only while you record this Business Pitch Idea. Your browser will show its own permission prompt next. This step is skipped automatically once access is already granted."><div className="space-y-4"><Alert tone="info">Select <strong>Allow microphone</strong> in the browser prompt. The recording stays in your browser until you stop it, then it is uploaded in the format supported by your browser for this order.</Alert><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setMicrophonePromptOpen(false)}>Cancel</Button><Button onClick={requestMicrophone}>Allow microphone and record</Button></div></div></Modal>

        <Modal open={saveChoiceOpen} onClose={() => setSaveChoiceOpen(false)} title="Save your order workspace" description="Your typed intake information is saved as a draft. Files and recordings already uploaded are already attached to this order."><div className="space-y-4"><Alert tone="info">{pendingPitch ? "Your reviewed browser recording will be uploaded with this save, then attached to this order." : "All current answers, project details, uploaded documents, and uploaded recordings will remain available when you return."}</Alert><div className="rounded-lg border border-line bg-surface-soft p-3 text-sm text-body"><p className="font-medium text-ink">Choose what happens after saving</p><p className="mt-1">You can continue working now, or save and return to your order dashboard. Nothing is submitted or locked by either choice.</p></div><div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => setSaveChoiceOpen(false)}>Cancel</Button><Button variant="outline" busy={save.isPending || uploading} onClick={() => { setSaveReturningLater(false); void persistDraft(false, true).then(() => setSaveChoiceOpen(false)); }}>Save and continue working</Button><Button busy={save.isPending || uploading || saveReturningLater} onClick={() => { setSaveReturningLater(true); void persistDraft(true, true); }}>Save and return later</Button></div></div></Modal>

        <Card id="intake-desiredOutcomes" className="hidden">
          <CardHeader
            title="Section 7 — Desired outcomes"
            description="What are you trying to achieve with this packet? Choose everything that applies."
          />
          <div className="mt-4 space-y-2.5">
            {(outcomes.data?.desiredOutcomes ?? []).map((outcome) => (
              <Checkbox
                key={outcome}
                label={outcome}
                checked={desiredOutcomes.includes(outcome)}
                disabled={readOnly}
                onChange={(event) => {
                  setDesiredOutcomes((current) =>
                    event.target.checked
                      ? [...current, outcome]
                      : current.filter((item) => item !== outcome),
                  );
                  setDirty(true);
                  setErrors((current) => ({ ...current, desiredOutcomes: "" }));
                }}
              />
            ))}
          </div>
          {errors.desiredOutcomes ? (
            <p className="mt-2 text-sm text-danger">{errors.desiredOutcomes}</p>
          ) : null}
        </Card>

        <Card id="intake-integrityChoice" className="hidden border-gold/35">
          <CardHeader
            title="Section 8 — The Integrity Clause"
            description="If our analysis concludes the concept cannot work as described, we will not write a favourable report. Choose now how you would like us to proceed."
          />
          <fieldset className="mt-4 space-y-3">
            <legend className="sr-only">Integrity clause choice</legend>
            {(outcomes.data?.integrityChoices ?? []).map((choice) => (
              <label
                key={choice}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 ${
                  integrityChoice === choice
                    ? "border-gold bg-gold/5 ring-1 ring-gold/25"
                    : "border-line hover:border-muted"
                }`}
              >
                <input
                  type="radio"
                  name="integrity-choice"
                  value={choice}
                  checked={integrityChoice === choice}
                  disabled={readOnly}
                  onChange={() => {
                    setIntegrityChoice(choice);
                    setDirty(true);
                    setErrors((current) => ({ ...current, integrityChoice: "" }));
                  }}
                  className="mt-0.5 size-4 shrink-0 accent-gold"
                />
                <span className="text-sm text-ink">
                  {INTEGRITY_CHOICE_LABELS[choice as keyof typeof INTEGRITY_CHOICE_LABELS] ?? choice}
                </span>
              </label>
            ))}
          </fieldset>
          {errors.integrityChoice ? (
            <p className="mt-2 text-sm text-danger">{errors.integrityChoice}</p>
          ) : null}
        </Card>

        {!readOnly ? (
          <Card id="intake-confirmAccurate">
            <Alert tone="warning" className="mb-4">Submitting Phase 1 locks your customer documents, browser recording, and answers. You may remove or replace your own materials until you submit. After submission, only an administrator can confirm an unlock.</Alert>
            <Checkbox
              label="I confirm that the information I have provided is accurate and complete to the best of my knowledge, and I acknowledge that submitting this intake locks Phase 1 until an administrator confirms an unlock."
              checked={confirmAccurate}
              onChange={(event) => {
                setConfirmAccurate(event.target.checked);
                setErrors((current) => ({ ...current, confirmAccurate: "" }));
              }}
              error={errors.confirmAccurate || undefined}
            />
            <div className="mt-5 flex flex-wrap gap-2">
              <Button
                busy={submit.isPending || save.isPending}
                onClick={validateAndSubmit}
                leadingIcon={<Send className="size-4" aria-hidden="true" />}
              >
                Submit and lock Phase 1
              </Button>
              <Button variant="outline" busy={save.isPending || uploading} onClick={openSaveChoices}>
                Save workspace
              </Button>
            </div>
            <p className="mt-3 text-xs text-muted">
              Submitting moves your order into Phase II and locks these answers. {BRAND.companyShortName}{" "}
              will then schedule your Logic Synthesis call.
            </p>
          </Card>
        ) : null}
      </div>
    </>
  );
}

export function MndaPage() {
  const params = useParams<{ id: string }>();
  const orderId = Number.isFinite(Number(params.id)) ? Number(params.id) : undefined;
  const toast = useToast();
  const [, navigate] = useLocation();

  const document = trpc.intake.mndaDocument.useQuery();
  const status = trpc.intake.mndaStatus.useQuery({ orderId });

  const [signatureName, setSignatureName] = useState("");
  const [confirmAuthority, setConfirmAuthority] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const accept = trpc.intake.acceptMnda.useMutation({
    async onSuccess() {
      await status.refetch();
      toast.success("NDA signed", "You can now complete your Phase I intake form.");
      if (orderId) navigate(`/portal/orders/${orderId}/intake`);
    },
    onError(error) {
      setFormError(errorMessage(error));
    },
  });

  const alreadySigned = status.data?.accepted;

  return (
    <>
      <PageHeader
        title="Mutual non-disclosure agreement"
        description="Both parties are bound: you protect our methodology, and we protect your concept."
        breadcrumb={
          orderId
            ? { href: `/portal/orders/${orderId}`, label: "Back to order" }
            : { href: "/portal", label: "Back to portal" }
        }
        actions={
          alreadySigned ? (
            <Badge tone="success">Signed {formatDateTime(status.data?.acceptedAt ?? null)}</Badge>
          ) : null
        }
      />

      <div className="grid max-w-6xl gap-6 lg:grid-cols-[1.5fr_1fr] lg:items-start">
        <Card>
          {document.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-64 w-full" />
            </div>
          ) : document.isError || !document.data ? (
            <Alert tone="danger" title="The agreement could not be loaded">
              Please contact us at {BRAND.emails.compliance} and we will provide a copy directly.
            </Alert>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-4">
                <h2 className="text-lg font-semibold text-ink">{document.data.title}</h2>
                <span className="text-xs text-muted">
                  Version {document.data.version} · effective {document.data.effectiveDate}
                </span>
              </div>
              {/*
                The agreement is rendered in a scrollable region rather than a
                separate download, so the signature is captured against text the
                signer has actually been shown.
              */}
              <div
                className="prose-rp mt-5 max-h-[32rem] overflow-y-auto rounded-lg border border-line bg-surface-soft p-5 text-sm"
                tabIndex={0}
                role="region"
                aria-label="Agreement text"
              >
                <Markdown source={document.data.bodyMarkdown} />
              </div>
            </>
          )}
        </Card>

        <Card className="lg:sticky lg:top-24">
          <CardHeader
            title={alreadySigned ? "Signature on file" : "Sign the agreement"}
            description={
              alreadySigned
                ? "A copy of this agreement and your signature record is retained in your account."
                : "Type your full legal name to sign electronically."
            }
          />

          {alreadySigned ? (
            <div className="mt-5">
              <p className="flex items-center gap-2 text-sm text-success">
                <CheckCircle2 className="size-4" aria-hidden="true" />
                Signed on {formatDateTime(status.data?.acceptedAt ?? null)}
              </p>
              {orderId ? (
                <LinkButton
                  href={`/portal/orders/${orderId}/intake`}
                  fullWidth
                  className="mt-5"
                  leadingIcon={<ClipboardCheck className="size-4" aria-hidden="true" />}
                >
                  Continue to Phase I intake
                </LinkButton>
              ) : null}
            </div>
          ) : (
            <form
              className="mt-5 space-y-5"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                setFormError(null);
                if (signatureName.trim().length < 3) {
                  setFormError("Enter your full legal name as your signature.");
                  return;
                }
                if (!confirmAuthority) {
                  setFormError("Confirm that you are authorised to sign this agreement.");
                  return;
                }
                accept.mutate({
                  orderId,
                  signatureName: signatureName.trim(),
                  confirmAuthority,
                });
              }}
            >
              {formError ? <Alert tone="danger">{formError}</Alert> : null}

              <Input
                label="Full legal name"
                value={signatureName}
                onChange={(event) => setSignatureName(event.target.value)}
                autoComplete="name"
                required
                maxLength={120}
                help="This is recorded as your electronic signature."
              />

              <Checkbox
                label="I have read the agreement above, I agree to be bound by it, and I am authorised to sign on behalf of the disclosing party."
                checked={confirmAuthority}
                onChange={(event) => setConfirmAuthority(event.target.checked)}
              />

              <Button
                type="submit"
                fullWidth
                busy={accept.isPending}
                leadingIcon={<FileSignature className="size-4" aria-hidden="true" />}
              >
                Sign agreement
              </Button>

              <p className="text-xs leading-relaxed text-muted">
                Your signature is recorded with a timestamp, the agreement version, your IP address,
                and your browser's user agent, which is what makes the record evidentiary. Governing
                law is Maryland, with venue in Baltimore County.
              </p>
            </form>
          )}
        </Card>
      </div>
    </>
  );
}
