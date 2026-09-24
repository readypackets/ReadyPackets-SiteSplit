import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { trpc, createTrpcClient } from "@/lib/trpc";
import { SessionProvider } from "@/lib/session";
import { ThemeProvider } from "@/lib/theme";
import { ToastProvider } from "@/components/ui/Toast";
import { CookieConsentProvider } from "@/components/privacy/CookieConsent";
import { AnalyticsProvider } from "@/components/privacy/AnalyticsProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { MarketingApp } from "@/MarketingApp";
import "@/styles/index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: (failureCount, error) => !(error instanceof Error && (error.message.includes("UNAUTHORIZED") || error.message.includes("FORBIDDEN"))) && failureCount < 2, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});
const container = document.getElementById("root");
if (!container) throw new Error("Root container is missing from the document.");

createRoot(container).render(
  <StrictMode><ErrorBoundary><trpc.Provider client={createTrpcClient()} queryClient={queryClient}><QueryClientProvider client={queryClient}><CookieConsentProvider><AnalyticsProvider /><ThemeProvider><ToastProvider><SessionProvider><MarketingApp /></SessionProvider></ToastProvider></ThemeProvider></CookieConsentProvider></QueryClientProvider></trpc.Provider></ErrorBoundary></StrictMode>,
);
