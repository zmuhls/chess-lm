# Chess / LM

Play White against Death, powered by Stockfish 18 at Skill Level 8. Compare the engine’s candidate replies with a language model’s explanation of the turn.

**Live game:** [chess-lm.ailab-452.workers.dev](https://chess-lm.ailab-452.workers.dev/)

The application and coach API run together on Cloudflare. Desktop and mobile release checks confirmed real Gemma 4 coaching through CAIL on 2026-10-19. Repeat the actual coaching check for each release.

## Playing

Tap a white piece and its destination, drag a piece, or open **More controls** to choose a legal move by notation. Pawn promotion offers a queen, rook, bishop, or knight. Undo cancels an unfinished engine search and returns to your previous turn. Flip board also moves the player labels beside their pieces.

The complete PGN saves in this browser and restores on reload, including an unfinished engine turn. **Save PGN** downloads a portable copy, and **Open PGN** restores a legal game from a PGN file. Private browsing and blocked storage can prevent local saves; the interface reports save failures. A new game asks before replacing an existing game.

The previous [GitHub Pages address](https://milwrite.github.io/chess-lm/) and the Cloudflare address have separate browser storage. A saved game cannot transfer automatically between them. Import its PGN at the Cloudflare address before continuing. The older Pages interface did not include a download control; to recover an existing save, open its browser console on the original address and run this local download snippet:

```js
const pgn = localStorage.getItem('chess-lm-pgn');
if (!pgn) throw new Error('No saved game was found in this browser');
const url = URL.createObjectURL(new Blob([pgn], { type: 'application/x-chess-pgn' }));
const link = Object.assign(document.createElement('a'), { href: url, download: 'chess-lm.pgn' });
link.click();
setTimeout(() => URL.revokeObjectURL(url), 1000);
```

This reads only that browser’s saved chess game and downloads it locally. Recovery requires access to the browser that holds the original save.

The CAIL Games link returns to the arcade collection. The interface uses the Lab’s existing logo, a monochrome board, and restrained hover color. It contains no generated background artwork. Coaching and engine lines move below the board on smaller screens, and the primary controls keep 44-pixel touch targets.

## Engine and model responsibilities

- `chess.js` validates moves and game endings.
- Stockfish 18 Lite runs in a browser worker at Skill Level 8 and supplies up to three principal variations. It owns every move made by Death. Search time is capped at 1.5 seconds, with separate startup, response, and cancellation deadlines. Replaced searches finish their cancellation handshake before another position is sent.
- **Engine lines** are the actual legal candidate lines reported by Stockfish, with evaluations from White’s side. Positions with fewer candidates show fewer lines.
- **Chess coach** sends the played turn and engine evidence to the same-origin `/api/coach` route. The Worker validates the request and calls the CAIL Gateway through a service binding. The configured model is Gemma 4 26B A4B, `@cf/google/gemma-4-26b-a4b-it`, from the [CAIL model registry](https://ailab.gc.cuny.edu/models/). An unavailable coach does not stop the game. Its prose can still make mistakes, so compare it with the board and engine evidence.

The reusable council prompts and evaluation positions remain in [`model/`](model/README.md) for workshop experimentation. The live interface uses the factual Engine lines display in place of the old deterministic adviser prose.

## Local development

Use Node 22.12 or newer:

```bash
npm ci
npm run build
cp .dev.vars.example .dev.vars
```

Configure the application’s `CAIL_GATEWAY_KEY` in the ignored `.dev.vars` file. This is a server-side CAIL application credential. Never put it in browser code or a `VITE_` variable.

Run the Worker and Vite in separate terminals:

```bash
npm start
npm run dev
```

`npm start` runs Wrangler at `http://127.0.0.1:8797`. Vite serves the interface at the root path and proxies `/api` and `/health` to that Worker. The service binding must connect to a running development Gateway or an explicitly configured remote Gateway for real coaching. The board and Stockfish can be developed without a working Gateway; local chess play does not require a model request.

## Worker and coach contract

`worker/index.js` serves the built assets and API. `POST /api/coach` accepts `beforeFen`, `fen` after the reply, full PGN, the player and engine SAN moves, and one to three unique candidates. Each candidate includes SAN, evaluation, and a legal SAN continuation from `beforeFen`. The Worker verifies the entire turn before making a model call and sends only the last 16 moves. Clients may omit `beforeFen` when their complete PGN proves it.

The browser calls its own origin. Credentials stay in the Worker, and the `GATEWAY` service binding connects to `cail-model-api`. There is no direct browser provider credential or separate Railway coach service in this architecture.

Configuration in [`wrangler.jsonc`](wrangler.jsonc):

| Binding or variable | Value | Purpose |
| --- | --- | --- |
| `ASSETS` | Built `dist/` directory | Frontend, engine and static assets |
| `GATEWAY` | `cail-model-api` | Internal CAIL model service |
| `CAIL_GATEWAY_KEY` | Worker secret | Application authorization and Gateway spend accounting |
| `COACH_MODEL` | `@cf/google/gemma-4-26b-a4b-it` | Configured coach model |
| `PUBLIC_ORIGIN` | `https://chess-lm.ailab-452.workers.dev` | Public application origin |
| `REQUEST_LIMIT` | 12 requests per 60 seconds | Per-client native rate-limit binding |
| `GLOBAL_LIMIT` | 60 requests per 60 seconds | Shared application rate-limit binding |
| `RELEASE` | Set when releasing | Deployment identification |

Cloudflare’s native rate limits apply at a Cloudflare location. Despite its binding name, `GLOBAL_LIMIT` is not a strict worldwide request ceiling. The Gateway’s application spend controls provide a separate model budget boundary. A Worker rate-limit response and a Gateway budget response must remain failures rather than triggering extra provider calls.

`GET /health` reports configuration readiness, not a successful model probe. Release acceptance includes a real `/api/coach` response with nonempty commentary and the model actually returned by the Gateway.

## Validation and release

```bash
npm test
npm run lint
npm run build
npm run check:worker
```

Tests cover engine cancellation and stale messages, timeout/restart behavior, saved games, constrained candidate sets, and Worker coach behavior. Before publishing, play a complete human/Stockfish turn at desktop and mobile widths, then check reload, undo, promotion, PGN import/export, and a real coach reply.

The GitHub workflow validates changes; it does not deploy GitHub Pages or automatically publish the Worker. Provision the Worker’s CAIL application secret through Wrangler’s secret handling before a release that needs coaching, then deploy the built application with `npm run deploy`. Verify the serving release, asset routes, and actual coach response after deployment. CAIL Games has a separate repository and collection entry.

## Structure and licenses

- `src/engine/` — worker lifecycle, UCI parsing and notation
- `src/game/` — saved-game recovery, PGN handling and turn undo
- `src/components/` — board-adjacent controls and analysis
- `src/model/` — legal candidate formatting and same-origin coach client
- `worker/` — Cloudflare request handling, validated coaching and Gateway access
- `model/` — experimental role prompts and evaluation positions
- `public/engine/` — Stockfish 18 Lite, WebAssembly and license
- `docs/design/` — archived design studies, not runtime assets

[chess.js](https://github.com/jhlywa/chess.js), [react-chessboard](https://github.com/Clariity/react-chessboard), and [Stockfish.js](https://github.com/nmrugg/stockfish.js) provide the rules, board and engine. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). Chess / LM is distributed under GPL-3.0-only because it includes Stockfish.js.
