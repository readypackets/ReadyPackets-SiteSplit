import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LOGIN_SLIDES,
  LoginSlideshow,
  nextLoginSlideIndex,
  previousLoginSlideIndex,
  shouldRotateLoginSlides,
} from "../client/src/components/auth/LoginSlideshow.js";

describe("login slideshow", () => {
  it("keeps the credentials first in DOM order and on the right beside the desktop slideshow", () => {
    const loginSource = readFileSync(resolve(process.cwd(), "client/src/pages/auth/Login.tsx"), "utf8");
    const slideshowSource = readFileSync(
      resolve(process.cwd(), "client/src/components/auth/LoginSlideshow.tsx"),
      "utf8",
    );

    expect(loginSource).toContain('lg:grid-cols-[minmax(0,1.1fr)_minmax(32rem,0.9fr)]');
    expect(loginSource).toContain('main id="auth-main" className="order-1');
    expect(loginSource).toContain("lg:order-2");
    expect(loginSource).toContain("<LoginSlideshow />");
    expect(slideshowSource).toContain('className="relative order-1 hidden');
    expect(slideshowSource).toContain("if (!isDesktop) return null;");
  });

  it("wraps slide controls without accepting an invalid empty slide set", () => {
    expect(nextLoginSlideIndex(0, 3)).toBe(1);
    expect(nextLoginSlideIndex(2, 3)).toBe(0);
    expect(previousLoginSlideIndex(0, 3)).toBe(2);
    expect(previousLoginSlideIndex(1, 3)).toBe(0);
    expect(nextLoginSlideIndex(0, 0)).toBe(0);
    expect(previousLoginSlideIndex(0, 0)).toBe(0);
  });

  it("rotates only while the desktop page is visible, playing, and motion is allowed", () => {
    expect(
      shouldRotateLoginSlides({
        isDesktop: true,
        isPlaying: true,
        prefersReducedMotion: false,
        documentVisible: true,
      }),
    ).toBe(true);

    for (const override of [
      { isDesktop: false },
      { isPlaying: false },
      { prefersReducedMotion: true },
      { documentVisible: false },
    ]) {
      expect(
        shouldRotateLoginSlides({
          isDesktop: true,
          isPlaying: true,
          prefersReducedMotion: false,
          documentVisible: true,
          ...override,
        }),
      ).toBe(false);
    }
  });

  it("uses only supplied same-origin ReadyPackets brand assets", () => {
    expect(LOGIN_SLIDES).toHaveLength(3);
    for (const slide of LOGIN_SLIDES) {
      expect(slide.image).toMatch(/^\/brand\/[a-zA-Z0-9._/-]+$/);
      expect(slide.image).not.toMatch(/^https?:\/\//i);
      expect(slide.title).not.toHaveLength(0);
      expect(slide.description).not.toHaveLength(0);
    }
  });

  it("renders labelled, keyboard-operable carousel controls without live updates", () => {
    const markup = renderToStaticMarkup(createElement(LoginSlideshow));
    expect(markup).toContain('aria-roledescription="carousel"');
    expect(markup).toContain('aria-label="ReadyPackets highlights"');
    expect(markup).toContain('aria-label="Previous slide"');
    expect(markup).toContain('aria-label="Next slide"');
    expect(markup).toContain('aria-label="Pause slide rotation"');
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain(`Slide 1 of ${LOGIN_SLIDES.length}.`);
    expect(markup).not.toContain("aria-live");
  });
});
