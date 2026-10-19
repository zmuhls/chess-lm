import { RefreshCw } from 'lucide-react'
import type { CoachState } from '../model/coachClient'

type ChessCoachProps = { coach: CoachState; onRetry: () => void }
export function ChessCoach({ coach, onRetry }: ChessCoachProps) {
  const working = coach.status === 'loading'
  return (
    <section
      className={`chess-coach chess-coach--${coach.status}`}
      aria-labelledby="chess-coach-title"
    >
      <div className="section-heading">
        <h2 id="chess-coach-title">Chess coach</h2>
        <span>Language model</span>
      </div>
      <p
        className="coach-reading"
        role="status"
        aria-live="polite"
        aria-busy={working}
      >
        {coach.message}
      </p>
      <div className="coach-meta">
        <span>
          {coach.status === 'ready'
            ? `${coach.model.replace(':cloud', '').replaceAll('-', ' ')} · CAIL`
            : 'Engine-grounded commentary'}
        </span>
        {coach.status === 'error' ? (
          <button type="button" onClick={onRetry}>
            <RefreshCw aria-hidden="true" />
            Try again
          </button>
        ) : null}
      </div>
      {coach.status === 'error' ? (
        <p className="engine-caption">
          You can keep playing while the coach is unavailable.
        </p>
      ) : null}
    </section>
  )
}
