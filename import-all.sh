#!/bin/sh
echo "Importing all CSVs..."
node import.js "csv-import/PSM-Affiliate Commision formula  - MAR WK1 .csv"
node import.js "csv-import/PSM-Affiliate Commision formula  - MAR WK2 .csv"
node import.js "csv-import/PSM-Affiliate Commision formula  - MAR WK3 .csv"
node import.js "csv-import/PSM-Affiliate Commision formula  - Mar WK 4 .csv"

echo ""
echo "Recalculating Week 4 adjustments..."
node -e "
const db = require('./db');
const { calculate } = require('./commission');
const reports = db.prepare(\"SELECT * FROM weekly_reports WHERE adjustment > 0\").all();
for (const r of reports) {
  let extras = [];
  try { extras = JSON.parse(r.extra_expenses || '[]'); } catch(e) {}
  const calc = calculate({
    affiliateId: r.affiliate_id, weekStart: r.week_start,
    activePlayers: r.active_players, netSc: r.net_sc,
    soldUsd: r.sold_usd, bonuses: r.bonuses,
    adjustment: r.adjustment, extraExpenses: extras,
    rateOverride: r.commission_rate, excludeReportId: r.id,
  });
  db.prepare('UPDATE weekly_reports SET processing_fees=?, total_expenses=?, carryover_in=?, net=?, payout_net=?, total_commission=?, carryover_out=? WHERE id=?')
    .run(calc.processingFees, calc.totalExpenses, calc.carryoverIn, calc.net, calc.payoutNet, calc.totalCommission, calc.carryoverOut, r.id);
}
console.log('Recalculated ' + reports.length + ' reports with adjustments.');
"
echo "Done! All data imported."
