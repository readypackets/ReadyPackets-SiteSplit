import { StrictMode, useEffect, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { trpc, createTrpcClient, SESSION_INVALID_EVENT } from "@/lib/trpc";
import { SessionProvider, useSession } from "@/lib/session";
import { ThemeProvider } from "@/lib/theme";
import { ToastProvider } from "@/components/ui/Toast";
import { CookieConsentProvider } from "@/components/privacy/CookieConsent";
import { AnalyticsProvider } from "@/components/privacy/AnalyticsProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { PwaInstallPrompt, PwaUpdatePrompt } from "@/components/PwaPrompts";
import { PortalApp } from "@/PortalApp";
import "@/styles/index.css";

/** Clears in-memory account queries after the authoritative server session ends. */
function PortalSessionPrivacyBoundary({ children }: { children: ReactNode }) {
  const session = useSession();
  const client = useQueryClient();
  const wasAuthenticated = useRef(false);

  useEffect(() => {
    if (session.authenticated) {
      wasAuthenticated.current = true;
      return;
    }
    if (wasAuthenticated.current) {
      wasAuthenticated.current = false;
      client.clear();
    }
  }, [client, session.authenticated]);

  useEffect(() => {
    const clearForInvalidSession = () => {
      wasAuthenticated.current = false;
      client.clear();
    };
    window.addEventListener(SESSION_INVALID_EVENT, clearForInvalidSession);
    return () => window.removeEventListener(SESSION_INVALID_EVENT, clearForInvalidSession);
  }, [client]);

  return <>{children}</>;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: (failureCount, error) => !(error instanceof Error && (error.message.includes("UNAUTHORIZED") || error.message.includes("FORBIDDEN"))) && failureCount < 2, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});
const container = document.getElementById("root");
if (!container) throw new Error("Root container is missing from the document.");

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <trpc.Provider client={createTrpcClient()} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <CookieConsentProvider>
            <AnalyticsProvider />
            <ThemeProvider>
              <ToastProvider>
                <SessionProvider>
                  <PortalSessionPrivacyBoundary>
                    <PortalApp />
                    <PwaInstallPrompt />
                    <PwaUpdatePrompt />
                  </PortalSessionPrivacyBoundary>
                </SessionProvider>
              </ToastProvider>
            </ThemeProvider>
          </CookieConsentProvider>
        </QueryClientProvider>
      </trpc.Provider>
    </ErrorBoundary>
  </StrictMode>,
);
