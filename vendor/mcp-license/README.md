# @theluckystrike/mcp-license

Offline Ed25519 license verification and free/pro gating shared by the MCP servers in this repository.

A license key looks like `MCPL1.<payload>.<signature>`. The payload names the product (or `*` for the
bundle) and an optional expiry. Verification is a pure local signature check: no network request is
made, and no key or identifier is sent anywhere.

```js
import { createLicenseGate } from "@theluckystrike/mcp-license";

const gate = createLicenseGate({ product: "time-tracker" });
gate.isPro();                 // boolean
gate.status();                // { product, tier, licenseId, expires, source, upgradeUrl }
gate.activate(key);           // { ok, reason? } and saves the key locally on success
gate.upgradeText("feature");  // text to return to the user, with the checkout URL
gate.registerTools(server);   // adds license_status and license_activate
```

Key lookup order: `MCP_LICENSE_KEY` environment variable, then
`${XDG_CONFIG_HOME:-~/.config}/mcp-servers/license.json`, then the free tier.

Built by theluckystrike - https://github.com/theluckystrike

MIT
