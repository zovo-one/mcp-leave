export declare const PUBLIC_KEY_B64 = "VZXpvTpJn2XzaEn9ijFXk1vjPjtZvzAHZazC0Z+0pHU=";
export declare const CHECKOUT_BASE = "https://mcp.zovo.one";
export declare const PRICE_SINGLE_USD = 19;
export declare const PRICE_BUNDLE_USD = 39;
/**
 * How many single-server products the bundle covers. The published package cannot see
 * servers/ at runtime, so this is a constant - but it is the only one in the repo that
 * cap messages read, and packages/mcp-license/test/bundle-link.test.mjs compares it to
 * the number of sellable servers on disk, so adding a server fails the suite rather than
 * leaving "all 22 servers" stale in every cap message on every server.
 */
export declare const SERVER_COUNT = 46;
/** The prose page a human reads when they want the free-versus-Pro context, not a form. */
export declare const GUIDE_URL = "https://mcp.zovo.one/guides/mcp-server-free-vs-pro";
/** The bundle checkout URL for a cap message, tagged `<product>.<tool>.bundle`. */
export declare function bundleLink(src: string, tenant?: string): string;
/**
 * The one sentence every cap message ends with, on every transport. Measured 2026-09-05:
 * 65 upgrade-link clicks in 7 days, none of them through any bundle source, because no
 * cap message carried a bundle link at all - the $39 option was named in prose with
 * nothing to click. See docs/CONVERSION_INSTRUMENT.md.
 */
export declare function bundleSentence(src: string, tenant?: string): string;
export interface LicensePayload {
    v: 1;
    p: string;
    id: string;
    iat: number;
    exp?: number;
    h?: string;
}
export interface VerifyResult {
    ok: boolean;
    reason?: string;
    payload?: LicensePayload;
}
/** Verify a key string "MCPL1.<payload>.<sig>" for a product. Pure offline. */
export declare function verifyLicense(key: string, product: string, now?: number): VerifyResult;
/**
 * Conversion-instrument tag for the /buy link on a cap message: `<product>.<tool>`.
 * The billing worker counts clicks on this tag (docs/CONVERSION_INSTRUMENT.md), so it
 * only has to be stable and traceable back to the message that produced it, not a
 * registered tool id. When the call site does not pass an explicit tool name, the
 * feature text itself is slugified so every cap message still tags a distinct src.
 */
export declare function slugifySrc(s: string): string;
/**
 * Upgrade text for a hosted (streamable-HTTP) tenant: the checkout link carries
 * `?tenant=<anon token>` so fulfilment binds that same anonymous token to the
 * purchased key, and the hosted endpoint recognizes it as Pro with no key paste.
 */
export declare function hostedUpgradeText(feature: string, product: string, tenant: string, toolName?: string): string;
export interface LicenseGate {
    product: string;
    isPro(): boolean;
    status(): {
        product: string;
        tier: "free" | "pro";
        licenseId?: string;
        expires?: string | null;
        source?: string;
        reason?: string;
        upgradeUrl: string;
        payment: Record<string, unknown>;
    };
    activate(key: string): VerifyResult & {
        savedTo?: string;
    };
    upgradeText(feature: string, toolName?: string): string;
    /** The cap message as one machine-readable object, for a client that wants fields not prose. */
    payment(reason: "free_tier_cap" | "rate_limit" | "status", feature?: string, toolName?: string): Record<string, unknown>;
    /**
     * registerResource and registerPrompt are optional so a caller that only has
     * registerTool (every server passes `server as unknown as { registerTool: Function }`)
     * still type-checks, and so a host that does not implement them is skipped rather than
     * throwing. Both are feature-detected at runtime.
     */
    registerTools(server: {
        registerTool: Function;
        registerResource?: Function;
        registerPrompt?: Function;
    }): void;
}
export declare function createLicenseGate(opts: {
    product: string;
}): LicenseGate;
export { paymentDescriptor } from "./payment.js";
export type { PaymentDescriptorInput, PaymentReason } from "./payment.js";
export { withFileLock, STALE_MS } from "./lock.js";
export { readSharedProfile, writeSharedProfile, hasSharedProfile, profilePath, profileDir, resolveEmail, inferTimezoneFromAddress, PROFILE_FIELDS, EMAIL_PLACEHOLDER } from "./profile.js";
export type { SharedProfile, ProfileField } from "./profile.js";
