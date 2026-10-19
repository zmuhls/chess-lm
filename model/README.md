# Chess / LM model guide

The running game separates engine evidence from model commentary. Stockfish chooses every move made by Death. The language model explains the played turn and may make mistakes; it cannot change the board.

## Engine evidence

Stockfish runs in a dedicated browser worker with Skill Level 8 and MultiPV 3. The interface displays up to three distinct legal candidate replies, their evaluations for White, and short continuations. It does not repeat candidates when a position has fewer lines. These rows are labeled **Engine lines** and come directly from the engine.

## Coach contract

The browser sends the FEN before and after Death’s reply, complete PGN, the player move, engine reply, and the supplied candidates to the same-origin `POST /api/coach` route. The Cloudflare Worker replays the PGN, checks both positions and played moves, and verifies each candidate continuation before inference. Only the last 16 moves and bounded candidate evidence enter the prompt.

The Worker calls the CAIL Gateway through the `GATEWAY` service binding to `cail-model-api`. Its `CAIL_GATEWAY_KEY` stays in a Worker secret, never in the frontend. The configured `COACH_MODEL` is Gemma 4 26B A4B, `@cf/google/gemma-4-26b-a4b-it`, from the [CAIL model registry](https://ailab.gc.cuny.edu/models/). Model changes should preserve registry eligibility and be checked against the same legal position evidence. This configuration is a deployment choice, not a benchmark claim about chess ability.

The coach is asked to explain the played reply and give a practical plan in two connected sentences. Stockfish retains move authority. Short prompts and legal evidence reduce unsupported claims, but they do not establish that every explanation is correct. A missing or failed coach response leaves the local chess game playable.

The Worker’s native per-client and shared request limits apply at individual Cloudflare locations. Gateway application spend controls provide the separate model budget boundary. Configuration readiness alone is insufficient: release verification must include nonempty coaching from the deployed route and the model ID actually served.

## Workshop materials

`council-prompts.json` preserves three experimental roles: The Witness, The Knight, and The Bishop. These prompts are reusable teaching materials. The former browser council was deterministic prose, not three live model calls; the current interface displays engine evidence without implying otherwise.

`evals/positions.json` contains six positions spanning development, king safety, structure, tactics, and endings. `npm run validate:model` checks legal FENs, role identifiers, prompt structure, and candidate gates. These structural checks do not measure coaching quality.

A future evaluation can compare each explanation against the played move and supplied engine line, record factual errors, and ask a player whether the suggested plan was useful. Preserve the model ID and request evidence with any such result. Players can export and import PGN to retain or revisit a game; those files also allow the legal move history to be checked independently.
