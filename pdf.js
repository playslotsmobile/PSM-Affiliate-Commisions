const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { formatCurrency } = require('./telegram');
const { getNextTier, TIERS } = require('./commission');
const db = require('./db');

const logoPath = path.join(__dirname, 'public', 'images', 'logo.png');

function generatePDF(report, affiliate) {
  return new Promise((resolve, reject) => {
    const dir = path.join(__dirname, 'reports');
    fs.mkdirSync(dir, { recursive: true });

    const filename = `${affiliate.username}_${report.week_label.replace(/\s+/g, '_')}.pdf`;
    const filepath = path.join(dir, filename);
    const doc = new PDFDocument({ size: 'LETTER', margin: 50, autoFirstPage: false });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

    // Colors
    const bg = '#0a0a12';
    const purple = '#7B4FFF';
    const teal = '#00D4C8';
    const white = '#ffffff';
    const gray = '#aaa';
    const red = '#ff6b6b';

    const pageW = 612; // LETTER width
    const pageH = 792; // LETTER height
    const margin = 50;
    const contentW = pageW - margin * 2;

    let y = 0;

    function newPage() {
      doc.addPage({ size: 'LETTER', margin: 50 });
      doc.rect(0, 0, pageW, pageH).fill(bg);
      y = 40;
    }

    function checkPage(needed) {
      if (y + needed > pageH - 50) newPage();
    }

    // All text uses explicit x,y — no auto-flow
    function sectionHeader(title) {
      checkPage(38);
      doc.roundedRect(margin, y, contentW, 24, 4).fill(purple);
      doc.fillColor(white).fontSize(11).font('Helvetica-Bold')
        .text(title, margin + 10, y + 6, { width: contentW - 20, lineBreak: false });
      y += 32;
    }

    function row(label, value, valueColor) {
      checkPage(16);
      doc.fillColor(gray).fontSize(9).font('Helvetica')
        .text(label, margin + 10, y, { width: 250, lineBreak: false });
      doc.fillColor(valueColor || white).fontSize(9).font('Helvetica-Bold')
        .text(value, margin + 260, y, { width: contentW - 270, align: 'right', lineBreak: false });
      y += 15;
    }

    // ─── PAGE 1 ───
    newPage();

    // Logo
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, (pageW - 70) / 2, y, { width: 70 });
      y += 75;
    }

    // Title
    doc.fillColor(purple).fontSize(18).font('Helvetica-Bold')
      .text('PlaySlotsMobile Commission Report', margin, y, { width: contentW, align: 'center', lineBreak: false });
    y += 26;

    doc.fillColor(white).fontSize(10).font('Helvetica')
      .text(`${affiliate.username}  ·  ${report.week_range}  ·  ${report.week_label}`, margin, y, { width: contentW, align: 'center', lineBreak: false });
    y += 22;

    // Status
    const statusColor = report.status === 'paid' ? teal : red;
    doc.fillColor(statusColor).fontSize(12).font('Helvetica-Bold')
      .text(report.status.toUpperCase(), margin, y, { width: contentW, align: 'center', lineBreak: false });
    y += 24;

    // ─── PERFORMANCE ───
    const playerRows = db.prepare(`
      SELECT week_start, player_count FROM player_weekly
      WHERE affiliate_id = ? AND week_start <= ?
      ORDER BY week_start DESC LIMIT 4
    `).all(report.affiliate_id, report.week_start).reverse();
    const counts = playerRows.map(r => r.player_count);
    const avg = counts.length > 0 ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;

    sectionHeader('PERFORMANCE');
    row('Active Players (this week)', report.active_players.toString());
    row('Referred Players', (report.referred_players || 0).toString());
    row('Players (4-wk avg)', (Math.round(avg * 100) / 100).toString());
    row('Sold USD', formatCurrency(report.sold_usd));
    row('NET SC', formatCurrency(report.net_sc));
    y += 4;

    // ─── EXPENSES ───
    sectionHeader('EXPENSES');
    row('Processing Fees (6.25%)', formatCurrency(report.processing_fees));
    row('Bonuses', formatCurrency(report.bonuses));
    if (report.adjustment) {
      row('Adjustment' + (report.adjustment_note ? ' (' + report.adjustment_note + ')' : ''), formatCurrency(report.adjustment));
    }
    let extras = [];
    try { extras = JSON.parse(report.extra_expenses || '[]'); } catch (e) {}
    extras.forEach(e => row(e.label, formatCurrency(e.amount)));
    row('Total Expenses', formatCurrency(report.total_expenses), purple);
    y += 4;

    // ─── NET CALCULATION ───
    sectionHeader('NET CALCULATION');
    row('Net (NET SC - Expenses)', formatCurrency(report.net));
    row('Carryover In', report.carryover_in !== 0 ? formatCurrency(report.carryover_in) : 'None');
    row('Payout Net', formatCurrency(report.payout_net), teal);
    y += 4;

    // ─── COMMISSION ───
    sectionHeader('COMMISSION');
    const ratePercent = Math.round(report.commission_rate * 100);
    const rateBasis = report.rate_override_reason || `${ratePercent}% tier`;
    row('Commission Rate', `${ratePercent}% (${rateBasis})`);
    row('Total Commission', formatCurrency(report.total_commission), purple);
    if (report.carryover_out < 0) {
      row('Carryover Out', formatCurrency(report.carryover_out), red);
    }
    y += 8;

    // ─── TIER QUALIFICATION ───
    sectionHeader('TIER QUALIFICATION');
    // Header row
    doc.fillColor(gray).fontSize(8).font('Helvetica-Bold');
    doc.text('Rate', margin + 10, y, { lineBreak: false });
    doc.text('Players Req', margin + 80, y, { lineBreak: false });
    doc.text('Sold Req', margin + 180, y, { lineBreak: false });
    doc.text('Status', margin + 320, y, { lineBreak: false });
    y += 14;

    for (const tier of [...TIERS].reverse()) {
      checkPage(16);
      const meetsPlayers = avg >= tier.players;
      const meetsSold = report.sold_usd >= tier.sold;
      const meetsBoth = meetsPlayers && meetsSold;
      const isCurrentTier = report.commission_rate === tier.rate;

      if (isCurrentTier) {
        doc.roundedRect(margin + 5, y - 2, contentW - 10, 14, 2).fill('#2a1f5c');
      }

      const font = isCurrentTier ? 'Helvetica-Bold' : 'Helvetica';
      doc.fillColor(isCurrentTier ? purple : white).fontSize(8).font(font)
        .text(`${Math.round(tier.rate * 100)}%`, margin + 10, y, { lineBreak: false });
      doc.fillColor(meetsPlayers ? teal : red).fontSize(8).font(font)
        .text(`${tier.players}+`, margin + 80, y, { lineBreak: false });
      doc.fillColor(meetsSold ? teal : red).fontSize(8).font(font)
        .text(`$${tier.sold.toLocaleString()}+`, margin + 180, y, { lineBreak: false });
      doc.fillColor(meetsBoth ? teal : gray).fontSize(8).font(font)
        .text(meetsBoth ? 'Qualified' : '--', margin + 320, y, { lineBreak: false });
      y += 14;
    }
    y += 8;

    // ─── PLAYER HISTORY ───
    sectionHeader('PLAYER HISTORY');
    doc.fillColor(gray).fontSize(8).font('Helvetica-Bold');
    doc.text('Week', margin + 10, y, { lineBreak: false });
    doc.text('Players', margin + 260, y, { width: contentW - 270, align: 'right', lineBreak: false });
    y += 14;

    playerRows.forEach((r, i) => {
      checkPage(14);
      doc.fillColor(white).fontSize(8).font('Helvetica')
        .text(`Wk ${i + 1} (${r.week_start})`, margin + 10, y, { lineBreak: false });
      doc.text(r.player_count.toString(), margin + 260, y, { width: contentW - 270, align: 'right', lineBreak: false });
      y += 14;
    });
    doc.fillColor(purple).fontSize(8).font('Helvetica-Bold')
      .text('4-week average', margin + 10, y, { lineBreak: false });
    doc.text((Math.round(avg * 100) / 100).toString(), margin + 260, y, { width: contentW - 270, align: 'right', lineBreak: false });
    y += 18;

    // ─── NEXT TIER ───
    checkPage(20);
    const nextTierInfo = getNextTier(avg, report.sold_usd);
    if (nextTierInfo) {
      const parts = [];
      if (nextTierInfo.playersNeeded > 0) parts.push(`${Math.ceil(nextTierInfo.playersNeeded)} more avg players`);
      if (nextTierInfo.soldNeeded > 0) parts.push(`${formatCurrency(nextTierInfo.soldNeeded)} more in sales`);
      doc.fillColor(purple).fontSize(9).font('Helvetica-Bold')
        .text(`Next tier: ${parts.join(' & ')} to reach ${Math.round(nextTierInfo.tier.rate * 100)}%`, margin, y, { width: contentW, align: 'center', lineBreak: false });
    } else {
      doc.fillColor(teal).fontSize(9).font('Helvetica-Bold')
        .text('You are at the maximum commission tier!', margin, y, { width: contentW, align: 'center', lineBreak: false });
    }
    y += 20;

    // ─── FOOTER ───
    checkPage(30);
    doc.fillColor(gray).fontSize(7).font('Helvetica')
      .text('Active player = purchased AND wagered >= $5.00 within the week (Mon-Sun CST)', margin, y, { width: contentW, align: 'center', lineBreak: false });
    y += 14;

    const now = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
    doc.fillColor(gray).fontSize(7).font('Helvetica')
      .text(`Generated ${now} CST · PlaySlotsMobile`, margin, y, { width: contentW, align: 'center', lineBreak: false });

    doc.end();
    stream.on('finish', () => {
      db.prepare('UPDATE weekly_reports SET pdf_path = ? WHERE id = ?').run(filepath, report.id);
      resolve(filepath);
    });
    stream.on('error', reject);
  });
}

module.exports = { generatePDF };
