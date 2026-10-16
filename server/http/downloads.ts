/**
 * File download endpoint.
 *
 * A download is only reachable with a single-use ticket that was issued after an
 * ownership check in the tRPC layer, and the ticket is bound to the requesting
 * user, so a stolen URL cannot be replayed from another session. Every response
 * is sent as an attachment with `nosniff`, which prevents a stored SVG or HTML
 * payload from executing in the origin.
 */
import type { Request, Response, Router } from "express";
import express from "express";
import * as archiverModule from "archiver";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { files } from "../db/schema.js";
import { resolveSession } from "../auth/session.js";
import { authoriseFileAccess, consumeDownloadTicket, getAudioPlaybackTicket, logFileAccess } from "../routers/files.js";
import { contentDisposition, getObjectStream, objectExists } from "../services/storage.js";
import { logger } from "../observability/logger.js";
import { recordSecurityEvent } from "../observability/audit.js";
import { singleRouteParam } from "./routeParam.js";

/**
 * Archiver 8 is native ESM and exports `ZipArchive`; the installed community
 * declaration package currently models the pre-8 factory API. Keep the narrow
 * bridge here rather than falling back to the vulnerable legacy package.
 */
interface ZipArchiveInstance {
  on(event: "warning" | "error", listener: (error: Error) => void): this;
  pipe(destination: NodeJS.WritableStream): NodeJS.WritableStream;
  append(source: NodeJS.ReadableStream | Buffer | string, data?: { name: string }): this;
  finalize(): Promise<void>;
}

const ZipArchive = (archiverModule as unknown as {
  ZipArchive: new (options?: { zlib?: { level?: number } }) => ZipArchiveInstance;
}).ZipArchive;

export function createDownloadRouter(): Router {
  const router = express.Router();

  router.get("/audio/:token", async (req: Request, res: Response) => {
    const token = singleRouteParam(req.params.token);
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
      res.status(400).type("text/plain").send("Invalid audio token");
      return;
    }
    const session = await resolveSession(req);
    if (!session || session.mfaPending || session.restricted) {
      res.status(401).type("text/plain").send("Authentication required");
      return;
    }
    const ticket = getAudioPlaybackTicket(token);
    if (!ticket) {
      res.status(410).type("text/plain").send("This audio link has expired");
      return;
    }
    if (ticket.userId !== session.user.id) {
      void recordSecurityEvent({ eventType: "file.access_denied", outcome: "blocked", severity: "critical", message: "Audio playback ticket presented by a different account", userId: session.user.id, ipAddress: (res.locals.clientIp as string | undefined) ?? null });
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }
    const authorised = await authoriseFileAccess([ticket.fileId], session.user.id, session.user.role);
    const file = authorised[0];
    if (!file || !file.detectedMime.startsWith("audio/") || !(await objectExists(file.storageKey))) {
      await logFileAccess(ticket.fileId, session.user.id, "audio_playback", (res.locals.clientIp as string | undefined) ?? null, "denied");
      res.status(404).type("text/plain").send("Audio recording not found");
      return;
    }
    const sizeRow = await db.select({ sizeBytes: files.sizeBytes }).from(files).where(and(eq(files.id, file.id), isNull(files.deletedAt))).limit(1);
    const size = sizeRow[0]?.sizeBytes ?? 0;
    if (size <= 0) {
      res.status(404).type("text/plain").send("Audio recording not found");
      return;
    }
    const range = req.headers.range;
    let start = 0;
    let end = size - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
        return;
      }
      start = match[1] ? Number(match[1]) : 0;
      end = match[2] ? Number(match[2]) : size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
        res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
        return;
      }
      end = Math.min(end, size - 1);
    }
    const contentLength = end - start + 1;
    res.status(range ? 206 : 200);
    res.setHeader("Content-Type", file.detectedMime);
    res.setHeader("Content-Disposition", `inline; filename=\"audio-${file.id}\"`);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", String(contentLength));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    void logFileAccess(ticket.fileId, session.user.id, "audio_playback", (res.locals.clientIp as string | undefined) ?? null);
    const stream = await getObjectStream(file.storageKey, { start, end });
    stream.on("error", (error) => {
      logger.error("Audio playback stream failed", { error, fileId: file.id });
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    stream.pipe(res);
  });

  router.get("/download/:token", async (req: Request, res: Response) => {
    const token = singleRouteParam(req.params.token);
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
      res.status(400).type("text/plain").send("Invalid download token");
      return;
    }

    const session = await resolveSession(req);
    if (!session || session.mfaPending || session.restricted) {
      res.status(401).type("text/plain").send("Authentication required");
      return;
    }

    const ticket = consumeDownloadTicket(token);
    if (!ticket) {
      res.status(410).type("text/plain").send("This download link has expired");
      return;
    }

    // A ticket issued to another account must never be honoured.
    if (ticket.userId !== session.user.id) {
      void recordSecurityEvent({
        eventType: "file.access_denied",
        outcome: "blocked",
        severity: "critical",
        message: "Download ticket presented by a different account",
        userId: session.user.id,
        ipAddress: (res.locals.clientIp as string | undefined) ?? null,
      });
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }

    const rows = await db
      .select({
        id: files.id,
        storageKey: files.storageKey,
        originalName: files.originalName,
        detectedMime: files.detectedMime,
        sizeBytes: files.sizeBytes,
        isPlaceholder: files.isPlaceholder,
      })
      .from(files)
      .where(and(inArray(files.id, ticket.fileIds), isNull(files.deletedAt)));

    const deliverable = rows.filter((row) => !row.isPlaceholder);
    if (deliverable.length === 0) {
      res.status(404).type("text/plain").send("File not found");
      return;
    }

    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");

    // Single file: stream it directly.
    if (deliverable.length === 1 && !ticket.archiveName) {
      const file = deliverable[0]!;
      if (!(await objectExists(file.storageKey))) {
        logger.error("Stored object missing for file record", { fileId: file.id });
        res.status(404).type("text/plain").send("File not found");
        return;
      }

      // Always an attachment: never render user-supplied content in the origin.
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", contentDisposition(file.originalName));
      res.setHeader("Content-Length", String(file.sizeBytes));

      void logFileAccess(
        file.id,
        session.user.id,
        "download",
        (res.locals.clientIp as string | undefined) ?? null,
      );

      const stream = await getObjectStream(file.storageKey);
      stream.on("error", (error) => {
        logger.error("Download stream failed", { error, fileId: file.id });
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
      });
      stream.pipe(res);
      return;
    }

    // Multiple files: build a ZIP on the fly, without buffering it in memory.
    const archiveName = ticket.archiveName ?? "readypackets-files.zip";
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", contentDisposition(archiveName));

    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on("warning", (error) => {
      logger.warn("Archive warning during bulk download", { error });
    });
    archive.on("error", (error) => {
      logger.error("Archive failed during bulk download", { error });
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });

    archive.pipe(res);

    const usedNames = new Set<string>();
    for (const file of deliverable) {
      if (!(await objectExists(file.storageKey))) continue;
      // Disambiguate duplicate names so entries are not silently overwritten.
      let entryName = file.originalName.replace(/[/\\]/g, "_");
      if (usedNames.has(entryName)) {
        const dot = entryName.lastIndexOf(".");
        const base = dot > 0 ? entryName.slice(0, dot) : entryName;
        const ext = dot > 0 ? entryName.slice(dot) : "";
        entryName = `${base}-${file.id}${ext}`;
      }
      usedNames.add(entryName);
      archive.append(await getObjectStream(file.storageKey), { name: entryName });
      void logFileAccess(
        file.id,
        session.user.id,
        "bulk_download",
        (res.locals.clientIp as string | undefined) ?? null,
      );
    }

    await archive.finalize();
  });

  return router;
}
