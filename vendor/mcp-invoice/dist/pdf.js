import { createWriteStream, existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import PDFDocument from "pdfkit";
import { formatMoney } from "./money.js";
const PAGE_W = 595.28;
const M = 50;
const CONTENT_W = PAGE_W - M * 2;
const INK = "#111111";
const MUTED = "#666666";
const RULE = "#cccccc";
// Every money column prints the currency code ("EUR 1080.00"), so UNIT and
// AMOUNT are wide enough for code + digits; DESCRIPTION takes what is left.
const COLS = { desc: M, qty: M + 196, unit: M + 244, tax: M + 336, amount: M + 381 };
const COL_W = { desc: 190, qty: 44, unit: 88, tax: 41 };
const RIGHT_EDGE = PAGE_W - M;
/**
 * Every money value on the page carries its currency code (D-8, user-value
 * audit 2026-09-02): a client's accounts department should never have to infer
 * the currency of a line from the currency of the total.
 */
function money(minor, currency) { return formatMoney(minor, currency); }
function qtyText(q) {
    return Number.isInteger(q) ? String(q) : String(Number(q.toFixed(4)));
}
export async function renderInvoicePdf(inv, biz, outPath, opts) {
    mkdirSync(dirname(outPath), { recursive: true });
    const doc = new PDFDocument({ size: "A4", margin: M, bufferPages: true, info: {
            Title: `Invoice ${inv.number}`, Author: biz.name || "Invoice", Subject: `Invoice ${inv.number}`,
        } });
    const stream = createWriteStream(outPath);
    doc.pipe(stream);
    let y = M;
    // Header: logo (Pro) or issuer name on the left, INVOICE block on the right.
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
            .text(biz.name || "Invoice", M, y, { width: 300 });
        headerLeftBottom = doc.y;
    }
    doc.font("Helvetica-Bold").fontSize(24).fillColor(INK)
        .text("INVOICE", M + 300, y, { width: CONTENT_W - 300, align: "right" });
    doc.font("Helvetica").fontSize(10).fillColor(MUTED)
        .text(inv.number, M + 300, doc.y + 2, { width: CONTENT_W - 300, align: "right" });
    const headerRightBottom = doc.y;
    y = Math.max(headerLeftBottom, headerRightBottom) + 20;
    // Issuer block (left) and dates (right)
    const issuer = [];
    if (opts.logo && biz.logo_path && existsSync(biz.logo_path) && biz.name)
        issuer.push(biz.name);
    if (biz.address)
        issuer.push(biz.address);
    if (biz.email)
        issuer.push(biz.email);
    if (biz.vat_id)
        issuer.push(`VAT ID: ${biz.vat_id}`);
    doc.font("Helvetica").fontSize(9).fillColor(MUTED)
        .text(issuer.join("\n"), M, y, { width: 260 });
    const issuerBottom = doc.y;
    const dates = [
        ["Issue date", inv.issue_date],
        ["Due date", inv.due_date],
        ["Status", inv.status.toUpperCase()],
    ];
    let dy = y;
    for (const [k, v] of dates) {
        doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(k, M + 300, dy, { width: 110 });
        doc.font("Helvetica-Bold").fontSize(9).fillColor(INK)
            .text(v, M + 300, dy, { width: CONTENT_W - 300, align: "right" });
        dy += 14;
    }
    y = Math.max(issuerBottom, dy) + 22;
    // Bill-to
    doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text("BILL TO", M, y);
    y = doc.y + 4;
    const client = [inv.client.name];
    if (inv.client.address)
        client.push(inv.client.address);
    if (inv.client.email)
        client.push(inv.client.email);
    if (inv.client.vat_id)
        client.push(`VAT ID: ${inv.client.vat_id}`);
    doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(client[0], M, y, { width: 300 });
    if (client.length > 1) {
        doc.font("Helvetica").fontSize(9).fillColor(MUTED)
            .text(client.slice(1).join("\n"), M, doc.y + 2, { width: 300 });
    }
    y = doc.y + 24;
    // Items table header
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
    const pageBottom = 841.89 - M - 60;
    doc.font("Helvetica").fontSize(9);
    for (const l of inv.lines) {
        const h = Math.max(doc.heightOfString(l.description, { width: COL_W.desc }), 11);
        if (y + h > pageBottom) {
            doc.addPage();
            y = drawTableHead(M);
            doc.font("Helvetica").fontSize(9);
        }
        doc.fillColor(INK).text(l.description, COLS.desc, y, { width: COL_W.desc });
        doc.text(qtyText(l.quantity), COLS.qty, y, { width: COL_W.qty, align: "right" });
        doc.text(money(l.unit_price_minor, inv.currency), COLS.unit, y, { width: COL_W.unit, align: "right" });
        doc.text(l.tax_rate ? `${l.tax_rate}%` : "-", COLS.tax, y, { width: COL_W.tax, align: "right" });
        doc.text(money(l.gross_minor, inv.currency), COLS.amount, y, { width: RIGHT_EDGE - COLS.amount, align: "right" });
        y += h + 8;
        doc.moveTo(M, y - 4).lineTo(RIGHT_EDGE, y - 4).lineWidth(0.4).strokeColor("#eeeeee").stroke();
    }
    // Totals
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
    row("Subtotal", money(inv.subtotal_minor, inv.currency));
    if (inv.discount_minor) {
        row(`Discount ${inv.discount_percent}%`, `-${money(inv.discount_minor, inv.currency)}`);
        row("Net", money(inv.net_minor, inv.currency));
    }
    for (const t of inv.tax_lines) {
        if (!t.rate && !t.tax_minor)
            continue;
        row(`Tax ${t.rate}% on ${money(t.base_minor, inv.currency)}`, money(t.tax_minor, inv.currency));
    }
    doc.moveTo(labelX, y + 2).lineTo(RIGHT_EDGE, y + 2).lineWidth(0.8).strokeColor(RULE).stroke();
    y += 8;
    row("Total", money(inv.total_minor, inv.currency), true);
    if (inv.paid_minor) {
        row("Paid", money(inv.paid_minor, inv.currency));
        row("Balance due", money(inv.total_minor - inv.paid_minor, inv.currency));
    }
    // Payment details + notes
    y += 16;
    const pay = [];
    if (biz.iban)
        pay.push(`IBAN: ${biz.iban}`);
    if (biz.bank)
        pay.push(`Bank: ${biz.bank}`);
    pay.push(`Reference: ${inv.number}`);
    pay.push(`Please pay by ${inv.due_date}.`);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text("PAYMENT DETAILS", M, y);
    doc.font("Helvetica").fontSize(9).fillColor(INK).text(pay.join("\n"), M, doc.y + 4, { width: 300 });
    y = doc.y + 12;
    if (inv.notes) {
        doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text("NOTES", M, y);
        doc.font("Helvetica").fontSize(9).fillColor(INK).text(inv.notes, M, doc.y + 4, { width: CONTENT_W });
    }
    // Footer on every page
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const fy = 841.89 - M - 24;
        doc.moveTo(M, fy - 8).lineTo(RIGHT_EDGE, fy - 8).lineWidth(0.5).strokeColor(RULE).stroke();
        doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
            .text(`${biz.name || ""}${biz.vat_id ? "  |  VAT ID " + biz.vat_id : ""}`, M, fy, { width: 300 });
        doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
            .text(`Invoice ${inv.number}  |  page ${i - range.start + 1} of ${range.count}`, M + 300, fy, { width: CONTENT_W - 300, align: "right" });
        if (opts.branded) {
            doc.font("Helvetica").fontSize(7).fillColor("#999999")
                .text("Generated with mcp-invoice by theluckystrike", M, fy + 11, { width: CONTENT_W, align: "center" });
        }
    }
    doc.end();
    await new Promise((resolve, reject) => {
        stream.on("finish", () => resolve());
        stream.on("error", reject);
    });
    return outPath;
}
