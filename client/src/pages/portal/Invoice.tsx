import { useParams } from "wouter";
import { BadgeCheck, Download, FileText, Printer, ShieldCheck } from "lucide-react";
import { trpc, errorMessage } from "@/lib/trpc";
import { Button, LinkButton } from "@/components/ui/Button";
import { Alert, Card, CardHeader, EmptyState, Skeleton } from "@/components/ui/Surface";
import { PageHeader } from "@/components/layout/PortalLayout";
import { formatDate } from "@/lib/utils";
import { formatCents } from "@shared/domain";

export function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const orderId = Number(id);
  const validOrderId = Number.isInteger(orderId) && orderId > 0;
  const invoiceQuery = trpc.invoices.getForOrder.useQuery({ orderId }, { enabled: validOrderId });
  const invoice = invoiceQuery.data;
  const print = () => { window.print(); };
  const downloadPdf = trpc.invoices.requestPdfDownload.useMutation({
    onSuccess(result) { window.open(result.url, "_blank", "noopener,noreferrer"); },
  });

  if (!validOrderId) return <EmptyState icon={FileText} title="Invoice unavailable" description="The requested order reference is invalid." action={<LinkButton href="/portal/orders" variant="outline">Back to my orders</LinkButton>} />;
  if (invoiceQuery.isLoading) return <><PageHeader title="Order invoice" description="Loading your confirmed paid-order invoice." breadcrumb={{ href: `/portal/orders/${orderId}`, label: "Back to order" }} /><Skeleton className="h-[38rem] w-full" /></>;
  if (invoiceQuery.error || !invoice) return <><PageHeader title="Order invoice" description="View the branded receipt for a confirmed paid order." breadcrumb={{ href: `/portal/orders/${orderId}`, label: "Back to order" }} /><Card className="max-w-2xl"><CardHeader title="Invoice unavailable" description={invoiceQuery.error ? errorMessage(invoiceQuery.error) : "The invoice is not available for this order."} /><LinkButton className="mt-5" href={`/portal/orders/${orderId}`} variant="outline">Back to order</LinkButton></Card></>;

  return <>
    <PageHeader title="Order invoice" description="A confirmed, customer-visible record of your ReadyPackets payment." breadcrumb={{ href: `/portal/orders/${orderId}`, label: "Back to order" }} actions={<div className="flex flex-wrap gap-2"><Button variant="outline" leadingIcon={<Download className="size-4" />} busy={downloadPdf.isPending} onClick={() => downloadPdf.mutate({ orderId })}>Download PDF</Button><Button variant="outline" leadingIcon={<Printer className="size-4" />} onClick={print}>Print</Button></div>} />
    <div className="mx-auto max-w-4xl print:max-w-none">
      <Alert tone="info" className="mb-5 print:hidden"><strong>Payment confirmed.</strong> This branded PDF invoice is saved with your order and is the same evidence document included with the invoice email.</Alert>
      <article className="invoice-paper rounded-xl border border-line bg-white p-8 shadow-sm print:border-0 print:p-0 print:shadow-none">
        <header className="flex flex-wrap items-start justify-between gap-8 border-b-4 border-brand-gold pb-7">
          <div><img src={invoice.brand.logoPath} alt="ReadyPackets" className="h-14 w-auto" /><p className="mt-3 text-sm text-body">Business readiness, packaged with clarity.</p><a className="mt-1 block text-sm text-teal-dark" href={invoice.brand.supportUrl}>{invoice.brand.supportUrl}</a></div>
          <div className="text-right"><p className="text-3xl font-bold tracking-wide text-brand-navy">INVOICE</p><p className="mt-2 font-mono text-sm font-semibold text-brand-navy">{invoice.invoiceNumber}</p><p className="mt-1 text-sm text-body">Issued {formatDate(invoice.issuedAt)}</p><p className="mt-1 text-sm text-success">Payment confirmed{invoice.paidAt ? ` · ${formatDate(invoice.paidAt)}` : ""}</p></div>
        </header>
        <section className="mt-7 grid gap-3 sm:grid-cols-2 print:hidden" aria-label="Invoice status">
          <div className="rounded-lg border border-teal/30 bg-teal/5 p-4"><div className="flex items-center gap-2 text-teal-dark"><BadgeCheck className="size-5" aria-hidden="true" /><p className="font-semibold">Payment recorded</p></div><p className="mt-1 text-sm text-body">The Portal confirmed this payment and made the invoice visible to your account.</p></div>
          <div className="rounded-lg border border-line bg-surface p-4"><div className="flex items-center gap-2 text-brand-navy"><ShieldCheck className="size-5" aria-hidden="true" /><p className="font-semibold">Protected account record</p></div><p className="mt-1 text-sm text-body">Use the invoice number and order reference when you contact support about this purchase.</p></div>
        </section>
        <section className="mt-7 grid gap-6 sm:grid-cols-2">
          <div><p className="text-xs font-semibold uppercase tracking-wide text-muted">Bill to</p><p className="mt-2 text-base font-semibold text-ink">{invoice.customer.firstName ?? ""} {invoice.customer.lastName ?? ""}</p>{invoice.customer.company ? <p className="text-sm text-body">{invoice.customer.company}</p> : null}<p className="mt-1 font-mono text-xs text-muted">Customer ID: {invoice.customer.publicId}</p></div>
          <div className="sm:text-right"><p className="text-xs font-semibold uppercase tracking-wide text-muted">Order reference</p><p className="mt-2 font-mono text-base font-semibold text-ink">{invoice.orderNumber}</p><p className="mt-1 text-xs text-body">{invoice.orderOriginLabel}</p>{invoice.paymentReference ? <p className="mt-1 text-xs text-muted">Payment reference: {invoice.paymentReference}</p> : null}</div>
        </section>
        <section className="mt-8 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-y border-brand-navy bg-brand-navy text-white"><th className="px-3 py-3">Product purchased</th><th className="px-3 py-3 text-right">Qty.</th><th className="px-3 py-3 text-right">Unit price</th><th className="px-3 py-3 text-right">Product total</th></tr></thead><tbody className="divide-y divide-line">{invoice.lines.map((line: { description: string; quantity: number; unitPriceCents: number; lineTotalCents: number }, index: number) => <tr key={`${line.description}-${index}`}><td className="px-3 py-3 text-ink">{line.description}</td><td className="px-3 py-3 text-right text-body">{line.quantity}</td><td className="px-3 py-3 text-right text-body">{formatCents(line.unitPriceCents)}</td><td className="px-3 py-3 text-right font-medium text-ink">{formatCents(line.lineTotalCents)}</td></tr>)}</tbody></table></section>
        <section className="ml-auto mt-7 max-w-sm space-y-2 text-sm"><div className="flex justify-between"><span className="text-body">Catalog product value</span><span>{formatCents(invoice.productValueCents)}</span></div>{invoice.pricingAdjustmentCents > 0 ? <div className="flex justify-between text-success"><span>Pricing / bundle adjustment</span><span>−{formatCents(invoice.pricingAdjustmentCents)}</span></div> : null}{invoice.discountCents > 0 ? <div className="flex justify-between text-success"><span>Discount{invoice.discount?.code ? ` (${invoice.discount.code})` : ""}</span><span>−{formatCents(invoice.discountCents)}</span></div> : null}<div className="flex justify-between border-t border-line pt-3 font-semibold text-ink"><span>Order amount due</span><span>{formatCents(invoice.totalCents)}</span></div><div className="flex justify-between border-t-2 border-brand-navy pt-3 text-lg font-bold text-brand-navy"><span>Actual customer payment</span><span>{formatCents(invoice.actualCustomerPaidCents)}</span></div></section>
        <section className="mt-7 rounded-lg border border-teal/30 bg-teal/5 p-4 text-sm"><p className="font-semibold text-teal-dark">Payment and order evidence</p><p className="mt-1 text-body">{invoice.paymentEvidenceLabel}</p></section>
        <footer className="mt-10 border-t border-line pt-5 text-xs text-muted">Thank you for choosing ReadyPackets. This invoice documents product value, applied discounts, order origin, and actual customer payment evidence for the order reference above.</footer>
      </article>
    </div>
  </>;
}
