/**
 * Shared, bounded configuration for the unauthenticated ReadyPackets login
 * slideshow. Administrators may change the copy and choose one of these local
 * brand assets, but cannot inject external URLs, markup, scripts, or styles.
 */
export const LOGIN_SLIDESHOW_IMAGE_KEYS = ["full", "mark", "square"] as const;

export type LoginSlideshowImageKey = (typeof LOGIN_SLIDESHOW_IMAGE_KEYS)[number];

export interface LoginSlideshowSlide {
  eyebrow: string;
  title: string;
  description: string;
  imageKey: LoginSlideshowImageKey;
}

export const DEFAULT_LOGIN_SLIDES: readonly LoginSlideshowSlide[] = [
  {
    eyebrow: "ReadyPackets portal",
    title: "One place for the work that matters.",
    description: "Access your orders, deliverables, messages, and support history from one protected workspace.",
    imageKey: "full",
  },
  {
    eyebrow: "Clear next steps",
    title: "Keep every packet moving forward.",
    description: "Review what is needed, share information securely, and stay connected to the next milestone.",
    imageKey: "mark",
  },
  {
    eyebrow: "Professional handoff",
    title: "Prepared for the conversations ahead.",
    description: "Find the documents and deliverables you need when it is time to move with confidence.",
    imageKey: "square",
  },
] as const;

export const MAX_LOGIN_SLIDESHOW_SLIDES = 5;

/** A safe immutable fallback for malformed, legacy, or absent stored config. */
export function loginSlideshowSlidesOrDefault(value: unknown): LoginSlideshowSlide[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_LOGIN_SLIDESHOW_SLIDES) {
    return [...DEFAULT_LOGIN_SLIDES];
  }

  const valid = value.every((slide) => {
    if (!slide || typeof slide !== "object") return false;
    const candidate = slide as Record<string, unknown>;
    return (
      typeof candidate.eyebrow === "string" && candidate.eyebrow.trim().length > 0 && candidate.eyebrow.length <= 80 &&
      typeof candidate.title === "string" && candidate.title.trim().length > 0 && candidate.title.length <= 120 &&
      typeof candidate.description === "string" && candidate.description.trim().length > 0 && candidate.description.length <= 360 &&
      typeof candidate.imageKey === "string" && (LOGIN_SLIDESHOW_IMAGE_KEYS as readonly string[]).includes(candidate.imageKey)
    );
  });

  if (!valid) return [...DEFAULT_LOGIN_SLIDES];
  return (value as LoginSlideshowSlide[]).map((candidate) => {
    return {
      eyebrow: candidate.eyebrow.trim(),
      title: candidate.title.trim(),
      description: candidate.description.trim(),
      imageKey: candidate.imageKey as LoginSlideshowImageKey,
    };
  });
}
