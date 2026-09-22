import { type Business } from "@theluckystrike/mcp-invoice/lib";
import type { Quote } from "./store.js";
export interface RenderQuoteOptions {
    branded: boolean;
    logo: boolean;
    expired: boolean;
}
export declare function renderQuotePdf(q: Quote, biz: Business, outPath: string, opts: RenderQuoteOptions): Promise<string>;
