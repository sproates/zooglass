# Security policy

ZooGlass is an early prototype. There are no supported production releases or
maintenance branches. Security fixes are considered against current `main`;
there is no guaranteed response time or backport commitment.

The local Workbench runner binds its owned service to loopback. The prototype
has no application authentication or access-control model, and holds view state
in memory. These are documented limitations, not a basis for exposing it to
untrusted networks or using it with sensitive data.

The fleet demo also offers an explicit external-viewer mode, bound to one chosen
private or loopback IPv4 address; other address ranges are rejected before
listening. Do not expose it through port forwarding or tunnels. Its single-use pairing links, viewer-scoped refresh capability,
Host/Origin checks and controller role protect demo operations; they do not add
product authorisation to ZooGlass. This mode is for synthetic data on a trusted
LAN using HTTP, not public hosting or confidential transport. See the
[external-viewer guide](incubator/workbench/docs/external-viewers.md) for scope,
revocation and connection limits.

## Report a vulnerability privately

Use GitHub's [Report a vulnerability](https://github.com/sproates/zooglass/security/advisories/new)
form under this repository's Security tab. Private vulnerability reporting is
enabled. Do not put suspected vulnerabilities, exploit details or secrets in a
public issue, PR or comment.

Include:

- The affected commit and component: ZooGlass, Workbench or repository tooling.
- Your operating system and relevant Java or Node versions.
- A minimal, sanitised reproduction and the command or protocol messages used.
- The observed impact, prerequisites and boundary you believe is affected.

Unexpected file or process access, unintended data exposure, and inputs that
exhaust resources are examples worth reporting. Distinguish the observed
behaviour from assumptions about deployment or currently unimplemented features.
Test only systems and data you are authorised to use.

The maintainer will assess the report and, where a fix is appropriate, coordinate
its publication and disclosure through the private advisory. Keep details private
while that assessment is underway. Ordinary functional defects and requests for
new security capabilities can follow [CONTRIBUTING.md](CONTRIBUTING.md).

### Continuous read-only demonstration

The `demo:drive` viewer binds to loopback or an explicit private IPv4 interface.
It uses ordinary HTTP and has no viewer authentication: anyone on that trusted
network who knows the URL can observe synthetic positions. It exposes static
assets and the ZooGlass live-subscription proxy, not event ingestion, view
administration or playback commands. Do not forward or tunnel this local demo
onto the internet. Closing a browser does not stop its source simulation.
