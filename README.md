# Pixie FEN Auto

Pixie FEN Auto is a Tampermonkey userscript plus a small Node.js Stockfish HTTP service for reading a Pixie Chess board state, converting it into standard FEN, asking Stockfish for a best move, and showing or optionally playing that move in the browser.

The project is intended for standard chess positions exposed by Pixie Chess. It does not implement a custom Pixie Chess engine and it does not understand non-standard or custom Pixie Chess pieces/variants. Unknown pieces are ignored or cannot be represented in normal FEN, so Stockfish analysis is only valid for ordinary chess rules and ordinary chess pieces.

## What is included

- Browser userscripts for Tampermonkey:
  - `pixie-fen-auto.user.js` — reads the board, builds FEN, asks the engine, and shows/can send a suggested move.
  - `pixie-fen-auto-move.user.js` — alternate move-oriented userscript variant.
  - `pixie-fen-auto-autoplay.user.js` — autoplay-capable variant with Auto ON/OFF controls.
- `server/stockfish-server.js` — a persistent Node.js HTTP wrapper around a Stockfish binary.
- `deploy/` — systemd, nginx, and one-shot setup templates for running the service on your own server.
- `tests/` — Node-based regression checks for FEN extraction and auto-mode behavior.

## Repository safety / privacy

This public version intentionally uses placeholder deployment values such as `your-domain.example`. It does not include private domains, private keys, API keys, proxy credentials, real server IP addresses, wallet files, or other deployment secrets.

If you deploy your own instance, keep private values outside git and pass them through environment variables, local service files, or your server's secret-management process.

## Important engine note

Pixie FEN Auto uses a normal chess engine (Stockfish) through standard FEN and UCI moves. It is not a custom engine for Pixie Chess-specific fairy pieces, modified movement rules, or other non-standard pieces. If a Pixie Chess game uses custom pieces or rules that cannot be represented in ordinary chess FEN, the engine recommendation may be invalid.

## Requirements

Browser side:

- A Chromium/Firefox-compatible browser.
- Tampermonkey or a compatible userscript manager.
- Access to a Pixie Chess game page matching `https://pixiechess.xyz/game/*` or `https://www.pixiechess.xyz/game/*`.

Server side:

- Linux server or local machine.
- Node.js 20+ recommended.
- Stockfish installed and executable.
- Optional: nginx if you want a public HTTPS reverse proxy.

## Quick local setup

```bash
git clone https://github.com/dieutx/pixie-fen-auto.git
cd pixie-fen-auto
npm install
npm run check
npm test
```

Install Stockfish:

```bash
sudo apt-get update
sudo apt-get install -y stockfish
which stockfish
```

Start the local service:

```bash
HOST=127.0.0.1 PORT=8777 STOCKFISH_PATH=$(which stockfish) npm start
```

Health check:

```bash
curl http://127.0.0.1:8777/health
```

Best-move test:

```bash
curl -X POST http://127.0.0.1:8777/bestmove \
  -H 'Content-Type: application/json' \
  --data '{"fen":"r1bqkbnr/pppp1ppp/2n5/4p3/3PP3/5N2/PPP2PPP/RNBQKB1R b KQkq - 2 3","movetime":1000,"multipv":1}'
```

## Install the userscript

Option A: install from this repository's raw files:

```text
https://raw.githubusercontent.com/dieutx/pixie-fen-auto/main/pixie-fen-auto.user.js
https://raw.githubusercontent.com/dieutx/pixie-fen-auto/main/pixie-fen-auto-autoplay.user.js
```

Option B: deploy the Node service and open the install page:

```text
https://your-domain.example/pixie-stockfish/install
```

The userscripts ship with a placeholder engine URL:

```text
https://your-domain.example/pixie-stockfish/bestmove
```

After installation, point the userscript at your own service from the browser console on a Pixie Chess page:

```js
localStorage.setItem("pixie-stockfish-server-url", "https://your-domain.example/pixie-stockfish/bestmove");
```

For local testing, use:

```js
localStorage.setItem("pixie-stockfish-server-url", "http://127.0.0.1:8777/bestmove");
```

If you use a real public domain, edit the userscript `@connect` metadata or add your domain in Tampermonkey so cross-origin requests are allowed.

## Server configuration

The server is configured with environment variables:

```text
HOST=127.0.0.1
PORT=8777
STOCKFISH_PATH=stockfish
ENGINE_THREADS=16
ENGINE_THREADS_FAST=16
ENGINE_THREADS_STRONG=16
ENGINE_THREADS_MAX=16
ENGINE_HASH_MB=2048
ENGINE_POOL_SIZE=1
MAX_ENGINE_QUEUE=2
MAX_MOVETIME=1500
MAX_MULTIPV=1
REQUEST_TIMEOUT=8000
SYZYGY_PATH=
ALLOWED_ORIGIN=*
```

For stronger analysis, increase `MAX_MOVETIME`, engine threads, and hash size to match your server capacity. Avoid exposing an unrestricted public endpoint without rate limiting if the server is resource constrained.

## Reverse proxy paths

If you use nginx, proxy these public paths to the Node service at `http://127.0.0.1:8777`:

```text
/pixie-stockfish/install
/pixie-stockfish/bestmove
/pixie-stockfish/health
/pixie-stockfish/pixie-fen-auto.user.js
/pixie-stockfish/pixie-fen-auto-autoplay.user.js
```

An example snippet is available in `deploy/nginx-pixie-stockfish.conf`.

## One-shot server deployment

From the repository root on a Linux server:

```bash
sudo SERVER_NAME=your-domain.example \
  PUBLIC_BASE_URL=https://your-domain.example/pixie-stockfish \
  bash deploy/setup-pixie-stockfish.sh
```

The script installs dependencies, clones/updates the repo, installs Stockfish when needed, configures systemd/nginx templates, restarts the service, and verifies `/health`, `/bestmove`, and userscript URLs.

For a manual walkthrough, see `deploy/NEW_SERVER_SETUP.md`.

## Development commands

```bash
npm run check
npm test
npm start
```

`npm run check` performs JavaScript syntax checks. `npm test` runs the repository's regression tests.

## Limitations

- Standard chess only; no custom Pixie Chess piece logic.
- Recommendations depend on accurate board-state extraction from Pixie Chess local storage / websocket traffic.
- Autoplay can make moves automatically; use it carefully and only where allowed by the site rules and your own testing policy.
- The server endpoint can be CPU-intensive under load; put it behind HTTPS, rate limiting, or private access controls when appropriate.

## License

No license file is currently included. Add a license before encouraging third-party reuse.
