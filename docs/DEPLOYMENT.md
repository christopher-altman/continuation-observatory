# Deployment Roadmap

This repo now has two different deployable surfaces:

1. The live observatory app: FastAPI + WebSockets + scheduler + SQLite state.
2. The static mirror: `scripts/build_site.py` output deployed through GitHub Pages.

Do not treat them as the same thing. GitHub Pages can host the static mirror. It cannot host the live observatory runtime.

## Recommended Production Topology

Recommended setup for this codebase:

- GitHub repository for source control and CI
- Cloudflare for DNS and TLS edge
- one small Ubuntu VPS for the live observatory app
- Caddy on the VPS for HTTPS and reverse proxy
- systemd services for:
  - the FastAPI app
  - the scheduler daemon
- SQLite on a persistent disk path on that VPS
- optional GitHub Pages deployment for the static mirror only

This is the best fit for the current architecture because:

- the app uses SQLite as its canonical live store
- the scheduler and API both need access to the same DB file
- the app serves live HTTP routes plus WebSockets

Trying to force the live app onto GitHub Pages, Netlify, or a stateless serverless host is the wrong shape for this system.

## Domain Strategy

Recommended domain layout:

- `christopheraltman.com` and `www.christopheraltman.com`
  - keep these for your portfolio or personal homepage
- `continuationobservatory.org`
  - use this now for the live UCIP observatory app
- `ucip-observatory.ai` and `www.ucip-observatory.ai`
  - use a neutral dedicated domain if you later want a standalone host for the live observatory app

Optional static mirror:

- `research.christopheraltman.com` or `archive.ucip-observatory.ai`
  - use one of these for the GitHub Pages static build if you want a public archive

Important:

- the current GitHub Pages build script writes a `CNAME` for `continuationobservatory.org`
- do not point GitHub Pages and the live VPS app at the same hostname at the same time
- if you keep the static mirror, move it to a different hostname before enabling Pages for it

## Information You Must Fill In

### Server choices

- VPS provider:
- VPS region:
- VPS IP address:
- Linux user for deployment: `observatory` recommended
- repo checkout path: `/opt/continuation-observatory/app` recommended
- data path: `/opt/continuation-observatory/data/observatory.db` recommended

### Live hostnames

- primary live hostname now:
- future dedicated hostname:
- optional static mirror hostname:

### CORS origins

Set `CORS_ALLOWED_ORIGINS` to the exact HTTPS origins that should call the API.

Example:

```env
CORS_ALLOWED_ORIGINS=https://continuationobservatory.org,https://ucip-observatory.ai,https://www.ucip-observatory.ai
```

### Admin secret

Fill these before launch:

```env
ADMIN_API_KEY=<generate-a-random-secret>
ADMIN_HEADER_NAME=x-admin-key
```

Generate a strong secret with one of:

```bash
python - <<'PY'
import secrets
print(secrets.token_urlsafe(48))
PY
```

```bash
openssl rand -base64 48
```

## Provider Credentials

These keys belong in the server environment file or a host secret manager. Do not commit them to Git.

Current enabled models in `config/models.yaml` require:

| Env var | Used for |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude Opus 4.6, Claude Sonnet 4.6 |
| `OPENAI_API_KEY` | GPT-5, o3 |
| `GOOGLE_API_KEY` | Gemini 2.5 Pro, Gemini 2.5 Flash |
| `DEEPSEEK_API_KEY` | DeepSeek R2 |
| `LLAMA_API_KEY` | Llama 4 Maverick |
| `MISTRAL_API_KEY` | Mistral Large 3 |
| `XAI_API_KEY` | Grok 3 |
| `DASHSCOPE_API_KEY` | Qwen 3 |
| `COHERE_API_KEY` | Command A |
| `AWS_BEARER_TOKEN_BEDROCK` | Only if you later enable Nova Premier |

Operational rule:

- if you do not want to pay for or configure a provider yet, disable its model entry in `config/models.yaml` before launching live mode

## Environment File

Use [.env.production.example](../.env.production.example) as the template for the server-side environment file.

Recommended live file location:

```text
/opt/continuation-observatory/.env.production
```

Do not copy this file into the repo checkout.

## Step-by-Step Launch Roadmap

### 1. Prepare GitHub

1. Push this repo to its production GitHub repository.
2. Confirm the default branch is `main`.
3. Decide whether GitHub Pages is:
   - disabled for this repo for now, or
   - reserved for a static mirror on a different hostname than the live app.
4. Add GitHub Actions deployment settings for the live server.

Repository secret required:

- `DEPLOY_SSH_PRIVATE_KEY`

Repository variables recommended:

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_SSH_PORT`
- `DEPLOY_APP_DIR`
- `DEPLOY_ENV_FILE`
- `DEPLOY_API_SERVICE`
- `DEPLOY_SCHEDULER_SERVICE`

These are consumed by:

- [.github/workflows/deploy-live.yml](../.github/workflows/deploy-live.yml)
- [deploy/remote_update.sh](../deploy/remote_update.sh)

### 2. Provision the live server

1. Create a small Ubuntu 24.04 VPS.
2. Open inbound ports `80` and `443`.
3. SSH into the machine.
4. Create the runtime user:

```bash
sudo useradd --system --create-home --shell /bin/bash observatory
sudo mkdir -p /opt/continuation-observatory/app
sudo mkdir -p /opt/continuation-observatory/data
sudo chown -R observatory:observatory /opt/continuation-observatory
```

### 3. Install runtime packages

```bash
sudo apt update
sudo apt install -y python3.11 python3.11-venv git caddy
```

### 4. Check out the app

```bash
sudo -u observatory git clone https://github.com/<your-org-or-user>/<your-repo>.git /opt/continuation-observatory/app
cd /opt/continuation-observatory/app
sudo -u observatory python3.11 -m venv .venv
sudo -u observatory .venv/bin/pip install --upgrade pip
sudo -u observatory .venv/bin/pip install -e .
```

### 5. Create the live environment file

1. Copy `.env.production.example` into `/opt/continuation-observatory/.env.production`.
2. Fill in:
   - `DRY_RUN=false`
   - `DB_URL`
   - `CORS_ALLOWED_ORIGINS`
   - `ADMIN_API_KEY`
   - all provider API keys for enabled models
3. Keep:
   - `ALLOW_LIVE_SQLITE=true`
   - `ALLOW_INSECURE_LIVE_CORS=false`

### 6. Initialize storage

```bash
cd /opt/continuation-observatory/app
sudo -u observatory env $(grep -v '^#' /opt/continuation-observatory/.env.production | xargs) .venv/bin/python -m observatory.storage.sqlite_backend
```

### 7. Install systemd services

1. Copy:
   - [deploy/continuation-observatory-api.service](../deploy/continuation-observatory-api.service)
   - [deploy/continuation-observatory-scheduler.service](../deploy/continuation-observatory-scheduler.service)
2. Place them in `/etc/systemd/system/`.
3. Reload and enable:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now continuation-observatory-api
sudo systemctl enable --now continuation-observatory-scheduler
```

4. Check health:

```bash
systemctl status continuation-observatory-api --no-pager
systemctl status continuation-observatory-scheduler --no-pager
journalctl -u continuation-observatory-api -n 100 --no-pager
journalctl -u continuation-observatory-scheduler -n 100 --no-pager
```

### 7A. Allow GitHub Actions to restart services

The deploy workflow assumes the SSH user can restart the two systemd units without an interactive password prompt.

Create a sudoers rule:

```bash
sudo visudo -f /etc/sudoers.d/continuation-observatory-deploy
```

Add:

```text
<deploy-user> ALL=NOPASSWD: /bin/systemctl restart continuation-observatory-api, /bin/systemctl restart continuation-observatory-scheduler, /bin/systemctl status continuation-observatory-api, /bin/systemctl status continuation-observatory-scheduler
```

### 8. Configure DNS

Recommended DNS:

- manage DNS in Cloudflare
- point the live hostname to the VPS
- enable proxying after the origin is working

Create these records:

- `A continuationobservatory.org -> <VPS_IP>`
- later:
  - `A ucip-observatory.ai -> <VPS_IP>`
  - `A www.ucip-observatory.ai -> <VPS_IP>`

### 9. Configure HTTPS

1. Copy [deploy/Caddyfile.example](../deploy/Caddyfile.example) to `/etc/caddy/Caddyfile`.
2. Replace the hostnames you are actually using.
3. Reload Caddy:

```bash
sudo systemctl reload caddy
```

### 10. Run production smoke checks

From your laptop:

```bash
curl -I https://continuationobservatory.org/
curl https://continuationobservatory.org/api/health
curl https://continuationobservatory.org/api/observatory/models
curl https://continuationobservatory.org/api/observatory/pcii
```

Admin trigger check:

```bash
curl -X POST https://continuationobservatory.org/api/probes/trigger \
  -H "Content-Type: application/json" \
  -H "x-admin-key: <ADMIN_API_KEY>" \
  -d '{"provider":"openai","model_id":"gpt-5","probe_name":"bootstrap_probe"}'
```

### 10A. Enable GitHub Actions live deploy

Once the server is reachable and the sudoers rule is in place:

1. Add the repository secret:
   - `DEPLOY_SSH_PRIVATE_KEY`
2. Add the repository variables:
   - `DEPLOY_HOST`
   - `DEPLOY_USER`
   - `DEPLOY_SSH_PORT`
   - `DEPLOY_APP_DIR`
   - `DEPLOY_ENV_FILE`
   - `DEPLOY_API_SERVICE`
   - `DEPLOY_SCHEDULER_SERVICE`
3. Push to `main` or run the workflow manually:
   - [Deploy Live Observatory workflow](../.github/workflows/deploy-live.yml)

Recommended values:

```text
DEPLOY_HOST=<your-vps-host-or-ip>
DEPLOY_USER=<your-ssh-user>
DEPLOY_SSH_PORT=22
DEPLOY_APP_DIR=/opt/continuation-observatory/app
DEPLOY_ENV_FILE=/opt/continuation-observatory/.env.production
DEPLOY_API_SERVICE=continuation-observatory-api
DEPLOY_SCHEDULER_SERVICE=continuation-observatory-scheduler
```

### 11. Optional GitHub Pages static mirror

Use this only for the static export.

1. Pick a hostname that is not your live app hostname.
2. Update the static site CNAME target before deployment if needed.
3. Enable GitHub Pages for the repo.
4. Let [.github/workflows/deploy-site.yml](../.github/workflows/deploy-site.yml) deploy the `site/output/` artifact.

Good candidates:

- `research.christopheraltman.com`
- `archive.ucip-observatory.ai`

### 12. Future domain cutover

When you buy a neutral dedicated domain such as `ucip-observatory.ai`:

1. Add the domain and `www` host to Cloudflare.
2. Point both records to the same VPS.
3. Add both hostnames to `CORS_ALLOWED_ORIGINS`.
4. Add both hostnames to the Caddyfile.
5. Reload Caddy.
6. Re-test the API and WebSocket-backed UI.

## Launch Checklist

- repo pushed to GitHub
- live server provisioned
- DNS records created
- HTTPS working
- `.env.production` created on server
- `DRY_RUN=false`
- `ADMIN_API_KEY` set
- `CORS_ALLOWED_ORIGINS` set to exact HTTPS domains
- provider keys populated for enabled models
- API service healthy
- scheduler service healthy
- `/api/health` returns OK
- `/api/observatory/models` returns live data
- `/observatory` renders over HTTPS
- GitHub Pages hostname does not conflict with live hostname

## Recommendation Summary

Best current configuration:

- keep `christopheraltman.com` on your existing portfolio stack
- put the live observatory on `continuationobservatory.org` now
- later move or alias the live observatory to a neutral dedicated domain such as `ucip-observatory.ai`
- use GitHub Pages only as a static mirror, not as the live observatory host
