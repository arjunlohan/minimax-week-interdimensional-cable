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
