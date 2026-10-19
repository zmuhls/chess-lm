import type { CouncilReading } from '../model/modelGuide'

type CouncilProps = { reading: CouncilReading | null; thinking: boolean }

export function Council({ reading, thinking }: CouncilProps) {
  return (
    <section
      className="engine-lines"
      aria-labelledby="lines-title"
      aria-busy={thinking}
    >
      <div className="section-heading">
        <h2 id="lines-title">Engine lines</h2>
        <span>Evaluation for White</span>
      </div>
      {thinking ? (
        <p className="empty-state">Stockfish is comparing legal replies.</p>
      ) : reading ? (
        <>
          <p className="played-reply">
            Death played <strong>{reading.decision}</strong>
          </p>
          <div className="candidate-list">
            {reading.advisers.map((adviser) => (
              <details key={adviser.move} className="candidate">
                <summary>
                  <strong>{adviser.move}</strong>
                  <span>{adviser.evaluation}</span>
                </summary>
                <p className="variation">{adviser.continuation}</p>
              </details>
            ))}
          </div>
          <p className="engine-caption">
            Candidate replies before Death’s move, calculated by Stockfish.
          </p>
        </>
      ) : (
        <p className="empty-state">
          Play a move to compare Stockfish’s replies.
        </p>
      )}
    </section>
  )
}
