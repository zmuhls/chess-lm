import type { Move } from 'chess.js'

type MoveLedgerProps = {
  history: Move[]
  activeTab: 'moves' | 'method'
  onTabChange: (tab: 'moves' | 'method') => void
}
export function MoveLedger({
  history,
  activeTab,
  onTabChange,
}: MoveLedgerProps) {
  const pairs: Array<{ number: number; white?: string; black?: string }> = []
  history.forEach((move, index) => {
    const pairIndex = Math.floor(index / 2)
    pairs[pairIndex] ??= { number: pairIndex + 1 }
    if (move.color === 'w') pairs[pairIndex].white = move.san
    else pairs[pairIndex].black = move.san
  })
  return (
    <section className="ledger" aria-label="Game record and method">
      <div className="ledger-tabs" role="tablist" aria-label="Game details">
        {(['moves', 'method'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            id={`${tab}-tab`}
            role="tab"
            aria-controls={`${tab}-panel`}
            aria-selected={activeTab === tab}
            tabIndex={activeTab === tab ? 0 : -1}
            onClick={() => onTabChange(tab)}
            onKeyDown={(event) => {
              if (
                ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
              ) {
                event.preventDefault()
                const next =
                  event.key === 'Home'
                    ? 'moves'
                    : event.key === 'End'
                      ? 'method'
                      : tab === 'moves'
                        ? 'method'
                        : 'moves'
                onTabChange(next)
                document.getElementById(`${next}-tab`)?.focus()
              }
            }}
          >
            {tab === 'moves' ? 'Moves' : 'How it works'}
          </button>
        ))}
      </div>
      {activeTab === 'moves' ? (
        <div
          className="move-record"
          id="moves-panel"
          role="tabpanel"
          aria-labelledby="moves-tab"
          tabIndex={0}
        >
          {pairs.length ? (
            <>
              <div className="move-columns" aria-hidden="true">
                <span>Turn</span>
                <span>You</span>
                <span>Death</span>
              </div>
              <ol>
                {pairs.map((pair) => (
                  <li key={pair.number}>
                    <span>{pair.number}</span>
                    <strong>{pair.white}</strong>
                    <strong>{pair.black ?? '…'}</strong>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className="empty-state">
              Tap a white piece, then a destination. You can also drag pieces or
              use notation in More controls.
            </p>
          )}
        </div>
      ) : (
        <div
          className="method-copy"
          id="method-panel"
          role="tabpanel"
          aria-labelledby="method-tab"
          tabIndex={0}
        >
          <p>
            You play White against Death, powered by Stockfish 18 at Skill Level
            8. Stockfish checks legal moves in your browser and chooses every
            reply.
          </p>
          <p>
            Engine lines show up to three candidate replies from the position
            before Death moved. Scores are measured for White; a positive number
            favors you, and M indicates a forced mate at the searched depth.
          </p>
          <p>
            The coach sends your position, recent moves, and engine lines to a
            language model through the CUNY AI Lab’s Cloudflare gateway. Its explanations can be
            mistaken. Compare them with the board and the supplied lines.
          </p>
          <p>
            Your game saves in this browser. Save PGN downloads the complete
            move record for study or another chess program.
          </p>
        </div>
      )}
    </section>
  )
}
