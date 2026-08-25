# Temporary Public-Repository Installation

**Purpose:** Install ReadyPackets from a fresh VPS without a GitHub token or deploy key while the approved source repository is intentionally public.

> This procedure is for a short, controlled installation window only. A public repository must never contain production environment files, database exports, uploaded customer files, backup archives, private keys, deploy keys, API keys, Cloudflare tokens, Stripe secrets, Microsoft credentials, or encrypted configuration bundles.

## 1. Before making the repository public

Use an approved local checkout to inspect the exact commit you intend to install. Prefer a reviewed, immutable 40-character commit SHA rather than a moving branch tip.

```bash
cd /path/to/ReadyPackets
git status --short
git rev-parse HEAD
git log -1 --oneline
```

Confirm that `git status --short` is empty. Review every tracked file for sensitive material before changing repository visibility. The following check is a helpful indicator, not a substitute for a deliberate code review:

```bash
git grep -nEI 'github_pat_|ghp_|cfut_|BEGIN( [A-Z]+)? PRIVATE KEY|DATA_ENCRYPTION_KEY=.{16,}|EMAIL_INDEX_KEY=.{16,}|STRIPE_SECRET|CLIENT_SECRET' || true
```

If the command reports a real secret, revoke or rotate that secret and remove it from Git history before making the repository public. Do not rely on deleting a current file alone if the secret exists in an earlier public commit.

In GitHub, open **Repository → Settings → General → Danger Zone → Change repository visibility**, select **Make public**, and complete GitHub’s confirmation. Record the reviewed commit SHA before proceeding.

## 2. Prepare the fresh VPS

Provision Ubuntu 22.04 or 24.04 LTS with a public IP address. Create the portal hostname DNS record before starting. Permit only SSH administration, HTTP, and HTTPS from the Internet; leave ReadyPackets port `3000` and MySQL port `3306` private.

```bash
sudo apt-get update
sudo apt-get install -y curl ca-certificates git
```

## 3. Start the token-free guided installer

The public bootstrap script intentionally uses anonymous HTTPS source retrieval. It now performs an explicit unauthenticated source-reachability check before downloading the repository. If the repository is private or the branch is unavailable, the installer stops before changing the platform configuration.

```bash
curl -fsSLO https://raw.githubusercontent.com/readypackets/ReadyPackets/main/deploy/one-click-install.sh \
  && chmod 0700 one-click-install.sh \
  && sudo ./one-click-install.sh
```

At the terminal prompts, select **Native VPS** unless an existing Docker environment is intentional. Enter the portal hostname, display name, TLS model, nightly-backup preference, and initial administrator information. When asked for a source, keep `readypackets/ReadyPackets` or provide the approved temporary-public fork. When asked for an optional reviewed commit SHA, paste the full 40-character SHA recorded in step 1.

| TLS choice | Appropriate use |
|---|---|
| **Let’s Encrypt** | DNS resolves directly to the VPS, or the proxy permits HTTP-01 validation. Provide a contact email. |
| **Cloudflare Origin CA — automatic** | Cloudflare proxy is enabled and SSL/TLS mode is **Full (strict)**. Provide only a zone-scoped API token with **Zone → SSL and Certificates → Edit** during the masked terminal prompt. |
| **Cloudflare Origin CA — existing PEM** | An approved Origin CA certificate and private key already exist in root-only files. |
| **HTTP only** | Non-production troubleshooting only. It requires an explicit typed confirmation and must not be used for public launch. |

The final review displays the repository, branch, optional immutable commit, certificate choice, administrator account, and backup setting. It does not display secret values. Type `INSTALL READY PACKETS` only after confirming those values.

## 4. Make the repository private again

Wait until the installer has printed the installed source commit and the completed local readiness result. The application is already copied and built on the VPS; changing GitHub visibility afterward does not interrupt the running portal.

Return to **Repository → Settings → General → Danger Zone** in GitHub and change the repository back to **Private**. The source checkout on the VPS remains usable for the installed version, but any future source pull requires the private-repository deploy-key method described in [Self-Hosted Installation Guide](SELF_HOSTED_INSTALLATION_GUIDE.md).

If Cloudflare API credentials were used only for one-time Origin CA issuance, revoke the token after certificate verification unless a documented renewal automation process needs it.

## 5. Verify the completed portal

```bash
sudo systemctl status readypackets nginx mysql --no-pager
sudo systemctl is-enabled readypackets readypackets-backup.timer
sudo nginx -t
curl -fsS https://portal.example.com/api/health
curl -fsS https://portal.example.com/api/health/ready
```

The health endpoints should report `{"status":"ok"}` and `{"status":"ready"}`. Complete initial administrator MFA enrollment, save recovery codes, configure external integrations, create a full backup, and perform an isolated restore drill before inviting customers.

## 6. Security boundary and limitations

Public source access removes the need for a GitHub credential **only to retrieve the source**. It does not remove the need to protect the VPS, Cloudflare configuration, backup archives, application secrets, or production data. The installer generates ReadyPackets application encryption keys locally and writes them to the root-protected `/etc/readypackets/portal.env`; they are not drawn from GitHub.

A temporary public repository is not an appropriate recovery method for a private production configuration. Use the protected full-backup and replacement-server procedure in [Full Backup Restore](FULL_BACKUP_RESTORE.md) when migrating users, order files, settings, encryption keys, and integration secrets.

## References

[1]: https://docs.github.com/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility "GitHub: Setting repository visibility"
[2]: https://docs.github.com/authentication/connecting-to-github-with-ssh/managing-deploy-keys "GitHub: Managing deploy keys"
[3]: https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/ "Cloudflare Origin CA"
[4]: https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/ "Cloudflare Full (strict)"
