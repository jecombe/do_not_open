// One player hammering the API: behind any number of replicas it must get exactly its
// allowance a minute (RATE_LIMIT_PER_MINUTE), then 429. The limit is counted in each replica's
// memory, so this holds only if the proxy keeps one address on one replica (client_ip_hash);
// spread over three replicas, the player would get three allowances.
//
//   k6 run -e BASE_URL=http://localhost:8080 loadtest/ratelimit.js
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";
import { BASE_URL, summarize } from "./lib.js";

const IP = "203.0.113.7";
const served = new Counter("ratelimit_served");
const refused = new Counter("ratelimit_refused");

export const options = {
  scenarios: { burst: { executor: "shared-iterations", vus: 1, iterations: 1, maxDuration: "2m" } },
  thresholds: { checks: ["rate==1"] },
};

const hit = () => http.get(`${BASE_URL}/v1/stats`, { headers: { "x-forwarded-for": IP }, tags: { kind: "ratelimit" } });

export default function () {
  // The window is a fixed minute: start in a fresh one (nothing spent yet, most of it ahead),
  // so the burst never straddles two.
  let first = hit();
  const limit = Number(first.headers["X-Ratelimit-Limit"]);
  if (!limit) throw new Error("no x-ratelimit-limit header: is the rate limit on?");
  const reset = Number(first.headers["X-Ratelimit-Reset"] ?? 0);
  const remaining = Number(first.headers["X-Ratelimit-Remaining"] ?? 0);
  if (reset < 55 || remaining < limit - 1) {
    sleep(reset + 1);
    first = hit();
  }

  let ok = first.status === 200 ? 1 : 0;
  let tooMany = first.status === 429 ? 1 : 0;
  for (let i = 1; i < limit + 50; i++) {
    const r = hit();
    if (r.status === 200) ok++;
    else if (r.status === 429) tooMany++;
  }
  served.add(ok);
  refused.add(tooMany);
  console.log(`limit ${limit}/min: ${ok} served, ${tooMany} refused`);
  check(null, {
    "served exactly the allowance": () => ok === limit,
    "refused the rest": () => tooMany === 50,
  });
}

export function handleSummary(data) {
  return summarize(data, {
    served: data.metrics.ratelimit_served?.values.count,
    refused: data.metrics.ratelimit_refused?.values.count,
  });
}
