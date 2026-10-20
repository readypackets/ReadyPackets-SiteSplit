import { Link } from "wouter";
import { Compass } from "lucide-react";
import { marketingSiteUrl } from "@/lib/marketing";

/** A portal-only fallback; public marketing content is never rendered here. */
export function PortalNotFoundPage() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-lg items-center px-4 py-16 text-center">
      <div className="w-full">
        <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-teal/10 text-teal-dark">
          <Compass className="size-7" aria-hidden="true" />
        </span>
        <p className="mt-6 text-6xl font-bold tabular-nums text-teal/25">404</p>
        <h1 className="mt-4 text-2xl font-semibold text-ink">This address is not part of the portal</h1>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-body">
          ReadyPackets account, support, and administration pages are available on this site. Sign in to continue, or visit the ReadyPackets website for general information.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link
            href="/login"
            className="inline-flex h-11 items-center justify-center rounded-lg bg-teal px-4 text-sm font-semibold text-white no-underline shadow-sm transition-colors hover:bg-teal-dark"
          >
            Sign in
          </Link>
          <a
            href={marketingSiteUrl()}
            className="inline-flex h-11 items-center justify-center rounded-lg border border-line bg-white px-4 text-sm font-semibold text-ink no-underline transition-colors hover:border-teal hover:text-teal-dark"
          >
            Visit ReadyPackets website
          </a>
        </div>
      </div>
    </div>
  );
}
