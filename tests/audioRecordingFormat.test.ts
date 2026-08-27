import { describe, expect, it } from "vitest";
import {
  normalizeAudioRecordingFormat,
  recordingFileName,
  selectAudioRecordingFormat,
} from "../client/src/lib/audioRecording";

function recorderSupporting(...supported: string[]) {
  return { isTypeSupported: (mimeType: string) => supported.includes(mimeType) };
}

describe("browser audio recording format selection", () => {
  it("selects Safari-compatible AAC in an M4A container when WebM is unavailable", () => {
    const format = selectAudioRecordingFormat(recorderSupporting("audio/mp4"));
    expect(format).toEqual({ mimeType: "audio/mp4", extension: "m4a", label: "M4A (AAC)" });
  });

  it("preserves WebM Opus as the preferred format when the browser supports it", () => {
    const format = selectAudioRecordingFormat(recorderSupporting("audio/mp4", "audio/webm;codecs=opus", "audio/webm"));
    expect(format).toEqual({ mimeType: "audio/webm;codecs=opus", extension: "webm", label: "WebM (Opus)" });
  });

  it("uses Ogg only when it is the browser's supported safe fallback", () => {
    const format = selectAudioRecordingFormat(recorderSupporting("audio/ogg"));
    expect(format).toEqual({ mimeType: "audio/ogg", extension: "ogg", label: "Ogg" });
  });

  it("fails closed when no approved recording format is advertised", () => {
    expect(selectAudioRecordingFormat(recorderSupporting())).toBeNull();
    expect(selectAudioRecordingFormat(undefined)).toBeNull();
  });

  it("normalizes Safari's actual MIME and emits a matching extension", () => {
    const preferred = { mimeType: "audio/mp4;codecs=mp4a.40.2", extension: "m4a" as const, label: "M4A (AAC)" };
    const actual = normalizeAudioRecordingFormat("audio/mp4", preferred);
    expect(actual.extension).toBe("m4a");
    expect(recordingFileName("phase-2-recording", 1724630400000, actual)).toBe("phase-2-recording-1724630400000.m4a");
  });
});
