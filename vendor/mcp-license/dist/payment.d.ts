/**
 * The machine-readable payment descriptor a caller gets when it meets a paywall.
 *
 * WHY THIS FILE EXISTS, AND WHY IT SAYS agent_settleable: false
 * ------------------------------------------------------------
 * The caller of an MCP server is usually a model, not a person, and until now everything
 * it learned at a free-tier cap was English prose with a URL in it. Prose is fine for a
 * human reading a transcript and useless to a client that wants to decide what to do.
 * This is the same fact as one object, so a client can branch on it.
 *
 * It reports `agent_settleable: false`, and that is not pessimism, it is the state of the
 * ecosystem on 2026-09-10, established from primary sources (docs/AGENT_PAYMENTS_R1.md):
 *
 *   - The MCP specification has NO payment primitive. Current version 2026-07-28. The one
 *     serious proposal, SEP-2007 "Payment Support for MCP Servers" (PR #2007, opened
 *     2025-12-23), was closed unmerged on 2026-06-24 for want of a sponsor. Nothing about
 *     payment exists in the schema, in the registry's server.json, or in the TypeScript SDK.
 *   - x402 v2 is the live HTTP-402 rail, but no mainstream MCP client pays one. Claude,
 *     ChatGPT and Cursor all require the user to install a third-party bridge and hand it a
 *     funded wallet's private key. That is a larger human step than clicking a link, not a
 *     smaller one.
 *
 * So an agent that reads this descriptor should NOT try to settle. It should tell its user
 * the one thing that is true: there is a link, a person has to open it, and the price is
 * fixed and one-time. Claiming otherwise would be a description that is not true of the
 * code, which is the repo's first hard rule.
 *
 * The `elicitation` block is the exception, and it is the one place a real convention does
 * exist: URL mode elicitation is merged and shipping in MCP 2026-07-28, and the spec names
 * "payment processing" as exactly what it is for. That block is the verbatim parameter
 * shape of an `elicitation/create` request with `mode: "url"`, so a client that supports it
 * can lift it as-is instead of parsing a sentence.
 *
 * This file is byte-identical to remote/src/payment.ts and a test asserts that. It takes
 * every constant as an argument and imports nothing, so the same code runs under Node on
 * stdio and under workerd on the hosted endpoint.
 */
/** Why the caller is being shown a price. */
export type PaymentReason = "free_tier_cap" | "rate_limit" | "status";
export interface PaymentDescriptorInput {
    /** Server id, e.g. "invoice". */
    product: string;
    reason: PaymentReason;
    /** The capped feature, when there is one. Absent for a plain status read. */
    feature?: string;
    /** Checkout URL for this one server, already tagged with its conversion src. */
    checkoutUrl: string;
    /** Checkout URL for the every-server bundle, tagged with its own src. */
    bundleUrl: string;
    /** A page that explains free versus Pro in prose, for a human who wants context. */
    guideUrl: string;
    priceUsd: number;
    bundlePriceUsd: number;
    serverCount: number;
    /**
     * True when the checkout URL carries the caller's own token, so payment switches this
     * exact connection to Pro with no key to paste. False on stdio, where the buyer gets a
     * key back and installs it with license_activate.
     */
    tokenBound: boolean;
    /** Current tier, for a status read. */
    tier?: "free" | "pro";
}
/**
 * Build the descriptor. Pure: same input, same object, no clock and no environment.
 */
export declare function paymentDescriptor(i: PaymentDescriptorInput): Record<string, unknown>;
