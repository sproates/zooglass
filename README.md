# ZooGlass

### Event-driven live views

Applications often need a live view built from updates owned by several independent systems.

Keeping that view useful gets harder when updates arrive late, out of order, are corrected, or when a client disconnects and reconnects.

ZooGlass aims to help keep event-driven views current, and clarify what data they reflect.

[What we're trying to build](docs/what-is-zooglass.md) explains the intended
product, the promises its views should make, and how Workbench will help us
verify them. Separate diagrams show ZooGlass's intended production role and the
Workbench environment used to build and test it.

At the moment ZooGlass is a very early prototype, I'm trying out ideas. You won't find much interesting code yet.

The service uses Java 25 and Spring Boot.

The [Scenario Simulator](incubator/workbench/README.md) uses TypeScript and Node 26 to play JSON scenarios on a deterministic simulated timeline. It can run those scenarios through a local ZooGlass process and check the views it produces.

See the [ZooGlass prototype](incubator/zooglass/README.md) and try the [live-match scenario](incubator/workbench/scenarios/live-match.json).

## Testing

ZooGlass has unit and functional tests for the system itself. The Workbench is
where most scenario testing should happen: it drives different event and client
behaviours through ZooGlass and checks the resulting views. Tests for
integrations with external systems, such as Kafka, are a separate concern.
