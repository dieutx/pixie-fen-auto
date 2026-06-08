// ==UserScript==
// @name         Pixie Chess FEN + Suggest + Move VN
// @namespace    pixie-fen-auto
// @version      1.7.5
// @description  Continuously extract latest FEN, suggest next move, and confirm/send the suggested move in Pixie Chess
// @updateURL    https://raw.githubusercontent.com/dieutx/pixie-fen-auto/main/pixie-fen-auto.user.js
// @downloadURL  https://raw.githubusercontent.com/dieutx/pixie-fen-auto/main/pixie-fen-auto.user.js
// @match        https://www.pixiechess.xyz/game/*
// @match        https://pixiechess.xyz/game/*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      your-domain.example
// @connect      localhost
// @connect      127.0.0.1
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const CACHE_KEY = "pixie-board-state-cache";
  const SIDE_PREF_PREFIX = "pixie-my-side:";
  const POLL_MS = 250;
  const MINIMAX_FALLBACK_DEPTH = 3;
  const ENGINE_MODE = "stockfish"; // "stockfish" hoặc "minimax"
  const STOCKFISH_URL_STORAGE_KEY = "pixie-stockfish-server-url";
  const DEFAULT_STOCKFISH_SERVER_URL = "https://your-domain.example/pixie-stockfish/bestmove";
  const STOCKFISH_DEPTH = 16;
  const STOCKFISH_MOVETIME_MS = 5000;
  const STOCKFISH_MULTIPV = 1;
  const AVOID_MAJOR_TRADES = false;
  const STYLE_WINDOW_CP = 45;
  const MAJOR_TRADE_PENALTY_CP = 80;
  const COMPUTE_ONLY_ON_MY_TURN = true;
  const AUTO_COPY_FEN = false;
  const DEFAULT_MY_SIDE = "auto"; // "auto", "w" = trắng, "b" = đen

  const pieceMap = {
    pawn: "p",
    rook: "r",
    knight: "n",
    bishop: "b",
    queen: "q",
    king: "k"
  };

  const pieceNamesVi = {
    p: "Tốt",
    n: "Mã",
    b: "Tượng",
    r: "Xe",
    q: "Hậu",
    k: "Vua"
  };

  const pieceValues = {
    p: 100,
    n: 320,
    b: 330,
    r: 500,
    q: 900,
    k: 20000
  };

  let lastKey = "";
  let lastFen = "";
  let lastSuggestionKey = "";
  let lastSuggestion = null;
  let lastStateForDebug = null;
  let tickBusy = false;
  let lastOverlayKey = "";
  let lastPanelStateKey = "";
  let primarySocket = null;
  let socketPlayerAddress = null;
  let socketGameId = null;
  let lastMoveExecution = null;

  function sideName(side) {
    if (side === "auto") return "Auto";
    if (side === "w") return "Trắng";
    if (side === "b") return "Đen";
    return "Chưa rõ";
  }

  function normalizeSide(value) {
    if (value === 0 || value === "0") return "w";
    if (value === 1 || value === "1") return "b";

    const text = String(value || "").trim().toLowerCase();
    if (["w", "white", "trang", "trắng", "first", "before"].includes(text)) return "w";
    if (["b", "black", "den", "đen", "second", "after"].includes(text)) return "b";
    if (text === "auto") return "auto";
    return null;
  }

  function getGameId() {
    const m = location.pathname.match(/\/game\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  function getSidePrefKey() {
    const gameId = getGameId();
    return `${SIDE_PREF_PREFIX}${gameId || "global"}`;
  }

  function getSidePreference() {
    const saved = normalizeSide(localStorage.getItem(getSidePrefKey()));
    return saved || DEFAULT_MY_SIDE;
  }

  function setSidePreference(side) {
    const normalized = normalizeSide(side) || "auto";
    localStorage.setItem(getSidePrefKey(), normalized);
    lastSuggestionKey = "";
    tick().catch(console.error);
  }

  function getStockfishServerUrl() {
    const saved = localStorage.getItem(STOCKFISH_URL_STORAGE_KEY);
    return saved && /^https?:\/\//i.test(saved) ? saved : DEFAULT_STOCKFISH_SERVER_URL;
  }

  function parseJson(text, fallback) {
    try {
      return JSON.parse(text);
    } catch {
      return fallback;
    }
  }

  function requestJson(url, body, timeout = 5000) {
    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "POST",
          url,
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          data: JSON.stringify(body),
          timeout,
          onload: response => {
            if (response.status < 200 || response.status >= 300) {
              reject(new Error(`HTTP ${response.status}: ${response.responseText || "request failed"}`));
              return;
            }
            resolve(parseJson(response.responseText, null));
          },
          onerror: () => reject(new Error("Không gọi được Stockfish server")),
          ontimeout: () => reject(new Error("Stockfish server timeout"))
        });
      });
    }

    return fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    }).then(async response => {
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text || "request failed"}`);
      return parseJson(text, null);
    });
  }

  function getStates() {
    const gameId = getGameId();
    if (!gameId) return [];

    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return [];

    const cache = parseJson(raw, null);
    if (!cache || !Array.isArray(cache.entries)) return [];

    return cache.entries
      .filter(([key]) => typeof key === "string" && key.startsWith(gameId + ":"))
      .map(([key, state]) => ({
        key,
        turnIndex: Number(key.split(":").pop()),
        state
      }))
      .filter(x => Number.isFinite(x.turnIndex) && x.state && Array.isArray(x.state.pieces))
      .sort((a, b) => a.turnIndex - b.turnIndex);
  }

  function toSquare(point) {
    if (!point) return null;
    return "abcdefgh"[Number(point.x)] + String(Number(point.y) + 1);
  }


  function squareToPoint(square) {
    if (typeof square !== "string") return null;
    const s = square.trim().toLowerCase();
    if (!/^[a-h][1-8]$/.test(s)) return null;
    return {
      x: "abcdefgh".indexOf(s[0]),
      y: Number(s[1]) - 1
    };
  }

  function clone(value) {
    if (value == null) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function decodeSocketEvent(payload) {
    if (typeof payload !== "string") return null;
    const idx = payload.indexOf("[");
    if (idx < 0) return null;
    const prefix = payload.slice(0, idx);
    if (!/^\d+$/.test(prefix)) return null;
    try {
      const json = JSON.parse(payload.slice(idx));
      if (!Array.isArray(json) || !json.length) return null;
      return { prefix, eventName: json[0], args: json.slice(1) };
    } catch {
      return null;
    }
  }

  function updateSocketContext(payload) {
    const decoded = decodeSocketEvent(payload);
    if (!decoded) return;

    const { eventName, args } = decoded;
    if (eventName === "select_point" || eventName === "move") {
      if (args[0]) socketGameId = args[0];
      if (args[1]) socketPlayerAddress = args[1];
    }
  }

  function isPixieSocketUrl(url) {
    const text = String(url || "");
    return /pixiechess\.xyz/i.test(text) && /socket\.io/i.test(text);
  }

  function attachSocketHooks(ws) {
    if (!ws || ws.__pixie_socket_hooked__) return ws;
    ws.__pixie_socket_hooked__ = true;

    const wsUrl = String(ws.url || "");
    if (isPixieSocketUrl(wsUrl)) {
      primarySocket = ws;
    }

    const origSend = ws.send;
    ws.send = function (data) {
      if (isPixieSocketUrl(this.url || wsUrl)) {
        primarySocket = this;
        updateSocketContext(data);
      }
      return origSend.apply(this, arguments);
    };

    ws.addEventListener("message", ev => {
      if (isPixieSocketUrl(ws.url || wsUrl)) {
        primarySocket = ws;
        updateSocketContext(ev.data);
      }
    }, true);

    return ws;
  }

  function installMoveSocketHooks() {
    if (window.__pixie_move_socket_hooks_installed__) return;
    window.__pixie_move_socket_hooks_installed__ = true;

    const OrigWebSocket = window.WebSocket;

    if (!OrigWebSocket.prototype.__pixie_send_patched__) {
      OrigWebSocket.prototype.__pixie_send_patched__ = true;
      const protoSend = OrigWebSocket.prototype.send;
      OrigWebSocket.prototype.send = function (data) {
        if (isPixieSocketUrl(this.url)) {
          primarySocket = this;
          attachSocketHooks(this);
          updateSocketContext(data);
        }
        return protoSend.apply(this, arguments);
      };
    }

    window.WebSocket = new Proxy(OrigWebSocket, {
      construct(Target, args, NewTarget) {
        const ws = Reflect.construct(Target, args, NewTarget);
        return attachSocketHooks(ws);
      }
    });
  }

  function getMoveSocket() {
    return primarySocket;
  }

  function pickAddressCandidate(values) {
    for (const value of values) {
      if (typeof value !== "string") continue;
      const text = value.trim();
      if (/^0x[a-f0-9]{20,}$/i.test(text)) return text;
    }
    for (const value of values) {
      if (typeof value !== "string") continue;
      const text = value.trim();
      if (text) return text;
    }
    return null;
  }

  function resolvePlayerAddress(state = lastStateForDebug) {
    const directCandidates = [];

    if (typeof socketPlayerAddress === "string" && socketPlayerAddress.trim()) {
      directCandidates.push(socketPlayerAddress);
    }
    if (window.ethereum && typeof window.ethereum.selectedAddress === "string") {
      directCandidates.push(window.ethereum.selectedAddress);
    }

    for (const key of ["me", "self", "you", "currentUser", "currentPlayer", "localUser", "user"]) {
      const value = state && state[key];
      if (!value || typeof value !== "object") continue;
      directCandidates.push(
        getStringField(value, ["walletAddress", "address", "wallet", "publicKey", "owner", "id", "userId", "playerId"])
      );
    }

    const direct = pickAddressCandidate(directCandidates);
    if (direct) return direct;

    const selfIds = collectSelfIds(state);
    const playerLists = [state?.players, state?.participants, state?.seats].filter(Array.isArray);
    const idKeys = ["id", "userId", "uid", "accountId", "wallet", "walletAddress", "address", "playerId", "publicKey", "owner"];
    const addressKeys = ["walletAddress", "address", "wallet", "publicKey", "owner", "playerAddress"];

    for (const players of playerLists) {
      for (const player of players) {
        if (!player || typeof player !== "object") continue;
        const ids = idKeys.map(key => getStringField(player, [key])).filter(Boolean).map(x => x.toLowerCase());
        if (!ids.some(id => selfIds.has(id))) continue;
        const candidate = pickAddressCandidate(addressKeys.map(key => getStringField(player, [key])));
        if (candidate) return candidate;
      }
    }

    return null;
  }

  function moveRuntimeReady() {
    return Boolean(getMoveSocket() && (socketGameId || getGameId()) && resolvePlayerAddress());
  }

  function sendPixieMoveEvent(eventName, ...args) {
    const ws = getMoveSocket();
    if (!ws) throw new Error("Chưa bắt được websocket PixieChess");
    const payload = `42${JSON.stringify([eventName, ...args])}`;
    ws.send(payload);
    updateSocketContext(payload);
    return payload;
  }

  function getCurrentPieces() {
    return Array.isArray(lastStateForDebug?.pieces) ? lastStateForDebug.pieces.filter(p => !p.captured && p.point) : [];
  }

  function findPieceBySquare(square) {
    const target = String(square || "").trim().toLowerCase();
    return getCurrentPieces().find(piece => toSquare(piece.point) === target) || null;
  }

  function getSuggestedMoveData(suggestion = lastSuggestion) {
    const move = suggestion?.move || null;
    if (move && move.from && move.to) return move;

    const uci = suggestion?.uci && suggestion.uci !== "-" ? String(suggestion.uci).trim().toLowerCase() : "";
    const m = uci.match(/^([a-h][1-8])([a-h][1-8])(?:[qrbn])?$/);
    if (!m) return null;
    return { from: m[1], to: m[2], uci };
  }

  async function executeSuggestedMove(suggestion = lastSuggestion, options = {}) {
    const move = getSuggestedMoveData(suggestion);
    if (!move) throw new Error("Chưa có nước gợi ý hợp lệ để đi");
    if (!moveRuntimeReady()) throw new Error("Chưa đủ dữ liệu runtime để gửi move. Hãy chọn/đi một quân tay trước để script bắt được socket.");

    const piece = findPieceBySquare(move.from);
    if (!piece) throw new Error(`Không tìm thấy quân ở ô ${move.from}`);

    const to = squareToPoint(move.to);
    if (!to) throw new Error(`Ô đích không hợp lệ: ${move.to}`);

    const confirmMessage = options.message || `Đi ${suggestion?.vi || move.from + ' -> ' + move.to}?`;
    if (options.confirm !== false && typeof window.confirm === "function") {
      const accepted = window.confirm(confirmMessage);
      if (!accepted) {
        return { ok: false, cancelled: true, move, piece: clone(piece) };
      }
    }

    const fromPoint = clone(piece.point);
    const payload = {
      from: fromPoint,
      to,
      pieceId: piece.id,
      player: piece.player
    };

    const playerAddress = resolvePlayerAddress();
    if (!playerAddress) throw new Error("Chưa suy ra được player address để gửi move");

    sendPixieMoveEvent("select_point", socketGameId || getGameId(), playerAddress, fromPoint);
    await delay(Number.isFinite(options.delayMs) ? Number(options.delayMs) : 180);
    sendPixieMoveEvent("move", socketGameId || getGameId(), playerAddress, payload);
    lastMoveExecution = {
      at: new Date().toISOString(),
      move: clone(move),
      payload: clone(payload),
      piece: clone(piece),
      suggestion: clone(suggestion)
    };
    return { ok: true, cancelled: false, move, piece: clone(piece), payload: clone(payload) };
  }

  function detectLastMove(prevState, currState) {
    if (!prevState || !currState) return null;

    const prevById = new Map((prevState.pieces || []).map(p => [p.id, p]));
    const changes = [];

    for (const curr of currState.pieces || []) {
      const prev = prevById.get(curr.id);
      if (!prev) continue;

      const prevX = prev.point ? Number(prev.point.x) : null;
      const prevY = prev.point ? Number(prev.point.y) : null;
      const currX = curr.point ? Number(curr.point.x) : null;
      const currY = curr.point ? Number(curr.point.y) : null;

      const moved = prevX !== currX || prevY !== currY;
      const capturedChanged = Boolean(prev.captured) !== Boolean(curr.captured);

      if (moved || capturedChanged) {
        changes.push({ prev, curr, moved, capturedChanged });
      }
    }

    const movedPiece = changes.find(x =>
      x.moved &&
      x.prev.point &&
      x.curr.point &&
      !x.curr.captured
    );

    if (!movedPiece) return null;

    return {
      player: movedPiece.curr.player === 0 ? "white" : "black",
      playerId: movedPiece.curr.player,
      piece: movedPiece.curr.subKey || movedPiece.curr.key,
      from: toSquare(movedPiece.prev.point),
      to: toSquare(movedPiece.curr.point)
    };
  }

  function inferSideToMove(prevState, currState, turnIndex) {
    const lastMove = detectLastMove(prevState, currState);

    if (lastMove) {
      return lastMove.playerId === 0 ? "b" : "w";
    }

    return turnIndex % 2 === 0 ? "w" : "b";
  }

  function getStringField(obj, names) {
    if (!obj || typeof obj !== "object") return null;
    for (const name of names) {
      if (typeof obj[name] === "string" && obj[name].trim()) return obj[name].trim();
      if (typeof obj[name] === "number") return String(obj[name]);
    }
    return null;
  }

  function sideFromPlayerIndex(value) {
    const side = normalizeSide(value);
    if (side === "w" || side === "b") return side;
    return null;
  }

  function sideFromObject(value) {
    if (!value || typeof value !== "object") return null;
    const sideKeys = ["side", "color", "colour", "playerSide", "playerColor", "playerColour"];
    for (const key of sideKeys) {
      const side = normalizeSide(value[key]);
      if (side === "w" || side === "b") return side;
    }
    return null;
  }

  function detectSideFromExplicitFields(state) {
    if (!state || typeof state !== "object") return null;

    const sideKeys = [
      "mySide", "myColor", "myColour", "playerSide", "playerColor",
      "localSide", "localColor", "localColour", "userSide", "userColor", "userColour"
    ];

    for (const key of sideKeys) {
      const side = normalizeSide(state[key]);
      if (side === "w" || side === "b") return { side, source: `state.${key}` };
    }

    const indexKeys = [
      "myPlayer", "myPlayerId", "myPlayerIndex", "localPlayer",
      "localPlayerId", "localPlayerIndex", "userPlayer", "userPlayerId",
      "userPlayerIndex", "playerIndex"
    ];

    for (const key of indexKeys) {
      const side = sideFromPlayerIndex(state[key]);
      if (side) return { side, source: `state.${key}` };
    }

    for (const key of ["me", "self", "you", "currentUser", "currentPlayer", "localUser", "user"]) {
      const value = state[key];
      if (!value || typeof value !== "object") continue;

      for (const sideKey of sideKeys) {
        const side = normalizeSide(value[sideKey]);
        if (side === "w" || side === "b") return { side, source: `state.${key}.${sideKey}` };
      }

      for (const indexKey of indexKeys) {
        const side = sideFromPlayerIndex(value[indexKey]);
        if (side) return { side, source: `state.${key}.${indexKey}` };
      }
    }

    return null;
  }

  function collectSelfIds(state) {
    const ids = new Set();
    const idKeys = [
      "id", "userId", "uid", "accountId", "wallet", "walletAddress",
      "address", "playerId", "publicKey", "owner"
    ];

    for (const key of ["me", "self", "you", "currentUser", "localUser", "user"]) {
      const value = state && state[key];
      if (!value || typeof value !== "object") continue;
      for (const idKey of idKeys) {
        const id = getStringField(value, [idKey]);
        if (id) ids.add(id.toLowerCase());
      }
    }

    if (window.ethereum && typeof window.ethereum.selectedAddress === "string") {
      ids.add(window.ethereum.selectedAddress.toLowerCase());
    }

    return ids;
  }

  function detectSideFromPlayers(state) {
    if (!state || typeof state !== "object") return null;

    const playerLists = [state.players, state.participants, state.seats].filter(Array.isArray);
    const flagKeys = ["isMe", "isSelf", "isLocal", "isYou", "me", "self", "you", "local"];

    for (const players of playerLists) {
      for (let i = 0; i < players.length; i++) {
        const player = players[i];
        if (!player || typeof player !== "object") continue;

        if (flagKeys.some(key => player[key] === true)) {
          return { side: sideFromObject(player) || (i === 0 ? "w" : "b"), source: `players[${i}].flag` };
        }
      }
    }

    const selfIds = collectSelfIds(state);
    if (!selfIds.size) return null;

    const idKeys = [
      "id", "userId", "uid", "accountId", "wallet", "walletAddress",
      "address", "playerId", "publicKey", "owner"
    ];

    for (const players of playerLists) {
      for (let i = 0; i < players.length; i++) {
        const player = players[i];
        if (!player || typeof player !== "object") continue;

        for (const key of idKeys) {
          const id = getStringField(player, [key]);
          if (id && selfIds.has(id.toLowerCase())) {
            return { side: sideFromObject(player) || (i === 0 ? "w" : "b"), source: `players[${i}].${key}` };
          }
        }
      }
    }

    const whiteKeys = ["white", "whitePlayer", "player0", "firstPlayer"];
    const blackKeys = ["black", "blackPlayer", "player1", "secondPlayer"];

    for (const key of whiteKeys) {
      const value = state[key];
      if (typeof value === "string" && selfIds.has(value.toLowerCase())) {
        return { side: "w", source: `state.${key}` };
      }
      if (value && typeof value === "object") {
        for (const idKey of idKeys) {
          const id = getStringField(value, [idKey]);
          if (id && selfIds.has(id.toLowerCase())) return { side: "w", source: `state.${key}.${idKey}` };
        }
      }
    }

    for (const key of blackKeys) {
      const value = state[key];
      if (typeof value === "string" && selfIds.has(value.toLowerCase())) {
        return { side: "b", source: `state.${key}` };
      }
      if (value && typeof value === "object") {
        for (const idKey of idKeys) {
          const id = getStringField(value, [idKey]);
          if (id && selfIds.has(id.toLowerCase())) return { side: "b", source: `state.${key}.${idKey}` };
        }
      }
    }

    return null;
  }

  function detectSideFromDom() {
    const text = (document.body && document.body.innerText || "").slice(0, 20000).toLowerCase();
    const whitePatterns = [
      /you\s+(are|play|as)\s+white/,
      /your\s+side\s*[:\-]\s*white/,
      /bạn\s+(là|chơi)\s+trắng/,
      /phe\s+của\s+bạn\s*[:\-]\s*trắng/
    ];
    const blackPatterns = [
      /you\s+(are|play|as)\s+black/,
      /your\s+side\s*[:\-]\s*black/,
      /bạn\s+(là|chơi)\s+đen/,
      /phe\s+của\s+bạn\s*[:\-]\s*đen/
    ];

    if (whitePatterns.some(pattern => pattern.test(text))) return { side: "w", source: "dom" };
    if (blackPatterns.some(pattern => pattern.test(text))) return { side: "b", source: "dom" };
    return null;
  }

  function resolveMySide(state) {
    const pref = getSidePreference();
    if (pref === "w" || pref === "b") {
      return { side: pref, preference: pref, source: "manual" };
    }

    const detected =
      detectSideFromExplicitFields(state) ||
      detectSideFromPlayers(state) ||
      detectSideFromDom();

    if (detected) return { ...detected, preference: "auto" };
    return { side: null, preference: "auto", source: "unknown" };
  }

  function stateToFen(prevState, currState, turnIndex) {
    const board = Array.from({ length: 8 }, () => Array(8).fill(null));

    for (const p of currState.pieces || []) {
      if (!p || p.captured || !p.point) continue;

      const x = Number(p.point.x);
      const y = Number(p.point.y);

      if (x < 0 || x > 7 || y < 0 || y > 7) continue;

      let symbol = pieceMap[p.subKey] || pieceMap[p.key] || "?";
      if (p.player === 0) symbol = symbol.toUpperCase();

      board[7 - y][x] = symbol;
    }

    const placement = board.map(row => {
      let out = "";
      let empty = 0;

      for (const cell of row) {
        if (!cell) {
          empty++;
        } else {
          if (empty) {
            out += empty;
            empty = 0;
          }
          out += cell;
        }
      }

      if (empty) out += empty;
      return out;
    }).join("/");

    const sideToMove = inferSideToMove(prevState, currState, turnIndex);
    const fullMove = Math.floor(turnIndex / 2) + 1;

    return `${placement} ${sideToMove} - - 0 ${fullMove}`;
  }

  function parseFenBoard(fen) {
    const [placement, turn] = fen.split(" ");
    const rows = placement.split("/");
    const board = [];

    for (let r = 0; r < 8; r++) {
      const row = [];
      for (const ch of rows[r]) {
        if (/\d/.test(ch)) {
          const count = Number(ch);
          for (let i = 0; i < count; i++) row.push(null);
        } else {
          row.push(ch);
        }
      }
      board.push(row);
    }

    return { board, turn };
  }

  function cloneBoard(board) {
    return board.map(row => row.slice());
  }

  function isWhite(piece) {
    return piece && piece === piece.toUpperCase();
  }

  function isBlack(piece) {
    return piece && piece === piece.toLowerCase();
  }

  function sameColor(a, b) {
    if (!a || !b) return false;
    return (isWhite(a) && isWhite(b)) || (isBlack(a) && isBlack(b));
  }

  function opponentColor(side) {
    return side === "w" ? "b" : "w";
  }

  function pieceType(piece) {
    return piece.toLowerCase();
  }

  function squareName(row, col) {
    return "abcdefgh"[col] + String(8 - row);
  }

  function inside(r, c) {
    return r >= 0 && r < 8 && c >= 0 && c < 8;
  }

  function findKing(board, side) {
    const target = side === "w" ? "K" : "k";
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (board[r][c] === target) return [r, c];
      }
    }
    return null;
  }

  function pseudoMovesForPiece(board, row, col) {
    const piece = board[row][col];
    if (!piece) return [];

    const moves = [];
    const type = pieceType(piece);
    const white = isWhite(piece);

    function pushStep(r, c) {
      if (!inside(r, c)) return;
      const target = board[r][c];
      if (!target || !sameColor(piece, target)) {
        moves.push({ fromRow: row, fromCol: col, toRow: r, toCol: c });
      }
    }

    function pushSlides(directions) {
      for (const [dr, dc] of directions) {
        let r = row + dr;
        let c = col + dc;
        while (inside(r, c)) {
          const target = board[r][c];
          if (!target) {
            moves.push({ fromRow: row, fromCol: col, toRow: r, toCol: c });
          } else {
            if (!sameColor(piece, target)) {
              moves.push({ fromRow: row, fromCol: col, toRow: r, toCol: c });
            }
            break;
          }
          r += dr;
          c += dc;
        }
      }
    }

    if (type === "p") {
      const dir = white ? -1 : 1;
      const startRow = white ? 6 : 1;

      const oneStep = row + dir;
      if (inside(oneStep, col) && !board[oneStep][col]) {
        moves.push({ fromRow: row, fromCol: col, toRow: oneStep, toCol: col });
        const twoStep = row + dir * 2;
        if (row === startRow && inside(twoStep, col) && !board[twoStep][col]) {
          moves.push({ fromRow: row, fromCol: col, toRow: twoStep, toCol: col });
        }
      }

      for (const dc of [-1, 1]) {
        const r = row + dir;
        const c = col + dc;
        if (!inside(r, c)) continue;
        const target = board[r][c];
        if (target && !sameColor(piece, target)) {
          moves.push({ fromRow: row, fromCol: col, toRow: r, toCol: c });
        }
      }
    } else if (type === "n") {
      const jumps = [
        [-2, -1], [-2, 1], [-1, -2], [-1, 2],
        [1, -2], [1, 2], [2, -1], [2, 1]
      ];
      for (const [dr, dc] of jumps) pushStep(row + dr, col + dc);
    } else if (type === "b") {
      pushSlides([[-1, -1], [-1, 1], [1, -1], [1, 1]]);
    } else if (type === "r") {
      pushSlides([[-1, 0], [1, 0], [0, -1], [0, 1]]);
    } else if (type === "q") {
      pushSlides([
        [-1, -1], [-1, 1], [1, -1], [1, 1],
        [-1, 0], [1, 0], [0, -1], [0, 1]
      ]);
    } else if (type === "k") {
      const dirs = [
        [-1, -1], [-1, 0], [-1, 1],
        [0, -1],           [0, 1],
        [1, -1],  [1, 0],  [1, 1]
      ];
      for (const [dr, dc] of dirs) pushStep(row + dr, col + dc);
    }

    return moves;
  }

  function attackedSquaresForPiece(board, row, col) {
    const piece = board[row][col];
    if (!piece) return [];

    const attacks = [];
    const type = pieceType(piece);
    const white = isWhite(piece);

    function push(r, c) {
      if (inside(r, c)) attacks.push([r, c]);
    }

    function pushSlides(directions) {
      for (const [dr, dc] of directions) {
        let r = row + dr;
        let c = col + dc;
        while (inside(r, c)) {
          attacks.push([r, c]);
          if (board[r][c]) break;
          r += dr;
          c += dc;
        }
      }
    }

    if (type === "p") {
      const dir = white ? -1 : 1;
      push(row + dir, col - 1);
      push(row + dir, col + 1);
    } else if (type === "n") {
      for (const [dr, dc] of [
        [-2, -1], [-2, 1], [-1, -2], [-1, 2],
        [1, -2], [1, 2], [2, -1], [2, 1]
      ]) {
        push(row + dr, col + dc);
      }
    } else if (type === "b") {
      pushSlides([[-1, -1], [-1, 1], [1, -1], [1, 1]]);
    } else if (type === "r") {
      pushSlides([[-1, 0], [1, 0], [0, -1], [0, 1]]);
    } else if (type === "q") {
      pushSlides([
        [-1, -1], [-1, 1], [1, -1], [1, 1],
        [-1, 0], [1, 0], [0, -1], [0, 1]
      ]);
    } else if (type === "k") {
      for (const [dr, dc] of [
        [-1, -1], [-1, 0], [-1, 1],
        [0, -1],           [0, 1],
        [1, -1],  [1, 0],  [1, 1]
      ]) {
        push(row + dr, col + dc);
      }
    }

    return attacks;
  }

  function applyMove(board, move) {
    const next = cloneBoard(board);
    let piece = next[move.fromRow][move.fromCol];
    next[move.fromRow][move.fromCol] = null;

    if (piece && pieceType(piece) === "p") {
      if (isWhite(piece) && move.toRow === 0) piece = "Q";
      if (isBlack(piece) && move.toRow === 7) piece = "q";
    }

    next[move.toRow][move.toCol] = piece;
    return next;
  }

  function isSquareAttacked(board, row, col, bySide) {
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const piece = board[r][c];
        if (!piece) continue;

        if (bySide === "w" && !isWhite(piece)) continue;
        if (bySide === "b" && !isBlack(piece)) continue;

        for (const [toRow, toCol] of attackedSquaresForPiece(board, r, c)) {
          if (toRow === row && toCol === col) {
            return true;
          }
        }
      }
    }
    return false;
  }

  function inCheck(board, side) {
    const kingPos = findKing(board, side);
    if (!kingPos) return true;
    return isSquareAttacked(board, kingPos[0], kingPos[1], opponentColor(side));
  }

  function generateLegalMoves(board, side) {
    const moves = [];

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const piece = board[r][c];
        if (!piece) continue;

        if (side === "w" && !isWhite(piece)) continue;
        if (side === "b" && !isBlack(piece)) continue;

        const pseudo = pseudoMovesForPiece(board, r, c);
        for (const move of pseudo) {
          const next = applyMove(board, move);
          if (!inCheck(next, side)) {
            const movedPiece = pieceType(piece);
            moves.push({
              ...move,
              piece: movedPiece,
              from: squareName(move.fromRow, move.fromCol),
              to: squareName(move.toRow, move.toCol)
            });
          }
        }
      }
    }

    return moves;
  }

  function evaluateSimple(board) {
    let score = 0;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const piece = board[r][c];
        if (!piece) continue;
        const value = pieceValues[piece.toLowerCase()] || 0;
        score += isWhite(piece) ? value : -value;
      }
    }
    return score;
  }

  function minimax(board, side, depth, alpha, beta, maximizing) {
    const legalMoves = generateLegalMoves(board, side);

    if (depth === 0 || legalMoves.length === 0) {
      if (legalMoves.length === 0) {
        if (inCheck(board, side)) {
          return side === "w" ? -99999 : 99999;
        }
        return 0;
      }
      return evaluateSimple(board);
    }

    if (maximizing) {
      let maxEval = -Infinity;
      for (const move of legalMoves) {
        const next = applyMove(board, move);
        const evalScore = minimax(next, opponentColor(side), depth - 1, alpha, beta, false);
        maxEval = Math.max(maxEval, evalScore);
        alpha = Math.max(alpha, evalScore);
        if (beta <= alpha) break;
      }
      return maxEval;
    }

    let minEval = Infinity;
    for (const move of legalMoves) {
      const next = applyMove(board, move);
      const evalScore = minimax(next, opponentColor(side), depth - 1, alpha, beta, true);
      minEval = Math.min(minEval, evalScore);
      beta = Math.min(beta, evalScore);
      if (beta <= alpha) break;
    }
    return minEval;
  }

  function sanLike(move) {
    const pieceLetterMap = {
      p: "",
      n: "N",
      b: "B",
      r: "R",
      q: "Q",
      k: "K"
    };
    return `${pieceLetterMap[move.piece] || ""}${move.to}`;
  }

  function moveFromUci(board, uci) {
    if (typeof uci !== "string" || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;

    const fromCol = uci.charCodeAt(0) - 97;
    const fromRow = 8 - Number(uci[1]);
    const toCol = uci.charCodeAt(2) - 97;
    const toRow = 8 - Number(uci[3]);
    const piece = board[fromRow] && board[fromRow][fromCol];
    if (!piece) return null;

    return {
      fromRow,
      fromCol,
      toRow,
      toCol,
      piece: pieceType(piece),
      from: squareName(fromRow, fromCol),
      to: squareName(toRow, toCol)
    };
  }

  function findBestMove(fen, depth = 3) {
    const parsed = parseFenBoard(fen);
    const side = parsed.turn;
    const legalMoves = generateLegalMoves(parsed.board, side);

    if (!legalMoves.length) return null;

    let bestMove = null;

    if (side === "w") {
      let bestScore = -Infinity;
      for (const move of legalMoves) {
        const next = applyMove(parsed.board, move);
        const score = minimax(next, "b", depth - 1, -Infinity, Infinity, false);
        if (score > bestScore) {
          bestScore = score;
          bestMove = { ...move, score };
        }
      }
    } else {
      let bestScore = Infinity;
      for (const move of legalMoves) {
        const next = applyMove(parsed.board, move);
        const score = minimax(next, "w", depth - 1, -Infinity, Infinity, true);
        if (score < bestScore) {
          bestScore = score;
          bestMove = { ...move, score };
        }
      }
    }

    if (!bestMove) return null;

    return {
      ...bestMove,
      san: sanLike(bestMove),
      uci: `${bestMove.from}${bestMove.to}`
    };
  }

  function suggestionFromMove(move, engine, extra = {}) {
    if (!move) {
      return {
        san: "-",
        uci: "-",
        vi: "Không có nước đi hợp lệ",
        engine
      };
    }

    const pieceName = pieceNamesVi[move.piece || "p"] || "Quân";
    const vi = `Đi ${pieceName} từ ${move.from} tới ${move.to}`;

    return {
      san: move.san || sanLike(move),
      uci: move.uci || `${move.from}${move.to}`,
      vi,
      move,
      engine,
      ...extra
    };
  }

  async function buildStockfishSuggestion(fen) {
    const response = await requestJson(getStockfishServerUrl(), {
      fen,
      depth: STOCKFISH_DEPTH,
      movetime: STOCKFISH_MOVETIME_MS,
      multipv: STOCKFISH_MULTIPV,
      avoidMajorTrades: AVOID_MAJOR_TRADES,
      styleWindowCp: STYLE_WINDOW_CP,
      majorTradePenaltyCp: MAJOR_TRADE_PENALTY_CP
    }, STOCKFISH_MOVETIME_MS + 5000);

    if (!response || response.ok === false) {
      throw new Error(response && response.error ? response.error : "Stockfish response không hợp lệ");
    }

    if (!response.bestmove || response.bestmove === "(none)") {
      return suggestionFromMove(null, "stockfish");
    }

    const parsed = parseFenBoard(fen);
    const move = moveFromUci(parsed.board, response.bestmove);
    if (!move) throw new Error(`Stockfish trả về nước không đọc được: ${response.bestmove}`);

    return suggestionFromMove({
      ...move,
      uci: response.bestmove,
      san: response.bestmove
    }, "stockfish", {
      score: response.score || null,
      raw: response.raw || null
    });
  }

  function buildMinimaxSuggestion(fen) {
    try {
      const move = findBestMove(fen, MINIMAX_FALLBACK_DEPTH);
      return suggestionFromMove(move, "minimax");
    } catch (err) {
      return {
        san: "-",
        uci: "-",
        vi: `Lỗi suggest: ${err.message}`,
        engine: "minimax"
      };
    }
  }

  async function buildSuggestion(fen) {
    if (ENGINE_MODE !== "stockfish") return buildMinimaxSuggestion(fen);

    try {
      return await buildStockfishSuggestion(fen);
    } catch (err) {
      const fallback = buildMinimaxSuggestion(fen);
      return {
        ...fallback,
        engine: "minimax fallback",
        warning: err.message
      };
    }
  }

  function waitingSuggestion(reason) {
    return {
      san: "-",
      uci: "-",
      vi: reason,
      engine: "none"
    };
  }

  function redactForDebug(value, depth = 0) {
    if (value == null) return value;
    if (depth > 5) return "[depth-limit]";

    if (typeof value === "string") {
      if (/^0x[a-f0-9]{20,}$/i.test(value)) return `${value.slice(0, 8)}...${value.slice(-4)}`;
      if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)) return "[email]";
      if (value.length > 80) return `${value.slice(0, 24)}...[${value.length}]`;
      return value;
    }

    if (typeof value !== "object") return value;

    if (Array.isArray(value)) {
      return value.slice(0, 12).map(item => redactForDebug(item, depth + 1));
    }

    const secretKeyPattern = /(token|secret|password|cookie|session|auth|key|private|mnemonic|seed)/i;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (secretKeyPattern.test(key)) {
        out[key] = "[redacted]";
      } else {
        out[key] = redactForDebug(item, depth + 1);
      }
    }
    return out;
  }

  function copyText(text) {
    if (typeof GM_setClipboard === "function") {
      GM_setClipboard(text);
      return;
    }
    navigator.clipboard.writeText(text).catch(() => {});
  }

  function copyDebugState() {
    if (!lastStateForDebug) return;
    const payload = {
      gameId: getGameId(),
      url: location.href,
      sidePreference: getSidePreference(),
      detectedSide: window.__pixie_my_side || null,
      latestInfo: redactForDebug(window.__pixie_latest_info || null),
      state: redactForDebug(lastStateForDebug)
    };
    copyText(JSON.stringify(payload, null, 2));
  }

  function clearSuggestedMoveOverlay() {
    const old = document.getElementById("pixie-auto-fen-overlay");
    if (old) old.remove();
    lastOverlayKey = "";
  }

  function findBoardRect() {
    const selectors = [
      "[class*='board']",
      "[id*='board']",
      "canvas",
      "svg"
    ];

    const candidates = [];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 240 || rect.height < 240) continue;
        const ratio = rect.width / rect.height;
        if (ratio < 0.75 || ratio > 1.35) continue;
        candidates.push({ el, rect, area: rect.width * rect.height });
      }
    }

    candidates.sort((a, b) => b.area - a.area);
    return candidates.length ? candidates[0].rect : null;
  }

  function highlightSuggestedMove(move) {
    if (!move || move.fromCol == null || move.toCol == null) return;

    const rect = findBoardRect();
    if (!rect) return;

    const size = Math.min(rect.width, rect.height);
    const left = rect.left + (rect.width - size) / 2;
    const top = rect.top + (rect.height - size) / 2;
    const cell = size / 8;
    const overlayKey = [
      move.fromRow,
      move.fromCol,
      move.toRow,
      move.toCol,
      Math.round(left),
      Math.round(top),
      Math.round(size)
    ].join(":");

    if (overlayKey === lastOverlayKey) return;

    let overlay = document.getElementById("pixie-auto-fen-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "pixie-auto-fen-overlay";
      document.body.appendChild(overlay);
    }

    overlay.style.cssText = `
      position: fixed;
      left: ${left}px;
      top: ${top}px;
      width: ${size}px;
      height: ${size}px;
      z-index: 999998;
      pointer-events: none;
    `;
    overlay.replaceChildren();

    function square(row, col, color, borderColor) {
      const el = document.createElement("div");
      el.style.cssText = `
        position: absolute;
        left: ${col * cell}px;
        top: ${row * cell}px;
        width: ${cell}px;
        height: ${cell}px;
        background: ${color};
        border: 3px solid ${borderColor};
        box-sizing: border-box;
        box-shadow: 0 0 18px ${borderColor};
      `;
      overlay.appendChild(el);
    }

    square(move.fromRow, move.fromCol, "rgba(255, 214, 90, .28)", "rgba(255, 214, 90, .95)");
    square(move.toRow, move.toCol, "rgba(80, 255, 140, .32)", "rgba(80, 255, 140, .95)");
    lastOverlayKey = overlayKey;
  }

  function buildPanelStateKey(info) {
    return JSON.stringify({
      fen: info.fen,
      sideToMove: info.sideToMove,
      mySide: info.mySide,
      sidePreference: info.sidePreference,
      suggestionVi: info.suggestion?.vi || "",
      suggestionUci: info.suggestion?.uci || "",
      suggestionSan: info.suggestion?.san || "",
      suggestionWarning: info.suggestion?.warning || "",
      runtimeReady: moveRuntimeReady()
    });
  }

  function ensurePanel() {
    let panel = document.getElementById("pixie-auto-fen-panel");
    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = "pixie-auto-fen-panel";

    panel.style.cssText = `
      position: fixed;
      left: 12px;
      bottom: 12px;
      z-index: 999999;
      width: min(360px, calc(100vw - 24px));
      box-sizing: border-box;
      padding: 12px;
      border: 1px solid rgba(161, 161, 170, .28);
      border-radius: 8px;
      background: rgba(24, 24, 27, .94);
      color: #e5e7eb;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 12px;
      line-height: 1.35;
      box-shadow: 0 12px 34px rgba(0, 0, 0, .34);
      backdrop-filter: blur(6px);
    `;

    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;">
        <div>
          <div style="font-size:11px;color:#a1a1aa;text-transform:uppercase;letter-spacing:0;">Pixie Chess</div>
          <div id="pixie-auto-fen-title" style="font-size:15px;font-weight:700;color:#f8fafc;">Đang đọc ván...</div>
        </div>
        <button id="pixie-auto-fen-hide" title="Ẩn popup" style="width:28px;height:28px;cursor:pointer;border:1px solid rgba(161, 161, 170, .35);border-radius:6px;background:rgba(39, 39, 42, .65);color:#d4d4d8;font-size:16px;line-height:1;">×</button>
      </div>
      <div id="pixie-auto-fen-status" style="margin-bottom:10px;padding:8px 10px;border-radius:7px;background:rgba(39, 39, 42, .78);color:#d4d4d8;">Đang chờ dữ liệu...</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
        <div style="padding:8px;border-radius:7px;background:rgba(39, 39, 42, .58);">
          <div style="color:#a1a1aa;font-size:11px;margin-bottom:2px;">Phe bạn</div>
          <div id="pixie-auto-fen-my-side" style="font-weight:700;color:#f8fafc;">Auto</div>
        </div>
        <div style="padding:8px;border-radius:7px;background:rgba(39, 39, 42, .58);">
          <div style="color:#a1a1aa;font-size:11px;margin-bottom:2px;">Tới lượt</div>
          <div id="pixie-auto-fen-turn" style="font-weight:700;color:#f8fafc;">-</div>
        </div>
      </div>
      <div id="pixie-auto-fen-side-controls" style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px;">
        <button data-side="auto" style="cursor:pointer;border:1px solid rgba(161, 161, 170, .35);border-radius:6px;padding:6px 4px;background:#fafafa;color:#18181b;font-size:12px;">Auto</button>
        <button data-side="w" style="cursor:pointer;border:1px solid rgba(161, 161, 170, .35);border-radius:6px;padding:6px 4px;background:#fafafa;color:#18181b;font-size:12px;">Trắng</button>
        <button data-side="b" style="cursor:pointer;border:1px solid rgba(161, 161, 170, .35);border-radius:6px;padding:6px 4px;background:#fafafa;color:#18181b;font-size:12px;">Đen</button>
      </div>
      <div style="margin-bottom:10px;">
        <div style="color:#a1a1aa;font-size:11px;margin-bottom:3px;">Gợi ý</div>
        <div id="pixie-auto-fen-suggest-main" style="font-size:16px;font-weight:800;color:#86efac;">Chưa có gợi ý</div>
        <div id="pixie-auto-fen-suggest-extra" style="margin-top:4px;color:#d4d4d8;">-</div>
      </div>
      <div id="pixie-auto-fen-warning" style="display:none;margin-bottom:10px;padding:8px 10px;border-radius:7px;background:rgba(127, 29, 29, .55);color:#fecaca;"></div>
      <div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;">
        <button id="pixie-auto-fen-move-btn" style="cursor:pointer;border:1px solid rgba(134, 239, 172, .45);border-radius:6px;padding:9px 10px;background:#14532d;color:#dcfce7;font-size:13px;font-weight:700;">Đi nước gợi ý</button>
        <div id="pixie-auto-fen-move-status" style="font-size:11px;color:#a1a1aa;text-align:right;">Chưa sẵn sàng</div>
      </div>
    `;

    document.body.appendChild(panel);

    panel.querySelector("#pixie-auto-fen-hide").onclick = () => {
      panel.style.display = "none";
    };

    for (const button of panel.querySelectorAll("#pixie-auto-fen-side-controls button")) {
      button.onclick = () => setSidePreference(button.dataset.side);
    }

    panel.querySelector("#pixie-auto-fen-move-btn").onclick = async () => {
      try {
        const result = await executeSuggestedMove();
        const statusEl = panel.querySelector("#pixie-auto-fen-move-status");
        if (result.cancelled) {
          statusEl.textContent = "Đã hủy";
          statusEl.style.color = "#fde68a";
          return;
        }
        statusEl.textContent = `Đã gửi ${result.move.from} → ${result.move.to}`;
        statusEl.style.color = "#86efac";
      } catch (err) {
        const statusEl = panel.querySelector("#pixie-auto-fen-move-status");
        statusEl.textContent = err.message;
        statusEl.style.color = "#fecaca";
        console.error("[Pixie MOVE]", err);
      }
    };

    return panel;
  }

  function updateSideButtons(panel, preference) {
    for (const button of panel.querySelectorAll("#pixie-auto-fen-side-controls button")) {
      const active = button.dataset.side === preference;
      button.style.background = active ? "#86efac" : "rgba(39, 39, 42, .65)";
      button.style.borderColor = active ? "#86efac" : "rgba(161, 161, 170, .35)";
      button.style.color = active ? "#052e16" : "#d4d4d8";
      button.style.fontWeight = active ? "700" : "400";
    }
  }

  function formatMoveCode(suggestion) {
    if (!suggestion) return "-";
    const uci = suggestion.uci && suggestion.uci !== "-" ? suggestion.uci : "";
    const san = suggestion.san && suggestion.san !== "-" && suggestion.san !== uci ? suggestion.san : "";
    return [uci, san].filter(Boolean).join(" / ") || "-";
  }

  function formatWarning(warning) {
    return warning ? "Stockfish lỗi, dùng gợi ý dự phòng." : "";
  }

  function updatePanel(info) {
    const panel = ensurePanel();
    const mySide = info.mySide;
    const hasMySide = mySide === "w" || mySide === "b";
    const myTurn = hasMySide && info.sideToMove === mySide;

    updateSideButtons(panel, info.sidePreference);

    panel.querySelector("#pixie-auto-fen-title").textContent =
      hasMySide ? `Bạn cầm ${sideName(mySide)}` : "Chưa xác định phe";
    panel.querySelector("#pixie-auto-fen-my-side").textContent =
      hasMySide ? sideName(mySide) : "Chưa rõ";
    panel.querySelector("#pixie-auto-fen-turn").textContent = sideName(info.sideToMove);

    let mainText;
    let statusText;
    let statusColor;
    let suggestColor;

    if (!hasMySide) {
      statusText = "Chọn phe để bật gợi ý.";
      statusColor = "#fecaca";
      suggestColor = "#fecaca";
      mainText = "Chưa có gợi ý";
    } else if (myTurn) {
      statusText = "Đến lượt bạn.";
      statusColor = "#bbf7d0";
      suggestColor = "#86efac";
      mainText = info.suggestion.vi || "Đang tính...";
    } else {
      statusText = "Đang chờ đối thủ.";
      statusColor = "#fde68a";
      suggestColor = "#fde68a";
      mainText = "Chưa cần đi";
    }

    const statusEl = panel.querySelector("#pixie-auto-fen-status");
    statusEl.textContent = statusText;
    statusEl.style.color = statusColor;

    const suggestionEl = panel.querySelector("#pixie-auto-fen-suggest-main");
    suggestionEl.textContent = mainText;
    suggestionEl.style.color = suggestColor;

    panel.querySelector("#pixie-auto-fen-suggest-extra").textContent =
      myTurn ? formatMoveCode(info.suggestion) : "-";

    const warningEl = panel.querySelector("#pixie-auto-fen-warning");
    if (info.suggestion.warning && myTurn) {
      warningEl.style.display = "block";
      warningEl.textContent = formatWarning(info.suggestion.warning);
    } else {
      warningEl.style.display = "none";
      warningEl.textContent = "";
    }

    const moveButton = panel.querySelector("#pixie-auto-fen-move-btn");
    const moveStatus = panel.querySelector("#pixie-auto-fen-move-status");
    const runtimeReady = moveRuntimeReady();
    const hasMove = Boolean(getSuggestedMoveData(info.suggestion));
    const canMoveNow = myTurn && hasMove && runtimeReady;
    moveButton.disabled = !canMoveNow;
    moveButton.style.opacity = canMoveNow ? "1" : ".55";
    moveButton.style.cursor = canMoveNow ? "pointer" : "not-allowed";
    moveButton.style.background = canMoveNow ? "#14532d" : "rgba(39, 39, 42, .65)";
    moveButton.style.borderColor = canMoveNow ? "rgba(134, 239, 172, .45)" : "rgba(161, 161, 170, .35)";
    moveButton.style.color = canMoveNow ? "#dcfce7" : "#d4d4d8";

    if (!myTurn) {
      moveStatus.textContent = "Chờ tới lượt";
      moveStatus.style.color = "#a1a1aa";
    } else if (!hasMove) {
      moveStatus.textContent = "Chưa có nước gợi ý";
      moveStatus.style.color = "#fecaca";
    } else if (!runtimeReady) {
      moveStatus.textContent = "Cần bắt socket trước";
      moveStatus.style.color = "#fde68a";
    } else {
      moveStatus.textContent = "Sẵn sàng gửi move";
      moveStatus.style.color = "#86efac";
    }

    if (myTurn && info.suggestion.move) {
      highlightSuggestedMove(info.suggestion.move);
    } else {
      clearSuggestedMoveOverlay();
    }
  }

  async function tick() {
    if (tickBusy) return;
    tickBusy = true;

    try {
      const states = getStates();
      if (!states.length) return;

      const curr = states.at(-1);
      const prev = states.length >= 2 ? states.at(-2) : null;
      lastStateForDebug = curr.state;

      const fen = stateToFen(prev?.state, curr.state, curr.turnIndex);
      const pieces = curr.state.pieces.filter(p => !p.captured).length;
      const lastMove = prev ? detectLastMove(prev.state, curr.state) : null;
      const sideToMove = fen.split(" ")[1];
      const mySideInfo = resolveMySide(curr.state);
      const hasMySide = mySideInfo.side === "w" || mySideInfo.side === "b";
      const myTurn = hasMySide && sideToMove === mySideInfo.side;

      const infoBase = {
        gameId: getGameId(),
        key: curr.key,
        turnIndex: curr.turnIndex,
        fen,
        pieces,
        lastMove,
        sideToMove,
        mySide: mySideInfo.side,
        sidePreference: mySideInfo.preference,
        mySideSource: mySideInfo.source,
        stockfishUrl: getStockfishServerUrl()
      };

      const shouldComputeSuggestion = !COMPUTE_ONLY_ON_MY_TURN || myTurn;
      const suggestionKey = shouldComputeSuggestion ? fen : "";
      const shouldRecomputeSuggestion = shouldComputeSuggestion && (lastSuggestionKey !== suggestionKey || !lastSuggestion);

      if (!shouldComputeSuggestion) {
        lastSuggestion = waitingSuggestion(hasMySide ? "Chờ đối thủ đi..." : "Chọn phe để bật gợi ý.");
        lastSuggestionKey = "";
      }

      if (shouldRecomputeSuggestion) {
        lastSuggestion = {
          san: "...",
          uci: "...",
          vi: ENGINE_MODE === "stockfish" ? "Đang hỏi Stockfish server..." : "Đang tính nước đi...",
          engine: ENGINE_MODE
        };
        lastSuggestionKey = suggestionKey;
        updatePanel({ ...infoBase, suggestion: lastSuggestion });

        lastSuggestion = await buildSuggestion(fen);
      }

      const info = {
        ...infoBase,
        suggestion: lastSuggestion
      };

      const panelStateKey = buildPanelStateKey(info);

      if (fen === lastFen && panelStateKey === lastPanelStateKey) {
        return;
      }

      window.__pixie_latest_fen = fen;
      window.__pixie_latest_info = info;
      window.__pixie_last_move = lastMove;
      window.__pixie_suggestion = lastSuggestion;
      window.__pixie_my_side = mySideInfo.side;
      window.pixieFenMove = {
        executeSuggestedMove: (suggestion, options) => executeSuggestedMove(suggestion, options),
        getSuggestedMoveData: (suggestion) => clone(getSuggestedMoveData(suggestion)),
        findPieceBySquare: (square) => clone(findPieceBySquare(square)),
        moveRuntimeReady: () => moveRuntimeReady(),
        getRuntimeContext: () => ({
          gameId: socketGameId || getGameId(),
          playerAddress: resolvePlayerAddress(),
          hasSocket: Boolean(getMoveSocket()),
          lastMoveExecution: clone(lastMoveExecution)
        })
      };

      updatePanel(info);
      lastPanelStateKey = panelStateKey;

      lastKey = curr.key;
      lastFen = fen;

      console.log("[Pixie FEN UPDATED]", curr.key);
      console.log("FEN:", fen);
      console.log("Side:", {
        sideToMove,
        mySide: mySideInfo.side,
        preference: mySideInfo.preference,
        source: mySideInfo.source
      });
      console.log("Suggestion:", lastSuggestion);

      if (AUTO_COPY_FEN) {
        if (typeof GM_setClipboard === "function") {
          GM_setClipboard(fen);
        } else {
          navigator.clipboard.writeText(fen).catch(() => {});
        }
      }

      window.dispatchEvent(new CustomEvent("pixieFenUpdated", {
        detail: info
      }));
    } finally {
      tickBusy = false;
    }
  }

  function start() {
    installMoveSocketHooks();
    ensurePanel();
    tick().catch(console.error);
    setInterval(() => {
      tick().catch(console.error);
    }, POLL_MS);
    console.log("[Pixie FEN] Auto updater started.");
  }

  if (document.body) {
    start();
  } else {
    window.addEventListener("DOMContentLoaded", start);
  }
})();
