# Meetble UI (prototype)

Live: run `node server.mjs` in the repo root and open http://localhost:8787. The UI then runs the real pipeline (Steps 0–2 Node CLI, Steps 3–5 Python) and draws its output.

Preview: open `index.html` straight from disk (or add `?demo=1`). It runs on sample data (Boris Jabes) so the flow can be demoed without the backend.

Flow: type who and by when → link accounts → live research → swipe the ranked action cards → "do it" (with an optional confirm step).

## Event contract

The UI only draws these events. The sample run in `index.html` (`run()`) emits them; the backend should emit the same JSON.

| type | fields | draws |
| --- | --- | --- |
| `track_started` / `track_done` | `track` | research track state |
| `step` | `id`, `group`, `label`, `status` (`running`/`done`/`none`/`locked`), `note`, `layers`, `at`, `via` | a checklist line |
| `finding` | `section` (`persona`/`now`/`prec`), `label`, `claim`, `source_url` | a row on the research board |
| `browse` | `domain`, `action`, `url` | the live agent view (what the agent has open) |
| `actions` | `actions[]` with `base`, `rel`, `time`, `warm`, `chan`, `title`, `cta`, `kind`, `out`, `whyDo` | the action card deck (% is computed in the UI) |
| `action_status` | `id`, `s` (`running`/`done`/`waiting`), `t`, `note` | the status on a card |

The orb is a port of the Lock-in Orb renderer (github.com/graceclara/lockinorb).

In live mode `server.mjs` also sends `meta` (`name`, `role`, `deadline_label`) and `end`, and `actions` carries `p_total` and `summary` from `out/plan.json`.
