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

const loaded = new Function(
  `
    const pieceMap = {
      pawn: "p",
      rook: "r",
      knight: "n",
      bishop: "b",
      queen: "q",
      king: "k"
    };
    ${extractFunction('toSquare')}
    ${extractFunction('detectLastMove')}
    ${extractFunction('normalizeSide')}
    ${extractFunction('playerIndexToSide')}
    ${extractFunction('opponentColor')}
    ${extractFunction('pixieHistoryMoves')}
    ${extractFunction('pixiePlayerMoves')}
    ${extractFunction('inferSideToMoveFromHistory')}
    ${extractFunction('inferSideToMove')}
    ${extractFunction('pieceKind')}
    ${extractFunction('pieceHasAbility')}
    ${extractFunction('pieceHasMovedFlag')}
    ${extractFunction('stateHasMoveMetadata')}
    ${extractFunction('pieceSquare')}
    ${extractFunction('statePieceAt')}
    ${extractFunction('historyState')}
    ${extractFunction('pieceMovedFromInitialSquare')}
    ${extractFunction('historyLooksLikeStartPosition')}
    ${extractFunction('inferCastlingRights')}
    ${extractFunction('inferEnPassantSquareFromState')}
    ${extractFunction('isEnPassantDoubleStep')}
    ${extractFunction('enPassantTargetSquare')}
    ${extractFunction('moveSquare')}
    ${extractFunction('inferEnPassantSquareFromHistory')}
    ${extractFunction('inferEnPassantSquare')}
    ${extractFunction('stateToFen')}
    return {
      inferCastlingRights,
      inferSideToMove,
      inferEnPassantSquare,
      stateToFen
    };
  `
)();

function point(square) {
  return {
    x: 'abcdefgh'.indexOf(square[0]),
    y: Number(square[1]) - 1
  };
}

function piece(id, key, player, square, extra = {}) {
  return {
    id,
    key,
    subKey: key,
    player,
    captured: false,
    point: point(square),
    ...extra
  };
}

function state(pieces) {
  return { pieces };
}

function withPieceAt(basePieces, id, square) {
  return basePieces.map(item => (
    item.id === id
      ? { ...item, point: point(square) }
      : { ...item, point: { ...item.point } }
  ));
}

const startPieces = [
  piece('wr-a', 'rook', 0, 'a1'),
  piece('wk', 'king', 0, 'e1'),
  piece('wr-h', 'rook', 0, 'h1'),
  piece('br-a', 'rook', 1, 'a8'),
  piece('bk', 'king', 1, 'e8'),
  piece('br-h', 'rook', 1, 'h8')
];
const startState = state(startPieces);
const startHistory = [{ turnIndex: 0, state: startState }];

assert.equal(loaded.inferCastlingRights(startState, startHistory), 'KQkq');
assert.equal(loaded.inferCastlingRights(startState, [startState]), '-');
assert.equal(loaded.inferCastlingRights(startState, [{ turnIndex: 3, state: startState }]), '-');

const castleAbility = { key: 'king_castle' };
const metadataCastlePieces = startPieces.map(item => (
  item.key === 'king'
    ? { ...item, abilities: [castleAbility] }
    : { ...item }
));
const metadataCastleState = state(metadataCastlePieces);
assert.equal(
  loaded.inferCastlingRights(metadataCastleState, [{ turnIndex: 7, state: metadataCastleState }]),
  'KQkq'
);

const movedMetadataCastleState = state(metadataCastlePieces.map(item => (
  item.id === 'wr-h'
    ? { ...item, state: { hasMoved: true } }
    : { ...item }
)));
assert.equal(
  loaded.inferCastlingRights(movedMetadataCastleState, [{ turnIndex: 7, state: movedMetadataCastleState }]),
  'Qkq'
);

const hasMovedCastleState = state(startPieces.map(item => ({
  ...item,
  state: { hasMoved: false }
})));
assert.equal(
  loaded.inferCastlingRights(hasMovedCastleState, [{ turnIndex: 7, state: hasMovedCastleState }]),
  'KQkq'
);

const kingMovedAway = state(withPieceAt(startPieces, 'wk', 'f1'));
const kingMovedBack = state(withPieceAt(startPieces, 'wk', 'e1'));
assert.equal(
  loaded.inferCastlingRights(kingMovedBack, [
    { turnIndex: 0, state: startState },
    { turnIndex: 1, state: kingMovedAway },
    { turnIndex: 2, state: kingMovedBack }
  ]),
  'kq'
);

assert.equal(
  loaded.stateToFen(null, startState, 0, startHistory),
  'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'
);

const beforeWhiteDoublePush = state([
  ...startPieces,
  piece('wp-e', 'pawn', 0, 'e2')
]);
const afterWhiteDoublePush = state(withPieceAt(beforeWhiteDoublePush.pieces, 'wp-e', 'e4'));
const doublePushHistory = [
  { turnIndex: 0, state: beforeWhiteDoublePush },
  { turnIndex: 1, state: afterWhiteDoublePush }
];

assert.equal(loaded.inferEnPassantSquare(beforeWhiteDoublePush, afterWhiteDoublePush), 'e3');
assert.equal(
  loaded.stateToFen(beforeWhiteDoublePush, afterWhiteDoublePush, 1, doublePushHistory),
  'r3k2r/8/8/8/4P3/8/8/R3K2R b KQkq e3 0 1'
);

const midgameEpState = state([
  ...startPieces,
  piece('bp-d', 'pawn', 1, 'd5', { state: { canBeEnPassanted: true } })
]);
assert.equal(loaded.inferEnPassantSquare(null, midgameEpState), 'd6');

const beforeNonStartDoublePush = state([
  ...startPieces,
  piece('wp-e3', 'pawn', 0, 'e3')
]);
const afterNonStartDoublePush = state(withPieceAt(beforeNonStartDoublePush.pieces, 'wp-e3', 'e5'));
assert.equal(loaded.inferEnPassantSquare(beforeNonStartDoublePush, afterNonStartDoublePush), '-');

const historyEpState = state(startPieces);
historyEpState.history = {
  moves: [
    {
      player: 1,
      abilities: [{ key: 'pawn_doubleStep', from: point('d7'), to: point('d5') }],
      isPlayerMove: { from: point('d7'), to: point('d5') }
    }
  ]
};
assert.equal(loaded.inferEnPassantSquare(null, historyEpState), 'd6');

const historyStringEpState = state(startPieces);
historyStringEpState.history = {
  moves: [
    { player: 'black', isPlayerMove: { from: 'd7', to: 'd5' } }
  ]
};
assert.equal(loaded.inferEnPassantSquare(null, historyStringEpState), 'd6');

const historyInvalidEpState = state(startPieces);
historyInvalidEpState.history = {
  moves: [
    { player: 'white', isPlayerMove: { from: 'e3', to: 'e5' } }
  ]
};
assert.equal(loaded.inferEnPassantSquare(null, historyInvalidEpState), '-');

const historyOnlyState = state(startPieces);
historyOnlyState.history = {
  moves: [
    { player: 0, isPlayerMove: { from: point('e2'), to: point('e4') } },
    { player: 1, isPlayerMove: { from: point('e7'), to: point('e5') } },
    { player: 0, isPlayerMove: { from: point('g1'), to: point('f3') } }
  ]
};
assert.equal(loaded.inferSideToMove(null, historyOnlyState, 0), 'b');

const historyStringPlayerState = state(startPieces);
historyStringPlayerState.history = {
  moves: [
    { player: 'white' }
  ]
};
assert.equal(loaded.inferSideToMove(null, historyStringPlayerState, 0), 'b');

const timingIgnoredState = state(startPieces);
timingIgnoredState.players = [
  { turnStartTime: 1000 },
  { turnStartTime: 2000 }
];
assert.equal(loaded.inferSideToMove(null, timingIgnoredState, 0), 'w');

const tickBody = extractFunction('tick');
const startSuggestionBody = extractFunction('startSuggestionRequest');

assert.match(tickBody, /startSuggestionRequest\(fen,\s*suggestionKey,\s*mySideInfo\.side,\s*mySideInfo\.playerIndex\)/);
assert.match(tickBody, /hasMySide\s*&&\s*gameStarted\s*&&/);
assert.match(tickBody, /suggestionRequestTimedOut\(suggestionKey\)/);
assert.match(tickBody, /stopSuggestionRequest\(\)/);
assert.match(tickBody, /engineTimeoutSuggestionKey\s*===\s*suggestionKey/);
assert.match(tickBody, /uci:\s*"-"/);
assert.doesNotMatch(tickBody, /detectClockInfoFromDom|inferActiveSideFromTiming|inferGameStartInfo/);
assert.doesNotMatch(tickBody, /buildMinimaxSuggestion\(fen\)/);
assert.doesNotMatch(tickBody, /await\s+buildSuggestion\(/);
assert.doesNotMatch(source, /data-side="auto"/);
assert.match(startSuggestionBody, /new AbortController\(\)/);
assert.match(startSuggestionBody, /buildSuggestion\(fen,\s*abortController\.signal\)\s*\.then/);
assert.match(startSuggestionBody, /isAbortError\(err\)/);
assert.match(startSuggestionBody, /\.catch/);

console.log('fen-and-poll tests passed');
