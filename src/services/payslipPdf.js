const PDFDocument = require('pdfkit');

const money = (n) => Number(n).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function render(p, res) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);
  doc.fontSize(20).text(p.company_name || 'Company', { align: 'left' });
  doc.fontSize(11).fillColor('#555').text(`Payslip for ${p.month}`).moveDown();
  doc.fillColor('#000').fontSize(11);
  const info = [
    ['Employee', p.employee_name], ['Employee code', p.employee_code], ['Department', p.department || '-'],
    ['Designation', p.designation || '-'], ['Join date', p.join_date],
  ];
  info.forEach(([k, v]) => doc.text(`${k}: `, { continued: true }).font('Helvetica-Bold').text(String(v)).font('Helvetica'));
  doc.moveDown();

  const row = (label, value, bold) => {
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(label, 50, y, { width: 300 }).text(value, 350, y, { width: 190, align: 'right' });
    doc.moveDown(0.3);
  };
  const line = () => { doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#bbb').stroke(); doc.moveDown(0.4); };

  doc.fontSize(12).font('Helvetica-Bold').text('Earnings').moveDown(0.3); doc.fontSize(11);
  row('Basic salary', money(p.basic)); row('House rent allowance', money(p.hra)); row('Medical allowance', money(p.medical));
  line(); row('Gross salary (monthly)', money(p.gross), true);
  if (p.employed_days !== p.working_days) row(`Prorated gross (${p.employed_days} of ${p.working_days} working days)`, money(p.earned_gross));
  doc.moveDown();

  doc.fontSize(12).font('Helvetica-Bold').text('Attendance').moveDown(0.3); doc.fontSize(11);
  row('Working days in month', String(p.working_days)); row('Absent days', String(p.absent_days));
  row('Unpaid leave days', String(p.unpaid_days)); row('Half days', String(p.half_days));
  doc.moveDown();

  doc.fontSize(12).font('Helvetica-Bold').text('Deductions').moveDown(0.3); doc.fontSize(11);
  row('Attendance / unpaid leave deduction', money(p.deductions)); row('Income tax', money(p.tax));
  line(); row('Net pay', money(p.net), true);

  doc.moveDown(2).fontSize(9).fillColor('#777').font('Helvetica').text('Computer generated payslip. Tax slab is illustrative.');
  doc.end();
}

module.exports = { render };
