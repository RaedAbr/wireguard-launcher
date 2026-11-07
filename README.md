# WireGuard Launcher

Start your own WireGuard VPN in the country you choose, in your own AWS account, from a web page. There's nothing to install, and the VPN deletes itself when your time is up.

**[Open the launcher](https://raedabr.github.io/wireguard-launcher/)**

AWS only. Tested on real AWS.

> **One VPN works on one device.** Each VPN is made for a single phone or computer. Using its configuration on a second device makes the two disconnect each other. For another device, start a separate VPN from that device, in a different country.

## Start a VPN

You need an AWS account and the [WireGuard app](https://www.wireguard.com/install/).

1. Open the [launcher page](https://raedabr.github.io/wireguard-launcher/), pick a country and a duration from 15 minutes to 30 days, and choose **Continue to AWS**.
2. Sign in to AWS, tick the box that says the template may create IAM resources, and choose **Create stack**.
3. After about 3 minutes, when the stack shows `CREATE_COMPLETE`, open the **Outputs** tab and tap the `OpenThisLink` link.
4. Save the configuration or scan the QR code with the WireGuard app.

Do all of this in the same browser, because that's where your private key is saved.

## Good to know

- **Deleting sooner:** the page opens the right AWS page, where you select the stack and choose **Delete**. There's no stop or pause. A stopped server would get a new IP address, and its disk would keep costing money.
- **Your VPN list:** the page shows only VPNs started in that browser, because it can't read your AWS account. CloudFormation always shows them all, as stacks named `wireguard-vpn-<region>`.
- **One VPN per country:** you can run several at once, but each must be in a different country.
- **Some countries are off by default:** turn them on in AWS under **Account**, then **AWS Regions**.
- **IPv4 only:** traffic exits over IPv4.

## Costs

A running VPN costs about 1 to 3 US cents an hour plus data, depending on the country. These are estimates. AWS bills your account directly, and a deleted VPN costs nothing.

## How it works

The page is static and has no backend. Its content security policy blocks it from sending data anywhere.

1. Your browser creates the VPN key pair. The private key stays in that browser, and only the public key goes into the AWS link.
2. AWS creates one CloudFormation stack from [template/vpn.yaml](template/vpn.yaml). The server creates its own private key.
3. The stack's output is a link back to the page, carrying the server's IP address and public key. These values are public.
4. The page combines them with your private key to build the configuration.

Every 15 minutes a small function in the stack checks the time and deletes the stack once it's up. As a safety net, the server powers itself off one hour later, and AWS then removes the server and its disk. If the stack ever fails to delete itself, the charges still stop, and only a free empty network stays behind.

The IAM box in step 2 is there because the stack needs a role for that function. The role has no password or access keys. It can delete this stack and server, but because AWS network permissions are broad, it can also delete networks and firewalls in that region. Its code only deletes its own stack.

## Host your own page

This is done once, by whoever hosts the page. People who use the page don't do any of it.

1. Run this with an AWS login that can create a bucket. It uploads the template to a public path and updates `docs/index.html`:

   ```bash
   scripts/publish.sh <bucket> <bucket-region>
   ```

2. Push the repository to GitHub, then under **Settings**, **Pages**, deploy from your branch and the `/docs` folder.

Until a template is published, the page runs as a demo that doesn't touch AWS. Run the script again whenever `template/vpn.yaml` changes.

## Develop

To test against real AWS before hosting the page, publish the template, then run `scripts/serve.sh` and open `http://localhost:8000/`. The template accepts localhost as the return page.

```bash
python -m unittest discover -s tests   # needs PyYAML
cfn-lint template/vpn.yaml
```

`docs/qrcode.js` is qrcode-generator 1.4.4 (MIT), by Kazuhiko Arase. The Geist fonts are under the SIL Open Font License, in [docs/fonts/LICENSE.txt](docs/fonts/LICENSE.txt).
