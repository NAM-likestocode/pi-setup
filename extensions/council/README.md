# Council

`/council` puts one idea in front of four opinionated advisors, lets them argue, and returns a single verdict.

```
/council opus5max should I open a specialty coffee bar in Vienna's 7th district?
```

## Who sits on the council

| Member | Lens |
|---|---|
| ☀ The Optimist | The honest best case: the real upside, the unfair advantage, the fastest first win |
| ☁ The Skeptic | The failure analysis: what kills it, ranked by probability × damage |
| € The CFO | Only money: unit economics, margin, cash needed, break-even, payback |
| ⚙ The Operator | What actually happens: the first 90 days, the missing skills, the smallest real test |

A fifth run, the **Chair**, reads the whole debate and decides. The chair never adds new facts.

## How a run works

1. **Opening positions** — all four members answer independently, in parallel.
2. **Rebuttals** — each member sees the other three and must concede, rebut, and update their score.
3. **Chair** — merges everything into a verdict, the one thing that kills it, the money that must hold, and the cheapest way to find out.

Default is 2 rounds, so `4 × 2 + 1 = 9` model runs. Use `--quick` for 5.

## Options

```
/council <model> [--rounds N] [--quick] [--no-web] <idea>
/council models      list the model names you can use
/council help
```

- **Model names are fuzzy:** `opus5`, `sonnet5`, `haiku45`, `sol`, `luna`, `gpt55`, or a full `provider/id`.
- **Thinking level** is a suffix or a colon: `opus5max`, `opus5:xhigh`. Default is `high`.
- Leave the model out entirely and the session's current model is used.
- **Web research is on by default.** Each member gets `web_search`, `source_check`, `fetch_content` and `get_search_content`, capped at ~4 searches by prompt. `--no-web` runs pure reasoning.
- Every run asks for confirmation first, showing the model, member list, run count, and whether the idea text will be sent to a search provider.

While the council sits, a panel above the prompt updates every second with the phase, elapsed time, and each member's state — `thinking…`, the search they are running, or `done · 7/10`. Members take minutes, so this is the only sign of life until the report lands.

The report arrives as one message in the session. The terminal shows the chair's verdict; `ctrl+o` expands the full debate. The complete transcript is in the model's context, so the main agent can be asked follow-up questions about it.

## How members run

Each member is a separate headless Pi process:

```
pi --mode json --print --no-session --no-extensions --no-skills
   --no-prompt-templates --no-context-files
   --append-system-prompt <persona> --model <provider/id> --thinking <level>
   [--extension <auth>] [--extension <web>] [--tools ...]
```

They have no session, no project context, no skills, and no file or shell access. Only the four web tools are ever enabled.

### Provider auth

`--no-extensions` also drops provider auth extensions. Anthropic here is OAuth-based, so members on an `anthropic/*` model automatically load `@gotgenes/pi-anthropic-auth`; without it the child is rejected with a "third-party apps draw from your extra usage" 400. If that package is missing, the command refuses to start instead of burning runs.

## Recursion safety

Two independent guards prevent a member from convening its own council:

- The extension does not register at all when `PI_COUNCIL_MEMBER=1`.
- `runCouncilChild()` refuses to spawn when `PI_COUNCIL_MEMBER=1`, which also protects direct importers.
- `getPiInvocation()` relaunches `process.argv[1]` **only** when that script is the Pi CLI itself. Importing this module from an arbitrary script and relaunching argv[1] would otherwise fork-bomb the machine.

Do not import `run.ts` from a standalone script expecting a live run; run it through Pi.

## Files

- `index.ts` — command, confirmation, orchestration, report rendering
- `members.ts` — personas, model-spec resolution, argument parsing (pure)
- `report.ts` — score extraction and report/transcript markdown (pure)
- `run.ts` — child process spawning and JSON event parsing
- `../../tests/council.test.ts` — unit tests for the pure parts and the spawn guard
