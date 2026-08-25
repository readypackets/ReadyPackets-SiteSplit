# ReadyPackets Guided Fresh-VPS Installer

The ReadyPackets guided installer provisions a **fresh Ubuntu or Debian VPS** from the approved GitHub `main` source by default. It asks only for deployment values that cannot be safely inferred, displays a redacted configuration review, and does not change the server until the operator types the final confirmation phrase.

> The installer is intended for a fresh server. It refuses to overwrite an existing project directory. Before running it, point the public hostname you plan to use to the server and ensure SSH access is available.

## Start a guided installation

Log in to the fresh server as a sudo-capable user and run:

```bash
curl -fsSLO https://raw.githubusercontent.com/readypackets/ReadyPackets/main/deploy/one-click-install.sh \
  && chmod 0700 one-click-install.sh \
  && sudo ./one-click-install.sh
```

The script retrieves the selected `main` source only after you complete the final review. It prints the resolved commit SHA at completion, so the installed version can be recorded independently. For a private source repository, use the read-only GitHub deploy-key procedure in [Self-Hosted Installation Guide](SELF_HOSTED_INSTALLATION_GUIDE.md) rather than placing a personal token in a command.

## Guided prompt sequence

| Prompt group | Required? | What it controls |
|---|---:|---|
| Installation type | Yes | Native VPS, existing Docker, or Docker bootstrap. Native VPS is the recommended default. |
| Public website hostname | Yes | The hostname used for TLS, CSP/origin protection, sessions, email links, and the health check. |
| Website display name | Optional | Browser titles and public metadata; defaults to `ReadyPackets`. |
| TLS method | Yes | Let’s Encrypt, Cloudflare Origin CA, or explicitly confirmed HTTP-only mode. |
| Let’s Encrypt email | Conditional | Required only if Let’s Encrypt is selected. |
| Cloudflare Origin CA credentials | Conditional | Either a least-privilege zone-scoped API token for automated issuance, or root-only PEM certificate/key paths for a manual Origin CA installation. Secrets are collected through protected prompts and are not displayed. |
| Source repository | Optional | Defaults to `readypackets/ReadyPackets` and the latest `main` commit. Advanced operators can choose an approved source, branch, or reviewed 40-character commit SHA. |
| Configuration-vault recovery | Optional | Retrieves the newest encrypted backup from a private GitHub vault after receiving a fine-grained token and recovery passphrase through masked prompts. |
| Nightly local backup timer | Optional | Defaults to enabled on the native VPS path. |
| Initial administrator | Required on a new installation without vault recovery | Collects administrator email and full name, then either generates a one-time password or accepts a masked password over standard input. MFA remains mandatory after first sign-in. |
| Final review | Yes | Redacts secrets, summarizes choices, and requires `INSTALL READY PACKETS` before package installation or any configuration change. |

## Latest commit or a reviewed release

The guided installer uses the latest `main` commit by default. To install a reviewed immutable release instead, choose the advanced source option when prompted and provide the complete 40-character Git commit SHA.

## Fully unattended use

Automation systems can skip all prompts by providing the documented environment variables and the explicit confirmation value. For example:

```bash
sudo env \
  RP_DOMAIN='portal.example.com' \
  RP_EMAIL='operations@example.com' \
  RP_MODE='native' \
  RP_TLS_PROVIDER='letsencrypt' \
  RP_SITE_NAME='ReadyPackets' \
  RP_ADMIN_EMAIL='admin@example.com' \
  RP_ADMIN_NAME='Platform Administrator' \
  RP_ADMIN_GENERATE_PASSWORD='yes' \
  RP_AUTO_CONFIRM='INSTALL_READY_PACKETS' \
  bash one-click-install.sh
```

The generated initial administrator password is printed once to the secured terminal. Store it in an offline password manager immediately. Use `RP_ADMIN_PASSWORD` only in protected automation where exposure through the execution environment is understood and controlled; the guided flow never places a typed password in shell history or command-line arguments.

## Recovering a failed fresh installation

If a fresh installation stops before the service becomes active, first pull the corrected installer source, then run the installer again using the same domain and email. The guided resume mode recognizes the incomplete Git checkout, requires a second review, and refuses to run when an active ReadyPackets service is detected:

```bash
cd /srv/readypackets
sudo git pull --ff-only origin main
sudo env RP_RESUME_FAILED_INSTALL='yes' bash deploy/one-click-install.sh
```

The resume flow reuses the protected environment and database already created on the failed fresh server, fetches the latest selected source, rebuilds all operational bundles, and resumes setup. Do **not** use this option on a working portal; it is intentionally rejected if the service is active.

## Verification

After installation, verify the returned public health endpoint:

```bash
curl -fsS https://portal.example.com/api/health
```

For a native VPS, confirm the service, reverse proxy, and backup timer:

```bash
sudo systemctl status readypackets nginx mysql
sudo systemctl status readypackets-backup.timer
```

The installer’s progress output identifies the installed source commit and portal URL. Keep that commit value with the server’s operational records.
