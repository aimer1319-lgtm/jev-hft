# Measuring Jev's response time

Code: `bench/latency.ts`. Run it with `npm run bench` (`BENCH_N=40 npm run bench` for more
samples). It makes about 170 real requests per route, which costs about half a cent at list price.

## What it does

It sends requests to Jev in different situations and reports how long they took. The results are
summarized in [latency.md](latency.md).

By default it runs **both routes** — straight to TypeSafe and through the gateway — one after the
other, and ends with the single number that matters put side by side. That is how the choice
between them was made: the same questions, from the same machine, a minute apart. Set
`BENCH_ROUTE=typesafe` (or `gateway`) for just one. A route whose key isn't set is skipped.

| Scenario | What it shows |
|---|---|
| New connection each time | the cost of connecting fresh, including the time to reach Vercel and set up encryption |
| A request for a model that doesn't exist | just the trip there and back, since it is turned down before any model runs |
| 1, 4, and 16 questions | whether more questions take longer (they barely do) |
| Short, medium, and long text | whether more text takes longer (it barely does) |
| 8 requests at once | how it behaves under load (and where rate limits kick in) |
| Through the AI SDK | the same request made the way the pipeline makes it |

## Why it doesn't use the AI SDK like the rest of the code

The pipeline calls Jev through the AI SDK, which is simpler and checks answers for us. The
benchmark needs to time each stage of a request (connecting, encryption, waiting for the reply)
and to send a deliberately invalid request, and the SDK doesn't allow either. So it makes the
requests itself, in the same format the SDK uses internally. That format isn't officially
documented and could change; if the benchmark breaks after an SDK update, compare it with
`node_modules/@ai-sdk/gateway/src/gateway-evaluation-model.ts` or
`node_modules/@ai-sdk/typesafe-ai/dist/index.js`. The two routes want slightly different
requests — TypeSafe calls a yes/no question a "noul" and takes the model name in the body, the
gateway takes it in a header — so each route describes its own request shape in the `ROUTES`
table.

## Reading the results

```
=== typesafe  model jev-latest  endpoint api.typesafe.ai  n=8 per scenario ===
cold (new TLS each)            n=  8  p50   226ms ...  tok   446  jev p50    89ms  req_01a0c147...
                               edge TCP connect (≈1 RTT) p50    47ms   TLS handshake p50    44ms
typesafe-only (unknown model) [rejected 400] n=  8  p50    57ms ...
warm 1q small                  n=  8  p50   146ms ...  tok   446  jev p50   105ms
warm 16q small                 n=  8  p50   146ms ...  tok  1834  jev p50   110ms

=== gateway  model typesafe-ai/jev  endpoint ai-gateway.vercel.sh  n=8 per scenario ===
gateway-only (unknown model) [rejected 404] n=  8  p50    94ms ...
warm 1q small                  n=  8  p50   270ms ...  tok   446  jev p50   178ms  sfo1>cle1

warm 1q, the round trip a decision waits for:
  typesafe   p50   146ms   fastest
  gateway    p50   270ms     124ms slower (46% of it)
```

- `p50`, `p90`, `p99` are the typical, slow, and very slow times.
- `tok` is how much text Jev was sent, in tokens.
- `jev p50` is how long Jev itself took, as that route reports it. Subtract it from `p50` to get
  the part spent getting there and back (above: 146 − 105 = 41 ms direct, against 270 − 178 =
  92 ms through the gateway, which matches each route's "unknown model" line, as it should).
  The two figures aren't quite alike: the gateway times TypeSafe from Cleveland, so its number
  includes a leg of network, while TypeSafe times only itself.
- `sfo1>cle1` shows the gateway's route: Vercel's San Francisco server, then Cleveland. The
  direct route prints TypeSafe's request id instead, which is what to quote when asking them
  about a slow call.
- Lines marked `rejected` are requests turned down before any model ran (too many requests, or a
  model that doesn't exist). They never reach Jev, so their times show what the hop itself costs.
  On a gateway account without credits most requests are refused, which is still useful for that
  reason.
