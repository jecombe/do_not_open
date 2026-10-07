// Players reading the game: what the app asks the API for while people browse, weighted like a
// visit. Only public reads; nothing that costs money or reaches Zama, Gemini, fal or X.
//
//   k6 run -e BASE_URL=http://localhost:8080 -e VUS=100 -e DURATION=2m loadtest/api.js
//
// Each visit comes from an address of its own (X-Forwarded-For): a virtual user plays one
// player after another, so the proxy spreads them over the replicas the way it spreads real
// players, and none of them reaches the per-IP rate limit (loadtest/ratelimit.js checks that).
import http from "k6/http";
import { check, group, sleep } from "k6";
import { BASE_URL, BOXES, DUELS, PLAYERS, ipOf, playerAddress, summarize } from "./lib.js";

const VUS = Number(__ENV.VUS || 50);
const DURATION = __ENV.DURATION || "2m";
/** Seconds a player waits between two screens: 0 for a stress test. */
const THINK = Number(__ENV.THINK ?? 1);

export const options = {
  scenarios: {
    players: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: VUS },
        { duration: DURATION, target: VUS },
        { duration: "10s", target: 0 },
      ],
      gracefulRampDown: "10s",
    },
  },
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  thresholds: {
    // Reads the index answers from Postgres: these decide whether the run passes.
    "http_req_duration{kind:index}": ["p(95)<300", "p(99)<800"],
    "http_req_failed{kind:index}": ["rate<0.01"],
    checks: ["rate>0.99"],
    // Reads that may wait on a free Sepolia RPC (cached, but a cold cache goes out): reported, never failing.
    "http_req_duration{kind:chain}": ["max>=0"],
    "http_req_failed{kind:chain}": ["rate>=0"],
  },
};

const int = (n) => Math.floor(Math.random() * n);
const box = () => int(BOXES);

function get(path, kind, name) {
  const res = http.get(`${BASE_URL}${path}`, {
    headers: { "x-forwarded-for": ipOf(__VU * 1000 + (__ITER % 1000)) },
    tags: { kind, name: name ?? path },
  });
  check(res, { [`${name ?? path} answers`]: (r) => r.status === 200 });
  return res;
}

const think = () => THINK && sleep(THINK * (0.5 + Math.random()));

/** Someone landing on the game: the shelf of boxes, the counters, the feed. */
function landing() {
  get("/health", "index");
  get("/v1/stats", "index");
  get("/v1/collection", "chain");
  const from = int(Math.max(1, BOXES - 1000));
  get(`/v1/boxes?from=${from}&to=${from + 1000}`, "index", "/v1/boxes?from&to");
  get("/v1/activity?limit=50", "index", "/v1/activity");
}

/** Looking at boxes one by one: a box, its story, its card. */
function browseBoxes() {
  for (let k = 0; k < 3; k++) {
    const id = box();
    get(`/v1/boxes/${id}`, "index", "/v1/boxes/:id");
    get(`/v1/boxes/${id}/activity?limit=20`, "index", "/v1/boxes/:id/activity");
    if (Math.random() < 0.3) get(`/metadata/${id}`, "index", "/metadata/:id");
    if (Math.random() < 0.2) get(`/v1/boxes/${id}/pantry`, "chain", "/v1/boxes/:id/pantry");
    think();
  }
}

/** The duels: the shelf, the standings, one duel. */
function duels() {
  get("/v1/duels/shelf", "index");
  get("/v1/leaderboard/duels", "index");
  get(`/v1/duels?tokens=${box()},${box()},${box()}&open=true`, "index", "/v1/duels?tokens");
  get(`/v1/duels/${1 + int(DUELS)}`, "index", "/v1/duels/:id");
}

/** A player's own page: their account, their duels, their pending proofs. */
function account() {
  const who = playerAddress(int(PLAYERS));
  get(`/v1/accounts/${who}`, "index", "/v1/accounts/:address");
  get(`/v1/duels?account=${who}`, "index", "/v1/duels?account");
  get(`/v1/accounts/${who}/requests`, "index", "/v1/accounts/:address/requests");
  get(`/v1/activity?account=${who}&limit=50`, "index", "/v1/activity?account");
}

/** The hall of fame and the croquette market. */
function rankings() {
  get("/v1/leaderboard", "index");
  if (Math.random() < 0.5) get("/v1/economy", "chain");
}

/** A visit picks screens in about the proportions the app asks for them. */
const VISITS = [
  [0.3, browseBoxes],
  [0.2, duels],
  [0.2, account],
  [0.15, rankings],
  [0.15, landing],
];

export function setup() {
  const res = http.get(`${BASE_URL}/health`);
  if (res.status !== 200) throw new Error(`${BASE_URL}/health answered ${res.status}: is the stack up?`);
  const block = res.json("block");
  if (!block) throw new Error("the index is empty: run the seed (pnpm --filter @dno/api seed:load) first");
}

export default function () {
  // Every visit starts on the landing screen, then wanders.
  if (__ITER === 0) group("landing", landing);
  let r = Math.random();
  for (const [weight, visit] of VISITS) {
    if ((r -= weight) <= 0) {
      group(visit.name, visit);
      break;
    }
  }
  think();
}

export function handleSummary(data) {
  return summarize(data, { vus: VUS, duration: DURATION });
}
