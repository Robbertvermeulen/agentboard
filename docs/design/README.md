# Design

The web UI was designed in Claude Design before it was built. This folder
holds the canvas and the screenshots used to check the build against it.

- `Agentboard.dc.html` + `support.js`: the canvas, exported from Claude
  Design. Three rounds: turn 1 (board, card detail, ops card, context viewer,
  mobile triage), turn 2 (hand-back, two kinds of waiting, blockers, routines,
  agent log, realtime, secrets intake), turn 3 (mobile navigation, doing
  confirmation, intake anchor).
- `design-update-2026-08-25-summary.md`: how turn 2 compares with its brief
  (Dutch).
- `verify/`: screenshots of the built UI, one folder per build batch.

claude.ai/design is the source of truth. The export caps files at 256 KiB, so
the local canvas is truncated: artboards 1c to 1f are missing. Open the file
over HTTP, not `file://`, to view it. The images in `../readme/` were rendered
from this canvas with the demo names replaced.

The colour palette takes inspiration from [Multica](https://github.com/multica-ai/multica).
Everything else, design and code, is Agentboard's own.
