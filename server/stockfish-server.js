#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8777);
const STOCKFISH_PATH = process.env.STOCKFISH_PATH || "stockfish";
const MAX_DEPTH = Number(process.env.MAX_DEPTH || 16);
const MAX_MOVETIME = Number(process.env.MAX_MOVETIME || 1500);
const MAX_MULTIPV = Number(process.env.MAX_MULTIPV || 1);
const REQUEST_TIMEOUT = Number(process.env.REQUEST_TIMEOUT || 8000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const ENGINE_THREADS = Number(process.env.ENGINE_THREADS || 16);
const ENGINE_THREADS_FAST = Number(process.env.ENGINE_THREADS_FAST || ENGINE_THREADS);
const ENGINE_THREADS_STRONG = Number(process.env.ENGINE_THREADS_STRONG || ENGINE_THREADS);
const ENGINE_THREADS_MAX = Number(process.env.ENGINE_THREADS_MAX || ENGINE_THREADS);
const ENGINE_HASH_MB = Number(process.env.ENGINE_HASH_MB || 2048);
const ENGINE_POOL_SIZE = Number(process.env.ENGINE_POOL_SIZE || 1);
const MAX_ENGINE_QUEUE = Number(process.env.MAX_ENGINE_QUEUE || 2);
const SYZYGY_PATH = process.env.SYZYGY_PATH || "";
const USERSCRIPT_PATH = new URL("../pixie-fen-auto.user.js", import.meta.url);
const AUTOPLAY_USERSCRIPT_PATH = new URL("../pixie-fen-auto-autoplay.user.js", import.meta.url);

const requestCounts = new Map();
let engines = [];
let nextEngine = 0;

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function installPage(res) {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pixie userscript install</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 760px; margin: 40px auto; padding: 0 16px; line-height: 1.5; }
    a.button { display: inline-block; margin: 8px 12px 8px 0; padding: 12px 16px; border-radius: 10px; background: #111827; color: #fff; text-decoration: none; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <h1>Pixie userscript install</h1>
  <p>If Tampermonkey is active, clicking a button below should open the install/update prompt.</p>
  <p>
    <a class="button" href="/pixie-stockfish/pixie-fen-auto.user.js">Install basic script</a>
    <a class="button" href="/pixie-stockfish/pixie-fen-auto-autoplay.user.js">Install autoplay script</a>
  </p>
  <p>If your browser still downloads the file, open Tampermonkey Dashboard -> Utilities -> Import from URL and paste your deployed public URL, for example:</p>
  <ul>
    <li><code>https://your-domain.example/pixie-stockfish/pixie-fen-auto.user.js</code></li>
    <li><code>https://your-domain.example/pixie-stockfish/pixie-fen-auto-autoplay.user.js</code></li>
  </ul>
</body>
</html>`;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, max-age=0"
  });
  res.end(html);
}

async function userscript(req, res, fileUrl) {
  const body = await readFile(fileUrl, "utf8");
  const filename = String(new URL(fileUrl).pathname.split("/").pop() || "script.user.js");
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Disposition": `inline; filename="${filename}"`,
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Cache-Control": "no-store, max-age=0"
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function isValidFen(fen) {
  if (typeof fen !== "string" || fen.length > 120) return false;
  const parts = fen.trim().split(/\s+/);
  if (parts.length !== 6) return false;
  if (!/^[pnbrqkPNBRQK1-8/]+$/.test(parts[0])) return false;
  if (!/^[wb]$/.test(parts[1])) return false;
  if (!/^(-|[KQkq]+)$/.test(parts[2])) return false;
  if (!/^(-|[a-h][36])$/.test(parts[3])) return false;
  if (!/^\d+$/.test(parts[4]) || !/^\d+$/.test(parts[5])) return false;

  const rows = parts[0].split("/");
  if (rows.length !== 8) return false;
  for (const row of rows) {
    let count = 0;
    for (const ch of row) {
      count += /\d/.test(ch) ? Number(ch) : 1;
    }
    if (count !== 8) return false;
  }
  return true;
}

function parseScore(line) {
  const cp = line.match(/\bscore cp (-?\d+)/);
  if (cp) return { type: "cp", value: Number(cp[1]) };
  const mate = line.match(/\bscore mate (-?\d+)/);
  if (mate) return { type: "mate", value: Number(mate[1]) };
  return null;
}

function parsePvLine(line) {
  const multipv = Number(line.match(/\bmultipv\s+(\d+)/)?.[1] || 1);
  const score = parseScore(line);
  const pv = line.match(/\bpv\s+(.+)$/)?.[1]?.trim().split(/\s+/) || [];
  if (!score || !pv.length) return null;
  return { multipv, score, move: pv[0], pv };
}

function parseFenBoard(fen) {
  const [placement, sideToMove] = fen.split(/\s+/);
  const board = [];

  for (const row of placement.split("/")) {
    const cells = [];
    for (const ch of row) {
      if (/\d/.test(ch)) {
        for (let i = 0; i < Number(ch); i++) cells.push(null);
      } else {
        cells.push(ch);
      }
    }
    board.push(cells);
  }

  return { board, sideToMove };
}

function scoreForSide(score) {
  if (!score) return null;
  if (score.type === "mate") {
    return Math.sign(score.value || 1) * (100000 - Math.min(Math.abs(score.value), 1000));
  }
  if (score.type === "cp") return score.value;
  return null;
}

function moveTargetPiece(fen, uci) {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(String(uci || ""))) return null;
  const { board } = parseFenBoard(fen);
  const toCol = uci.charCodeAt(2) - 97;
  const toRow = 8 - Number(uci[3]);
  return board[toRow]?.[toCol] || null;
}

function isMajorPiece(piece) {
  return Boolean(piece && ["q", "r"].includes(piece.toLowerCase()));
}

function cloneBoard(board) {
  return board.map(row => row.slice());
}

function pieceColor(piece) {
  if (!piece) return null;
  return piece === piece.toUpperCase() ? "w" : "b";
}

function applyUciMove(board, uci) {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(String(uci || ""))) return null;

  const fromCol = uci.charCodeAt(0) - 97;
  const fromRow = 8 - Number(uci[1]);
  const toCol = uci.charCodeAt(2) - 97;
  const toRow = 8 - Number(uci[3]);
  let piece = board[fromRow]?.[fromCol] || null;
  if (!piece) return null;

  const captured = board[toRow]?.[toCol] || null;
  const promotion = uci[4];
  if (promotion) {
    piece = pieceColor(piece) === "w" ? promotion.toUpperCase() : promotion.toLowerCase();
  }

  board[fromRow][fromCol] = null;
  board[toRow][toCol] = piece;
  return { captured };
}

function majorTradeRisk(fen, pv) {
  const { board } = parseFenBoard(fen);
  const next = cloneBoard(board);
  const captures = [];

  for (let ply = 0; ply < Math.min(pv.length, 6); ply++) {
    const applied = applyUciMove(next, pv[ply]);
    if (!applied) break;
    if (isMajorPiece(applied.captured)) {
      captures.push({
        ply,
        move: pv[ply],
        piece: applied.captured,
        color: pieceColor(applied.captured)
      });
    }
  }

  const colors = new Set(captures.map(capture => capture.color));
  return {
    likely: captures.length >= 2 && colors.size >= 2,
    captures
  };
}

function engineThreadsForMovetime(movetime) {
  if (movetime >= 5000) return ENGINE_THREADS_MAX;
  if (movetime > 0 && movetime < 3000) return ENGINE_THREADS_FAST;
  return ENGINE_THREADS_STRONG;
}

function chooseStyledLine(fen, lines, { avoidMajorTrades, styleWindowCp, majorTradePenaltyCp }) {
  const scored = lines
    .map(line => {
      const sideScore = scoreForSide(line.score);
      const tradeRisk = majorTradeRisk(fen, line.pv);
      const capturesMajor = isMajorPiece(moveTargetPiece(fen, line.move));
      const stylePenalty = avoidMajorTrades && tradeRisk.likely ? majorTradePenaltyCp : 0;
      return {
        ...line,
        sideScore,
        capturesMajor,
        majorTradeLikely: tradeRisk.likely,
        majorCaptures: tradeRisk.captures,
        styleScore: sideScore == null ? null : sideScore - stylePenalty
      };
    })
    .filter(line => Number.isFinite(line.sideScore));

  if (!scored.length) return null;

  scored.sort((a, b) => b.sideScore - a.sideScore);
  const best = scored[0];
  if (!avoidMajorTrades || !best.majorTradeLikely) return { selected: best, candidates: scored };

  const alternatives = scored
    .filter(line => best.sideScore - line.sideScore <= styleWindowCp)
    .sort((a, b) => b.styleScore - a.styleScore);

  return { selected: alternatives[0] || best, candidates: scored };
}

class StockfishEngine {
  constructor(id) {
    this.id = id;
    this.proc = null;
    this.ready = null;
    this.queue = Promise.resolve();
    this.current = null;
    this.buffer = "";
    this.stderr = "";
    this.restartCount = 0;
    this.currentThreads = null;
    this.pending = 0;
    this.completed = 0;
    this.queueTimeouts = 0;
    this.searchTimeouts = 0;
    this.clientAborts = 0;
    this.lastQueueMs = 0;
    this.lastSearchMs = 0;
    this.lastTotalMs = 0;
    this.start();
  }

  start() {
    this.proc = spawn(STOCKFISH_PATH, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.buffer = "";
    this.stderr = "";
    this.current = null;
    this.currentThreads = null;

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stdout.on("data", data => this.handleStdout(data));
    this.proc.stderr.on("data", data => {
      this.stderr += data;
    });

    this.proc.on("error", err => this.failCurrent(err));
    this.proc.on("exit", code => {
      const err = new Error(this.stderr.trim() || `Stockfish exited with code ${code}`);
      this.failCurrent(err);
      this.restartCount += 1;
      setTimeout(() => this.start(), 250);
    });

    this.ready = this.initialize();
  }

  write(command) {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error("Stockfish stdin is not writable");
    }
    this.proc.stdin.write(`${command}\n`);
  }

  initialize() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Stockfish init timed out")), REQUEST_TIMEOUT);
      const previous = this.current;
      this.current = {
        type: "init",
        resolve: () => {
          clearTimeout(timeout);
          this.current = previous;
          this.currentThreads = ENGINE_THREADS;
          resolve();
        },
        reject: err => {
          clearTimeout(timeout);
          this.current = previous;
          reject(err);
        }
      };

      this.write("uci");
      this.write(`setoption name Threads value ${ENGINE_THREADS}`);
      this.write(`setoption name Hash value ${ENGINE_HASH_MB}`);
      this.write("setoption name Ponder value false");
      this.write("setoption name Move Overhead value 0");
      this.write("setoption name Skill Level value 20");
      this.write("setoption name UCI_LimitStrength value false");
      this.write("setoption name Use NNUE value true");
      if (SYZYGY_PATH.trim()) this.write(`setoption name SyzygyPath value ${SYZYGY_PATH}`);
      this.write("setoption name SyzygyProbeLimit value 6");
      this.write("setoption name SyzygyProbeDepth value 1");
      this.write("isready");
    });
  }

  handleStdout(data) {
    this.buffer += data;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line) continue;

      if (this.current?.type === "init" && line === "readyok") {
        this.current.resolve();
        continue;
      }

      if (this.current?.type !== "search") continue;

      const score = parseScore(line);
      if (score) this.current.latestScore = score;
      const pvLine = parsePvLine(line);
      if (pvLine) this.current.lines.set(pvLine.multipv, pvLine);

      const match = line.match(/^bestmove\s+(\S+)/);
      if (match) {
        const now = Date.now();
        const styled = chooseStyledLine(this.current.fen, Array.from(this.current.lines.values()), this.current.style);
        const selected = styled?.selected || null;
        const bestmove = selected?.move || match[1];
        this.completed += 1;
        this.lastQueueMs = this.current.queueMs;
        this.lastSearchMs = now - this.current.startedAt;
        this.lastTotalMs = now - this.current.queuedAt;
        this.current.resolve({
          ok: true,
          bestmove,
          stockfishBestmove: match[1],
          score: selected?.score || this.current.latestScore,
          lines: styled?.candidates || Array.from(this.current.lines.values()),
          selection: selected
            ? {
                move: selected.move,
                capturesMajor: selected.capturesMajor,
                majorTradeLikely: selected.majorTradeLikely,
                majorCaptures: selected.majorCaptures,
                sideScore: selected.sideScore,
                styleScore: selected.styleScore
              }
            : null,
          raw: line,
          engineId: this.id,
          threads: this.current.threads,
          hashMb: ENGINE_HASH_MB,
          timing: {
            queueMs: this.current.queueMs,
            searchMs: this.lastSearchMs,
            totalMs: this.lastTotalMs
          }
        });
      }
    }
  }

  failCurrent(err) {
    if (this.current?.reject) this.current.reject(err);
    this.current = null;
  }

  search({ fen, depth, movetime, multipv, threads, avoidMajorTrades, styleWindowCp, majorTradePenaltyCp, signal }) {
    const queuedAt = Date.now();
    this.pending += 1;

    const task = this.queue
      .catch(() => {})
      .then(() => {
        const queueMs = Date.now() - queuedAt;
        if (signal?.aborted) {
          this.clientAborts += 1;
          throw new Error("Client disconnected before search");
        }
        if (queueMs >= REQUEST_TIMEOUT) {
          this.queueTimeouts += 1;
          throw new Error(`Engine queue timeout after ${queueMs}ms`);
        }
        return this.runSearch({
          fen,
          depth,
          movetime,
          multipv,
          threads,
          avoidMajorTrades,
          styleWindowCp,
          majorTradePenaltyCp,
          signal,
          queuedAt,
          queueMs
        });
      })
      .finally(() => {
        this.pending = Math.max(0, this.pending - 1);
      });

    this.queue = task.catch(() => {});
    return task;
  }

  async runSearch({ fen, depth, movetime, multipv, threads, avoidMajorTrades, styleWindowCp, majorTradePenaltyCp, signal, queuedAt, queueMs }) {
    await this.ready;

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        this.clientAborts += 1;
        reject(new Error("Client disconnected before search"));
        return;
      }

      const startedAt = Date.now();
      const remainingTimeout = Math.max(250, REQUEST_TIMEOUT - queueMs);
      let hardStopTimeout = null;
      let done = false;

      const finish = (fn, value) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        clearTimeout(hardStopTimeout);
        if (signal) signal.removeEventListener("abort", abortSearch);
        this.current = null;
        fn(value);
      };

      const stopWithError = err => {
        if (!this.current || this.current.stopError) return;
        this.current.stopError = err;
        try {
          this.write("stop");
        } catch {
          finish(reject, err);
          return;
        }

        hardStopTimeout = setTimeout(() => {
          try {
            this.proc.kill();
          } catch {}
          finish(reject, err);
        }, 2000);
      };

      const timeout = setTimeout(() => {
        this.searchTimeouts += 1;
        stopWithError(new Error("Stockfish timed out"));
      }, remainingTimeout);

      const abortSearch = () => {
        this.clientAborts += 1;
        stopWithError(new Error("Client disconnected"));
      };
      if (signal) signal.addEventListener("abort", abortSearch, { once: true });

      this.current = {
        type: "search",
        fen,
        threads,
        queuedAt,
        queueMs,
        startedAt,
        style: { avoidMajorTrades, styleWindowCp, majorTradePenaltyCp },
        latestScore: null,
        lines: new Map(),
        stopError: null,
        resolve: result => {
          if (this.current?.stopError) {
            finish(reject, this.current.stopError);
            return;
          }
          finish(resolve, result);
        },
        reject: err => finish(reject, err)
      };

      if (this.currentThreads !== threads) {
        this.write(`setoption name Threads value ${threads}`);
        this.currentThreads = threads;
      }
      this.write(`setoption name MultiPV value ${multipv}`);
      this.write(`position fen ${fen}`);
      if (movetime > 0) {
        this.write(`go movetime ${movetime}`);
      } else {
        this.write(`go depth ${depth}`);
      }
    });
  }
}

function engineStats() {
  return engines.map(engine => ({
    id: engine.id,
    pending: engine.pending,
    completed: engine.completed,
    restarts: engine.restartCount,
    queueTimeouts: engine.queueTimeouts,
    searchTimeouts: engine.searchTimeouts,
    clientAborts: engine.clientAborts,
    currentThreads: engine.currentThreads,
    lastQueueMs: engine.lastQueueMs,
    lastSearchMs: engine.lastSearchMs,
    lastTotalMs: engine.lastTotalMs,
    busy: engine.current?.type === "search"
  }));
}

function pickEngine() {
  if (!engines.length) return null;

  const minPending = Math.min(...engines.map(engine => engine.pending));
  const candidates = engines.filter(engine => engine.pending === minPending);
  const engine = candidates[nextEngine % candidates.length];
  nextEngine += 1;
  return engine;
}

function bestMove({ fen, depth, movetime, multipv, threads, avoidMajorTrades, styleWindowCp, majorTradePenaltyCp, signal }) {
  const engine = pickEngine();
  if (!engine) throw new Error("No Stockfish engine available");
  if (engine.pending >= MAX_ENGINE_QUEUE) {
    const err = new Error(`Engine queue full: pending=${engine.pending}`);
    err.statusCode = 503;
    throw err;
  }
  return engine.search({ fen, depth, movetime, multipv, threads, avoidMajorTrades, styleWindowCp, majorTradePenaltyCp, signal });
}

engines = Array.from({ length: ENGINE_POOL_SIZE }, (_, index) => new StockfishEngine(index));

function rateLimited(req) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const bucket = requestCounts.get(ip) || [];
  const recent = bucket.filter(ts => now - ts < 60_000);
  recent.push(now);
  requestCounts.set(ip, recent);
  return recent.length > 120;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    json(res, 204, {});
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && (url.pathname === "/install" || url.pathname === "/pixie-stockfish/install")) {
    installPage(res);
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && (url.pathname === "/pixie-fen-auto.user.js" || url.pathname === "/pixie-stockfish/pixie-fen-auto.user.js")) {
    try {
      await userscript(req, res, USERSCRIPT_PATH);
    } catch (err) {
      json(res, 500, { ok: false, error: "Userscript unavailable" });
    }
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && (url.pathname === "/pixie-fen-auto-autoplay.user.js" || url.pathname === "/pixie-stockfish/pixie-fen-auto-autoplay.user.js")) {
    try {
      await userscript(req, res, AUTOPLAY_USERSCRIPT_PATH);
    } catch (err) {
      json(res, 500, { ok: false, error: "Autoplay userscript unavailable" });
    }
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && (url.pathname === "/health" || url.pathname === "/pixie-stockfish/health")) {
    json(res, 200, {
      ok: true,
      engine: STOCKFISH_PATH,
      persistent: true,
      poolSize: ENGINE_POOL_SIZE,
      maxEngineQueue: MAX_ENGINE_QUEUE,
      threads: ENGINE_THREADS,
      threadPolicy: {
        fast: ENGINE_THREADS_FAST,
        strong: ENGINE_THREADS_STRONG,
        max: ENGINE_THREADS_MAX
      },
      hashMb: ENGINE_HASH_MB,
      maxMovetime: MAX_MOVETIME,
      maxMultipv: MAX_MULTIPV,
      syzygyPath: SYZYGY_PATH || null,
      engines: engineStats()
    });
    return;
  }

  const isBestMovePath = url.pathname === "/bestmove" || url.pathname === "/pixie-stockfish/bestmove";
  if (req.method !== "POST" || !isBestMovePath) {
    json(res, 404, { ok: false, error: "Not found" });
    return;
  }

  if (rateLimited(req)) {
    json(res, 429, { ok: false, error: "Rate limited" });
    return;
  }

  const abortController = new AbortController();
  let responseFinished = false;
  res.on("finish", () => {
    responseFinished = true;
  });
  req.on("aborted", () => {
    abortController.abort();
  });
  res.on("close", () => {
    if (!responseFinished) abortController.abort();
  });

  try {
    const requestedAt = Date.now();
    const bodyText = await readBody(req);
    const body = JSON.parse(bodyText || "{}");
    const fen = String(body.fen || "").trim();
    if (!isValidFen(fen)) {
      json(res, 400, { ok: false, error: "Invalid FEN" });
      return;
    }

    const depth = Math.max(1, Math.min(MAX_DEPTH, Number(body.depth || 12)));
    const movetime = Math.max(0, Math.min(MAX_MOVETIME, Number(body.movetime || 0)));
    const multipv = Math.max(1, Math.min(MAX_MULTIPV, Number(body.multipv || 1)));
    const threads = engineThreadsForMovetime(movetime);
    const avoidMajorTrades = body.avoidMajorTrades === true;
    const styleWindowCp = Math.max(0, Math.min(300, Number(body.styleWindowCp || 45)));
    const majorTradePenaltyCp = Math.max(0, Math.min(500, Number(body.majorTradePenaltyCp || 80)));
    const result = await bestMove({
      fen,
      depth,
      movetime,
      multipv,
      threads,
      avoidMajorTrades,
      styleWindowCp,
      majorTradePenaltyCp,
      signal: abortController.signal
    });
    result.timing = {
      ...(result.timing || {}),
      httpMs: Date.now() - requestedAt
    };
    json(res, 200, result);
  } catch (err) {
    const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
    json(res, status, {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Pixie Stockfish server listening on http://${HOST}:${PORT}`);
});
