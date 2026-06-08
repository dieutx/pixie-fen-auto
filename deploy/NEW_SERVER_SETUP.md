# New server setup for Pixie Stockfish

This guide is for rebuilding the Pixie Stockfish service on another Linux server as fast as possible.

Target result:

- local service on `127.0.0.1:8777`
- public reverse proxy on `/pixie-stockfish/`
- userscripts served from the same service
- Stockfish bestmove API reachable by Tampermonkey

## 0) Fastest path: one-shot setup script

If you want the whole setup in one command, run from the repo root:

```bash
sudo SERVER_NAME=your-domain.example \
  PUBLIC_BASE_URL=https://your-domain.example/pixie-stockfish \
  bash deploy/setup-pixie-stockfish.sh
```

What it does:

- installs base packages
- installs Node.js if missing
- clones or updates the repo
- installs stockfish if missing
- copies and patches the systemd unit
- installs nginx config for `/pixie-stockfish/`
- verifies `/health`, `/bestmove`, and userscript URLs

Environment variables you can override:

```text
REPO_DIR=/root/claude/pixie-fen-auto
SERVICE_NAME=pixie-stockfish
STOCKFISH_PATH=/usr/local/bin/stockfish
NODE_PATH=/usr/bin/node
ENGINE_THREADS=20
ENGINE_THREADS_FAST=20
ENGINE_THREADS_STRONG=20
ENGINE_THREADS_MAX=20
ENGINE_HASH_MB=1024
MAX_ENGINE_QUEUE=1
MAX_MOVETIME=5000
MAX_MULTIPV=1
SERVER_NAME=your-domain.example
PUBLIC_BASE_URL=https://your-domain.example/pixie-stockfish
```

If you prefer step-by-step control, follow the manual procedure below.

## 1) Install base packages

Ubuntu/Debian example:

```bash
sudo apt-get update
sudo apt-get install -y git curl nginx build-essential
```

Install Node.js 24 if not already present. One common path is NVM:

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install 24
nvm use 24
node -v
npm -v
```

If you install Node another way, adjust the `ExecStart=` path in the systemd unit.

## 2) Clone the repo

```bash
sudo mkdir -p /root/claude
cd /root/claude
git clone https://github.com/dieutx/pixie-fen-auto.git
cd pixie-fen-auto
npm install
```

## 3) Install Stockfish

The service expects a real engine binary at `STOCKFISH_PATH`.

Simplest path:

```bash
sudo apt-get install -y stockfish
which stockfish
```

If you have a stronger CPU-tuned build, place it somewhere stable such as:

```text
/usr/local/bin/stockfish-optimal
```

Then make it executable:

```bash
sudo chmod +x /usr/local/bin/stockfish-optimal
```

Quick engine sanity check:

```bash
/usr/local/bin/stockfish-optimal | head
```

If you are using distro stockfish instead, update the service file to the correct binary path.

## 4) Optional: prepare Syzygy tablebases

Current tuned config points to:

```text
/opt/syzygy/3-4-5:/opt/syzygy/6-man
```

Create those directories if you will use them:

```bash
sudo mkdir -p /opt/syzygy/3-4-5 /opt/syzygy/6-man
```

You can deploy without Syzygy first, then either:

- keep `SYZYGY_PATH` pointing at populated directories, or
- blank it out in the systemd file until tablebases exist

## 5) Install systemd service

Copy the template into `/etc/systemd/system`:

```bash
sudo cp deploy/pixie-stockfish.service /etc/systemd/system/pixie-stockfish.service
```

Open it and confirm these values fit the new server:

```text
WorkingDirectory=/root/claude/pixie-fen-auto
ExecStart=/root/.nvm/versions/node/v24.9.0/bin/node server/stockfish-server.js
Environment=STOCKFISH_PATH=/usr/local/bin/stockfish
Environment=ENGINE_THREADS=20
Environment=ENGINE_THREADS_FAST=20
Environment=ENGINE_THREADS_STRONG=20
Environment=ENGINE_THREADS_MAX=20
Environment=ENGINE_HASH_MB=1024
Environment=ENGINE_POOL_SIZE=1
Environment=MAX_ENGINE_QUEUE=1
Environment=SYZYGY_PATH=/opt/syzygy/3-4-5:/opt/syzygy/6-man
Environment=MAX_MOVETIME=5000
Environment=MAX_MULTIPV=1
Environment=REQUEST_TIMEOUT=9000
```

Important:

- `ExecStart` must match the actual `node` path on the new machine.
- `STOCKFISH_PATH` must match the actual engine binary.
- `ENGINE_THREADS=20` is the current production value.
- `ENGINE_POOL_SIZE=1` and `MAX_ENGINE_QUEUE=1` keep the server aligned with the client: one active FEN request at a time.

Then enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pixie-stockfish.service
sudo systemctl status pixie-stockfish.service --no-pager
```

View logs if needed:

```bash
sudo journalctl -u pixie-stockfish.service -n 100 --no-pager
```

## 6) Install nginx reverse proxy

Copy the nginx snippet into the right server block or include directory.

Example include install:

```bash
sudo cp deploy/nginx-pixie-stockfish.conf /etc/nginx/snippets/pixie-stockfish.conf
```

Then reference it from your TLS vhost:

```nginx
location /pixie-stockfish/ {
  proxy_pass http://127.0.0.1:8777;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

Validate and reload nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 7) Verify local service

Health:

```bash
curl http://127.0.0.1:8777/health
```

Expected fields include:

- `ok: true`
- `engine`
- `threads: 20`
- `threadPolicy.fast: 20`
- `threadPolicy.strong: 20`
- `threadPolicy.max: 20`
- `hashMb: 1024`
- `maxMovetime: 5000`

Bestmove test:

```bash
curl -X POST http://127.0.0.1:8777/bestmove \
  -H 'Content-Type: application/json' \
  --data '{"fen":"r1bqkbnr/pppp1ppp/2n5/4p3/3PP3/5N2/PPP2PPP/RNBQKB1R b KQkq - 2 3","movetime":3000,"multipv":1}'
```

Expected result: JSON with `ok: true` and a `bestmove`.

## 8) Verify public endpoint

Replace `your-domain.example` with the real host:

```bash
curl https://your-domain.example/pixie-stockfish/health
curl -X POST https://your-domain.example/pixie-stockfish/bestmove \
  -H 'Content-Type: application/json' \
  --data '{"fen":"r1bqkbnr/pppp1ppp/2n5/4p3/3PP3/5N2/PPP2PPP/RNBQKB1R b KQkq - 2 3","movetime":3000,"multipv":1}'
```

Also confirm userscript download URLs work:

```bash
curl -I https://your-domain.example/pixie-stockfish/pixie-fen-auto.user.js
curl -I https://your-domain.example/pixie-stockfish/pixie-fen-auto-autoplay.user.js
```

## 9) Point Tampermonkey to the new server

Best option: keep the same domain/path so clients continue working unchanged.

That is especially important for autoplay: the autoplay userscript follows Stockfish suggestions returned by the configured `/pixie-stockfish/bestmove` endpoint. Keeping the same public base URL preserves automatic move behavior with no client-side changes.

If the endpoint changes, set it in browser console:

```js
localStorage.setItem("pixie-stockfish-server-url", "https://your-domain.example/pixie-stockfish/bestmove");
```

If you changed userscript content, make sure the `@version` metadata was bumped so Tampermonkey auto-update picks it up.

## 10) Fast migration checklist

```text
[ ] install git/curl/nginx/node
[ ] clone repo and run npm install
[ ] install stockfish binary
[ ] verify STOCKFISH_PATH
[ ] copy deploy/pixie-stockfish.service to /etc/systemd/system/
[ ] verify ExecStart node path
[ ] systemctl enable --now pixie-stockfish.service
[ ] install nginx proxy for /pixie-stockfish/
[ ] curl local /health
[ ] curl public /health
[ ] curl public /bestmove
[ ] verify userscript URLs download
```

## 11) Updating after future repo changes

On the server:

```bash
cd /root/claude/pixie-fen-auto
git pull
npm install
sudo cp deploy/pixie-stockfish.service /etc/systemd/system/pixie-stockfish.service
sudo systemctl daemon-reload
sudo systemctl restart pixie-stockfish.service
sudo nginx -t && sudo systemctl reload nginx
```

If you keep local server-specific edits in the unit file, re-apply them after pulling.
