/**
 * Vite build configuration.
 *
 * Deliberately minimal: the React plugin and nothing else. No analytics, no
 * remote font loader, no CDN rewriting, and no runtime injection plugin. The
 * built bundle therefore makes zero third-party requests, which is what allows
 * a Content Security Policy with no external origins.
 */
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Stamp `nonce="__CSP_NONCE__"` onto every script and stylesheet tag Vite emits
 * into the built HTML.
 *
 * The server replaces the placeholder with a fresh per-request nonce when it
 * serves the shell. Without this, the strict CSP would block the bundle, and the
 * usual workaround — adding `'unsafe-inline'` or hashing at deploy time — is
 * exactly what we are refusing to do.
 */
function cspNoncePlugin(): Plugin {
  return {
    name: "readypackets-csp-nonce",
    enforce: "post",
    apply: "build",
    transformIndexHtml(html) {
      return html
        .replace(/<script(?![^>]*\bnonce=)/g, '<script nonce="__CSP_NONCE__"')
        .replace(
          /<link([^>]*\brel="(?:stylesheet|modulepreload)"[^>]*)>/g,
          (match, attributes: string) =>
            attributes.includes("nonce=")
              ? match
              : `<link nonce="__CSP_NONCE__"${attributes}>`,
        );
    },
  };
}

/** The legacy combined shell is not an installable Portal PWA surface. */
function removePortalPwaArtifacts(): Plugin {
  return {
    name: "readypackets-remove-portal-pwa-artifacts",
    apply: "build",
    async closeBundle() {
      const destination = path.join(here, "client", "dist");
      await Promise.all(
        ["manifest.webmanifest", "offline.html", "offline.css", "portal-service-worker.js", "portal-service-worker.mjs"].map(
          (file) => rm(path.join(destination, file), { force: true }),
        ),
      );
    },
  };
}

export default defineConfig({
  root: path.join(here, "client"),
  base: "/",
  plugins: [
    react(),
    cspNoncePlugin(),
    removePortalPwaArtifacts(),
  ],
  resolve: {
    alias: {
      "@": path.join(here, "client", "src"),
      "@shared": path.join(here, "shared"),
      "@server": path.join(here, "server"),
    },
  },
  build: {
    outDir: path.join(here, "client", "dist"),
    emptyOutDir: true,
    // Source maps are not published: they would hand an attacker the original
    // module layout and comments.
    sourcemap: false,
    target: "es2022",
    cssCodeSplit: true,
    // Keep automatic graph-aware chunking. Several UI dependencies import React
    // hooks transitively; forcing them into independently named vendor/react
    // chunks can create a browser ESM initialization cycle and leave a blank
    // shell before ErrorBoundary mounts. Vite still emits content-hashed assets
    // for safe immutable caching.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: false,
      },
    },
  },
  preview: { port: 4173, host: "127.0.0.1" },
  esbuild: {
    // Strip developer noise from the production bundle.
    drop: process.env.NODE_ENV === "production" ? ["console", "debugger"] : [],
    legalComments: "none",
  },
});
