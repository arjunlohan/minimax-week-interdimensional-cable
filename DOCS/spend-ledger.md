# MiniMax-H3 spend ledger

MiniMax-H3 is the only paid model in the pipeline, at $0.13 per request. The database table `gmi_spend` is the source of truth: every H3 submission is written there before it is sent (`app/lib/gmi/spend.ts`), and the caps (`H3_MAX_REQUESTS_PER_RUN`, default 14 per show; `H3_SESSION_CAP_USD`, default $8 for the database) are enforced from it.

This file is the human-readable copy. Rows are appended per run; the total is whatever `gmi_spend` says.

| Date (UTC) | Show | Format · duration | H3 requests | Cost (USD) | Note |
| :--------- | :--- | :---------------- | ----------: | ---------: | :--- |

Reconcile with:

```sql
SELECT count(*) AS requests, sum(cost_cents) / 100.0 AS usd
FROM gmi_spend
WHERE model = 'MiniMax-H3';
```

## Runs

| When (PDT) | Show | Format | H3 requests | H3 spend | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-09-06 20:40 | 4bfa4ea8 (Joe Rogan Like, smart-fridge botnet) | audio, 60 s plan | 0 | $0.00 | Free models only: M3, Speech 2.8 HD, Music 3.0. Ready on Mux, 131.8 s. |
| 2026-09-06 20:19 | smoke (`gmi:smoke --only=video`) | n/a | 0 | $0.00 | MiniMax-H3 returned HTTP 402 Insufficient credits; nothing charged. |

Ledger total from `gmi_spend`: 0 requests, $0.00.
