import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const targetPath = new URL('../pixie-fen-auto-autoplay.user.js', import.meta.url);
const source = readFileSync(targetPath, 'utf8');

function extractFunction(name) {
  const signature = `function ${name}(`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `Missing function ${name}`);

  let idx = source.indexOf('{', start);
  assert.notEqual(idx, -1, `Missing body for ${name}`);

  let depth = 0;
  let end = idx;
  for (; end < source.length; end++) {
    const ch = source[end];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return source.slice(start, end);
}

const context = {
  AUTO_MOVE_PREF_PREFIX: 'pixie-auto-move:',
  DEFAULT_AUTO_MOVE_MODE: 'off',
  localStorage: {
    store: new Map(),
    getItem(key) {
      return this.store.has(key) ? this.store.get(key) : null;
    },
    setItem(key, value) {
      this.store.set(key, String(value));
    }
  },
  getGameId() {
    return 'game-123';
  },
  toSquare(point) {
    return 'abcdefgh'[Number(point.x)] + String(Number(point.y) + 1);
  },
  normalizeSide(value) {
    const text = String(value || '').toLowerCase();
    if (value === 0 || value === '0' || text === 'w' || text === 'white') return 'w';
    if (value === 1 || value === '1' || text === 'b' || text === 'black') return 'b';
    return null;
  },
  clone(value) {
    return JSON.parse(JSON.stringify(value));
  },
  lastState: {
    pieces: [
      { id: 'wp', player: 0, captured: false, point: { x: 4, y: 1 } },
      { id: 'bp', player: 1, captured: false, point: { x: 4, y: 6 } }
    ]
  }
};

const loaded = new Function(
  'context',
  `
    const AUTO_MOVE_PREF_PREFIX = context.AUTO_MOVE_PREF_PREFIX;
    const DEFAULT_AUTO_MOVE_MODE = context.DEFAULT_AUTO_MOVE_MODE;
    const localStorage = context.localStorage;
    const getGameId = context.getGameId;
    const toSquare = context.toSquare;
    const normalizeSide = context.normalizeSide;
    const clone = context.clone;
    const sideName = side => side === 'w' ? 'Trắng' : side === 'b' ? 'Đen' : 'Chưa rõ';
    const lastStateForDebug = context.lastState;
    ${extractFunction('normalizeAutoMoveMode')}
    ${extractFunction('getAutoMovePrefKey')}
    ${extractFunction('getAutoMoveMode')}
    ${extractFunction('shouldAutoPlay')}
    ${extractFunction('getCurrentPieces')}
    ${extractFunction('findPieceBySquare')}
    ${extractFunction('getSuggestedMoveData')}
    ${extractFunction('normalizePlayerIndex')}
    ${extractFunction('playerIndexName')}
    ${extractFunction('piecePlayerIndex')}
    ${extractFunction('pieceSide')}
    ${extractFunction('suggestionUsesMyPiece')}
    ${extractFunction('pieceOwnerLabel')}
    ${extractFunction('filterSuggestionForMySide')}
    return {
      normalizeAutoMoveMode,
      getAutoMovePrefKey,
      getAutoMoveMode,
      shouldAutoPlay,
      suggestionUsesMyPiece,
      filterSuggestionForMySide
    };
  `
)(context);

assert.equal(loaded.normalizeAutoMoveMode('ON'), 'on');
assert.equal(loaded.normalizeAutoMoveMode('off'), 'off');
assert.equal(loaded.normalizeAutoMoveMode('weird'), null);
assert.equal(loaded.getAutoMovePrefKey(), 'pixie-auto-move:game-123');
assert.equal(loaded.getAutoMoveMode(), 'off');

context.localStorage.setItem('pixie-auto-move:game-123', 'on');
assert.equal(loaded.getAutoMoveMode(), 'on');

assert.equal(
  loaded.shouldAutoPlay({ myTurn: true, autoMoveMode: 'on', hasMove: true, runtimeReady: true }),
  true
);
assert.equal(
  loaded.shouldAutoPlay({ myTurn: true, autoMoveMode: 'off', hasMove: true, runtimeReady: true }),
  false
);
assert.equal(
  loaded.shouldAutoPlay({ myTurn: false, autoMoveMode: 'on', hasMove: true, runtimeReady: true }),
  false
);
assert.equal(
  loaded.shouldAutoPlay({ myTurn: true, autoMoveMode: 'on', hasMove: false, runtimeReady: true }),
  false
);
assert.equal(
  loaded.shouldAutoPlay({ myTurn: true, autoMoveMode: 'on', hasMove: true, runtimeReady: false }),
  false
);
assert.equal(
  loaded.shouldAutoPlay({ myTurn: true, gameStarted: false, autoMoveMode: 'on', hasMove: true, runtimeReady: true }),
  false
);

assert.equal(
  loaded.suggestionUsesMyPiece({ uci: 'e2e4' }, 'w'),
  true
);
assert.equal(
  loaded.suggestionUsesMyPiece({ uci: 'e7e5' }, 'w'),
  false
);
assert.equal(
  loaded.filterSuggestionForMySide({ uci: 'e7e5', engine: 'stockfish' }, 'w').uci,
  '-'
);
assert.equal(
  loaded.suggestionUsesMyPiece({ uci: 'e7e5' }, 'b', 0),
  false
);
assert.equal(
  loaded.filterSuggestionForMySide({ uci: 'e7e5', engine: 'stockfish' }, 'b', 0).uci,
  '-'
);

console.log('auto-mode tests passed');
