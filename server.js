process.env.TZ = 'America/Chicago';

const express = require('express');
const path = require('path');
const db = require('./db');
const { calculate, getCarryoverIn, getPlayerHistory, TIERS } = require('./commission');
const { initBot, sendReport, formatCurrency } = require('./telegram');
const { generatePDF } = require('./pdf');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/reports', express.static(path.join(__dirname, 'reports')));

// Helper for templates
app.locals.formatCurrency = formatCurrency;

// ─── Dashboard ───
app.get('/', (req, res) => {
  const affiliates = db.prepare('SELECT * FROM affiliates ORDER BY username').all();

  const data = affiliates.map(a => {
    const lastReport = db.prepare(`
      SELECT * FROM weekly_reports WHERE affiliate_id = ?
      ORDER BY week_start DESC LIMIT 1
    `).get(a.id);

    const playerRows = db.prepare(`
      SELECT player_count FROM player_weekly
      WHERE affiliate_id = ? ORDER BY week_start DESC LIMIT 4
    `).all(a.id);
    const counts = playerRows.map(r => r.player_count);
    const playerAvg = counts.length > 0
      ? Math.round((counts.reduce((s, c) => s + c, 0) / counts.length) * 100) / 100
      : 0;

    return {
      ...a,
      carryover: lastReport ? lastReport.carryover_out : 0,
      lastCommission: lastReport ? lastReport.total_commission : 0,
      lastStatus: lastReport ? lastReport.status : 'n/a',
      playerAvg,
    };
  });

  res.render('dashboard', { affiliates: data });
});

// ─── New Affiliate ───
app.post('/affiliate/new', (req, res) => {
  const { username, email, telegram_chat_id, notes } = req.body;
  try {
    db.prepare(`
      INSERT INTO affiliates (username, email, telegram_chat_id, notes)
      VALUES (?, ?, ?, ?)
    `).run(username, email || null, telegram_chat_id || null, notes || null);
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.redirect('/?error=Username already exists');
    }
    throw e;
  }
  res.redirect('/');
});

// ─── Affiliate Profile ───
app.get('/affiliate/:id', (req, res) => {
  const affiliate = db.prepare('SELECT * FROM affiliates WHERE id = ?').get(req.params.id);
  if (!affiliate) return res.status(404).send('Affiliate not found');

  const reports = db.prepare(`
    SELECT * FROM weekly_reports WHERE affiliate_id = ?
    ORDER BY week_start DESC
  `).all(affiliate.id);

  const playerHistory = db.prepare(`
    SELECT * FROM player_weekly WHERE affiliate_id = ?
    ORDER BY week_start DESC LIMIT 12
  `).all(affiliate.id);

  res.render('affiliate', { affiliate, reports, playerHistory, formatCurrency });
});

// ─── Update Affiliate ───
app.post('/affiliate/:id/update', (req, res) => {
  const { email, telegram_chat_id, commission_rate_override, notes } = req.body;
  const rateOverride = commission_rate_override ? parseFloat(commission_rate_override) / 100 : null;
  db.prepare(`
    UPDATE affiliates SET email = ?, telegram_chat_id = ?,
    commission_rate_override = ?, notes = ? WHERE id = ?
  `).run(email || null, telegram_chat_id || null, rateOverride, notes || null, req.params.id);
  res.redirect(`/affiliate/${req.params.id}`);
});

// ─── New Report Form ───
app.get('/report/new', (req, res) => {
  const affiliates = db.prepare('SELECT * FROM affiliates ORDER BY username').all();
  const selectedId = req.query.affiliate_id || '';
  let preload = null;

  if (selectedId) {
    const affiliate = db.prepare('SELECT * FROM affiliates WHERE id = ?').get(selectedId);
    if (affiliate) {
      // Default week: last Monday to last Sunday CST
      const now = new Date();
      const dayOfWeek = now.getDay();
      const lastMonday = new Date(now);
      lastMonday.setDate(now.getDate() - dayOfWeek - 6);
      lastMonday.setHours(0, 0, 0, 0);
      const lastSunday = new Date(lastMonday);
      lastSunday.setDate(lastMonday.getDate() + 6);
      lastSunday.setHours(23, 59, 59, 999);

      const weekStart = lastMonday.toISOString().split('T')[0];
      const carryoverIn = getCarryoverIn(parseInt(selectedId), weekStart);
      const playerData = getPlayerHistory(parseInt(selectedId), weekStart, 0);

      preload = {
        affiliate,
        carryoverIn,
        playerData,
        weekStart,
        weekEnd: lastSunday.toISOString().split('T')[0],
      };
    }
  }

  res.render('report_new', { affiliates, preload, selectedId, tiers: TIERS });
});

// ─── API: Calculate (live preview) ───
app.post('/api/calculate', (req, res) => {
  const { affiliate_id, week_start, active_players, net_sc, sold_usd, bonuses, rate_override } = req.body;
  const result = calculate({
    affiliateId: parseInt(affiliate_id),
    weekStart: week_start,
    activePlayers: parseInt(active_players) || 0,
    netSc: parseFloat(net_sc) || 0,
    soldUsd: parseFloat(sold_usd) || 0,
    bonuses: parseFloat(bonuses) || 0,
    rateOverride: rate_override ? parseFloat(rate_override) / 100 : null,
  });
  res.json(result);
});

// ─── Save Report ───
app.post('/report/save', async (req, res) => {
  const {
    affiliate_id, week_label, week_start, week_end,
    active_players, net_sc, sold_usd, bonuses,
    rate_override, rate_override_reason
  } = req.body;

  const aid = parseInt(affiliate_id);
  const players = parseInt(active_players) || 0;
  const nsc = parseFloat(net_sc) || 0;
  const sold = parseFloat(sold_usd) || 0;
  const bon = parseFloat(bonuses) || 0;
  const rateOv = rate_override ? parseFloat(rate_override) / 100 : null;

  const calc = calculate({
    affiliateId: aid,
    weekStart: week_start,
    activePlayers: players,
    netSc: nsc,
    soldUsd: sold,
    bonuses: bon,
    rateOverride: rateOv,
  });

  const weekRange = `${week_start} to ${week_end}`;

  // Save player_weekly
  db.prepare(`
    INSERT OR REPLACE INTO player_weekly (affiliate_id, week_start, player_count)
    VALUES (?, ?, ?)
  `).run(aid, week_start, players);

  // Save report
  const result = db.prepare(`
    INSERT INTO weekly_reports (
      affiliate_id, week_label, week_range, week_start, week_end,
      active_players, net_sc, sold_usd, processing_fees, bonuses,
      total_expenses, carryover_in, net, payout_net,
      commission_rate, total_commission, carryover_out,
      rate_override_reason, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid')
  `).run(
    aid, week_label || `Week of ${week_start}`, weekRange, week_start, week_end,
    players, nsc, sold, calc.processingFees, bon,
    calc.totalExpenses, calc.carryoverIn, calc.net, calc.payoutNet,
    calc.commissionRate, calc.totalCommission, calc.carryoverOut,
    rate_override_reason || null
  );

  const reportId = result.lastInsertRowid;
  const report = db.prepare('SELECT * FROM weekly_reports WHERE id = ?').get(reportId);
  const affiliate = db.prepare('SELECT * FROM affiliates WHERE id = ?').get(aid);

  // Generate PDF
  try {
    await generatePDF(report, affiliate);
  } catch (e) {
    console.error('PDF generation error:', e);
  }

  res.redirect(`/report/${reportId}/send`);
});

// ─── Report Send Page ───
app.get('/report/:id/send', (req, res) => {
  const report = db.prepare('SELECT * FROM weekly_reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).send('Report not found');
  const affiliate = db.prepare('SELECT * FROM affiliates WHERE id = ?').get(report.affiliate_id);

  // Get player history for preview
  const playerRows = db.prepare(`
    SELECT week_start, player_count FROM player_weekly
    WHERE affiliate_id = ? AND week_start <= ?
    ORDER BY week_start DESC LIMIT 4
  `).all(report.affiliate_id, report.week_start).reverse();
  const counts = playerRows.map(r => r.player_count);
  const avg = counts.length > 0 ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;

  res.render('report_send', { report, affiliate, playerRows, avg, formatCurrency });
});

// ─── Send via Telegram ───
app.post('/report/:id/telegram', async (req, res) => {
  const report = db.prepare('SELECT * FROM weekly_reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  const affiliate = db.prepare('SELECT * FROM affiliates WHERE id = ?').get(report.affiliate_id);

  try {
    await sendReport(report, affiliate);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Mark Paid/Unpaid ───
app.post('/report/:id/status', (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE weekly_reports SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ success: true });
});

// ─── Download PDF ───
app.get('/report/:id/pdf', async (req, res) => {
  const report = db.prepare('SELECT * FROM weekly_reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).send('Report not found');

  const affiliate = db.prepare('SELECT * FROM affiliates WHERE id = ?').get(report.affiliate_id);
  let pdfPath = report.pdf_path;

  if (!pdfPath || !require('fs').existsSync(pdfPath)) {
    pdfPath = await generatePDF(report, affiliate);
  }

  res.download(pdfPath);
});

// ─── Delete Report ───
app.post('/report/:id/delete', (req, res) => {
  const report = db.prepare('SELECT * FROM weekly_reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).send('Report not found');

  // Remove PDF file if exists
  if (report.pdf_path) {
    try { require('fs').unlinkSync(report.pdf_path); } catch (e) {}
  }

  // Remove player_weekly entry for this week
  db.prepare('DELETE FROM player_weekly WHERE affiliate_id = ? AND week_start = ?')
    .run(report.affiliate_id, report.week_start);

  db.prepare('DELETE FROM weekly_reports WHERE id = ?').run(report.id);
  res.redirect(`/affiliate/${report.affiliate_id}`);
});

// Start
initBot();
app.listen(PORT, () => {
  console.log(`PSM Commissions running on port ${PORT}`);
});
