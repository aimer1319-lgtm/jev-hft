# Measuring Jev's response time

Code: `bench/latency.ts`. Run it with `npm run bench` (`BENCH_N=40 npm run bench` for more
samples).

## What it does

It sends requests to Jev through the gateway in different situations and reports how long they
took. The results are summarized in [latency.md](latency.md).

| Scenario | What it shows |
|---|---|
| New connection each time | the cost of connecting fresh, including the time to reach Vercel and set up encryption |
| A request for a model that doesn't exist | just the trip to the gateway and back, since the gateway rejects it immediately |
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
`node_modules/@ai-sdk/gateway/src/gateway-evaluation-model.ts`.

## Reading the results

```
warm 1q small                  n=  1  p50   335ms ...  tok   446  sfo1>cle1
warm 1q small [rejected 429]   n=  4  p50   176ms ...  sfo1>cle1
```

- `p50`, `p90`, `p99` are the typical, slow, and very slow times.
- `tok` is how much text Jev was sent, in tokens.
- `sfo1>cle1` shows the route: Vercel's San Francisco server, then its Cleveland servers. If this
  changes, the time breakdown in [latency.md](latency.md) needs measuring again.
- Lines marked `rejected` are requests the gateway refused (too many requests, or a model that
  doesn't exist). They never reach Jev, so their times show the gateway's own delay. On the free
  tier most requests are refused, which is still useful for that reason.

Successful gateway responses also say exactly how long the gateway waited for TypeSafe. That's how
the ~150 ms "TypeSafe part" in [latency.md](latency.md) was measured. The benchmark doesn't print
it yet; it would be a small addition.
