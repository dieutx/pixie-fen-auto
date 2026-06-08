// ==UserScript==
// @name         Pixie Chess FEN + Suggest + Auto Toggle VN
// @namespace    pixie-fen-auto-autoplay
// @version      1.10.1
// @description  Continuously extract latest FEN, suggest next move, and optionally auto-play the suggestion in Pixie Chess
// @updateURL    https://raw.githubusercontent.com/dieutx/pixie-fen-auto/main/pixie-fen-auto-autoplay.user.js
// @downloadURL  https://raw.githubusercontent.com/dieutx/pixie-fen-auto/main/pixie-fen-auto-autoplay.user.js
// @match        https://www.pixiechess.xyz/game/*
// @match        https://pixiechess.xyz/game/*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      your-domain.example
// @connect      localhost
// @connect      127.0.0.1
// @run-at       document-start
// ==/UserScript==
// Changelog 1.10.1:
// - không dùng đồng hồ/timing để quyết định bắt đầu ván hoặc lượt đi
// - chỉ dùng phe Trắng/Đen do người dùng chọn thủ công để lọc bestmove
// - chỉ hỏi Stockfish khi FEN side-to-move trùng phe đã chọn
//
// Changelog 1.10.0:
// - abort request Stockfish đang chạy khi đổi FEN/hết lượt/đổi mode/watchdog timeout
// - xóa hẳn nhánh engine phụ khỏi userscript autoplay
// - nếu Stockfish lỗi thì chỉ báo lỗi, không tự đi nước thay thế
//
// Changelog 1.9.9:
// - mode 100ms cũng gọi Stockfish server
// - chặn retry liên tục trên cùng FEN sau watchdog timeout
// - chỉ nhận bestmove nếu ô xuất phát là quân của bạn

(function () {
  "use strict";

  const CACHE_KEY = "pixie-board-state-cache";
  const SIDE_PREF_PREFIX = "pixie-my-side:";
  const POLL_MS = 250;
  const STOCKFISH_URL_STORAGE_KEY = "pixie-stockfish-server-url";
  const DEFAULT_STOCKFISH_SERVER_URL = "https://your-domain.example/pixie-stockfish/bestmove";
  const STOCKFISH_BULLET_MOVETIME_MS = 100;
  const STOCKFISH_DEPTH = 16;
  const STOCKFISH_FAST_MOVETIME_MS = 1000;
  const STOCKFISH_STRONG_MOVETIME_MS = 3000;
  const STOCKFISH_MAX_MOVETIME_MS = 5000;
  const STOCKFISH_SERVER_TIMEOUT_EXTRA_MS = 5000;
  const SUGGESTION_WATCHDOG_EXTRA_MS = 2500;
  const STOCKFISH_THINK_MODE_STORAGE_KEY = "pixie-stockfish-think-mode";
  const DEFAULT_STOCKFISH_THINK_MODE = "strong";
  const STOCKFISH_MULTIPV = 1;
  const AVOID_MAJOR_TRADES = false;
  const STYLE_WINDOW_CP = 45;
  const MAJOR_TRADE_PENALTY_CP = 80;
  const COMPUTE_ONLY_ON_MY_TURN = true;
  const AUTO_COPY_FEN = false;
  const DEBUG_LOG = false;
  const DEFAULT_MY_SIDE = "auto"; // "auto", "w" = trắng, "b" = đen
  const AUTO_MOVE_PREF_PREFIX = "pixie-auto-move:";
  const DEFAULT_AUTO_MOVE_MODE = "off";

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
  let autoMoveBusy = false;
  let lastAutoMoveKey = "";
  let lastAutoMoveReport = null;
  let cachedGameIdPath = "";
  let cachedGameId = null;
  let cachedStatesGameId = "";
  let cachedStatesRaw = null;
  let cachedStates = [];
  let boardElementCache = null;
  let suggestionRequestSeq = 0;
  let suggestionInFlightKey = "";
  let suggestionInFlightAt = 0;
  let suggestionAbortController = null;
  let engineTimeoutSuggestionKey = "";
  let engineTimeoutReason = "";
  let pendingTickTimer = null;

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
    const path = location.pathname;
    if (path === cachedGameIdPath) return cachedGameId;
    cachedGameIdPath = path;
    const m = path.match(/\/game\/([^/?#]+)/);
    cachedGameId = m ? m[1] : null;
    return cachedGameId;
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
    stopSuggestionRequest();
    lastSuggestionKey = "";
    scheduleTick();
  }

  function normalizeAutoMoveMode(value) {
    const text = String(value || "").trim().toLowerCase();
    if (text === "on") return "on";
    if (text === "off") return "off";
    return null;
  }

  function normalizeStockfishThinkMode(value) {
    const text = String(value || "").trim().toLowerCase();
    if (text === "bullet" || text === "chess" || text === "chess100") return "bullet";
    if (text === "fast") return "fast";
    if (text === "strong") return "strong";
    if (text === "max") return "max";
    return null;
  }

  function getStockfishThinkMode() {
    const saved = normalizeStockfishThinkMode(localStorage.getItem(STOCKFISH_THINK_MODE_STORAGE_KEY));
    return saved || DEFAULT_STOCKFISH_THINK_MODE;
  }

  function setStockfishThinkMode(mode) {
    const normalized = normalizeStockfishThinkMode(mode) || DEFAULT_STOCKFISH_THINK_MODE;
    localStorage.setItem(STOCKFISH_THINK_MODE_STORAGE_KEY, normalized);
    stopSuggestionRequest();
    lastSuggestionKey = "";
    scheduleTick();
  }

  function getStockfishMovetimeMs(mode = getStockfishThinkMode()) {
    if (mode === "bullet") return STOCKFISH_BULLET_MOVETIME_MS;
    if (mode === "fast") return STOCKFISH_FAST_MOVETIME_MS;
    if (mode === "max") return STOCKFISH_MAX_MOVETIME_MS;
    return STOCKFISH_STRONG_MOVETIME_MS;
  }

  function formatStockfishThinkMode(mode = getStockfishThinkMode()) {
    if (mode === "bullet") return `Bullet · Stockfish ${STOCKFISH_BULLET_MOVETIME_MS}ms`;
    if (mode === "fast") return `Fast · ${STOCKFISH_FAST_MOVETIME_MS}ms`;
    if (mode === "max") return `Max · ${STOCKFISH_MAX_MOVETIME_MS}ms`;
    return `Strong · ${STOCKFISH_STRONG_MOVETIME_MS}ms`;
  }

  function getAutoMovePrefKey() {
    const gameId = getGameId();
    return `${AUTO_MOVE_PREF_PREFIX}${gameId || "global"}`;
  }

  function getAutoMoveMode() {
    const saved = normalizeAutoMoveMode(localStorage.getItem(getAutoMovePrefKey()));
    return saved || DEFAULT_AUTO_MOVE_MODE;
  }

  function setAutoMoveMode(mode) {
    const normalized = normalizeAutoMoveMode(mode) || DEFAULT_AUTO_MOVE_MODE;
    localStorage.setItem(getAutoMovePrefKey(), normalized);
    lastPanelStateKey = "";
    lastAutoMoveReport = null;
    scheduleTick();
  }

  function shouldAutoPlay(info) {
    return Boolean(
      info?.myTurn &&
      info?.gameStarted !== false &&
      info?.autoMoveMode === "on" &&
      info?.hasMove &&
      info?.runtimeReady
    );
  }

  function getStockfishServerUrl() {
    const saved = localStorage.getItem(STOCKFISH_URL_STORAGE_KEY);
    return saved && /^https?:\/\//i.test(saved) ? saved : DEFAULT_STOCKFISH_SERVER_URL;
  }

  function parseJson(text, defaultValue) {
    try {
      return JSON.parse(text);
    } catch {
      return defaultValue;
    }
  }

  function abortError(label) {
    const err = new Error(`${label} aborted`);
    err.name = "AbortError";
    return err;
  }

  function isAbortError(err) {
    return err?.name === "AbortError" || /\babort(?:ed)?\b/i.test(String(err?.message || ""));
  }

  function requestJson(url, body, timeout = 5000, label = "server", signal = null) {
    if (signal?.aborted) return Promise.reject(abortError(label));

    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((resolve, reject) => {
        let done = false;
        let request = null;

        const cleanup = () => {
          if (signal) signal.removeEventListener("abort", abortRequest);
        };
        const finish = (fn, value) => {
          if (done) return;
          done = true;
          cleanup();
          fn(value);
        };
        const abortRequest = () => {
          try {
            request?.abort?.();
          } catch {}
          finish(reject, abortError(label));
        };

        if (signal) signal.addEventListener("abort", abortRequest, { once: true });

        request = GM_xmlhttpRequest({
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
              finish(reject, new Error(`HTTP ${response.status}: ${response.responseText || "request failed"}`));
              return;
            }
            finish(resolve, parseJson(response.responseText, null));
          },
          onerror: () => finish(reject, new Error(`Không gọi được ${label}`)),
          ontimeout: () => finish(reject, new Error(`${label} timeout`))
        });

        if (signal?.aborted) abortRequest();
      });
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    const abortRequest = () => controller.abort();
    if (signal) signal.addEventListener("abort", abortRequest, { once: true });

    return fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    }).then(async response => {
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text || "request failed"}`);
      return parseJson(text, null);
    }).catch(err => {
      if (timedOut) throw new Error(`${label} timeout`);
      if (controller.signal.aborted) throw abortError(label);
      throw err;
    }).finally(() => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abortRequest);
    });
  }

  function getStates() {
    const gameId = getGameId();
    if (!gameId) return [];

    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    if (raw === cachedStatesRaw && gameId === cachedStatesGameId) return cachedStates;

    const cache = parseJson(raw, null);
    if (!cache || !Array.isArray(cache.entries)) {
      cachedStatesGameId = gameId;
      cachedStatesRaw = raw;
      cachedStates = [];
      return cachedStates;
    }

    cachedStatesGameId = gameId;
    cachedStatesRaw = raw;
    cachedStates = cache.entries
      .filter(([key]) => typeof key === "string" && key.startsWith(gameId + ":"))
      .map(([key, state]) => ({
        key,
        turnIndex: Number(key.split(":").pop()),
        state: normalizeBoardState(state)
      }))
      .filter(x => Number.isFinite(x.turnIndex) && x.state && Array.isArray(x.state.pieces))
      .sort((a, b) => a.turnIndex - b.turnIndex);
    return cachedStates;
  }

  function normalizeBoardState(state) {
    if (!state || typeof state !== "object") return state;
    if (Array.isArray(state.pieces)) return state;
    if (state.board && Array.isArray(state.board.pieces)) {
      return {
        ...state.board,
        gameId: state.gameId || state.game_id || state.id || state.board.gameId,
        gameDurationMs: state.gameDurationMs ?? state.durationMs ?? state.board.gameDurationMs,
        playerIds: state.playerIds || state.board.playerIds,
        playerStatuses: state.playerStatuses || state.board.playerStatuses,
        players: state.players || state.board.players,
        status: state.status || state.board.status,
        __pixieGame: state
      };
    }
    return state;
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

  function scheduleTick(delayMs = 0) {
    if (pendingTickTimer) return;
    pendingTickTimer = setTimeout(() => {
      pendingTickTimer = null;
      tick().catch(console.error);
    }, delayMs);
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

  function normalizePlayerIndex(value) {
    if (value == null || value === "") return null;
    if (value === 0 || value === "0") return 0;
    if (value === 1 || value === "1") return 1;

    const text = String(value).trim().toLowerCase();
    if (!text) return null;
    const match = text.match(/^(?:player|p)?[\s_-]*([01])$/);
    if (match) return Number(match[1]);

    const side = normalizeSide(text);
    if (side === "w") return 0;
    if (side === "b") return 1;
    return null;
  }

  function playerIndexName(playerIndex) {
    const index = normalizePlayerIndex(playerIndex);
    if (index === 0) return "player 0 / Trắng";
    if (index === 1) return "player 1 / Đen";
    return "player chưa rõ";
  }

  function piecePlayerIndex(piece) {
    if (!piece || typeof piece !== "object") return null;
    return normalizePlayerIndex(piece.player ?? piece.playerIndex ?? piece.player_id ?? piece.ownerPlayer);
  }

  function pieceSide(piece) {
    const playerIndex = piecePlayerIndex(piece);
    if (playerIndex === 0) return "w";
    if (playerIndex === 1) return "b";
    return normalizeSide(piece?.side || piece?.color || piece?.colour || piece?.playerSide || piece?.playerColor);
  }

  function suggestionUsesMyPiece(suggestion, mySide, myPlayerIndex = null) {
    const move = getSuggestedMoveData(suggestion);
    if (!move) return false;
    const piece = findPieceBySquare(move.from);
    if (!piece) return false;

    const expectedPlayerIndex = normalizePlayerIndex(myPlayerIndex);
    if (expectedPlayerIndex !== null) {
      return piecePlayerIndex(piece) === expectedPlayerIndex;
    }

    if (mySide !== "w" && mySide !== "b") return false;
    return pieceSide(piece) === mySide;
  }

  function pieceOwnerLabel(piece) {
    if (!piece) return "ô trống";
    const playerIndex = piecePlayerIndex(piece);
    if (playerIndex !== null) return playerIndexName(playerIndex);
    const side = pieceSide(piece);
    return side ? sideName(side) : "không rõ phe";
  }

  function filterSuggestionForMySide(suggestion, mySide, myPlayerIndex = null) {
    if (!suggestion || suggestion.pending) return suggestion;
    if (suggestionUsesMyPiece(suggestion, mySide, myPlayerIndex)) return suggestion;

    const move = getSuggestedMoveData(suggestion);
    const from = move?.from || "?";
    const piece = move ? findPieceBySquare(from) : null;
    const expectedPlayerIndex = normalizePlayerIndex(myPlayerIndex);
    const expectedOwner = expectedPlayerIndex !== null ? playerIndexName(expectedPlayerIndex) : sideName(mySide);
    return {
      san: "-",
      uci: "-",
      vi: `Bỏ qua bestmove ${from}: không phải quân của bạn`,
      engine: suggestion.engine || "engine",
      warning: `Engine trả nước từ ${from} (${pieceOwnerLabel(piece)}); bạn là ${expectedOwner}`,
      rejectedMove: clone(suggestion)
    };
  }

  async function executeSuggestedMove(suggestion = lastSuggestion, options = {}) {
    const move = getSuggestedMoveData(suggestion);
    if (!move) throw new Error("Chưa có nước gợi ý hợp lệ để đi");
    if (!moveRuntimeReady()) throw new Error("Chưa đủ dữ liệu runtime để gửi move. Hãy chọn/đi một quân tay trước để script bắt được socket.");

    const piece = findPieceBySquare(move.from);
    if (!piece) throw new Error(`Không tìm thấy quân ở ô ${move.from}`);

    const expectedPlayerIndex = normalizePlayerIndex(options.myPlayerIndex ?? window.__pixie_my_player_index ?? null);
    if (expectedPlayerIndex !== null) {
      const actualPlayerIndex = piecePlayerIndex(piece);
      if (actualPlayerIndex !== expectedPlayerIndex) {
        throw new Error(`Chặn move: ${move.from} là ${playerIndexName(actualPlayerIndex)}, không phải ${playerIndexName(expectedPlayerIndex)}`);
      }
    } else {
      const expectedSide = options.mySide || window.__pixie_my_side || null;
      if (expectedSide !== "w" && expectedSide !== "b") {
        throw new Error("Chưa xác định được phe/player của bạn để chặn move đối thủ");
      }
      const actualSide = pieceSide(piece);
      if (actualSide !== expectedSide) {
        throw new Error(`Chặn move: ${move.from} là quân ${sideName(actualSide)}, không phải ${sideName(expectedSide)}`);
      }
    }

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

    const movedPieces = changes.filter(x =>
      x.moved &&
      x.prev.point &&
      x.curr.point &&
      !x.curr.captured
    );
    const movedPiece = movedPieces.find(x => pieceKind(x.curr) === "king") ||
      movedPieces.find(x => !x.capturedChanged) ||
      movedPieces[0];

    if (!movedPiece) return null;

    return {
      player: movedPiece.curr.player === 0 ? "white" : "black",
      playerId: movedPiece.curr.player,
      piece: movedPiece.curr.subKey || movedPiece.curr.key,
      from: toSquare(movedPiece.prev.point),
      to: toSquare(movedPiece.curr.point)
    };
  }

  function inferSideToMove(prevState, currState, turnIndex, options) {
    options = options || {};
    if (options.activeSide === "w" || options.activeSide === "b") {
      return options.activeSide;
    }

    const lastMove = detectLastMove(prevState, currState);

    if (lastMove) {
      return lastMove.playerId === 0 ? "b" : "w";
    }

    const historySide = inferSideToMoveFromHistory(currState);
    if (historySide) return historySide;

    return turnIndex % 2 === 0 ? "w" : "b";
  }

  function pieceKind(piece) {
    const kind = String(piece?.subKey || piece?.key || "").trim().toLowerCase();
    return {
      p: "pawn",
      r: "rook",
      n: "knight",
      b: "bishop",
      q: "queen",
      k: "king"
    }[kind] || kind;
  }

  function pieceHasAbility(piece, key) {
    return Array.isArray(piece?.abilities) && piece.abilities.some(ability =>
      ability &&
      ability.key === key &&
      ability.isDisabled !== true &&
      ability.disabled !== true
    );
  }

  function pieceHasMovedFlag(piece) {
    if (!piece || typeof piece !== "object") return null;
    if (piece.state && Object.prototype.hasOwnProperty.call(piece.state, "hasMoved")) {
      return piece.state.hasMoved === true;
    }
    if (Object.prototype.hasOwnProperty.call(piece, "hasMoved")) {
      return piece.hasMoved === true;
    }
    return null;
  }

  function stateHasMoveMetadata(state) {
    return (state?.pieces || []).some(piece =>
      pieceHasMovedFlag(piece) !== null ||
      pieceHasAbility(piece, "king_castle")
    );
  }

  function pieceSquare(piece) {
    return piece?.point ? toSquare(piece.point) : null;
  }

  function statePieceAt(state, square, player, kind) {
    return (state?.pieces || []).find(piece =>
      piece &&
      !piece.captured &&
      piece.player === player &&
      pieceKind(piece) === kind &&
      pieceSquare(piece) === square
    ) || null;
  }

  function historyState(item) {
    return item?.state || item;
  }

  function pieceMovedFromInitialSquare(piece, history) {
    const movedFlag = pieceHasMovedFlag(piece);
    if (movedFlag === true) return true;

    if (!piece?.id || !Array.isArray(history) || !history.length) return movedFlag !== false;
    const startSquare = pieceSquare(piece);
    const firstState = historyState(history[0]);
    const firstSeen = (firstState?.pieces || []).find(candidate => candidate?.id === piece.id);
    if (!firstSeen || firstSeen.captured || pieceSquare(firstSeen) !== startSquare) return true;

    for (const item of history) {
      const state = historyState(item);
      const current = (state?.pieces || []).find(candidate => candidate?.id === piece.id);
      if (!current) continue;
      if (current.captured || pieceSquare(current) !== startSquare) return true;
    }
    return false;
  }

  function historyLooksLikeStartPosition(history) {
    if (!Array.isArray(history) || !history.length) return false;
    const firstItem = history[0];
    if (typeof firstItem?.turnIndex !== "number" || firstItem.turnIndex !== 0) return false;
    const firstState = historyState(firstItem);
    if (!firstState || !Array.isArray(firstState.pieces)) return false;
    const required = [
      ["e1", 0, "king"], ["a1", 0, "rook"], ["h1", 0, "rook"],
      ["e8", 1, "king"], ["a8", 1, "rook"], ["h8", 1, "rook"]
    ];
    return required.every(([square, player, kind]) => statePieceAt(firstState, square, player, kind));
  }

  function inferCastlingRights(currState, history) {
    const historyFromStart = historyLooksLikeStartPosition(history);
    const canUsePixieMetadata = stateHasMoveMetadata(currState);
    if (!historyFromStart && !canUsePixieMetadata) return "-";

    function moved(piece) {
      if (!piece) return true;
      const movedFlag = pieceHasMovedFlag(piece);
      if (movedFlag === true) return true;
      if (historyFromStart) return pieceMovedFromInitialSquare(piece, history);
      return false;
    }

    function canCastleWith(king, rook) {
      if (!king || !rook || moved(king) || moved(rook)) return false;
      if (historyFromStart) return true;
      if (pieceHasAbility(king, "king_castle")) return true;
      return pieceHasMovedFlag(king) === false && pieceHasMovedFlag(rook) === false;
    }

    const rights = [];
    const whiteKing = statePieceAt(currState, "e1", 0, "king");
    if (canCastleWith(whiteKing, statePieceAt(currState, "h1", 0, "rook"))) rights.push("K");
    if (canCastleWith(whiteKing, statePieceAt(currState, "a1", 0, "rook"))) rights.push("Q");

    const blackKing = statePieceAt(currState, "e8", 1, "king");
    if (canCastleWith(blackKing, statePieceAt(currState, "h8", 1, "rook"))) rights.push("k");
    if (canCastleWith(blackKing, statePieceAt(currState, "a8", 1, "rook"))) rights.push("q");

    return rights.join("") || "-";
  }

  function inferEnPassantSquareFromState(currState) {
    const candidates = (currState?.pieces || []).filter(piece =>
      piece &&
      !piece.captured &&
      piece.point &&
      pieceKind(piece) === "pawn" &&
      piece.state?.canBeEnPassanted === true
    );

    for (const pawn of candidates) {
      const x = Number(pawn.point.x);
      const y = Number(pawn.point.y);
      if (x < 0 || x > 7 || y < 0 || y > 7) continue;

      const epY = pawn.player === 0 ? y - 1 : y + 1;
      if (epY < 0 || epY > 7) continue;
      const square = "abcdefgh"[x] + String(epY + 1);
      if (/^[a-h][36]$/.test(square)) return square;
    }

    return "-";
  }

  function isEnPassantDoubleStep(side, fromRank, toRank) {
    const whiteDoubleStep = fromRank === 2 && toRank === 4;
    const blackDoubleStep = fromRank === 7 && toRank === 5;
    if (side === "w") return whiteDoubleStep;
    if (side === "b") return blackDoubleStep;
    return whiteDoubleStep || blackDoubleStep;
  }

  function enPassantTargetSquare(file, epRank) {
    const square = /^[a-h]$/.test(file) && Number.isInteger(epRank) ? `${file}${epRank}` : "-";
    return /^[a-h][36]$/.test(square) ? square : "-";
  }

  function moveSquare(value) {
    if (typeof value === "string") {
      const square = value.trim().toLowerCase();
      return /^[a-h][1-8]$/.test(square) ? square : null;
    }
    return toSquare(value);
  }

  function inferEnPassantSquareFromHistory(currState) {
    const moves = pixiePlayerMoves(currState);
    const last = moves.at(-1);
    if (!last) return "-";

    const ability = (last.abilities || []).find(item =>
      item &&
      item.key === "pawn_doubleStep" &&
      item.from &&
      item.to
    );
    const from = moveSquare(ability?.from || last.isPlayerMove?.from || last.from);
    const to = moveSquare(ability?.to || last.isPlayerMove?.to || last.to);
    if (!from || !to) return "-";

    const fromRank = Number(from[1]);
    const toRank = Number(to[1]);
    if (Math.abs(toRank - fromRank) !== 2) return "-";

    const side = playerIndexToSide(last.player ?? last.isPlayerMove?.player);
    if (!ability && !isEnPassantDoubleStep(side, fromRank, toRank)) return "-";

    const file = from[0];
    const epRank = (fromRank + toRank) / 2;
    return enPassantTargetSquare(file, epRank);
  }

  function inferEnPassantSquare(prevState, currState) {
    const lastMove = detectLastMove(prevState, currState);
    if (!lastMove) {
      const fromState = inferEnPassantSquareFromState(currState);
      return fromState !== "-" ? fromState : inferEnPassantSquareFromHistory(currState);
    }
    const piece = pieceKind({ key: lastMove.piece });
    if (piece !== "pawn") {
      const fromState = inferEnPassantSquareFromState(currState);
      return fromState !== "-" ? fromState : inferEnPassantSquareFromHistory(currState);
    }

    const fromRank = Number(lastMove.from?.[1]);
    const toRank = Number(lastMove.to?.[1]);
    const side = playerIndexToSide(lastMove.playerId);
    if (Math.abs(toRank - fromRank) !== 2 || !isEnPassantDoubleStep(side, fromRank, toRank)) {
      const fromState = inferEnPassantSquareFromState(currState);
      return fromState !== "-" ? fromState : inferEnPassantSquareFromHistory(currState);
    }

    const file = lastMove.from?.[0];
    const epRank = (fromRank + toRank) / 2;
    return enPassantTargetSquare(file, epRank);
  }

  function playerIndexToSide(value) {
    const side = normalizeSide(value);
    if (side === "w" || side === "b") return side;

    const n = Number(value);
    if (n === 0) return "w";
    if (n === 1) return "b";
    return null;
  }

  function pixieHistoryMoves(state) {
    const history = state?.history || state?.board?.history || state?.__pixieGame?.board?.history;
    return Array.isArray(history?.moves) ? history.moves : [];
  }

  function pixiePlayerMoves(state) {
    return pixieHistoryMoves(state).filter(move =>
      move &&
      move.simulated !== true &&
      (move.isPlayerMove || playerIndexToSide(move.player))
    );
  }

  function inferSideToMoveFromHistory(state) {
    const moves = pixiePlayerMoves(state);
    if (!moves.length) return null;
    const lastPlayer = moves.at(-1)?.player;
    const side = playerIndexToSide(lastPlayer);
    if (side) return opponentColor(side);
    return moves.length % 2 === 0 ? "w" : "b";
  }

  function getStringField(obj, names) {
    if (!obj || typeof obj !== "object") return null;
    for (const name of names) {
      if (typeof obj[name] === "string" && obj[name].trim()) return obj[name].trim();
      if (typeof obj[name] === "number") return String(obj[name]);
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
    if (typeof socketPlayerAddress === "string" && socketPlayerAddress.trim()) {
      ids.add(socketPlayerAddress.trim().toLowerCase());
    }

    return ids;
  }

  function resolveMySide(state) {
    const pref = getSidePreference();
    if (pref === "w" || pref === "b") {
      return {
        side: pref,
        playerIndex: normalizePlayerIndex(pref),
        preference: pref,
        playerIndexSource: "manual",
        source: "manual"
      };
    }

    return { side: null, playerIndex: null, preference: "auto", source: "manual.required" };
  }

  function stateToFen(prevState, currState, turnIndex, history = [], options) {
    options = options || {};
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

    const sideToMove = inferSideToMove(prevState, currState, turnIndex, {
      activeSide: options.activeSide
    });
    const castling = inferCastlingRights(currState, history);
    const enPassant = inferEnPassantSquare(prevState, currState);
    const fullMove = Math.floor(turnIndex / 2) + 1;

    return `${placement} ${sideToMove} ${castling} ${enPassant} 0 ${fullMove}`;
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

  function opponentColor(side) {
    return side === "w" ? "b" : "w";
  }

  function pieceType(piece) {
    return piece.toLowerCase();
  }

  function squareName(row, col) {
    return "abcdefgh"[col] + String(8 - row);
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

  async function buildStockfishSuggestion(fen, signal = null) {
    const thinkMode = getStockfishThinkMode();

    const movetimeMs = getStockfishMovetimeMs(thinkMode);
    const response = await requestJson(getStockfishServerUrl(), {
      fen,
      depth: STOCKFISH_DEPTH,
      movetime: movetimeMs,
      multipv: STOCKFISH_MULTIPV,
      avoidMajorTrades: AVOID_MAJOR_TRADES,
      styleWindowCp: STYLE_WINDOW_CP,
      majorTradePenaltyCp: MAJOR_TRADE_PENALTY_CP
    }, movetimeMs + STOCKFISH_SERVER_TIMEOUT_EXTRA_MS, "Stockfish server", signal);

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

  async function buildSuggestion(fen, signal = null) {
    return buildStockfishSuggestion(fen, signal);
  }

  function pendingSuggestion() {
    return {
      san: "...",
      uci: "...",
      vi: "Đang hỏi Stockfish server...",
      engine: "stockfish",
      pending: true
    };
  }

  function suggestionWatchdogMs() {
    return getStockfishMovetimeMs() + STOCKFISH_SERVER_TIMEOUT_EXTRA_MS + SUGGESTION_WATCHDOG_EXTRA_MS;
  }

  function suggestionRequestTimedOut(suggestionKey) {
    return Boolean(
      suggestionInFlightKey &&
      suggestionInFlightKey === suggestionKey &&
      suggestionInFlightAt > 0 &&
      Date.now() - suggestionInFlightAt > suggestionWatchdogMs()
    );
  }

  function stopSuggestionRequest() {
    if (!suggestionInFlightKey) return;
    suggestionRequestSeq += 1;
    if (suggestionAbortController) {
      suggestionAbortController.abort();
      suggestionAbortController = null;
    }
    suggestionInFlightKey = "";
    suggestionInFlightAt = 0;
  }

  function startSuggestionRequest(fen, suggestionKey, mySide, myPlayerIndex = null) {
    if (suggestionInFlightKey === suggestionKey) return;
    if (suggestionInFlightKey) stopSuggestionRequest();

    suggestionInFlightKey = suggestionKey;
    suggestionInFlightAt = Date.now();
    suggestionAbortController = new AbortController();
    const requestSeq = ++suggestionRequestSeq;
    const abortController = suggestionAbortController;

    buildSuggestion(fen, abortController.signal)
      .then(suggestion => {
        if (requestSeq !== suggestionRequestSeq || lastSuggestionKey !== suggestionKey) return;
        lastSuggestion = filterSuggestionForMySide(suggestion, mySide, myPlayerIndex);
        suggestionInFlightKey = "";
        suggestionInFlightAt = 0;
        if (suggestionAbortController === abortController) suggestionAbortController = null;
        if (engineTimeoutSuggestionKey === suggestionKey) {
          engineTimeoutSuggestionKey = "";
          engineTimeoutReason = "";
        }
        scheduleTick();
      })
      .catch(err => {
        if (isAbortError(err)) return;
        if (requestSeq !== suggestionRequestSeq || lastSuggestionKey !== suggestionKey) return;
        engineTimeoutSuggestionKey = suggestionKey;
        engineTimeoutReason = err.message || "Stockfish lỗi";
        lastSuggestion = {
          san: "-",
          uci: "-",
          vi: engineTimeoutReason,
          engine: "stockfish",
          warning: engineTimeoutReason
        };
        suggestionInFlightKey = "";
        suggestionInFlightAt = 0;
        if (suggestionAbortController === abortController) suggestionAbortController = null;
        scheduleTick();
      });
  }

  function waitingSuggestion(reason) {
    return {
      san: "-",
      uci: "-",
      vi: reason,
      engine: "none"
    };
  }

  function buildAutoMoveKey(info) {
    const move = getSuggestedMoveData(info?.suggestion);
    if (!move) return "";
    return [
      info?.gameId || getGameId() || "",
      info?.fen || "",
      move.uci || `${move.from}${move.to}`,
      info?.sideToMove || "",
      info?.autoMoveMode || ""
    ].join("|");
  }

  async function maybeAutoPlaySuggestion(info) {
    const autoMoveKey = buildAutoMoveKey(info);
    if (!shouldAutoPlay({
      myTurn: info?.myTurn,
      gameStarted: info?.gameStarted,
      autoMoveMode: info?.autoMoveMode,
      hasMove: Boolean(getSuggestedMoveData(info?.suggestion)),
      runtimeReady: info?.runtimeReady ?? moveRuntimeReady()
    })) {
      return false;
    }
    if (!autoMoveKey || autoMoveBusy || lastAutoMoveKey === autoMoveKey) return false;

    autoMoveBusy = true;
    lastAutoMoveKey = autoMoveKey;
    try {
      const result = await executeSuggestedMove(info?.suggestion, {
        confirm: false,
        mySide: info?.mySide,
        myPlayerIndex: info?.myPlayerIndex
      });
      if (result?.ok) {
        lastAutoMoveReport = {
          kind: "sent",
          text: `Auto đã gửi ${result.move.from} → ${result.move.to}`,
          key: autoMoveKey
        };
      }
      return true;
    } catch (err) {
      lastAutoMoveKey = "";
      lastAutoMoveReport = {
        kind: "error",
        text: `Auto lỗi: ${err.message}`,
        key: autoMoveKey
      };
      console.error("[Pixie AUTO]", err);
      return false;
    } finally {
      autoMoveBusy = false;
    }
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
      detectedPlayerIndex: window.__pixie_my_player_index ?? null,
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
    if (boardElementCache && document.contains(boardElementCache)) {
      const rect = boardElementCache.getBoundingClientRect();
      const ratio = rect.width / rect.height;
      if (rect.width >= 240 && rect.height >= 240 && ratio >= 0.75 && ratio <= 1.35) {
        return rect;
      }
    }

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
    boardElementCache = candidates.length ? candidates[0].el : null;
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
      autoMoveMode: info.autoMoveMode,
      thinkMode: getStockfishThinkMode(),
      gameStarted: info.gameStarted,
      suggestionVi: info.suggestion?.vi || "",
      suggestionUci: info.suggestion?.uci || "",
      suggestionSan: info.suggestion?.san || "",
      suggestionWarning: info.suggestion?.warning || "",
      runtimeReady: info.runtimeReady ?? moveRuntimeReady(),
      autoMoveBusy,
      autoMoveReport: lastAutoMoveReport?.text || ""
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
      <div id="pixie-auto-fen-side-controls" style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px;margin-bottom:10px;">
        <button data-side="w" style="cursor:pointer;border:1px solid rgba(161, 161, 170, .35);border-radius:6px;padding:6px 4px;background:#fafafa;color:#18181b;font-size:12px;">Trắng</button>
        <button data-side="b" style="cursor:pointer;border:1px solid rgba(161, 161, 170, .35);border-radius:6px;padding:6px 4px;background:#fafafa;color:#18181b;font-size:12px;">Đen</button>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;">
        <div style="color:#a1a1aa;font-size:11px;">Auto đánh</div>
        <div id="pixie-auto-fen-auto-controls" style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px;min-width:132px;">
          <button data-auto-move="off" style="cursor:pointer;border:1px solid rgba(161, 161, 170, .35);border-radius:6px;padding:6px 8px;background:#fafafa;color:#18181b;font-size:12px;">OFF</button>
          <button data-auto-move="on" style="cursor:pointer;border:1px solid rgba(161, 161, 170, .35);border-radius:6px;padding:6px 8px;background:#fafafa;color:#18181b;font-size:12px;">ON</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr;gap:6px;margin-bottom:10px;">
        <div>
          <div style="color:#a1a1aa;font-size:11px;">Mode</div>
          <div id="pixie-auto-fen-think-label" style="margin-top:2px;color:#d4d4d8;font-size:11px;">Strong · 3000ms</div>
        </div>
        <div id="pixie-auto-fen-think-controls" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;min-width:0;">
          <button data-think-mode="bullet" style="cursor:pointer;border:1px solid rgba(161, 161, 170, .35);border-radius:6px;padding:6px 5px;background:#fafafa;color:#18181b;font-size:12px;">100ms</button>
          <button data-think-mode="fast" style="cursor:pointer;border:1px solid rgba(161, 161, 170, .35);border-radius:6px;padding:6px 5px;background:#fafafa;color:#18181b;font-size:12px;">Fast</button>
          <button data-think-mode="strong" style="cursor:pointer;border:1px solid rgba(161, 161, 170, .35);border-radius:6px;padding:6px 5px;background:#fafafa;color:#18181b;font-size:12px;">Strong</button>
          <button data-think-mode="max" style="cursor:pointer;border:1px solid rgba(161, 161, 170, .35);border-radius:6px;padding:6px 5px;background:#fafafa;color:#18181b;font-size:12px;">Max</button>
        </div>
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

    for (const button of panel.querySelectorAll("#pixie-auto-fen-auto-controls button")) {
      button.onclick = () => setAutoMoveMode(button.dataset.autoMove);
    }

    for (const button of panel.querySelectorAll("#pixie-auto-fen-think-controls button")) {
      button.onclick = () => setStockfishThinkMode(button.dataset.thinkMode);
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

  function updateAutoMoveButtons(panel, mode) {
    for (const button of panel.querySelectorAll("#pixie-auto-fen-auto-controls button")) {
      const active = button.dataset.autoMove === mode;
      button.style.background = active ? "#60a5fa" : "rgba(39, 39, 42, .65)";
      button.style.borderColor = active ? "#60a5fa" : "rgba(161, 161, 170, .35)";
      button.style.color = active ? "#082f49" : "#d4d4d8";
      button.style.fontWeight = active ? "700" : "400";
    }
  }

  function updateThinkModeButtons(panel, mode) {
    for (const button of panel.querySelectorAll("#pixie-auto-fen-think-controls button")) {
      const active = button.dataset.thinkMode === mode;
      button.style.background = active ? "#facc15" : "rgba(39, 39, 42, .65)";
      button.style.borderColor = active ? "#facc15" : "rgba(161, 161, 170, .35)";
      button.style.color = active ? "#422006" : "#d4d4d8";
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
    if (!warning) return "";
    const detail = String(warning).replace(/\s+/g, " ").trim();
    const shortDetail = detail.length > 120 ? `${detail.slice(0, 117)}...` : detail;
    return `Stockfish lỗi: ${shortDetail}.`;
  }

  function updatePanel(info) {
    const panel = ensurePanel();
    const mySide = info.mySide;
    const hasMySide = mySide === "w" || mySide === "b";
    const myTurn = hasMySide && info.sideToMove === mySide;
    const autoOn = info.autoMoveMode === "on";
    const thinkMode = getStockfishThinkMode();

    updateSideButtons(panel, info.sidePreference);
    updateAutoMoveButtons(panel, info.autoMoveMode);
    updateThinkModeButtons(panel, thinkMode);
    panel.querySelector("#pixie-auto-fen-think-label").textContent = formatStockfishThinkMode(thinkMode);

    panel.querySelector("#pixie-auto-fen-title").textContent =
      hasMySide ? `Bạn cầm ${sideName(mySide)}` : "Chưa chọn phe";
    panel.querySelector("#pixie-auto-fen-my-side").textContent =
      hasMySide ? sideName(mySide) : "Chưa rõ";
    panel.querySelector("#pixie-auto-fen-turn").textContent = sideName(info.sideToMove);

    let mainText;
    let statusText;
    let statusColor;
    let suggestColor;

    if (!info.gameStarted) {
      statusText = "Chờ ván bắt đầu.";
      statusColor = "#fde68a";
      suggestColor = "#fde68a";
      mainText = "Chưa cần gợi ý";
    } else if (!hasMySide) {
      statusText = "Chọn Trắng/Đen để bật gợi ý.";
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
    const runtimeReady = info.runtimeReady ?? moveRuntimeReady();
    const hasMove = Boolean(getSuggestedMoveData(info.suggestion));
    const canMoveNow = info.gameStarted && myTurn && hasMove && runtimeReady && !autoOn;
    moveButton.textContent = autoOn ? "Auto đang bật" : "Đi nước gợi ý";
    moveButton.disabled = !canMoveNow;
    moveButton.style.opacity = canMoveNow ? "1" : ".55";
    moveButton.style.cursor = canMoveNow ? "pointer" : "not-allowed";
    moveButton.style.background = canMoveNow ? "#14532d" : "rgba(39, 39, 42, .65)";
    moveButton.style.borderColor = canMoveNow ? "rgba(134, 239, 172, .45)" : "rgba(161, 161, 170, .35)";
    moveButton.style.color = canMoveNow ? "#dcfce7" : "#d4d4d8";

    const autoMoveKey = buildAutoMoveKey(info);
    const matchingAutoReport = lastAutoMoveReport && lastAutoMoveReport.key === autoMoveKey ? lastAutoMoveReport : null;

    if (autoOn) {
      if (!info.gameStarted) {
        moveStatus.textContent = "Auto bật - chờ ván bắt đầu";
        moveStatus.style.color = "#fde68a";
      } else if (!myTurn) {
        moveStatus.textContent = "Auto bật - chờ tới lượt";
        moveStatus.style.color = "#a1a1aa";
      } else if (!hasMove) {
        moveStatus.textContent = "Auto bật - đang tính nước";
        moveStatus.style.color = "#fde68a";
      } else if (!runtimeReady) {
        moveStatus.textContent = "Auto bật nhưng cần bắt socket trước";
        moveStatus.style.color = "#fde68a";
      } else if (matchingAutoReport?.kind === "error") {
        moveStatus.textContent = matchingAutoReport.text;
        moveStatus.style.color = "#fecaca";
      } else if (autoMoveBusy) {
        moveStatus.textContent = "Auto đang gửi nước";
        moveStatus.style.color = "#93c5fd";
      } else if (matchingAutoReport?.kind === "sent") {
        moveStatus.textContent = matchingAutoReport.text;
        moveStatus.style.color = "#86efac";
      } else {
        moveStatus.textContent = "Auto sẽ tự đi khi tới lượt";
        moveStatus.style.color = "#93c5fd";
      }
    } else if (!info.gameStarted) {
      moveStatus.textContent = "Chờ ván bắt đầu";
      moveStatus.style.color = "#fde68a";
    } else if (!myTurn) {
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

      const mySideInfo = resolveMySide(curr.state);
      const gameStarted = true;

      const fen = stateToFen(prev?.state, curr.state, curr.turnIndex, states);
      const pieces = curr.state.pieces.filter(p => !p.captured).length;
      const lastMove = prev ? detectLastMove(prev.state, curr.state) : null;
      const sideToMove = fen.split(" ")[1];
      const hasMySide = mySideInfo.side === "w" || mySideInfo.side === "b";
      const myTurn = hasMySide && sideToMove === mySideInfo.side;
      const runtimeReady = moveRuntimeReady();

      const infoBase = {
        gameId: getGameId(),
        key: curr.key,
        turnIndex: curr.turnIndex,
        fen,
        pieces,
        lastMove,
        sideToMove,
        mySide: mySideInfo.side,
        myPlayerIndex: mySideInfo.playerIndex ?? null,
        myPlayerIndexSource: mySideInfo.playerIndexSource || null,
        sidePreference: mySideInfo.preference,
        mySideSource: mySideInfo.source,
        stockfishUrl: getStockfishServerUrl(),
        autoMoveMode: getAutoMoveMode(),
        runtimeReady,
        gameStarted,
        gameStartSource: "board-state",
        clockSource: null
      };

      const shouldComputeSuggestion = hasMySide && gameStarted && (!COMPUTE_ONLY_ON_MY_TURN || myTurn);
      const suggestionKey = shouldComputeSuggestion ? `${fen}|${getStockfishThinkMode()}` : "";
      let shouldRecomputeSuggestion = shouldComputeSuggestion && (lastSuggestionKey !== suggestionKey || !lastSuggestion);

      if (!shouldComputeSuggestion) {
        stopSuggestionRequest();
        engineTimeoutSuggestionKey = "";
        engineTimeoutReason = "";
        lastSuggestion = waitingSuggestion(hasMySide ? "Chờ tới lượt bạn..." : "Chọn Trắng/Đen để bật gợi ý.");
        lastSuggestionKey = "";
      }

      if (shouldComputeSuggestion && suggestionRequestTimedOut(suggestionKey)) {
        stopSuggestionRequest();
        engineTimeoutSuggestionKey = suggestionKey;
        engineTimeoutReason = "Stockfish quá thời gian phản hồi";
        lastSuggestion = {
          san: "-",
          uci: "-",
          vi: engineTimeoutReason,
          engine: "stockfish",
          warning: engineTimeoutReason
        };
        lastSuggestionKey = suggestionKey;
        shouldRecomputeSuggestion = false;
      }

      if (shouldComputeSuggestion && engineTimeoutSuggestionKey === suggestionKey) {
        shouldRecomputeSuggestion = false;
      }

      if (shouldRecomputeSuggestion) {
        lastSuggestion = pendingSuggestion();
        lastSuggestionKey = suggestionKey;
        startSuggestionRequest(fen, suggestionKey, mySideInfo.side, mySideInfo.playerIndex);
      }

      const info = {
        ...infoBase,
        suggestion: lastSuggestion,
        myTurn
      };

      await maybeAutoPlaySuggestion(info);

      const panelStateKey = buildPanelStateKey(info);

      if (fen === lastFen && panelStateKey === lastPanelStateKey) {
        return;
      }

      window.__pixie_latest_fen = fen;
      window.__pixie_latest_info = info;
      window.__pixie_last_move = lastMove;
      window.__pixie_suggestion = lastSuggestion;
      window.__pixie_my_side = mySideInfo.side;
      window.__pixie_my_player_index = mySideInfo.playerIndex ?? null;
      window.pixieFenMove = {
        executeSuggestedMove: (suggestion, options) => executeSuggestedMove(suggestion, options),
        getSuggestedMoveData: (suggestion) => clone(getSuggestedMoveData(suggestion)),
        findPieceBySquare: (square) => clone(findPieceBySquare(square)),
        moveRuntimeReady: () => moveRuntimeReady(),
        getAutoMoveMode: () => getAutoMoveMode(),
        setAutoMoveMode: (mode) => setAutoMoveMode(mode),
        getRuntimeContext: () => ({
          gameId: socketGameId || getGameId(),
          playerAddress: resolvePlayerAddress(),
          hasSocket: Boolean(getMoveSocket()),
          mySide: window.__pixie_my_side || null,
          myPlayerIndex: window.__pixie_my_player_index ?? null,
          autoMoveMode: getAutoMoveMode(),
          autoMoveBusy,
          lastAutoMoveReport: clone(lastAutoMoveReport),
          lastMoveExecution: clone(lastMoveExecution)
        })
      };

      updatePanel(info);
      lastPanelStateKey = panelStateKey;

      lastKey = curr.key;
      lastFen = fen;

      if (DEBUG_LOG) {
        console.log("[Pixie FEN UPDATED]", curr.key);
        console.log("FEN:", fen);
        console.log("Side:", {
          sideToMove,
          mySide: mySideInfo.side,
          preference: mySideInfo.preference,
          source: mySideInfo.source
        });
        console.log("Suggestion:", lastSuggestion);
      }

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
    if (DEBUG_LOG) console.log("[Pixie FEN] Auto updater started.");
  }

  if (document.body) {
    start();
  } else {
    window.addEventListener("DOMContentLoaded", start);
  }
})();
