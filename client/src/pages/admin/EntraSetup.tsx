import { useEffect, useState } from "react";
import { ClipboardCopy, ExternalLink, ShieldCheck } from "lucide-react";
import { trpc, errorMessage } from "@/lib/trpc";
import { copyToClipboard } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { FieldShell, Input, Select, Textarea } from "@/components/ui/Field";
import { Alert, Card, CardHeader } from "@/components/ui/Surface";
import { PageHeader } from "@/components/layout/PortalLayout";
import { useToast } from "@/components/ui/Toast";

export function AdminEntraSetupPage() {
  const toast = useToast();
  const config = trpc.adminSecurity.samlConfig.useQuery();
  const utils = trpc.useUtils();
  const [name, setName] = useState("Microsoft Entra ID");
  const [entryPoint, setEntryPoint] = useState("");
  const [issuer, setIssuer] = useState("");
  const [certificate, setCertificate] = useState("");
  const [autoProvision, setAutoProvision] = useState(false);
  const [defaultRole, setDefaultRole] = useState<"customer" | "staff" | "admin">("staff");
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!config.data) return;
    setName(config.data.name);
    setEntryPoint(config.data.entryPoint);
    setIssuer(config.data.issuer);
    setAutoProvision(config.data.autoProvision);
    setDefaultRole((config.data.defaultRole === "admin" || config.data.defaultRole === "customer") ? config.data.defaultRole : "staff");
    setEnabled(config.data.enabled);
  }, [config.data]);

  const save = trpc.adminSecurity.upsertSamlConfig.useMutation({
    async onSuccess() {
      await utils.adminSecurity.samlConfig.invalidate();
      toast.success("Microsoft Entra ID configuration saved");
    },
    onError(error) {
      toast.error("Could not save Entra configuration", errorMessage(error));
    },
  });

  const acsUrl = config.data?.acsUrl ?? "";
  const metadataUrl = config.data?.metadataUrl ?? "";
  const signOnUrl = config.data?.signOnUrl ?? "";
  const copy = async (value: string) => {
    if (await copyToClipboard(value)) toast.success("Copied to clipboard");
    else toast.error("Clipboard unavailable", "Copy the displayed value manually.");
  };

  const portalValues = [
    { label: "Identifier (Entity ID)", value: metadataUrl },
    { label: "Reply URL (ACS)", value: acsUrl },
    { label: "Sign-on URL (ReadyPackets SP launch URL)", value: signOnUrl },
  ];

  return (
    <>
      <PageHeader
        title="Microsoft Entra ID setup"
        description="Configure Microsoft Entra single sign-on through SAML 2.0."
      />
      <Alert tone="info" className="mb-6" title="Use the values in their matching fields">
        In Entra, create a non-gallery SAML Enterprise Application. Step 1 values belong in Entra Basic SAML Configuration. Step 2 values come from Entra’s Set up application pane. The two sign-on URLs have different purposes.
      </Alert>
      <div className="grid gap-6 lg:grid-cols-[0.8fr_1.2fr]">
        <Card>
          <CardHeader
            title="Step 1 — Register ReadyPackets in Entra"
            description="Copy these exact Portal values into Entra Basic SAML Configuration. The Identifier must exactly match the SAML request issuer."
          />
          <div className="mt-5 space-y-4">
            {portalValues.map((item) => (
              <div key={item.label}>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">{item.label}</p>
                <div className="mt-1 flex gap-2">
                  <code className="min-w-0 flex-1 break-all rounded bg-surface-soft p-2 text-xs text-ink">{item.value}</code>
                  <Button size="sm" variant="outline" onClick={() => void copy(item.value)} leadingIcon={<ClipboardCopy className="size-4" aria-hidden="true" />}>
                    Copy
                  </Button>
                </div>
              </div>
            ))}
            <a className="inline-flex items-center gap-1 text-sm font-semibold text-teal-dark" href="https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/add-application-portal-setup-sso" target="_blank" rel="noreferrer">
              Open Entra SAML guidance <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Step 2 — Paste Microsoft Entra values"
            description="The certificate is stored securely and is not displayed after saving."
          />
          <div className="mt-5 space-y-4">
            <Input label="Configuration name" value={name} onChange={(event) => setName(event.target.value)} required />
            <Input
              label="Microsoft Entra Login URL (IdP SSO endpoint)"
              help="Copy Login URL from Entra’s Set up application pane. Do not paste the ReadyPackets Sign-on URL from Step 1 here."
              type="url"
              value={entryPoint}
              onChange={(event) => setEntryPoint(event.target.value)}
              placeholder="https://login.microsoftonline.com/.../saml2"
              required
            />
            <Input
              label="Microsoft Entra Identifier (IdP issuer)"
              help="Copy Microsoft Entra Identifier from Entra’s Set up application pane. This differs from the ReadyPackets Entity ID in Step 1."
              value={issuer}
              onChange={(event) => setIssuer(event.target.value)}
              placeholder="https://sts.windows.net/{tenant-id}/"
              required
            />
            <Textarea
              label="Base64 certificate"
              help={config.data?.certificatePresent ? "A certificate is already saved; leave empty unless replacing it." : "Download Certificate (Base64) from Entra SAML Certificates."}
              rows={7}
              value={certificate}
              onChange={(event) => setCertificate(event.target.value)}
              placeholder="-----BEGIN CERTIFICATE----- ..."
              required={!config.data?.certificatePresent}
            />
            <div className="grid gap-4 sm:grid-cols-3">
              <FieldShell label="Provisioning">
                <Select value={autoProvision ? "yes" : "no"} onChange={(event) => setAutoProvision(event.target.value === "yes")}>
                  <option value="no">Only matched accounts</option>
                  <option value="yes">Provision automatically</option>
                </Select>
              </FieldShell>
              <FieldShell label="New SAML user role" help="Applied only when automatic provisioning creates a new account.">
                <Select value={defaultRole} onChange={(event) => setDefaultRole(event.target.value as "customer" | "staff" | "admin")}>
                  <option value="customer">Customer</option>
                  <option value="staff">Staff</option>
                  <option value="admin">Administrator</option>
                </Select>
              </FieldShell>
              <FieldShell label="Activation">
                <Select value={enabled ? "enabled" : "disabled"} onChange={(event) => setEnabled(event.target.value === "enabled")}>
                  <option value="disabled">Save disabled until tested</option>
                  <option value="enabled">Enable Entra sign-in</option>
                </Select>
              </FieldShell>
            </div>
            <Alert tone="warning" title="Administrator provisioning">
              Choose Administrator only when the Entra assignment is restricted to trusted administrators. Existing local roles are not changed by this setting.
            </Alert>
            <div className="flex justify-end">
              <Button
                busy={save.isPending}
                disabled={!name || !entryPoint || !issuer || (!certificate && !config.data?.certificatePresent)}
                leadingIcon={<ShieldCheck className="size-4" aria-hidden="true" />}
                onClick={() => save.mutate({ name, entryPoint, issuer, idpCertificate: certificate || "preserved-certificate-placeholder", autoProvision, defaultRole, enabled })}
              >
                Save Entra configuration
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
