# @dno/admin

The team's dashboard, behind one password: how the boarding page, the game and the sealed vault are doing. React
and Vite, no chart library (the charts are plain SVG in `src/charts.tsx`). Its copy is in French,
for the team, and kept in `src/labels.ts`.

| Tab | Shows |
| --- | --- |
| Vue d'ensemble | the whitelist's seats, their pace over 7 days and when the list fills at it; 12 figures (boarding passes, X accounts, seats, `/board`, claims, ideas, purchases, openings, duels, rats, studio packs, active wallets), each with today, yesterday, 7 days against the 7 before and a daily line; boarding and chain charts by day; the latest steps; when players are around (weekday × hour, in the viewer's time zone) |
| Embarquement | the boarding funnel (pass → X → each required task → seat → wallet → claim → Discord) with what each step keeps, the step that loses the most, the tasks on X, the median time from a pass to a seat, ideas by language |
| Joueurs | every pass by X handle: search, filters (seated, X without a seat, no X, seat without a wallet), tasks with their times, a CSV export; a linked wallet shows only on a click, which the API logs |
| Jeu on-chain | boxes bought, opened, shaken and fed, duels posted and played, rats, studio packs, ETH → USDC, distinct wallets a day: public facts only |
| Coffre | the sealed vault from its public events: NFTs inside and deposited, Seaport sales and volume, private sales settled, 6 figures (deposits, listings, Seaport sales, private sales, withdrawals, requests) with their daily line, boxes by state, ETH paid and collected, requests by action and outcome, deposits per collection, the latest events. Never who holds a box nor a private sale's price |
| Idées | the suggestion box, by language, searchable, with a CSV export |

The period (7, 14, 30 or 90 days) applies to the charts; the page reloads its figures every
minute while it is visible.

## How it is served

The API serves the build under `/admin` and its data under `/admin/api` when `ADMIN_PASSWORD`
is set ([`apps/api/README.md`](../api/README.md#the-admin-site)); the image builds this app
(`apps/api/Dockerfile`). On the server, the edge proxy routes `ADMIN_DOMAIN` to `/admin`, so
the app lives at `/` on its domain and asks `/api/...` on its own origin; the public API's
domain refuses `/admin` ([`deploy/README.md`](../../deploy/README.md#the-admin-site)).

## Run it

```bash
ADMIN_PASSWORD=some-long-password pnpm --filter @dno/api dev   # the API on :8080
pnpm --filter @dno/admin dev                                   # http://localhost:5174, /api proxied to :8080/admin/api
ADMIN_API=http://localhost:9000 pnpm --filter @dno/admin dev   # another API
pnpm --filter @dno/admin build                                 # dist/, what the image serves
```
