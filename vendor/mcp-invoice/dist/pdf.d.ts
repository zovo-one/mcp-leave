import type { Business, Invoice } from "./store.js";
export interface RenderOptions {
    branded: boolean;
    logo: boolean;
}
export declare function renderInvoicePdf(inv: Invoice, biz: Business, outPath: string, opts: RenderOptions): Promise<string>;
