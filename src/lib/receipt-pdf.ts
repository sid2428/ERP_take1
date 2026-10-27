import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

/** One row of v_fee_receipt (bigint columns arrive from node-pg as strings). */
export interface ReceiptRow {
  receipt_no: string;
  paid_at: Date;
  purpose: string;                       // 'FEE' | 'TOPUP'
  amount_paise: string | number;
  gateway: string;
  gateway_order_id: string;
  gateway_payment_id: string;
  method: string | null;
  student_name: string;
  student_number: string;
  program_name: string;
  dept_name: string;
  academic_year: string | null;
  tuition_paise: string | number | null;
  development_paise: string | number | null;
  examination_paise: string | number | null;
  other_paise: string | number | null;
  late_fee_paise: string | number | null;
  total_due_paise: string | number | null;
  paid_paise: string | number | null;
  outstanding_paise: string | number | null;
}

// The built-in PDF fonts only cover Latin-1, so anything else becomes "?" and Rs. replaces the rupee sign.
const safe = (s: string) => s.replace(/[^\x20-\x7E\u00A0-\u00FF]/g, '?');
const money = (paise: string | number | null) =>
  'Rs. ' + (Number(paise ?? 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (d: Date) => d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST';

export async function buildReceiptPdf(r: ReceiptRow, isTest: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page: PDFPage = doc.addPage([595, 842]);
  const font: PDFFont = await doc.embedFont(StandardFonts.Helvetica);
  const bold: PDFFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.11, 0.14, 0.2);
  const muted = rgb(0.42, 0.45, 0.52);
  const navy = rgb(0.12, 0.23, 0.45);
  const L = 50;
  const R = 545;
  let y = 790;

  const text = (s: string, x: number, size = 10, f = font, color = ink) =>
    page.drawText(safe(s), { x, y, size, font: f, color });
  const textRight = (s: string, size = 10, f = font) =>
    page.drawText(safe(s), { x: R - f.widthOfTextAtSize(safe(s), size), y, size, font: f, color: ink });
  const rule = (color = rgb(0.85, 0.87, 0.9)) =>
    page.drawLine({ start: { x: L, y }, end: { x: R, y }, thickness: 0.7, color });
  const row = (label: string, value: string) => {
    text(label, L, 10, font, muted);
    text(value, 190, 10, font);
    y -= 18;
  };

  text('PICT ERP Portal', L, 20, bold, navy);
  y -= 22;
  text(r.purpose === 'FEE' ? 'Fee Receipt' : 'D-Wallet Top-up Receipt', L, 13, bold);
  y -= 16;
  text('Academic project - synthetic data - not an official PICT system', L, 8.5, font, muted);
  if (isTest) {
    y -= 13;
    text('TEST PAYMENT - no real money was charged', L, 9, bold, rgb(0.7, 0.35, 0.05));
  }
  y -= 14;
  rule(navy);
  y -= 26;

  row('Receipt no.', r.receipt_no);
  row('Date', when(r.paid_at));
  row('Student', r.student_name);
  row('Student no.', r.student_number);
  row('Program', r.program_name);
  row('Department', r.dept_name);
  if (r.academic_year) row('Academic year', r.academic_year);
  row('Payment method', r.method ?? 'Online');
  row('Payment reference', r.gateway_payment_id);
  row('Order reference', r.gateway_order_id);
  y -= 6;
  rule();
  y -= 24;

  if (r.purpose === 'FEE') {
    text('Fee head', L, 10, bold);
    page.drawText('Amount', { x: R - bold.widthOfTextAtSize('Amount', 10), y, size: 10, font: bold, color: ink });
    y -= 8;
    rule();
    y -= 18;
    const heads: Array<[string, string | number | null]> = [
      ['Tuition fee', r.tuition_paise],
      ['Development fee', r.development_paise],
      ['Examination fee', r.examination_paise],
      ['Other fee', r.other_paise],
    ];
    if (Number(r.late_fee_paise ?? 0) > 0) heads.push(['Late fee', r.late_fee_paise]);
    for (const [name, amount] of heads) {
      text(name, L);
      textRight(money(amount));
      y -= 18;
    }
    y -= 2;
    rule();
    y -= 18;
    text('Total fee due', L, 10, bold);
    textRight(money(r.total_due_paise), 10, bold);
    y -= 28;
  }

  page.drawRectangle({ x: L, y: y - 14, width: R - L, height: 38, color: rgb(0.93, 0.95, 0.99) });
  text(r.purpose === 'FEE' ? 'Amount paid in this transaction' : 'Amount added to D-Wallet', L + 12, 11, bold, navy);
  textRight(money(r.amount_paise), 13, bold);
  y -= 44;

  if (r.purpose === 'FEE') {
    row('Total paid so far', money(r.paid_paise));
    row('Balance outstanding (today)', money(r.outstanding_paise));
  }
  y -= 20;
  text('This is a computer-generated receipt and does not need a signature.', L, 8.5, font, muted);

  return doc.save();
}
