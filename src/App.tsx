import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Chess, type Square } from 'chess.js'
import { Chessboard, type ChessboardOptions } from 'react-chessboard'
import {
  ArrowLeft,
  Download,
  Upload,
  FlipHorizontal2,
  Plus,
  RotateCcw,
  Undo2,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { ChessCoach } from './components/ChessCoach'
import { Council } from './components/Council'
import { MoveLedger } from './components/MoveLedger'
import { PlayerBar } from './components/PlayerBar'
import { StockfishClient } from './engine/StockfishClient'
import { parseUciMove } from './engine/uci'
import { restoreGame, saveGame, undoPlayerTurn } from './game/persistence'
import { buildCouncilReading, type CouncilReading } from './model/modelGuide'
import {
  INITIAL_COACH_STATE,
  requestCoach,
  type CoachRequest,
  type CoachState,
} from './model/coachClient'
import './App.css'

type EngineState = 'loading' | 'ready' | 'error'
type Promotion = 'q' | 'r' | 'b' | 'n'
const promotionPieces: [Promotion, string][] = [
  ['q', 'Queen'],
  ['r', 'Rook'],
  ['b', 'Bishop'],
  ['n', 'Knight'],
]

function gameStatus(game: Chess, engineState: EngineState) {
  if (game.isCheckmate())
    return game.turn() === 'w'
      ? 'Checkmate · Death wins'
      : 'Checkmate · You win'
  if (game.isStalemate()) return 'Draw · Stalemate'
  if (game.isThreefoldRepetition()) return 'Draw · Repetition'
  if (game.isInsufficientMaterial()) return 'Draw · Insufficient material'
  if (game.isDraw()) return 'Draw · Fifty-move rule'
  if (engineState === 'loading') return 'Loading engine'
  if (engineState === 'error') return 'Engine paused'
  if (game.turn() === 'b') return 'Death is thinking'
  return game.isCheck() ? 'Check · Your move' : 'Your move'
}

function App() {
  const [game] = useState(() => {
    try {
      return restoreGame(window.localStorage)
    } catch {
      return new Chess()
    }
  })
  const engineRef = useRef<StockfishClient | null>(null)
  const searchIdRef = useRef(0)
  const audioRef = useRef<AudioContext | null>(null)
  const soundRef = useRef(false)
  const coachAbortRef = useRef<AbortController | null>(null)
  const lastCoachRequestRef = useRef<CoachRequest | null>(null)
  const promotionRef = useRef<HTMLButtonElement>(null)
  const newGameRef = useRef<HTMLButtonElement>(null)
  const keepPlayingRef = useRef<HTMLButtonElement>(null)
  const boardRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [importError, setImportError] = useState('')
  const [pendingImport, setPendingImport] = useState<Chess | null>(null)
  const [fen, setFen] = useState(game.fen())
  const [orientation, setOrientation] = useState<'white' | 'black'>('white')
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null)
  const [promotion, setPromotion] = useState<{
    from: string
    to: string
  } | null>(null)
  const [engineState, setEngineState] = useState<EngineState>('loading')
  const [engineError, setEngineError] = useState('')
  const [council, setCouncil] = useState<CouncilReading | null>(null)
  const [coach, setCoach] = useState<CoachState>(INITIAL_COACH_STATE)
  const [activeTab, setActiveTab] = useState<'moves' | 'method'>('moves')
  const [soundOn, setSoundOn] = useState(false)
  const [confirmNew, setConfirmNew] = useState(false)
  const [storageAvailable, setStorageAvailable] = useState(true)
  const [keyboardMove, setKeyboardMove] = useState('')
  const [reducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const history = game.history({ verbose: true })
  const lastMove = history.at(-1)
  const thinking =
    engineState === 'ready' && game.turn() === 'b' && !game.isGameOver()
  const playable =
    engineState === 'ready' && game.turn() === 'w' && !game.isGameOver()
  const legalMoves = game.moves({ verbose: true })
  const legalSquares = selectedSquare
    ? legalMoves
        .filter((move) => move.from === selectedSquare)
        .map((move) => move.to)
    : []

  useEffect(() => {
    let active = true
    let engine: StockfishClient | null = null
    try {
      engine = new StockfishClient(import.meta.env.BASE_URL)
      engineRef.current = engine
      engine
        .ready()
        .then(() => {
          if (active) setEngineState('ready')
        })
        .catch((error: Error) => {
          if (active) {
            setEngineState('error')
            setEngineError(error.message)
          }
        })
    } catch {
      setEngineState('error')
      setEngineError('This browser could not start Stockfish.')
    }
    return () => {
      active = false
      searchIdRef.current += 1
      coachAbortRef.current?.abort()
      engine?.terminate()
      engineRef.current = null
      void audioRef.current?.close().catch(() => {})
      audioRef.current = null
    }
  }, [])

  useEffect(() => {
    if (promotion) promotionRef.current?.focus()
  }, [promotion])

  useEffect(() => {
    if (confirmNew || pendingImport) keepPlayingRef.current?.focus()
  }, [confirmNew, pendingImport])

  const clearCoach = useCallback(() => {
    coachAbortRef.current?.abort()
    coachAbortRef.current = null
    lastCoachRequestRef.current = null
    setCoach(INITIAL_COACH_STATE)
  }, [])

  const runCoach = useCallback(async (position: CoachRequest) => {
    coachAbortRef.current?.abort()
    const controller = new AbortController()
    coachAbortRef.current = controller
    lastCoachRequestRef.current = position
    setCoach({
      status: 'loading',
      message: 'The coach is reading this turn and Stockfish’s lines.',
    })
    try {
      const result = await requestCoach(position, controller.signal)
      if (coachAbortRef.current !== controller) return
      setCoach({
        status: 'ready',
        message: result.coach,
        model: result.model,
        cached: result.cached,
      })
    } catch (error) {
      if (controller.signal.aborted || coachAbortRef.current !== controller)
        return
      setCoach({
        status: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'The coach could not read this turn.',
      })
    }
  }, [])

  const syncGame = useCallback(() => {
    setFen(game.fen())
    setKeyboardMove('')
    try {
      setStorageAvailable(saveGame(game, window.localStorage))
    } catch {
      setStorageAvailable(false)
    }
  }, [game])

  const playMoveSound = useCallback(() => {
    if (!soundRef.current) return
    try {
      const context = audioRef.current ?? new AudioContext()
      audioRef.current = context
      void context.resume().catch(() => {})
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.frequency.setValueAtTime(164, context.currentTime)
      gain.gain.setValueAtTime(0.0001, context.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.045, context.currentTime + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.12)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start()
      oscillator.stop(context.currentTime + 0.13)
      oscillator.onended = () => {
        oscillator.disconnect()
        gain.disconnect()
      }
    } catch {
      /* Sound is optional; it never interrupts a legal move. */
    }
  }, [])

  useEffect(() => {
    const engine = engineRef.current
    if (
      engineState !== 'ready' ||
      !engine ||
      game.isGameOver() ||
      game.turn() !== 'b'
    )
      return
    const beforeFen = game.fen()
    const playerMove = game.history().at(-1) ?? ''
    const searchId = ++searchIdRef.current
    void engine
      .analyze(beforeFen)
      .then((analysis) => {
        if (searchId !== searchIdRef.current || game.fen() !== beforeFen) return
        const reading = buildCouncilReading(beforeFen, analysis)
        game.move(parseUciMove(analysis.bestMove))
        const reply = game.history().at(-1)!
        setCouncil(reading)
        setEngineError('')
        syncGame()
        playMoveSound()
        if (reading.advisers.length) {
          void runCoach({
            beforeFen,
            fen: game.fen(),
            pgn: game.pgn(),
            playerMove,
            engineMove: reply,
            candidates: reading.advisers.map(
              ({ move, evaluation, continuation }) => ({
                move,
                evaluation,
                continuation,
              }),
            ),
          })
        }
      })
      .catch((error: Error) => {
        if (searchId !== searchIdRef.current || error.name === 'AbortError')
          return
        setEngineState('error')
        setEngineError(error.message)
      })
    return () => {
      if (searchId === searchIdRef.current) searchIdRef.current += 1
      engine.cancel()
    }
  }, [fen, engineState, game, playMoveSound, runCoach, syncGame])

  const commitPlayerMove = (
    from: string,
    to: string,
    chosenPromotion?: Promotion,
  ) => {
    if (!playable || confirmNew || pendingImport) return false
    const matches = game
      .moves({ verbose: true })
      .filter((move) => move.from === from && move.to === to)
    if (!matches.length) return false
    if (matches.some((move) => move.isPromotion()) && !chosenPromotion) {
      setPromotion({ from, to })
      return false
    }
    try {
      game.move({ from, to, promotion: chosenPromotion })
      clearCoach()
      setCouncil(null)
      setSelectedSquare(null)
      setPromotion(null)
      syncGame()
      playMoveSound()
      if (promotion)
        window.requestAnimationFrame(() => boardRef.current?.focus())
      return true
    } catch {
      return false
    }
  }

  const chooseSquare = (square: string) => {
    if (!playable || promotion || confirmNew || pendingImport) return
    if (selectedSquare && legalSquares.includes(square as Square)) {
      commitPlayerMove(selectedSquare, square)
      return
    }
    const piece = game.get(square as Square)
    setSelectedSquare(
      piece?.color === 'w' && square !== selectedSquare ? square : null,
    )
  }

  const restartEngine = async () => {
    setEngineState('loading')
    setEngineError('')
    try {
      let engine = engineRef.current
      if (engine) await engine.restart()
      else {
        engine = new StockfishClient(import.meta.env.BASE_URL)
        engineRef.current = engine
        await engine.ready()
      }
      if (engineRef.current === engine) setEngineState('ready')
    } catch (error) {
      setEngineState('error')
      setEngineError(
        error instanceof Error
          ? error.message
          : 'The engine could not restart.',
      )
    }
  }

  const clearTurn = () => {
    searchIdRef.current += 1
    engineRef.current?.cancel()
    clearCoach()
    setCouncil(null)
    setSelectedSquare(null)
    setPromotion(null)
    setConfirmNew(false)
    setPendingImport(null)
  }

  const resetGame = () => {
    clearTurn()
    game.reset()
    syncGame()
    newGameRef.current?.focus()
    if (engineState === 'error') void restartEngine()
  }

  const undoTurn = () => {
    clearTurn()
    undoPlayerTurn(game)
    syncGame()
  }

  const applyImport = (imported: Chess) => {
    clearTurn()
    game.loadPgn(imported.pgn())
    syncGame()
    boardRef.current?.focus()
    if (engineState === 'error') void restartEngine()
  }

  const importGame = async (file?: File) => {
    if (!file) return
    setImportError('')
    try {
      if (file.size > 100_000)
        throw new Error('Choose a PGN smaller than 100 KB.')
      const imported = new Chess()
      const text = await file.text()
      if (!text.trim()) throw new Error('This PGN is empty.')
      try {
        imported.loadPgn(text)
      } catch {
        throw new Error('This file does not contain a valid chess game.')
      }
      if (game.history().length) setPendingImport(imported)
      else applyImport(imported)
    } catch (error) {
      setImportError(
        error instanceof Error
          ? error.message
          : 'This PGN could not be opened.',
      )
    }
  }

  const exportGame = () => {
    const url = URL.createObjectURL(
      new Blob([game.pgn()], { type: 'application/x-chess-pgn' }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = 'chess-lm.pgn'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const squareStyles: Record<string, React.CSSProperties> = {}
  if (lastMove)
    for (const square of [lastMove.from, lastMove.to])
      squareStyles[square] = {
        boxShadow: 'inset 0 0 0 2px rgba(255,255,255,.65)',
      }
  if (selectedSquare)
    squareStyles[selectedSquare] = { boxShadow: 'inset 0 0 0 4px #f3c76b' }
  for (const square of legalSquares)
    squareStyles[square] = {
      ...squareStyles[square],
      backgroundImage:
        'radial-gradient(circle, #f3c76bcc 0 17%, transparent 19%)',
    }
  const boardOptions: ChessboardOptions = {
    id: 'chess-lm-board',
    position: fen,
    boardOrientation: orientation,
    onPieceDrop: ({ sourceSquare, targetSquare }) =>
      targetSquare ? commitPlayerMove(sourceSquare, targetSquare) : false,
    onSquareClick: ({ square }) => chooseSquare(square),
    canDragPiece: ({ piece }) =>
      playable && !promotion && !confirmNew && !pendingImport && piece.pieceType.startsWith('w'),
    squareStyles,
    allowDrawingArrows: true,
    animationDurationInMs: reducedMotion ? 0 : 160,
    boardStyle: { borderRadius: 0 },
    lightSquareStyle: { backgroundColor: '#deded7' },
    darkSquareStyle: { backgroundColor: '#575c60' },
    lightSquareNotationStyle: {
      color: '#32363a',
      fontSize: 12,
      fontWeight: 600,
    },
    darkSquareNotationStyle: { color: '#fff', fontSize: 12, fontWeight: 600 },
  }
  const selectableMoves = useMemo(
    () => new Chess(fen).moves({ verbose: true }),
    [fen],
  )

  return (
    <div className="app-shell">
      <a className="skip-link" href="#game">
        Skip to game
      </a>
      <header className="site-header">
        <a
          className="suite-brand"
          href="https://games.ailab-452.workers.dev/"
          aria-label="CAIL Games"
        >
          <img
            src={`${import.meta.env.BASE_URL}assets/cail-logo-white.png`}
            alt="CUNY AI Lab"
            width="1154"
            height="259"
          />
          <span>Games</span>
        </a>
        <a className="back-link" href="https://games.ailab-452.workers.dev/">
          <ArrowLeft aria-hidden="true" />
          All games
        </a>
      </header>
      <main id="game" tabIndex={-1}>
        <div className="game-heading">
          <div>
            <p className="eyebrow">An encounter with Death</p>
            <h1>Chess / LM</h1>
          </div>
          <span className="edition">Stockfish 18 · Level 8</span>
        </div>
        <div className="game-shell">
          <section className="board-column" aria-label="Chess board">
            <PlayerBar
              side={orientation === 'white' ? 'death' : 'player'}
              status={
                orientation === 'black'
                  ? gameStatus(game, engineState)
                  : undefined
              }
            />
            <div
              ref={boardRef}
              tabIndex={-1}
              className="board-frame"
              aria-label="Chess board"
            >
              <Chessboard options={boardOptions} />
            </div>
            <PlayerBar
              side={orientation === 'white' ? 'player' : 'death'}
              status={
                orientation === 'white'
                  ? gameStatus(game, engineState)
                  : undefined
              }
            />
            {promotion ? (
              <div
                className="inline-prompt"
                role="group"
                aria-label="Choose promotion"
              >
                <strong>Promote your pawn</strong>
                <div className="promotion-options">
                  {promotionPieces.map(([piece, label], i) => (
                    <button
                      ref={i === 0 ? promotionRef : undefined}
                      key={piece}
                      type="button"
                      onClick={() =>
                        commitPlayerMove(promotion.from, promotion.to, piece)
                      }
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      setPromotion(null)
                      boardRef.current?.focus()
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
            {engineError ? (
              <div className="engine-error" role="alert">
                <p>{engineError}</p>
                <button type="button" onClick={() => void restartEngine()}>
                  <RotateCcw aria-hidden="true" />
                  Retry engine
                </button>
              </div>
            ) : null}
            <div className="game-controls" aria-label="Game controls">
              <button
                ref={newGameRef}
                type="button"
                onClick={() =>
                  history.length ? setConfirmNew(true) : resetGame()
                }
              >
                <Plus aria-hidden="true" />
                New game
              </button>
              <button
                type="button"
                onClick={undoTurn}
                disabled={!history.length}
              >
                <Undo2 aria-hidden="true" />
                Undo turn
              </button>
              <button
                type="button"
                onClick={() =>
                  setOrientation((current) =>
                    current === 'white' ? 'black' : 'white',
                  )
                }
              >
                <FlipHorizontal2 aria-hidden="true" />
                Flip board
              </button>
            </div>
            {confirmNew || pendingImport ? (
              <div
                className="inline-prompt"
                role="group"
                aria-label={
                  pendingImport ? 'Open a saved game' : 'Start a new game'
                }
              >
                <p>
                  {pendingImport
                    ? 'Open this PGN? Your current saved game will be replaced.'
                    : 'Start again? Your saved game will be replaced.'}
                </p>
                <button
                  type="button"
                  onClick={() =>
                    pendingImport ? applyImport(pendingImport) : resetGame()
                  }
                >
                  {pendingImport ? 'Open saved game' : 'Start new game'}
                </button>
                <button
                  ref={keepPlayingRef}
                  type="button"
                  onClick={() => {
                    setConfirmNew(false)
                    setPendingImport(null)
                    newGameRef.current?.focus()
                  }}
                >
                  Keep playing
                </button>
              </div>
            ) : null}
            <details className="board-tools">
              <summary>More controls</summary>
              <form
                className="move-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  const move = selectableMoves.find(
                    (item) => item.san === keyboardMove,
                  )
                  if (move)
                    commitPlayerMove(
                      move.from,
                      move.to,
                      move.promotion as Promotion | undefined,
                    )
                }}
              >
                <label htmlFor="legal-move">Play by notation</label>
                <div>
                  <select
                    id="legal-move"
                    value={keyboardMove}
                    disabled={!playable || !!promotion}
                    onChange={(event) => setKeyboardMove(event.target.value)}
                  >
                    <option value="">Choose a legal move</option>
                    {playable
                      ? selectableMoves.map((move) => (
                          <option value={move.san} key={move.san}>
                            {move.san} · {move.from} to {move.to}
                          </option>
                        ))
                      : null}
                  </select>
                  <button type="submit" disabled={!keyboardMove || !playable}>
                    Play
                  </button>
                </div>
              </form>
              <input
                ref={fileRef}
                type="file"
                accept=".pgn,text/plain,application/x-chess-pgn"
                hidden
                onChange={(event) => {
                  void importGame(event.target.files?.[0])
                  event.target.value = ''
                }}
              />
              <div className="secondary-controls">
                <button type="button" onClick={() => fileRef.current?.click()}>
                  <Upload aria-hidden="true" />
                  Open PGN
                </button>
                <button
                  type="button"
                  aria-pressed={soundOn}
                  onClick={() => {
                    soundRef.current = !soundOn
                    setSoundOn(!soundOn)
                    playMoveSound()
                  }}
                >
                  {soundOn ? (
                    <Volume2 aria-hidden="true" />
                  ) : (
                    <VolumeX aria-hidden="true" />
                  )}
                  Sound {soundOn ? 'on' : 'off'}
                </button>
                <button
                  type="button"
                  onClick={exportGame}
                  disabled={!history.length}
                >
                  <Download aria-hidden="true" />
                  Save PGN
                </button>
              </div>
              {importError ? <p role="alert">{importError}</p> : null}
              <p>
                {storageAvailable
                  ? 'Your game resumes in this browser. Download the PGN to keep a copy.'
                  : 'This browser could not save your game. Download the PGN to keep it.'}
              </p>
            </details>
          </section>
          <aside className="analysis-column" aria-label="Game analysis">
            <ChessCoach
              coach={coach}
              onRetry={() => {
                if (lastCoachRequestRef.current)
                  void runCoach(lastCoachRequestRef.current)
              }}
            />
            <Council reading={council} thinking={thinking} />
            <MoveLedger
              history={history}
              activeTab={activeTab}
              onTabChange={setActiveTab}
            />
          </aside>
        </div>
      </main>
      <footer className="site-footer">
        <span>Play carefully · Read the reasoning</span>
        <a href="https://github.com/milwrite/chess-lm">
          Source &amp; credits ↗
        </a>
      </footer>
    </div>
  )
}
export default App
