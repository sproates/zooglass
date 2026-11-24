# Isolate benchmark monitoring overhead

This client-only diagnostic compares protocol serialization, parsing and accounting
with resource sampling off and on. It does not measure ZooGlass capacity, change
campaign classifications or relax sending deadlines. The same prepared, idle
ZooGlass JVM remains running in both arms; no workload publications reach it.

Use Node 26, Java 25, Python 3 and a prepared service JAR. Preparation is explicit:
`npm run prepare:service`. The diagnostic never builds Java. Reserve an idle host.

```sh
npm run benchmark:sampling -- /absolute/new-directory \
  --conditions "actual competing load, power and storage conditions"
```

The fixed plan pairs 10, 100, 300 and 1000 submissions/second, three repeats each,
30 seconds per trial. Pair order alternates by repeat. That is 12 minutes of
scheduled work plus setup, settling and output; an internal 20-minute timeout
bounds the owned service session. Each trial has a two-second settling period.
Add `--smoke` for one pair at 100/s for one second each, for wiring checks only.
The output directory must be new. There is no automatic resume or rerun.

`manifest.json` records executable identity, host conditions and trial order.
Each `trial-NN.json` preserves the planned/actual submission times, scheduler
wakes and missed slots, accounting, event-loop delay and sampling records. Both
arms enable event-loop monitoring and timing capture; the sampled arm adds the
process, I/O and JVM sampler in a worker thread. The worker returns its first
sample before timed client work starts; both arms begin their diagnostic event-loop
histogram after setup. The sampler retains a separate sender-thread histogram. Capture stops at one million wake records.
`completion.json` marks a completed set after orderly JVM shutdown. An error
exits nonzero; retain partial trials but do not treat them as a complete comparison.

Compare missed slots and `timing.lateSubmissions`, not just the historical
client-diagnostic `qualified` field: that field checks missed slots, counts and
pending work and does not test actual submission lateness. Sampling records carry
start times and elapsed durations. Elapsed sampling time includes asynchronous
work; it is not an event-loop blocking measurement. Low CPU for the driver and
service excludes CPU consumed by sampler child processes.

The idle JVM omits load-dependent interactions. Evidence of an effect here can
justify a sampler correction, but absence does not clear sampling under service
load. A failed 1000/s control points to a separate driver scheduling limitation.
Do not infer a service capacity limit, change durability, or switch providers
from this diagnostic alone. Run a reviewed targeted follow-up before another
full campaign.

Worker isolation removes probe launches and parsing from the sending thread; it
does not remove host CPU/I/O contention or the cost of receiving one sample per
second. Treat reduced interference as a hypothesis until the paired control is
rerun. The sender and client control share a deadline-waiting clock: longer gaps
use timers, and the final portion (less than 2 ms) yields to the event loop until
the deadline. Internal clock polls do not become diagnostic wake records. This
avoids requesting sub-millisecond timers, but repeated yields cost CPU and cannot
guarantee punctuality under host load. Compare CPU as well as missed/late slots
in the next paired run; high-rate qualification remains an evidence requirement.
