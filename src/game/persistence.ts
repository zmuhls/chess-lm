import { Chess } from 'chess.js'

export const SAVE_KEY = 'chess-lm-pgn'

export function restoreGame(storage: Pick<Storage, 'getItem'>): Chess {
  const game = new Chess()
  try {
    const pgn = storage.getItem(SAVE_KEY)
    if (pgn && pgn.length <= 100_000) game.loadPgn(pgn)
  } catch {
    // A damaged or unavailable save must not prevent a new game.
    game.reset()
  }
  return game
}

export function saveGame(
  game: Chess,
  storage: Pick<Storage, 'setItem'>,
): boolean {
  try {
    storage.setItem(SAVE_KEY, game.pgn())
    return true
  } catch {
    return false
  }
}

export function undoPlayerTurn(game: Chess) {
  if (!game.history().length) return
  game.undo()
  if (game.turn() === 'b' && game.history().length) game.undo()
}
