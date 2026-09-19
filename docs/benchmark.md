# Measuring Jev's response time

Code: `bench/latency.ts`. Run it with `npm run bench` (`BENCH_N=40 npm run bench` for more
samples). It makes about 170 real requests, which costs about half a cent at list price.

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
cold (new TLS each)            n= 10  p50   360ms  p90   412ms ...  tok   446  typesafe p50   167ms  sfo1>cle1
gateway-only (unknown model) [rejected 404] n= 10  p50    95ms ...
warm 1q small                  n= 20  p50   257ms  p90   318ms ...  tok   446  typesafe p50   163ms  sfo1>cle1
warm 16q small                 n= 20  p50   277ms  p90   350ms ...  tok  1834  typesafe p50   158ms  sfo1>cle1
warm 1q large                  n= 20  p50   274ms  p90   330ms ...  tok  6633  typesafe p50   160ms  sfo1>cle1
```

- `p50`, `p90`, `p99` are the typical, slow, and very slow times.
- `tok` is how much text Jev was sent, in tokens.
- `typesafe p50` is how long the gateway says it waited for TypeSafe. Subtract it from `p50` to
  get the part spent on the network and inside the gateway (here 257 − 163 = 94 ms, about the
  same as the "gateway-only" line, as it should be).
- `sfo1>cle1` shows the route: Vercel's San Francisco server, then its Cleveland servers. If this
  changes, the time breakdown in [latency.md](latency.md) needs measuring again.
- Lines marked `rejected` are requests the gateway refused (too many requests, or a model that
  doesn't exist). They never reach Jev, so their times show the gateway's own delay. On an
  account without credits most requests are refused, which is still useful for that reason.
