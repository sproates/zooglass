# Security policy

ZooGlass is an early prototype. There are no supported production releases or
maintenance branches. Security fixes are considered against current `main`;
there is no guaranteed response time or backport commitment.

The local Workbench runner binds its owned service to loopback. The prototype
has no application authentication or access-control model, and holds view state
in memory. These are documented limitations, not a basis for exposing it to
untrusted networks or using it with sensitive data.

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
