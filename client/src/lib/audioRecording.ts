export type AudioRecordingFormat = {
  mimeType: string;
  extension: "m4a" | "webm" | "ogg";
  label: string;
};

type MediaRecorderSupport = {
  isTypeSupported?: (mimeType: string) => boolean;
};

/**
 * Selects a format the current browser explicitly advertises for MediaRecorder.
 * Chromium/Firefox normally use Opus in WebM, which remains the preferred
 * established path. Safari records AAC in an MP4 container, stored with the
 * conventional .m4a extension, and is selected when WebM is unavailable. Ogg
 * remains a final browser-supported fallback. Never assume a MIME type from a
 * user agent.
 */
const RECORDING_FORMATS: readonly AudioRecordingFormat[] = [
  { mimeType: "audio/webm;codecs=opus", extension: "webm", label: "WebM (Opus)" },
  { mimeType: "audio/webm", extension: "webm", label: "WebM" },
  { mimeType: "audio/mp4;codecs=mp4a.40.2", extension: "m4a", label: "M4A (AAC)" },
  { mimeType: "audio/mp4", extension: "m4a", label: "M4A (AAC)" },
  { mimeType: "audio/ogg;codecs=opus", extension: "ogg", label: "Ogg (Opus)" },
  { mimeType: "audio/ogg", extension: "ogg", label: "Ogg" },
];

export function selectAudioRecordingFormat(mediaRecorder: MediaRecorderSupport | undefined): AudioRecordingFormat | null {
  if (typeof mediaRecorder?.isTypeSupported !== "function") return null;
  for (const format of RECORDING_FORMATS) {
    try {
      if (mediaRecorder.isTypeSupported(format.mimeType)) return format;
    } catch {
      // A malformed or unsupported MIME must not prevent trying the next safe format.
    }
  }
  return null;
}

/**
 * Uses the recorder's actual MIME when it still maps to the negotiated safe
 * container. Some engines normalize a requested codec MIME to its container.
 */
export function normalizeAudioRecordingFormat(actualMimeType: string, fallback: AudioRecordingFormat): AudioRecordingFormat {
  const normalized = actualMimeType.toLowerCase().split(";", 1)[0]?.trim();
  if (normalized === "audio/mp4") return { mimeType: "audio/mp4", extension: "m4a", label: "M4A (AAC)" };
  if (normalized === "audio/webm") return { mimeType: "audio/webm", extension: "webm", label: "WebM (Opus)" };
  if (normalized === "audio/ogg") return { mimeType: "audio/ogg", extension: "ogg", label: "Ogg (Opus)" };
  return fallback;
}

export function recordingFileName(prefix: string, timestamp: string | number, format: AudioRecordingFormat): string {
  return `${prefix}-${timestamp}.${format.extension}`;
}
