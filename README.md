# Token Radar — make.fun token-radar-01

A token launch radar: pre-token protocols ranked by implied value, from a comps model fitted on
the snapshot's own live-token protocols. Built for the make.fun bounty
[token-radar-01](https://make.fun/c/token-radar-01) (deadline 14 Dec 2026).

## The model (radar-2)

Implied value is a comps model, not a flat multiple:

```
multiple   = kernel-weighted median of ln(market cap / TVL) over the live-token comps
             (Gaussian kernel on ln(TVL) distance, bandwidth 1.0; same-category comps 1.0,
             other categories 0.35; clamped to [0.02, 5.0])
implied    = round(tvl_usd x multiple x growth x maturity)
growth     = 1 + clamp(change_7d, -60, 120) / 100 x 0.5
maturity   = 0.6 + min(age_days, 1095) / 1095 x 0.4
```

The board covers the whole watchlist (40 protocols) plus every other rankable pre-token protocol
the snapshot records. Each row carries a farm plan generated from its own record (category, chains,
TVL, age) with costs and times, and the detail view names the nearest live comps the kernel priced
it from. The model is validated leave-one-out on the live comps: the validation numbers are
computed by the program itself and shown on the dashboard.

## Run locally

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path to snapshot.json>
```

`main.ts` writes `board.json`, `data.js`, `dashboard/` and `screenshots/` to the output directory,
then `dossier.json` via the vendored `vendor/makefun-board.ts`. It runs twice in grading; both runs
write identical bytes.

## Layout

- `main.ts` — the entrypoint (Node 22, standard library only)
- `lib/model.ts` — the snapshot parser, the comps model, the farm plans, the validation
- `dashboard/` — the static page (no network): `index.html`, `app.css`, `app.js`
- `screenshots/` — the board, a protocol's detail view, and a filtered view
- `vendor/makefun-board.ts` — make.fun's dossier library, copied unchanged from the kit

## License

MIT — see `LICENSE`.
