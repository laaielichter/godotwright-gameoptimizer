# Contributing

Thanks for wanting to help. Bug reports, findings that were wrong on your project, and pull requests are all welcome.

## Quick start

```sh
git clone https://github.com/laaielichter/godotwright-gameoptimizer
cd godotwright-gameoptimizer
npm test                      # no dependencies, no Godot needed
GO_TEST_GODOT=1 npm test      # also the tests that run Godot (set GODOT or have godot on PATH)
node bin/gameoptimizer.mjs demo /tmp/world && node bin/gameoptimizer.mjs audit /tmp/world
```

Node 20 or newer. There is no build step and no runtime dependency, and it should stay that way.

## Good ways to help

- **A finding that is wrong or missing on your project.** Open an issue with the audit output (`--json` is best) and,
  if you can, a small project that shows it. Real projects are what make the rules better.
- **Benchmark numbers on a real GPU.** The numbers in the README come from a software renderer. A `compare` report
  from your own hardware is very useful.
- **Issues labelled [`good first issue`](https://github.com/laaielichter/godotwright-gameoptimizer/labels/good%20first%20issue).**

## Rules for code

[AGENTS.md](AGENTS.md) describes the layout. The short version:

- A rule must be quiet on a project that does it right: test both ways.
- A fix must be exact, reversible (undo restores every byte) and idempotent. Write through a `Transaction`.
- Every Godot setting path and default must exist in the Godot version named in the README. Look it up.
- A new tool or input goes into `src/tools.mjs`, then `README.md`, `llms.txt`, `skills/gameoptimizer/SKILL.md` and a test.

## Pull requests

Keep a PR to one change, describe what you measured (if anything), and make sure `npm test` passes. Your commits stay
under your own name, and you are credited in the CHANGELOG.
