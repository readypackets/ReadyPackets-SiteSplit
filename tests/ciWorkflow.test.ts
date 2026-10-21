import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryPath = (...segments: string[]) => resolve(process.cwd(), ...segments);

describe("GitHub Actions workflow safety", () => {
  it("keeps fixed-width CI encryption keys quoted so YAML cannot coerce them to numbers", () => {
    const workflow = readFileSync(repositoryPath(".github/workflows/portal-ci.yml"), "utf8");

    expect(workflow).toContain(
      'DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"',
    );
    expect(workflow).toContain(
      'EMAIL_INDEX_KEY: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"',
    );
  });

  it("lets pnpm/action-setup use the repository-integrity-pinned packageManager declaration", () => {
    for (const relativePath of [
      ".github/workflows/portal-ci.yml",
      ".github/workflows/native-mobile.yml",
    ]) {
      const workflow = readFileSync(repositoryPath(relativePath), "utf8");
      const setupBlocks = workflow.split("pnpm/action-setup@v4").slice(1);
      expect(setupBlocks.length, relativePath).toBeGreaterThan(0);

      for (const block of setupBlocks) {
        const nextStep = block.search(/\n\s*-\s+(?:name:\s+)?(?:uses:|run:)/);
        const step = nextStep < 0 ? block : block.slice(0, nextStep);
        expect(step, relativePath).not.toMatch(/\n\s*version\s*:/);
      }
    }
  });
});
