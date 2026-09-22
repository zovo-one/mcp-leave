import { createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { paymentDescriptor } from "./payment.js";
// Raw 32-byte Ed25519 public key (base64). Private key never leaves the billing worker.
export const PUBLIC_KEY_B64 = "VZXpvTpJn2XzaEn9ijFXk1vjPjtZvzAHZazC0Z+0pHU=";
export const CHECKOUT_BASE = "https://mcp.zovo.one";
export const PRICE_SINGLE_USD = 19;
export const PRICE_BUNDLE_USD = 39;
/**
 * How many single-server products the bundle covers. The published package cannot see
 * servers/ at runtime, so this is a constant - but it is the only one in the repo that
 * cap messages read, and packages/mcp-license/test/bundle-link.test.mjs compares it to
 * the number of sellable servers on disk, so adding a server fails the suite rather than
 * leaving "all 22 servers" stale in every cap message on every server.
 */
export const SERVER_COUNT = 46;
/** The prose page a human reads when they want the free-versus-Pro context, not a form. */
export const GUIDE_URL = "https://mcp.zovo.one/guides/mcp-server-free-vs-pro";
/** The bundle checkout URL for a cap message, tagged `<product>.<tool>.bundle`. */
export function bundleLink(src, tenant) {
    const params = [];
    if (tenant)
        params.push(`tenant=${encodeURIComponent(tenant)}`);
    params.push(`src=${encodeURIComponent(`${src}.bundle`)}`);
    return `${CHECKOUT_BASE}/buy/bundle?${params.join("&")}`;
}
const NO_HAND_MATH = "The exact figures for this request are only in the free tools' output above; any total or journal composed outside them is an estimate, not a figure from the books. ";
/**
 * The one sentence every cap message ends with, on every transport. Measured 2026-09-05:
 * 65 upgrade-link clicks in 7 days, none of them through any bundle source, because no
 * cap message carried a bundle link at all - the $39 option was named in prose with
 * nothing to click. See docs/CONVERSION_INSTRUMENT.md.
 */
export function bundleSentence(src, tenant) {
    return `Or all ${SERVER_COUNT} servers for $${PRICE_BUNDLE_USD}: ${bundleLink(src, tenant)}`;
}
const b64url = {
    dec(s) { return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"); },
    enc(b) { return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
};
function publicKey() {
    const raw = Buffer.from(PUBLIC_KEY_B64, "base64");
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    return createPublicKey({ key: Buffer.concat([spkiPrefix, raw]), format: "der", type: "spki" });
}
/** Reject any payload whose signed fields are missing or the wrong type (review #19). */
function payloadShapeError(p) {
    if (!p || typeof p !== "object" || Array.isArray(p))
        return "bad payload";
    if (p.v !== 1)
        return "unsupported version";
    if (typeof p.p !== "string" || p.p.length === 0)
        return "bad payload";
    if (typeof p.id !== "string" || p.id.length === 0)
        return "bad payload";
    if (!Number.isSafeInteger(p.iat))
        return "bad payload";
    if (p.exp !== undefined && !(Number.isSafeInteger(p.exp) && p.exp > 0))
        return "bad payload";
    return null;
}
/** Verify a key string "MCPL1.<payload>.<sig>" for a product. Pure offline. */
export function verifyLicense(key, product, now = Math.floor(Date.now() / 1000)) {
    if (typeof key !== "string")
        return { ok: false, reason: "no key" };
    const parts = key.trim().split(".");
    if (parts.length !== 3 || parts[0] !== "MCPL1")
        return { ok: false, reason: "malformed key" };
    let payload;
    try {
        payload = JSON.parse(b64url.dec(parts[1]).toString("utf8"));
    }
    catch {
        return { ok: false, reason: "bad payload" };
    }
    let sigOk = false;
    try {
        sigOk = verify(null, Buffer.from(parts[1], "utf8"), publicKey(), b64url.dec(parts[2]));
    }
    catch {
        sigOk = false;
    }
    if (!sigOk)
        return { ok: false, reason: "signature invalid" };
    const shape = payloadShapeError(payload);
    if (shape)
        return { ok: false, reason: shape };
    if (payload.p !== "*" && payload.p !== product)
        return { ok: false, reason: `key is for ${payload.p}, not ${product}` };
    if (payload.exp !== undefined && payload.exp <= now)
        return { ok: false, reason: "expired" };
    return { ok: true, payload };
}
function configPath() {
    const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    return join(base, "mcp-servers", "license.json");
}
function readStoredKeys() {
    try {
        return JSON.parse(readFileSync(configPath(), "utf8"));
    }
    catch {
        return {};
    }
}
function writeStoredKeys(keys) {
    const p = configPath();
    mkdirSync(join(p, ".."), { recursive: true, mode: 0o700 });
    // Per-process temp name (pid + random) so concurrent activations cannot clobber
    // one another's temp file, and mode 0600 so no other local user can read the key.
    const tmp = `${p}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
        writeFileSync(tmp, JSON.stringify(keys, null, 2), { mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, p);
        chmodSync(p, 0o600);
    }
    catch (e) {
        try {
            if (existsSync(tmp))
                unlinkSync(tmp);
        }
        catch { }
        throw e;
    }
}
/**
 * Conversion-instrument tag for the /buy link on a cap message: `<product>.<tool>`.
 * The billing worker counts clicks on this tag (docs/CONVERSION_INSTRUMENT.md), so it
 * only has to be stable and traceable back to the message that produced it, not a
 * registered tool id. When the call site does not pass an explicit tool name, the
 * feature text itself is slugified so every cap message still tags a distinct src.
 */
export function slugifySrc(s) {
    return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "unknown";
}
/**
 * Upgrade text for a hosted (streamable-HTTP) tenant: the checkout link carries
 * `?tenant=<anon token>` so fulfilment binds that same anonymous token to the
 * purchased key, and the hosted endpoint recognizes it as Pro with no key paste.
 */
export function hostedUpgradeText(feature, product, tenant, toolName) {
    const src = `${product}.${slugifySrc(toolName ?? feature)}`;
    const url = `${CHECKOUT_BASE}/buy/${product}?tenant=${encodeURIComponent(tenant)}&src=${encodeURIComponent(src)}`;
    return `"${feature}" is a Pro feature. Pro is a one-time $${PRICE_SINGLE_USD} for this server, lifetime. ` +
        `Buy at ${url} , and this hosted connection is Pro automatically once payment completes - no key to paste. ` +
        NO_HAND_MATH +
        bundleSentence(src, tenant);
}
export function createLicenseGate(opts) {
    const product = opts.product;
    const upgradeUrl = `${CHECKOUT_BASE}/buy/${product}`;
    let cached = null;
    function resolve() {
        // #18: a cached success is only reusable while it is still unexpired at the
        // current wall clock. exp is re-checked on every call; expiry drops the cache.
        if (cached) {
            if (!cached.ok)
                return cached;
            const exp = cached.payload?.exp;
            if (exp === undefined)
                return cached;
            if (Number.isSafeInteger(exp) && exp > Math.floor(Date.now() / 1000))
                return cached;
            cached = { ok: false, reason: "expired", source: cached.source, payload: cached.payload };
            return cached;
        }
        const env = process.env.MCP_LICENSE_KEY;
        if (env) {
            const r = verifyLicense(env, product);
            cached = { ...r, source: "env:MCP_LICENSE_KEY" };
            if (r.ok)
                return cached;
        }
        const stored = readStoredKeys();
        for (const k of [product, "*"]) {
            if (stored[k]) {
                const r = verifyLicense(stored[k], product);
                if (r.ok) {
                    cached = { ...r, source: configPath() };
                    return cached;
                }
                cached = { ...r, source: configPath() };
            }
        }
        cached = cached ?? { ok: false, reason: "no license found" };
        return cached;
    }
    const gate = {
        product,
        isPro: () => resolve().ok,
        status() {
            const r = resolve();
            return {
                product, tier: r.ok ? "pro" : "free", licenseId: r.payload?.id,
                expires: r.payload ? (r.payload.exp ? new Date(r.payload.exp * 1000).toISOString() : null) : undefined,
                // Tagged so a genuine in-product upgrade click is attributable. Untagged it
                // arrives as "<id>.unknown" and is indistinguishable from crawler noise; the
                // conversion audit found 28 distinct .unknown sources for exactly this reason.
                source: r.source, reason: r.ok ? undefined : r.reason,
                upgradeUrl: `${upgradeUrl}?src=${encodeURIComponent(`product.${product}.status`)}`,
                // The same facts as fields rather than prose, so a client can branch on them
                // instead of parsing a sentence. See src/payment.ts for why agent_settleable
                // is false and what a client is supposed to do about it.
                payment: gate.payment("status"),
            };
        },
        activate(key) {
            const r = verifyLicense(key, product);
            if (!r.ok)
                return r;
            const stored = readStoredKeys();
            stored[r.payload.p] = key.trim();
            writeStoredKeys(stored);
            cached = null;
            return { ...r, savedTo: configPath() };
        },
        payment(reason, feature, toolName) {
            const src = `${product}.${slugifySrc(toolName ?? feature ?? reason)}`;
            return paymentDescriptor({
                product,
                reason,
                feature,
                checkoutUrl: `${upgradeUrl}?src=${encodeURIComponent(src)}`,
                bundleUrl: bundleLink(src),
                guideUrl: GUIDE_URL,
                priceUsd: PRICE_SINGLE_USD,
                bundlePriceUsd: PRICE_BUNDLE_USD,
                serverCount: SERVER_COUNT,
                // stdio: the buyer gets a key back and installs it with license_activate. There is
                // no anonymous token to bind a purchase to, so this is false on this transport.
                tokenBound: false,
                tier: resolve().ok ? "pro" : "free",
            });
        },
        upgradeText(feature, toolName) {
            const src = `${product}.${slugifySrc(toolName ?? feature)}`;
            const taggedUrl = `${upgradeUrl}?src=${encodeURIComponent(src)}`;
            return `"${feature}" is a Pro feature. Pro is a one-time $${PRICE_SINGLE_USD} for this server, lifetime. ` +
                `Buy at ${taggedUrl} , then run license_activate with the key shown after checkout. Keys verify offline; nothing is sent anywhere. ` +
                NO_HAND_MATH +
                bundleSentence(src);
        },
        registerTools(server) {
            /**
             * NOT registered here, deliberately: the pricing resource and the upgrade_to_pro
             * prompt exist only on the hosted transport (remote/src/shims/license.ts).
             *
             * Adding them to the stdio gate adds one resource and one prompt to all 31 local
             * servers at once, and 17 suites under servers/*​/test assert the exact resource and
             * prompt lists with deepEqual, while scripts/gen-spec.mjs derives docs/spec output
             * from those same lists. Both would have to be updated in the same change, and both
             * live outside this package. The hosted endpoints are where an assistant meets a cap
             * without a config file to fall back on, so that is where the two surfaces went
             * first. The descriptor itself IS available on stdio: gate.payment() builds it and
             * license_status returns it under `payment`.
             *
             * See docs/AGENT_PAYMENTS_R1.md, "What is still human-gated", for the exact
             * follow-up: the same two registrations, plus the 17 list assertions.
             */
            server.registerTool("license_status", { title: "License status", description: "Report this server's licence state: product, tier free or pro, licence id, expiry, the key source and the upgrade URL. No arguments, no network. Explains a free-tier refusal; license_activate installs a key.", inputSchema: {} }, async () => ({ content: [{ type: "text", text: JSON.stringify(gate.status(), null, 2) }] }));
            server.registerTool("license_activate", { title: "Activate license", description: "Activate a Pro key (MCPL1.xxx.yyy) from checkout: verified offline against a built-in public key, saved to your config file. A wrong, malformed or expired key is refused, unsaved. license_status reads it back.",
                inputSchema: { key: z.string().describe("License key from the checkout confirmation page") } }, async ({ key }) => {
                const r = gate.activate(key);
                return r.ok
                    ? { content: [{ type: "text", text: `Activated Pro for ${r.payload.p === "*" ? "all servers (bundle)" : r.payload.p}. Saved to ${r.savedTo}.` }] }
                    : { content: [{ type: "text", text: `Error: license not accepted (${r.reason}).` }], isError: true };
            });
        },
    };
    return gate;
}
export { paymentDescriptor } from "./payment.js";
export { withFileLock, STALE_MS } from "./lock.js";
export { readSharedProfile, writeSharedProfile, hasSharedProfile, profilePath, profileDir, resolveEmail, inferTimezoneFromAddress, PROFILE_FIELDS, EMAIL_PLACEHOLDER } from "./profile.js";
