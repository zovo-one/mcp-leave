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
/** Two decimal places, no currency symbol: a field a client parses, not prose. */
function amount(usd) {
    return usd.toFixed(2);
}
/**
 * Build the descriptor. Pure: same input, same object, no clock and no environment.
 */
export function paymentDescriptor(i) {
    const paid = i.tier === "pro";
    return {
        // Versioned and namespaced because MCP defines no field for this. If a payment SEP is
        // ever revived and merged, this is the thing that gets replaced, not extended.
        schema: "zovo.one/mcp-payment-descriptor/1",
        status: paid ? "paid" : i.reason === "status" ? "informational" : "payment_required",
        product: i.product,
        reason: i.reason,
        ...(i.feature ? { feature: i.feature } : {}),
        ...(i.tier ? { tier: i.tier } : {}),
        price: {
            amount: amount(i.priceUsd),
            currency: "USD",
            model: "one_time",
            grants: `lifetime Pro on the ${i.product} server`,
            url: i.checkoutUrl,
        },
        alternative: {
            amount: amount(i.bundlePriceUsd),
            currency: "USD",
            model: "one_time",
            grants: `lifetime Pro on all ${i.serverCount} servers`,
            url: i.bundleUrl,
        },
        checkout: { processor: "stripe", completed_in: "browser" },
        // The single most useful field here: it tells a paying agent to stop trying.
        agent_settleable: false,
        agent_settleable_reason: "This server has no agent-settleable payment rail. Payment is a card checkout a person completes in a browser. " +
            "As of MCP 2026-07-28 the specification defines no payment primitive (SEP-2007 was closed unmerged on 2026-06-24), " +
            "and no mainstream MCP client settles an x402 challenge without a separately installed, separately funded wallet bridge.",
        rails: {
            x402: {
                supported: false,
                note: "No x402 challenge is issued and no PAYMENT-SIGNATURE header is accepted. Do not retry with a payment payload.",
            },
        },
        // MCP 2026-07-28 elicitation/create parameters, mode "url" - the only merged part of
        // the spec that addresses payment. A client that supports URL mode can send this as-is.
        elicitation: {
            mode: "url",
            message: i.feature
                ? `"${i.feature}" needs Pro on the ${i.product} server. Pro is a one-time $${amount(i.priceUsd)}, lifetime.`
                : `Pro on the ${i.product} server is a one-time $${amount(i.priceUsd)}, lifetime.`,
            url: i.checkoutUrl,
        },
        human_step: "Open the checkout URL in a browser and pay by card. Nothing else is required of the user.",
        after_payment: i.tokenBound
            ? "The checkout URL carries this connection's token, so Pro switches on for this same connection and the same stored data. There is no key to paste and nothing to migrate."
            : "Checkout shows a key of the form MCPL1.<payload>.<signature>. Pass it to the license_activate tool; it is verified offline against a built-in public key and nothing is sent anywhere.",
        context_url: i.guideUrl,
    };
}
