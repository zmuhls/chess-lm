import { describe, expect, it } from 'vitest'
import { Chess } from 'chess.js'
import { restoreGame, saveGame, undoPlayerTurn } from './persistence'

describe('game recovery', () => {
  it('restores complete history, including a pending engine turn', () => {
    const game = new Chess()
    game.move('e4')
    const recovered = restoreGame({ getItem: () => game.pgn() })
    expect(recovered.fen()).toBe(game.fen())
    expect(recovered.history()).toEqual(['e4'])
    expect(recovered.turn()).toBe('b')
  })
  it('keeps repetition information after reload', () => {
    const game = new Chess()
    for (const move of ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8'])
      game.move(move)
    expect(
      restoreGame({ getItem: () => game.pgn() }).isThreefoldRepetition(),
    ).toBe(true)
  })
  it('recovers from malformed or inaccessible storage', () => {
    expect(restoreGame({ getItem: () => 'not a game' }).fen()).toBe(
      new Chess().fen(),
    )
    expect(
      restoreGame({
        getItem: () => {
          throw new Error('blocked')
        },
      }).history(),
    ).toEqual([])
    expect(
      saveGame(new Chess(), {
        setItem: () => {
          throw new Error('full')
        },
      }),
    ).toBe(false)
  })
  it('undoes both a full turn and an interrupted human move', () => {
    const game = new Chess()
    game.move('e4')
    game.move('e5')
    game.move('Nf3')
    undoPlayerTurn(game)
    expect(game.history()).toEqual(['e4', 'e5'])
    undoPlayerTurn(game)
    expect(game.history()).toEqual([])
  })
})
