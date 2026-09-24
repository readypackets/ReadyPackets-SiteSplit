import { useMemo, useState } from "react";
import { HelpCircle, Search } from "lucide-react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Input } from "@/components/ui/Field";
import { Card, EmptyState, Skeleton } from "@/components/ui/Surface";
import { PageSection } from "@/components/layout/PublicLayout";

type Faq = {
  id: number;
  question: string;
  answerMarkdown: string;
  category: string | null;
  sortOrder: number;
  updatedAt: Date | string;
};

/** Public, selectively published FAQ content. Native details/summary provides
 * keyboard-operable, screen-reader-announced disclosure without a custom state
 * model or ARIA synchronisation risk. */
export function FaqPage() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const faqs = trpc.faqs.visible.useQuery(category ? { category } : undefined);

  const categories = useMemo(
    () => Array.from(new Set((faqs.data ?? []).map((faq) => faq.category).filter((value): value is string => Boolean(value)))).sort(),
    [faqs.data],
  );
  const visible = useMemo(() => {
    const phrase = query.trim().toLocaleLowerCase();
    if (!phrase) return faqs.data as Faq[] | undefined;
    return (faqs.data as Faq[] | undefined)?.filter((faq) => `${faq.question} ${faq.answerMarkdown} ${faq.category ?? ""}`.toLocaleLowerCase().includes(phrase));
  }, [faqs.data, query]);

  return (
    <>
      <section className="border-b border-line bg-surface-soft py-14 sm:py-20">
        <PageSection width="narrow">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-teal">Support centre</p>
          <h1 className="mt-3 font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">Frequently asked questions</h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-body">Clear answers about ReadyPackets, orders, account access, collaboration, and payment. If you need help with a specific order, our team is ready to assist.</p>
        </PageSection>
      </section>

      <PageSection width="narrow" className="py-10 sm:py-14">
        <div className="space-y-6">
          <Card className="p-4 sm:p-5">
            <Input
              label="Search frequently asked questions"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Try “payment”, “order”, or “account”"
              leadingIcon={<Search className="size-4" aria-hidden="true" />}
            />
            {categories.length ? (
              <div className="mt-4 flex flex-wrap gap-2" aria-label="FAQ categories">
                <button type="button" onClick={() => setCategory(null)} aria-pressed={category === null} className={`min-h-11 rounded-full border px-4 text-sm font-medium transition-colors ${category === null ? "border-teal bg-teal text-white" : "border-line bg-white text-body hover:border-teal hover:text-teal"}`}>All topics</button>
                {categories.map((item) => <button key={item} type="button" onClick={() => setCategory(item)} aria-pressed={category === item} className={`min-h-11 rounded-full border px-4 text-sm font-medium transition-colors ${category === item ? "border-teal bg-teal text-white" : "border-line bg-white text-body hover:border-teal hover:text-teal"}`}>{item}</button>)}
              </div>
            ) : null}
          </Card>

          {faqs.isLoading ? <div className="space-y-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div> : null}
          {!faqs.isLoading && (visible?.length ?? 0) > 0 ? (
            <div className="space-y-3">
              {(visible ?? []).map((faq) => (
                <Card key={faq.id} className="overflow-hidden p-0">
                  <details className="group">
                    <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-left text-base font-semibold text-ink marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal sm:px-6">
                      <span>{faq.question}</span>
                      <span className="shrink-0 text-xl leading-none text-teal transition-transform group-open:rotate-45" aria-hidden="true">+</span>
                    </summary>
                    <div className="border-t border-line px-5 py-4 sm:px-6"><p className="whitespace-pre-wrap leading-7 text-body">{faq.answerMarkdown}</p></div>
                  </details>
                </Card>
              ))}
            </div>
          ) : null}
          {!faqs.isLoading && (visible?.length ?? 0) === 0 ? <EmptyState icon={HelpCircle} title={query ? "No matching questions" : "No published questions yet"} description={query ? "Try a broader search term or choose another topic." : "Please check back shortly, or contact our team for assistance."} /> : null}

          <Card className="border-teal/20 bg-teal/5 p-6">
            <h2 className="text-lg font-semibold text-ink">Still need help?</h2>
            <p className="mt-2 text-sm leading-6 text-body">Use the contact page for general questions. Customers can sign in to open a support ticket and receive order-specific assistance.</p>
            <div className="mt-4 flex flex-wrap gap-4 text-sm font-semibold"><Link href="/contact" className="text-teal underline underline-offset-4">Contact ReadyPackets</Link><a href="/login" className="text-teal underline underline-offset-4">Sign in to the portal</a></div>
          </Card>
        </div>
      </PageSection>
    </>
  );
}
