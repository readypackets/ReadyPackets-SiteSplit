import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";

describe("Express 5 startup compatibility", () => {
  it("constructs the complete application without path-to-regexp startup errors", () => {
    expect(() => createApp()).not.toThrow();
  });

  it("uses a named brace catch-all for the GET-only SPA fallback", () => {
    const source = readFileSync(resolve(process.cwd(), "server/app.ts"), "utf8");
    expect(source).toContain('app.get("/{*splat}", async (req: Request, res: Response) => {');
    expect(source).not.toContain('app.get("*", async (req: Request, res: Response) => {');
  });
});
