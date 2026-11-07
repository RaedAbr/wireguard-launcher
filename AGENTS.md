# Agent notes: WireGuard Launcher

A static page plus one CloudFormation template. The page builds a quick-create link, AWS creates a VPN stack in the user's account, and the stack's output links back to the page. There's no backend. See `README.md` for the product.

## Layout

- `template/vpn.yaml`: the whole VPN, including the inline Lambda that picks the zone and deletes the stack at expiry.
- `docs/`: the site, served by GitHub Pages from `/docs`. `app.js` holds the flow, and `index.html` holds the landing page.
- `scripts/publish.sh`: uploads the template to public S3 and writes its URL into `docs/index.html`.
- `tests/test_template.py`: template checks, and the inline Lambda run against a fake AWS.

## Invariants

- **Minimum user config is the product goal.** Users need only an AWS account and the WireGuard app. Don't add steps, accounts or installs for them.
- **One VPN per device.** The peer is hardcoded as `10.66.66.2`. This must stay stated in the README, on the landing page, and in the setup flow.
- **The private device key never leaves the browser.** Only public values go in the AWS link and the return link.
- **The page has no network access.** The CSP is `default-src 'none'` with no `connect-src`, and the page's privacy claim depends on it. Everything is self-hosted, with no inline scripts, styles or `style` attributes.
- **An empty `wgl-template` meta means demo mode.** Demo mode must never touch AWS or store anything.
- **`CleanupRole` must be deleted last.** The self-deletion runs with its permissions, so every resource must depend on it, directly or indirectly. A test enforces this.
- **The role needs every delete permission for the stack's resources.** Adding a resource type means adding its delete actions. Update the role text in `app.js` and the README if its reach changes.
- **The Lambda has no logging rights on purpose.** A log group would outlive the stack and break "nothing left behind".
- **Keep the server's safety net.** `InstanceInitiatedShutdownBehavior: terminate`, `DeleteOnTermination` and the `vpn-expiry` timer stop the charges if self-deletion fails.
- **Keys in links are URL-safe base64 without padding.** This avoids encoding problems in the console link and the wait condition's JSON.
- **The return link's format is shared.** `template/vpn.yaml` writes `#connect=<region>.<ip>.<serverKey>.<clientKey>`, and `acceptReturnLink` in `app.js` reads it.
- **The stack name stays fixed per region**, as `wireguard-vpn-<region>`. AWS then blocks a duplicate VPN in that region, instead of billing for a forgotten one.
- **`Ready.Data` is parsed by splitting on `"`.** AWS documents it as `{"<UniqueId>":"<Data>"}`. The signal must stay a single signal with no quotes in the data.

## Gotchas

- In `UserData`, `${X}` is a CloudFormation substitution, and bash variables must be written as `$X`.
- The inline Lambda must stay under 4096 characters. A test enforces this.
- The artifact preview is a build of `docs/` with CSS, JS and fonts inlined and the CSP removed. Live behaviour must be tested from `docs/` itself.

## Known gaps

- The first real run worked end to end. Still unconfirmed: whether the tag condition on `ec2:TerminateInstances` matches, and whether opt-in regions load the template.
- Network delete rights cover the whole region. Try tag conditions after a real run.
- The page's VPN list is per browser and can't show live status.
- Timer failures are invisible, because the Lambda has no logs. The safety net covers the cost.

## Verifying changes

Run the unit tests and `cfn-lint`. UI changes need a real browser run from `docs/` with a template URL set, because the CSP can break things a syntax check won't catch.
