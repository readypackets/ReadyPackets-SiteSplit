import { defineConfig, type Plugin, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

export function createSplitViteConfig(html: "public.html" | "portal.html", outDir: "dist-public" | "dist-portal"): UserConfig {
  return defineConfig({
    root: path.join(here, "client"),
    base: "/",
    plugins: [react(), cspNoncePlugin()],
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
        output: {
          entryFileNames: "assets/[name].[hash].js",
          chunkFileNames: "assets/[name].[hash].js",
          assetFileNames: "assets/[name].[hash][extname]",
          manualChunks(id) {
            if (!id.includes("node_modules")) return undefined;
            if (id.includes("/react/") || id.includes("/react-dom/") || id.includes("/react-router/") || id.includes("/scheduler/") || id.includes("/use-sync-external-store/")) return "react";
            if (id.includes("/@trpc/") || id.includes("/@tanstack/")) return "data";
            if (id.includes("/lucide-react/")) return "icons";
            if (id.includes("/recharts/") || id.includes("/d3-")) return "charts";
            return "vendor";
          },
        },
      },
    },
    esbuild: { drop: process.env.NODE_ENV === "production" ? ["console", "debugger"] : [], legalComments: "none" },
  });
}
