/**
 * Avatar upload and serve endpoints.
 *
 * POST /api/avatar — upload a new avatar (authenticated, image only, max 2 MB)
 * GET  /api/avatar/:userId — serve an avatar image (public, cached)
 *
 * Avatars are stored in the same local storage as other files, keyed under
 * `avatar/` prefix. The storage key is written to users.avatar_storage_key.
 */
import type { Request, Response, Router } from "express";
import express from "express";
import multer from "multer";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { resolveSession } from "../auth/session.js";
import { CSRF_COOKIE, CSRF_HEADER } from "../security/csrf.js";
import { constantTimeEqual } from "../security/crypto.js";
import { putObject, getObjectStream, objectExists, deleteObject, validateUpload } from "../services/storage.js";
import { recordActivity, recordSecurityEvent } from "../observability/audit.js";
import { logger } from "../observability/logger.js";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED_AVATAR_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

export function createAvatarRouter(): Router {
  const router = express.Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AVATAR_BYTES, files: 1, fields: 2, parts: 5 },
  });

  // ── POST /api/avatar ─────────────────────────────────────────────────────────
  router.post(
    "/",
    (req, res, next) => {
      upload.single("avatar")(req, res, (error: unknown) => {
        if (error instanceof multer.MulterError) {
          if (error.code === "LIMIT_FILE_SIZE") {
            res.status(413).json({ error: "Avatar must be 2 MB or smaller." });
            return;
          }
          res.status(400).json({ error: error.message });
          return;
        }
        if (error) {
          res.status(500).json({ error: "Upload failed." });
          return;
        }
        next();
      });
    },
    async (req: Request, res: Response) => {
      // Auth
      const session = await resolveSession(req);
      if (!session || session.mfaPending || session.restricted) {
        res.status(401).json({ error: "Authentication required." });
        return;
      }

      // CSRF
      const csrfCookie = req.cookies?.[CSRF_COOKIE] as string | undefined;
      const csrfHeader = req.headers[CSRF_HEADER.toLowerCase()] as string | undefined;
      if (!csrfCookie || !csrfHeader || !constantTimeEqual(csrfCookie, csrfHeader)) {
        res.status(403).json({ error: "CSRF validation failed." });
        return;
      }

      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        res.status(400).json({ error: "No file provided." });
        return;
      }

      // Validate image type
      const validation = await validateUpload(file.originalname, file.buffer, { maxBytes: MAX_AVATAR_BYTES });
      if (!validation.ok || !validation.extension || !ALLOWED_AVATAR_EXTS.has(validation.extension)) {
        void recordSecurityEvent({
          eventType: "file.access_denied",
          outcome: "blocked",
          severity: "warning",
          message: `Avatar upload rejected: ${validation.reason ?? "not an image"}`,
          userId: session.user.id,
          ipAddress: (res.locals.clientIp as string | undefined) ?? null,
        });
        res.status(400).json({ error: "Only JPEG, PNG, WebP, and GIF images are accepted." });
        return;
      }

      try {
        // Delete old avatar if present
        const existing = await db
          .select({ avatarStorageKey: users.avatarStorageKey })
          .from(users)
          .where(eq(users.id, session.user.id))
          .limit(1);
        const oldKey = existing[0]?.avatarStorageKey;
        if (oldKey) {
          await deleteObject(oldKey).catch(() => null);
        }

        // Store new avatar
        const stored = await putObject(file.buffer, validation.extension);
        await db
          .update(users)
          .set({ avatarStorageKey: stored.storageKey })
          .where(eq(users.id, session.user.id));

        void recordActivity({
          actorUserId: session.user.id,
          actorRole: session.user.role,
          action: "profile.avatar_upload",
          entityType: "user",
          entityId: session.user.id,
          summary: "User uploaded a new avatar",
          changes: { sizeBytes: stored.sizeBytes },
          ipAddress: (res.locals.clientIp as string | undefined) ?? null,
        });

        res.status(200).json({ ok: true, storageKey: stored.storageKey });
      } catch (error) {
        logger.error("Avatar upload failed", { error });
        res.status(500).json({ error: "Failed to store avatar." });
      }
    },
  );

  // ── GET /api/avatar/:userId ──────────────────────────────────────────────────
  router.get("/:userId", async (req: Request, res: Response) => {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId < 1) {
      res.status(400).json({ error: "Invalid user ID." });
      return;
    }

    const rows = await db
      .select({ avatarStorageKey: users.avatarStorageKey })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const key = rows[0]?.avatarStorageKey;

    if (!key) {
      res.status(404).json({ error: "No avatar." });
      return;
    }

    const exists = await objectExists(key);
    if (!exists) {
      res.status(404).json({ error: "Avatar not found." });
      return;
    }

    // Serve with caching — avatar changes invalidate via new storage key
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");

    // Derive content type from extension
    const ext = key.split(".").pop()?.toLowerCase() ?? "jpg";
    const mimeMap: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      gif: "image/gif",
    };
    res.setHeader("Content-Type", mimeMap[ext] ?? "image/jpeg");

    try {
      const stream = await getObjectStream(key);
      stream.pipe(res);
    } catch (error) {
      logger.error("Avatar serve failed", { error, key });
      res.status(500).json({ error: "Failed to serve avatar." });
    }
  });

  return router;
}
