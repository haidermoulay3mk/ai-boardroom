# Contributing

Thanks for wanting to make the board better. Three kinds of contribution are especially welcome.

## 1. Add an advisor

The easiest and most fun way in. Every seat at the table is one markdown file in [`advisors/`](advisors/). Copy an existing one, follow the format in [`advisors/README.md`](advisors/README.md), restart, and your advisor joins the meeting.

A good advisor brings a lens the others don't have, disagrees with someone, and sounds like nobody else at the table. Write personas from **publicly known ideas, in your own words**: no pasted book passages, no invented private details, nothing implying the real person endorses this project.

## 2. Add an engine

Boardroom runs on Claude Code today. Providers live in [`src/providers/`](src/providers/) and implement a small interface (`generate`, `prewarm`, `health`, `dispose`). An Ollama provider (fully local and free) and an Anthropic API provider are the most-wanted additions.

## 3. Fix something

Check the issues labelled `good first issue`. For anything bigger than a bug fix, open an issue first so we can agree on the approach.

## Development

```bash
npm install
npm run dev        # server restarts on change, no browser auto-open
npm run demo       # scripted advisors, no AI calls
npm run check      # typecheck + tests (all offline)
```

- Node 22.18+ runs the TypeScript directly; there is no build step.
- The frontend is plain JavaScript modules in [`public/js/`](public/js/), no framework.
- Tests use the built-in `node:test` runner and never call a real model. The Claude Code provider is tested against a fake CLI in [`test/fixtures/`](test/fixtures/).

Before opening a pull request, run `npm run check` and make sure it passes.
