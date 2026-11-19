[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/AfrizalSek/makefun-token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/AfrizalSek/makefun-token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Built for the [make.fun token-radar-01 bounty](https://make.fun/bounty/token-radar-01). Referral: https://make.fun/r/s9c6zfye

# Token Radar — make.fun token-radar-01

A token launch radar: pre-token protocols ranked by implied value, from a
comps model fitted on the snapshot's own live-token protocols. Built for the
make.fun bounty [token-radar-01](https://make.fun/c/token-radar-01)
(deadline 14 Dec 2026). This is a clean rebuild: every file was written
fresh in the rebuild session, after the first build's submission bundle was
blocked on provenance (its parent session file is 108.8 MB, over the CLI's
64 MiB limit).

## The model (radar-3)

Implied value is a comps model, not a flat multiple:

```
multiple   = kernel-weighted median of ln(market cap / TVL) over the live-token comps
             (Gaussian kernel on ln(TVL) distance, bandwidth 1.0; same-category comps 1.0,
             other categories 0.35; clamped to [0.02, 5.0])
spread     = 1.2533 x weighted std of ln(market cap / TVL) / sqrt(effective n)
implied    = round(TVL x multiple x growth x maturity)
growth     = 1 + clamp(change_7d, -60, 120) / 100 x 0.5
maturity   = 0.6 + min(age_days, 1095) / 1095 x 0.4
```

The board holds every rankable pre-token protocol the snapshot records:
the 40 watchlist names plus every other protocol that passes the watchlist's
own rule (not an exchange, not a wrapped / staked / bridged product, not a
versioned pool). Each row carries a farm plan generated from its own record
(category, chains, TVL, age) with costs and times, and the detail view names
the nearest live comps the kernel priced it from — and re-prices the row in
the page, so the drawer can say whether it got the same number board.json
carries.

Validation is leave-one-out over the 119 live comps, run two ways and shown
both ways on the dashboard: once for the multiple alone, and once for the
full board formula (clamp, growth and maturity included), which is the
formula the board actually uses. The dashboard says which number is which.

## Run locally

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path to snapshot.json>
```

`main.ts` writes `board.json`, `data.js`, `dashboard/` and `screenshots/` to
the output directory, then `dossier.json` via the vendored
`vendor/makefun-board.ts`. It runs twice in grading; both runs write
identical bytes.

## Layout

- `main.ts` — the entrypoint (Node 22, standard library only)
- `lib/model.ts` — the snapshot parser, the comps model, the farm plans, the validation
- `dashboard/` — the static page (no network): `index.html`, `app.css`, `app.js`
- `screenshots/` — the board, a protocol's detail view, and a filtered view
- `vendor/makefun-board.ts` — make.fun's dossier library, copied unchanged from the kit

## License

MIT — see `LICENSE`.
