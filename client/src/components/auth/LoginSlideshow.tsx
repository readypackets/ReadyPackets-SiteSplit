import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Pause, Play } from "lucide-react";
import { BRAND_ASSETS } from "@shared/brand";
import { Button } from "@/components/ui/Button";

const AUTO_ADVANCE_MS = 8_000;

export interface LoginSlide {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  /** Same-origin, supplied ReadyPackets brand asset. */
  image: string;
}

/**
 * These highlights are intentionally source-controlled rather than administrator
 * supplied. The sign-in page must not accept arbitrary remote image URLs.
 */
export const LOGIN_SLIDES: readonly LoginSlide[] = [
  {
    id: "workspace",
    eyebrow: "ReadyPackets portal",
    title: "One place for the work that matters.",
    description: "Access your orders, deliverables, messages, and support history from one protected workspace.",
    image: BRAND_ASSETS.dark.full,
  },
  {
    id: "momentum",
    eyebrow: "Clear next steps",
    title: "Keep every packet moving forward.",
    description: "Review what is needed, share information securely, and stay connected to the next milestone.",
    image: BRAND_ASSETS.mark.dark.svg,
  },
  {
    id: "handoff",
    eyebrow: "Professional handoff",
    title: "Prepared for the conversations ahead.",
    description: "Find the documents and deliverables you need when it is time to move with confidence.",
    image: BRAND_ASSETS.dark.squareLockup,
  },
] as const;

export function nextLoginSlideIndex(index: number, count = LOGIN_SLIDES.length): number {
  if (count <= 0) return 0;
  return (index + 1) % count;
}

export function previousLoginSlideIndex(index: number, count = LOGIN_SLIDES.length): number {
  if (count <= 0) return 0;
  return (index - 1 + count) % count;
}

export function shouldRotateLoginSlides({
  isDesktop,
  isPlaying,
  prefersReducedMotion,
  documentVisible,
}: {
  isDesktop: boolean;
  isPlaying: boolean;
  prefersReducedMotion: boolean;
  documentVisible: boolean;
}): boolean {
  return isDesktop && isPlaying && !prefersReducedMotion && documentVisible;
}

function mediaQueryMatches(query: string, fallback: boolean): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return fallback;
  return window.matchMedia(query).matches;
}

function useMediaQuery(query: string, fallback: boolean): boolean {
  const [matches, setMatches] = useState(() => mediaQueryMatches(query, fallback));

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia(query);
    const update = () => setMatches(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, [query]);

  return matches;
}

/**
 * Desktop-only login accompaniment. The authentication form remains first in DOM
 * order and this component is omitted below the desktop breakpoint, so signing
 * in remains the primary task for assistive technology and mobile users.
 */
export function LoginSlideshow() {
  const isDesktop = useMediaQuery("(min-width: 1024px)", true);
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)", false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [documentVisible, setDocumentVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    const pauseWhenHidden = () => {
      const visible = document.visibilityState !== "hidden";
      setDocumentVisible(visible);
      if (!visible) setIsPlaying(false);
    };
    pauseWhenHidden();
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => document.removeEventListener("visibilitychange", pauseWhenHidden);
  }, []);

  useEffect(() => {
    if (prefersReducedMotion) setIsPlaying(false);
  }, [prefersReducedMotion]);

  const canRotate = shouldRotateLoginSlides({
    isDesktop,
    isPlaying,
    prefersReducedMotion,
    documentVisible,
  });

  useEffect(() => {
    if (!canRotate) return;
    const interval = window.setInterval(() => {
      setActiveIndex((current) => nextLoginSlideIndex(current));
    }, AUTO_ADVANCE_MS);
    return () => window.clearInterval(interval);
  }, [canRotate]);

  if (!isDesktop) return null;

  const activeSlide = LOGIN_SLIDES[activeIndex] ?? LOGIN_SLIDES[0]!;
  const pauseForInteraction = () => setIsPlaying(false);
  const showPrevious = () => {
    pauseForInteraction();
    setActiveIndex((current) => previousLoginSlideIndex(current));
  };
  const showNext = () => {
    pauseForInteraction();
    setActiveIndex((current) => nextLoginSlideIndex(current));
  };

  return (
    <aside
      className="relative order-1 hidden min-h-screen overflow-hidden bg-navy text-white lg:flex"
      role="region"
      aria-roledescription="carousel"
      aria-label="ReadyPackets highlights"
      onMouseEnter={pauseForInteraction}
      onFocusCapture={pauseForInteraction}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgb(46_196_182_/_0.28),_transparent_42%),radial-gradient(circle_at_bottom_right,_rgb(201_168_76_/_0.16),_transparent_38%)]"
      />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/20" />

      <div className="relative flex w-full flex-col justify-between px-10 py-10 xl:px-16 xl:py-14">
        <div>
          <p className="text-sm font-semibold tracking-[0.14em] text-teal-light uppercase">
            ReadyPackets
          </p>
          <div className="mt-8 max-w-xl">
            <div className="flex min-h-44 items-center justify-center rounded-3xl border border-white/15 bg-white/5 px-10 py-8 shadow-2xl shadow-black/20">
              <img
                src={activeSlide.image}
                alt=""
                width={1024}
                height={512}
                className="max-h-48 max-w-full object-contain"
              />
            </div>
            <div className="mt-10">
              <p className="text-sm font-semibold tracking-wide text-teal-light">{activeSlide.eyebrow}</p>
              <h2 id="login-highlight-title" className="mt-3 max-w-lg text-4xl font-semibold tracking-tight text-white xl:text-5xl">
                {activeSlide.title}
              </h2>
              <p className="mt-5 max-w-xl text-lg leading-8 text-slate-200">{activeSlide.description}</p>
            </div>
          </div>
        </div>

        <div className="mt-12 flex items-center justify-between gap-4">
          <div className="flex items-center gap-1" aria-label="Choose a ReadyPackets highlight">
            {LOGIN_SLIDES.map((slide, index) => {
              const isActive = index === activeIndex;
              return (
                <button
                  key={slide.id}
                  type="button"
                  className="inline-flex size-11 items-center justify-center rounded-full text-white hover:bg-white/10"
                  aria-label={`Show slide ${index + 1} of ${LOGIN_SLIDES.length}: ${slide.title}`}
                  aria-current={isActive ? "true" : undefined}
                  onClick={() => {
                    pauseForInteraction();
                    setActiveIndex(index);
                  }}
                >
                  <span
                    aria-hidden="true"
                    className={`block rounded-full transition-all ${isActive ? "h-2.5 w-7 bg-teal-light" : "size-2.5 bg-white/45"}`}
                  />
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="border border-white/25 bg-white/10 text-white hover:bg-white/20"
              aria-label="Previous slide"
              onClick={showPrevious}
              leadingIcon={<ArrowLeft className="size-4" aria-hidden="true" />}
            />
            <Button
              variant="ghost"
              size="icon"
              className="border border-white/25 bg-white/10 text-white hover:bg-white/20"
              aria-label={isPlaying ? "Pause slide rotation" : "Play slide rotation"}
              aria-pressed={isPlaying}
              disabled={prefersReducedMotion}
              onClick={() => setIsPlaying((current) => !current)}
              leadingIcon={
                isPlaying ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />
              }
            />
            <Button
              variant="ghost"
              size="icon"
              className="border border-white/25 bg-white/10 text-white hover:bg-white/20"
              aria-label="Next slide"
              onClick={showNext}
              leadingIcon={<ArrowRight className="size-4" aria-hidden="true" />}
            />
          </div>
        </div>
        <p className="sr-only">Slide {activeIndex + 1} of {LOGIN_SLIDES.length}.</p>
      </div>
    </aside>
  );
}
