import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import PDFDocument from "pdfkit";
import { formatMoney } from "@theluckystrike/mcp-invoice/lib";
/**
 * A4 quote renderer. Same page geometry, same column stops, same fonts and the same
 * "every money value carries its currency code" rule as the invoice renderer
 * (servers/invoice/src/pdf.ts), so a client who has seen one document recognises the
 * other. It is a separate function rather than a flag on renderInvoicePdf because the
 * three blocks that differ are the ones a client reads first: the title, the validity
 * line in place of the due date, and an acceptance block in place of payment details.
 *
 * Hosted (streamable-HTTP) deployments swap this for the HTML shim the invoice server
 * uses there: the browser prints the same A4 layout to PDF, and quote_pdf's response
 * already names the file by what it is rather than assuming "PDF" (D-Q6 in the invoice
 * audit's D-R6 lineage).
 */
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 50;
const CONTENT_W = PAGE_W - M * 2;
const INK = "#111111";
const MUTED = "#666666";
const RULE = "#cccccc";
const COLS = { desc: M, qty: M + 196, unit: M + 244, tax: M + 336, amount: M + 381 };
const COL_W = { desc: 190, qty: 44, unit: 88, tax: 41 };
const RIGHT_EDGE = PAGE_W - M;
function money(minor, currency) { return formatMoney(minor, currency); }
function qtyText(q) {
    return Number.isInteger(q) ? String(q) : String(Number(q.toFixed(4)));
}
export async function renderQuotePdf(q, biz, outPath, opts) {
    mkdirSync(dirname(outPath), { recursive: true });
    const doc = new PDFDocument({ size: "A4", margin: M, bufferPages: true, info: {
            Title: `Quote ${q.id}`, Author: biz.name || "Quote", Subject: `Quote ${q.id}`,
        } });
    const stream = createWriteStream(outPath);
    /**
     * The settled promise is built BEFORE the first byte is written. A path the process
     * cannot open (EISDIR on a directory, EACCES on a system file) emits "error" on the
     * stream, and both orderings survive it today because every drawing call below is
     * synchronous, so a listener attached after doc.end() is still attached in the same
     * tick. Measured: one macrotask later is already too late -- the error is unhandled
     * and takes the process down, and the client then sees no response at all rather than
     * a refusal it can read. Any future await in the drawing code would introduce exactly
     * that delay, so the listener is attached at creation instead of relying on it.
     */
    const written = new Promise((resolve, reject) => {
        stream.on("finish", () => resolve());
        stream.on("error", reject);
    });
    doc.pipe(stream);
    let y = M;
    let headerLeftBottom = y;
    if (opts.logo && biz.logo_path && existsSync(biz.logo_path)) {
        try {
            doc.image(biz.logo_path, M, y, { fit: [140, 55] });
            headerLeftBottom = y + 55;
        }
        catch {
            headerLeftBottom = y;
        }
    }
    if (headerLeftBottom === y) {
        doc.font("Helvetica-Bold").fontSize(18).fillColor(INK)
            .text(biz.name || "Quote", M, y, { width: 300 });
        headerLeftBottom = doc.y;
    }
    doc.font("Helvetica-Bold").fontSize(24).fillColor(INK)
        .text("QUOTE", M + 300, y, { width: CONTENT_W - 300, align: "right" });
    doc.font("Helvetica").fontSize(10).fillColor(MUTED)
        .text(q.id, M + 300, doc.y + 2, { width: CONTENT_W - 300, align: "right" });
    const headerRightBottom = doc.y;
    y = Math.max(headerLeftBottom, headerRightBottom) + 20;
    const issuerLines = [];
    if (opts.logo && biz.logo_path && existsSync(biz.logo_path) && biz.name)
        issuerLines.push(biz.name);
    if (biz.address)
        issuerLines.push(biz.address);
    if (biz.email)
        issuerLines.push(biz.email);
    if (biz.vat_id)
        issuerLines.push(`VAT ID: ${biz.vat_id}`);
    doc.font("Helvetica").fontSize(9).fillColor(MUTED)
        .text(issuerLines.join("\n"), M, y, { width: 260 });
    const issuerBottom = doc.y;
    const state = q.status === "open" ? (opts.expired ? "EXPIRED" : "OPEN") : q.status.toUpperCase();
    const dates = [
        ["Quote date", q.issue_date],
        ["Valid until", q.valid_until],
        ["Status", state],
    ];
    let dy = y;
    for (const [k, v] of dates) {
        doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(k, M + 300, dy, { width: 110 });
        doc.font("Helvetica-Bold").fontSize(9).fillColor(INK)
            .text(v, M + 300, dy, { width: CONTENT_W - 300, align: "right" });
        dy += 14;
    }
    y = Math.max(issuerBottom, dy) + 22;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text("QUOTE FOR", M, y);
    y = doc.y + 4;
    const client = [q.client.name];
    if (q.client.address)
        client.push(q.client.address);
    if (q.client.email)
        client.push(q.client.email);
    if (q.client.vat_id)
        client.push(`VAT ID: ${q.client.vat_id}`);
    doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(client[0], M, y, { width: 300 });
    if (client.length > 1) {
        doc.font("Helvetica").fontSize(9).fillColor(MUTED)
            .text(client.slice(1).join("\n"), M, doc.y + 2, { width: 300 });
    }
    y = doc.y + 24;
    const drawTableHead = (top) => {
        doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED);
        doc.text("DESCRIPTION", COLS.desc, top, { width: COL_W.desc });
        doc.text("QTY", COLS.qty, top, { width: COL_W.qty, align: "right" });
        doc.text("UNIT", COLS.unit, top, { width: COL_W.unit, align: "right" });
        doc.text("TAX", COLS.tax, top, { width: COL_W.tax, align: "right" });
        doc.text("AMOUNT", COLS.amount, top, { width: RIGHT_EDGE - COLS.amount, align: "right" });
        const b = top + 14;
        doc.moveTo(M, b).lineTo(RIGHT_EDGE, b).lineWidth(0.8).strokeColor(RULE).stroke();
        return b + 8;
    };
    y = drawTableHead(y);
    const pageBottom = PAGE_H - M - 60;
    doc.font("Helvetica").fontSize(9);
    for (const l of q.lines) {
        const h = Math.max(doc.heightOfString(l.description, { width: COL_W.desc }), 11);
        if (y + h > pageBottom) {
            doc.addPage();
            y = drawTableHead(M);
            doc.font("Helvetica").fontSize(9);
        }
        doc.fillColor(INK).text(l.description, COLS.desc, y, { width: COL_W.desc });
        doc.text(qtyText(l.quantity), COLS.qty, y, { width: COL_W.qty, align: "right" });
        doc.text(money(l.unit_price_minor, q.currency), COLS.unit, y, { width: COL_W.unit, align: "right" });
        doc.text(l.tax_rate ? `${l.tax_rate}%` : "-", COLS.tax, y, { width: COL_W.tax, align: "right" });
        doc.text(money(l.gross_minor, q.currency), COLS.amount, y, { width: RIGHT_EDGE - COLS.amount, align: "right" });
        y += h + 8;
        doc.moveTo(M, y - 4).lineTo(RIGHT_EDGE, y - 4).lineWidth(0.4).strokeColor("#eeeeee").stroke();
    }
    const totalsTop = y + 10;
    if (totalsTop > pageBottom - 90) {
        doc.addPage();
        y = M;
    }
    else {
        y = totalsTop;
    }
    const labelX = M + 215;
    const labelW = 175;
    const valX = labelX + labelW + 5;
    const valW = RIGHT_EDGE - valX;
    const row = (label, value, bold = false) => {
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9)
            .fillColor(bold ? INK : MUTED).text(label, labelX, y, { width: labelW, align: "right" });
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9).fillColor(INK)
            .text(value, valX, y, { width: valW, align: "right" });
        y += bold ? 18 : 14;
    };
    row("Subtotal", money(q.subtotal_minor, q.currency));
    if (q.discount_minor) {
        row(`Discount ${q.discount_percent}%`, `-${money(q.discount_minor, q.currency)}`);
        row("Net", money(q.net_minor, q.currency));
    }
    for (const t of q.tax_lines) {
        if (!t.rate && !t.tax_minor)
            continue;
        row(`Tax ${t.rate}% on ${money(t.base_minor, q.currency)}`, money(t.tax_minor, q.currency));
    }
    doc.moveTo(labelX, y + 2).lineTo(RIGHT_EDGE, y + 2).lineWidth(0.8).strokeColor(RULE).stroke();
    y += 8;
    row("Total", money(q.total_minor, q.currency), true);
    y += 16;
    const accept = [];
    accept.push(`This quote is valid until ${q.valid_until}.`);
    accept.push("To accept, reply to this document and it will be invoiced as quoted.");
    if (q.invoice_number)
        accept.push(`Accepted and invoiced as ${q.invoice_number}.`);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text("ACCEPTANCE", M, y);
    doc.font("Helvetica").fontSize(9).fillColor(INK).text(accept.join("\n"), M, doc.y + 4, { width: 320 });
    y = doc.y + 12;
    if (q.notes) {
        doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text("NOTES", M, y);
        doc.font("Helvetica").fontSize(9).fillColor(INK).text(q.notes, M, doc.y + 4, { width: CONTENT_W });
    }
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const fy = PAGE_H - M - 24;
        doc.moveTo(M, fy - 8).lineTo(RIGHT_EDGE, fy - 8).lineWidth(0.5).strokeColor(RULE).stroke();
        doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
            .text(`${biz.name || ""}${biz.vat_id ? "  |  VAT ID " + biz.vat_id : ""}`, M, fy, { width: 300 });
        doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
            .text(`Quote ${q.id}  |  page ${i - range.start + 1} of ${range.count}`, M + 300, fy, { width: CONTENT_W - 300, align: "right" });
        if (opts.branded) {
            doc.font("Helvetica").fontSize(7).fillColor("#999999")
                .text("Generated with mcp-quotes by theluckystrike", M, fy + 11, { width: CONTENT_W, align: "center" });
        }
    }
    doc.end();
    await written;
    return outPath;
}
