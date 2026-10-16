import type { Request, Response, Router } from "express";
import express from "express";
import { resolveSession } from "../auth/session.js";
import { consumeInvoiceDownloadTicket } from "../services/invoiceDownloads.js";
import { getInvoiceByIdForDocument } from "../services/invoices.js";
import { invoicePdfFileName, renderInvoicePdf } from "../services/invoicePdf.js";
import { recordSecurityEvent } from "../observability/audit.js";
import { singleRouteParam } from "./routeParam.js";

function attachmentDisposition(filename: string): string {
  const safe = filename.replace(/[\r\n"\\/]/g, "_").slice(0, 190) || "ReadyPackets-Invoice.pdf";
  return `attachment; filename="${safe}"`;
}

/**
 * Generated invoices are never publicly addressable. A tRPC authorization check
 * creates a one-time ticket bound to the authenticated account; this endpoint
 * consumes it and emits a no-store PDF attachment.
 */
export function createInvoiceDownloadRouter(): Router {
  const router = express.Router();
  router.get("/download/:token", async (req: Request, res: Response) => {
    const token = singleRouteParam(req.params.token);
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
      res.status(400).type("text/plain").send("Invalid invoice download token");
      return;
    }
    const session = await resolveSession(req);
    if (!session || session.mfaPending || session.restricted) {
      res.status(401).type("text/plain").send("Authentication required");
      return;
    }
    const ticket = consumeInvoiceDownloadTicket(token);
    if (!ticket) {
      res.status(410).type("text/plain").send("This invoice link has expired");
      return;
    }
    if (ticket.userId !== session.user.id) {
      void recordSecurityEvent({
        eventType: "file.access_denied",
        outcome: "blocked",
        severity: "critical",
        message: "Invoice download ticket presented by a different account",
        userId: session.user.id,
        ipAddress: (res.locals.clientIp as string | undefined) ?? null,
      });
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }

    try {
      const invoice = await getInvoiceByIdForDocument(ticket.invoiceId);
      const pdf = renderInvoicePdf(invoice);
      res.status(200);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", attachmentDisposition(invoicePdfFileName(invoice)));
      res.setHeader("Content-Length", String(pdf.length));
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      res.setHeader("Pragma", "no-cache");
      res.end(pdf);
    } catch {
      res.status(404).type("text/plain").send("Invoice not found");
    }
  });
  return router;
}
