# Frontend handoff: web/index.html

The landing page is one self-contained file, `web/index.html`. It has no build step and is deployed as a static page. It calls exactly one backend route, on the same origin.

## What the backend must provide

```
POST /api/ask
Content-Type: application/json

{ "task": "<the user's question>" }
```

Success: `200` with JSON:

| field         | type    | used for                                                        |
|---------------|---------|-----------------------------------------------------------------|
| `answer`      | string  | Printed in the live-run terminal. Required and non-empty, otherwise the page treats the call as failed. |
| `specialist`  | string  | "routed to <specialist> · rank #1". Defaults to "Specialist".  |
| `source`      | string  | "source …" line. Defaults to "cited source".                   |
| `costUsd`     | number  | "paid 0.01 USD". Defaults to 0.01.                              |
| `receiptHash` | string  | Shortened to the first 10 and last 8 characters. Also adds a block to the receipts row. |
| `signalHash`  | string  | Verify link: `https://devnode.telegraphprotocol.com/engine/v1/signal/<signalHash>`, opened in a new tab. |
| `verified`    | boolean | `false` shows "not yet verified" instead of "◆ verified on node". |

Failure: any non-2xx status, invalid JSON, a missing `answer`, a network error or a 45-second timeout. The page then shows *"Live answers aren't reachable right now. The three examples are real verified runs; replaying the closest one."* and replays the closest of the three built-in examples. The page never blocks on this call.

Notes for the route:
- Allow at least 45 seconds of runtime (for example, `maxDuration` on a Vercel function), since routing plus payment can take a while.
- Input is capped at 500 characters on the client. Validate on the server as well.
- No keys, secrets or wallet code live in the page. Payment and signing stay server-side.

## What is in the page

1. **Hero (the one bold moment).** A real-time ASCII landscape (Three.js r160, pinned) flown over toward a radiant sun inside an arched portal. The landscape is a fixed backdrop behind the whole page: as you scroll, the camera climbs and the terrain dims slightly, and every section sits on a borderless panel that fades into it.
   - Receipt towers stand on the hills, linked by dashed lines.
   - Each question draws an arc to a tower, which lights up and releases a receipt block; a shockwave crosses the terrain.
   - Interactions: move to lift the ground and scan, hold to fly faster, click to drop a probe, hover a tower, use the light/dark toggle.
   - The ask box and the three example chips sit at left; a live-run terminal with a receipts row sits at bottom right.
2. **Examples** (`#examples`): the three verified runs side by side, plain model against Axiom. Each Axiom side shows the source, cost, shortened receipt, a "verified on node" badge and a "Verify on node ↗" link. Each plain-model side shows "No source, no receipt".
3. **How it works** (`#how`): four steps (ask, route, pay, prove) and the request and response shape.
4. **Star band and footer**, both linking to https://github.com/sadiqkhzn/axiom.

## Structure, for anyone editing it

- **Interface script** (a plain `<script>`): the terminal, ask form, fetch, fallback, example chips, replay buttons, idle demo and light/dark mode. It works without WebGL.
- **3D module** (`<script type="module">`): the terrain, towers and arcs. It listens for window events from the interface and never calls the network.
  - `ax:route` (detail = the answer object): pick a tower, start the arc.
  - `ax:arrive`: light the tower, receipt block, shockwave, sun flare.
  - `ax:mode` (`"light"` or `"dark"`): recolour.
- Scroll progress is exposed as the CSS variable `--sp` on `<html>` (0 at the top, 1 after one screen). It fades the halo, labels and scrim.
- If WebGL2 or the CDN is unavailable, the backdrop gets the class `nogl` and stays fully usable as a static paper hero.
- `prefers-reduced-motion`: no flight or animation; questions resolve instantly.
- The three example datasets appear twice: in the `EX` array in the interface script and as static HTML in `#examples`. Keep them in sync if they change.
- External scripts: `three@0.160.0` from cdn.jsdelivr.net only. Fonts: Google Fonts (Geist, Geist Mono, Red Hat Display).
- The file starts with `<meta charset="utf-8">` as required, so it renders in quirks mode (there is no doctype). The layout was checked in that mode at 1440px and 400px with no horizontal scroll.
