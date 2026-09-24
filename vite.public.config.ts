import { defineConfig } from "vite";
import { createSplitViteConfig } from "./vite.split.config.js";

export default defineConfig(createSplitViteConfig("public.html", "dist-public"));
