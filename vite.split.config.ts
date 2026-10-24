import { defineConfig, type Plugin, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";

const here = path.dirname(fileURLToPath(import.meta.url));

function cspNoncePlugin(): Plugin {
  return {
    name: "readypackets-csp-nonce",
    enforce: "post",
    apply: "build",
    transformIndexHtml(html) {
      return html
        .replace(/<script(?![^>]*\bnonce=)/g, '<script nonce="__CSP_NONCE__"')
        .replace(/<link([^>]*\brel="(?:stylesheet|modulepreload)"[^>]*)>/g, (match, attributes: string) =>
          attributes.includes("nonce=") ? match : `<link nonce="__CSP_NONCE__"${attributes}>`);
    },
  };
}

/**
 * The Portal PWA is deliberately conservative. Its worker receives an injected
 * manifest containing only static code, fonts, branding, and the generic
 * offline notice. Customer HTML, API responses, documents, uploads, downloads,
 * media and browser-generated state are never precached or runtime cached.
 */
function portalPwaPlugin(outDir: "dist-portal") {
  return VitePWA({
    strategies: "injectManifest",
    srcDir: "src/pwa",
    filename: "portal-service-worker.ts",
    scope: "/",
    injectRegister: false,
    registerType: "prompt",
    manifest: false,
    includeAssets: false,
    injectManifest: {
      globPatterns: [
        "assets/**/*.{js,css,woff2,png,svg,ico,webp}",
        "brand/**/*.{png,svg}",
        "fonts/**/*.woff2",
        "favicon.ico",
        "offline.html",
        "offline.css",
      ],
      maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
    },
    outDir,
  });
}

/** The standalone public bundle must not accidentally advertise a Portal PWA. */
function removePortalPwaArtifacts(outDir: "dist-public"): Plugin {
  return {
    name: "readypackets-remove-portal-pwa-artifacts",
    apply: "build",
    async closeBundle() {
      const destination = path.join(here, "client", outDir);
      await Promise.all(
        ["manifest.webmanifest", "offline.html", "offline.css", "portal-service-worker.js", "portal-service-worker.mjs"].map(
          (file) => rm(path.join(destination, file), { force: true }),
        ),
      );
    },
  };
}

export function createSplitViteConfig(html: "public.html" | "portal.html", outDir: "dist-public" | "dist-portal"): UserConfig {
  const isPortalBuild = outDir === "dist-portal";
  return defineConfig({
    root: path.join(here, "client"),
    base: "/",
    plugins: [react(), cspNoncePlugin(), ...(isPortalBuild ? [portalPwaPlugin(outDir)] : [removePortalPwaArtifacts(outDir)])],
    resolve: { alias: { "@": path.join(here, "client", "src"), "@shared": path.join(here, "shared"), "@server": path.join(here, "server") } },
    build: {
      outDir: path.join(here, "client", outDir),
      emptyOutDir: true,
      sourcemap: false,
      target: "es2022",
      cssCodeSplit: true,
      assetsInlineLimit: 0,
      rollupOptions: {
        input: path.join(here, "client", html),
        // Do not force arbitrary node modules into hand-written chunks. Several
        // portal dependencies import React hooks transitively, and a manual
        // `vendor` versus `react` split creates circular ES module execution
        // order. That can fail before ErrorBoundary mounts and leave a blank
        // browser page. Rollup's graph-aware automatic chunking preserves the
        // dependency order; emitted asset names remain content-hashed by Vite.
      },
    },
    esbuild: { drop: process.env.NODE_ENV === "production" ? ["console", "debugger"] : [], legalComments: "none" },
  });
}
