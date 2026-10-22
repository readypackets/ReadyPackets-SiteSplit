import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Cookie, Settings2, ShieldCheck, X } from "lucide-react";
import { csrfToken, refreshCsrfToken } from "@/lib/trpc";

type Preferences = {
  essential: true;
  preferences: boolean;
  analytics: boolean;
  marketing: boolean;
};

type ConsentConfig = {
  version: string;
  enabled: boolean;
  analyticsAvailable: boolean;
  marketingAvailable: boolean;
};

type ConsentPayload = {
  preferences: Preferences | null;
  version: string;
  config: ConsentConfig;
};

type ConsentContextValue = {
  preferences: Preferences | null;
  config: ConsentConfig | null;
  openPreferences: () => void;
};

const CookieConsentContext = createContext<ConsentContextValue | null>(null);

const COOKIE_PREFERENCE_SHORTCUT_HIDDEN_KEY = "rp-cookie-preference-shortcut-hidden";

function isCookiePreferenceShortcutHidden(): boolean {
  try {
    return window.sessionStorage.getItem(COOKIE_PREFERENCE_SHORTCUT_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

function hideCookiePreferenceShortcut(): void {
  try {
    window.sessionStorage.setItem(COOKIE_PREFERENCE_SHORTCUT_HIDDEN_KEY, "1");
  } catch {
    // Storage can be unavailable in restrictive privacy modes. Local state still hides the shortcut.
  }
}

function consentAction(preferences: Omit<Preferences, "essential">): "accepted_all" | "rejected_optional" | "saved_preferences" {
  if (preferences.preferences && preferences.analytics && preferences.marketing) return "accepted_all";
  if (!preferences.preferences && !preferences.analytics && !preferences.marketing) return "rejected_optional";
  return "saved_preferences";
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    ...init,
  });
  if (!response.ok) throw new Error("Unable to update cookie preferences. Please try again.");
  return response.json() as Promise<T>;
}

export function useCookieConsent(): ConsentContextValue {
  return useContext(CookieConsentContext) ?? {
    preferences: null,
    config: null,
    openPreferences: () => undefined,
  };
}

export function CookieConsentProvider({ children }: { children: ReactNode }) {
  const [payload, setPayload] = useState<ConsentPayload | null>(null);
  const [open, setOpen] = useState(false);
  const [customize, setCustomize] = useState(false);
  const [draft, setDraft] = useState<Omit<Preferences, "essential">>({ preferences: false, analytics: false, marketing: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shortcutHidden, setShortcutHidden] = useState(() => isCookiePreferenceShortcutHidden());

  useEffect(() => {
    void requestJson<ConsentPayload>("/api/privacy/consent")
      .then((next) => {
        setPayload(next);
        if (next.preferences) setDraft(next.preferences);
      })
      .catch(() => undefined);
  }, []);

  const openPreferences = useCallback(() => {
    if (payload?.config.enabled === false) return;
    setCustomize(true);
    setOpen(true);
    setError(null);
  }, [payload?.config.enabled]);

  const dismissShortcut = useCallback(() => {
    hideCookiePreferenceShortcut();
    setShortcutHidden(true);
  }, []);

  const save = useCallback(async (selection: Omit<Preferences, "essential">) => {
    setSaving(true);
    setError(null);
    try {
      let token = csrfToken();
      if (!token) token = await refreshCsrfToken();
      if (!token) throw new Error("Your security token expired. Reload the page and try again.");
      const action = consentAction(selection);
      const saved = await requestJson<{ preferences: Preferences; version: string }>("/api/privacy/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-rp-csrf": token },
        body: JSON.stringify({ ...selection, action }),
      });
      setPayload((current) => current ? { ...current, preferences: saved.preferences, version: saved.version } : current);
      setDraft(saved.preferences);
      // Optional analytics providers listen to this state transition so a
      // withdrawal made in the same page session immediately stops capture and
      // clears provider cookies where the provider supports it.
      window.dispatchEvent(new CustomEvent("rp:privacy-consent", { detail: saved.preferences }));
      setOpen(false);
      setCustomize(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to update cookie preferences.");
    } finally {
      setSaving(false);
    }
  }, []);

  const config = payload?.config ?? null;
  const showBanner = payload !== null && payload.config.enabled && payload.preferences === null;
  const context = useMemo(() => ({ preferences: payload?.preferences ?? null, config, openPreferences }), [payload?.preferences, config, openPreferences]);

  return (
    <CookieConsentContext.Provider value={context}>
      {children}
      {(showBanner || (open && config?.enabled)) && (
        <div className="fixed inset-0 z-[100] flex items-end bg-slate-950/20 p-3 backdrop-blur-[1px] sm:p-6" role="presentation">
          <section aria-modal="true" aria-labelledby="cookie-preferences-title" className="mx-auto w-full max-w-4xl rounded-2xl border-2 border-cyan-200/70 bg-slate-950 p-6 text-white shadow-[0_24px_80px_rgba(0,0,0,0.58)] ring-1 ring-cyan-300/30 sm:p-8" role="dialog">
            <div className="flex gap-4">
                  <div className="rounded-xl border border-cyan-200/40 bg-cyan-400/20 p-3 text-cyan-100"><Cookie className="h-7 w-7" aria-hidden="true" /></div>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 id="cookie-preferences-title" className="text-2xl font-bold tracking-tight text-white">Your privacy preferences</h2>
                    <p className="mt-2 text-base leading-7 text-slate-100">We use essential security cookies to operate ReadyPackets. Optional preferences, analytics, and marketing technologies remain off unless you choose them.</p>
                  </div>
                  {open && !showBanner && <button type="button" onClick={() => setOpen(false)} className="rounded-md p-1 text-[var(--muted-foreground)] hover:bg-white/10" aria-label="Close cookie preferences"><X className="h-5 w-5" /></button>}
                </div>

                {(customize || open) && (
                  <div className="mt-5 space-y-3">
                    <PreferenceRow title="Essential security" description="Required for sign-in, CSRF protection, secure checkout, and requested portal functions." checked disabled />
                    <PreferenceRow title="Preferences" description="Allows optional convenience settings, such as remembered visual preferences." checked={draft.preferences} onChange={(checked) => setDraft((current) => ({ ...current, preferences: checked }))} />
                    <PreferenceRow title="Analytics" description={config?.analyticsAvailable ? "Allows Microsoft Clarity measurement on anonymous sign-in, registration, verification, and recovery screens. Customer and administrator workspaces are excluded, and the Portal DOM remains masked." : "Not currently active. This category remains unavailable until an administrator enables an analytics integration."} checked={draft.analytics} disabled={!config?.analyticsAvailable} onChange={(checked) => setDraft((current) => ({ ...current, analytics: checked }))} />
                    <PreferenceRow title="Marketing" description={config?.marketingAvailable ? "Permits enabled campaign measurement or marketing technologies." : "Not currently active. This category remains unavailable until an administrator enables a marketing integration."} checked={draft.marketing} disabled={!config?.marketingAvailable} onChange={(checked) => setDraft((current) => ({ ...current, marketing: checked }))} />
                  </div>
                )}

                {error && <p className="mt-4 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-100" role="alert">{error}</p>}
                <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                  <a className="mr-auto self-center text-sm text-cyan-300 underline underline-offset-4" href="/privacy">Read the Privacy Policy</a>
                  <button type="button" onClick={() => void save({ preferences: false, analytics: false, marketing: false })} disabled={saving} className="rounded-lg border border-white/20 px-4 py-2.5 text-sm font-semibold text-[var(--foreground)] hover:bg-white/10 disabled:opacity-50">Reject optional</button>
                  <button type="button" onClick={() => void save(draft)} disabled={saving} className="rounded-lg border border-cyan-300/50 px-4 py-2.5 text-sm font-semibold text-cyan-200 hover:bg-cyan-500/10 disabled:opacity-50">Save choices</button>
                  <button type="button" onClick={() => void save({ preferences: true, analytics: config?.analyticsAvailable ?? false, marketing: config?.marketingAvailable ?? false })} disabled={saving} className="rounded-lg bg-cyan-400 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-cyan-300 disabled:opacity-50">Accept all available</button>
                </div>
              </div>
            </div>
          </section>
        </div>
      )}
      {payload?.preferences && config?.enabled && !open && !shortcutHidden && (
        <div className="fixed bottom-4 right-4 z-40 inline-flex items-center rounded-full border border-cyan-200/60 bg-slate-950 text-cyan-100 shadow-xl ring-1 ring-cyan-300/20">
          <button type="button" onClick={openPreferences} className="inline-flex items-center gap-2 rounded-l-full px-4 py-2.5 text-sm font-bold hover:bg-cyan-950" aria-label="Manage cookie preferences">
            <Settings2 className="h-4 w-4" /> Manage cookie preferences
          </button>
          <button type="button" onClick={dismissShortcut} className="mr-1 inline-flex h-8 w-8 items-center justify-center rounded-full text-cyan-100 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200" aria-label="Hide cookie preferences shortcut for this browser session" title="Hide for this browser session">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </CookieConsentContext.Provider>
  );
}

function PreferenceRow({ title, description, checked, disabled = false, onChange }: { title: string; description: string; checked: boolean; disabled?: boolean; onChange?: (checked: boolean) => void }) {
  return (
    <label className={`flex items-start gap-3 rounded-xl border p-3 ${disabled ? "border-white/10 bg-white/[0.03]" : "border-white/15 bg-white/[0.04]"}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange?.(event.target.checked)} className="mt-1 h-4 w-4 accent-cyan-400" />
      <span><span className="flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]">{title}{disabled && <ShieldCheck className="h-4 w-4 text-emerald-300" aria-label="Always enabled or unavailable" />}</span><span className="mt-1 block text-xs leading-5 text-[var(--muted-foreground)]">{description}</span></span>
    </label>
  );
}
