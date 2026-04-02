const db = require('./db');

const TIERS = [
  { rate: 0.40, players: 50, sold: 20000 },
  { rate: 0.35, players: 35, sold: 14000 },
  { rate: 0.30, players: 25, sold: 8000 },
  { rate: 0.25, players: 15, sold: 4000 },
  { rate: 0.20, players: 10, sold: 3000 },
];

function getPlayerAverage(affiliateId, currentWeekStart, currentWeekPlayers) {
  const rows = db.prepare(`
    SELECT player_count FROM player_weekly
    WHERE affiliate_id = ? AND week_start < ?
    ORDER BY week_start DESC LIMIT 3
  `).all(affiliateId, currentWeekStart);

  const counts = rows.map(r => r.player_count);
  counts.push(currentWeekPlayers);

  // Most recent weeks including current
  const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
  return { average: avg, weeks: counts.reverse() }; // oldest first
}

function getPlayerHistory(affiliateId, currentWeekStart, currentWeekPlayers) {
  const rows = db.prepare(`
    SELECT week_start, player_count FROM player_weekly
    WHERE affiliate_id = ? AND week_start < ?
    ORDER BY week_start DESC LIMIT 3
  `).all(affiliateId, currentWeekStart);

  const history = rows.reverse().map(r => ({
    week_start: r.week_start,
    count: r.player_count
  }));
  history.push({ week_start: currentWeekStart, count: currentWeekPlayers });

  const counts = history.map(h => h.count);
  const average = counts.reduce((a, b) => a + b, 0) / counts.length;

  return { history, average };
}

function determineTier(playerAvg, soldUsd) {
  for (const tier of TIERS) {
    if (playerAvg >= tier.players && soldUsd >= tier.sold) {
      return tier;
    }
  }
  return { rate: 0, players: 0, sold: 0 };
}

function getNextTier(playerAvg, soldUsd) {
  const current = determineTier(playerAvg, soldUsd);
  // Find next tier above current
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (TIERS[i].rate > current.rate) {
      return {
        tier: TIERS[i],
        playersNeeded: Math.max(0, TIERS[i].players - playerAvg),
        soldNeeded: Math.max(0, TIERS[i].sold - soldUsd),
      };
    }
  }
  return null; // Already at max tier
}

function getCarryoverIn(affiliateId, weekStart) {
  const prev = db.prepare(`
    SELECT carryover_out FROM weekly_reports
    WHERE affiliate_id = ? AND week_start < ?
    ORDER BY week_start DESC LIMIT 1
  `).get(affiliateId, weekStart);
  return prev ? prev.carryover_out : 0;
}

function calculate(inputs) {
  const {
    affiliateId, weekStart, activePlayers,
    netSc, soldUsd, bonuses,
    rateOverride
  } = inputs;

  const playerData = getPlayerHistory(affiliateId, weekStart, activePlayers);
  const playerAvg = playerData.average;
  const carryoverIn = getCarryoverIn(affiliateId, weekStart);

  const processingFees = soldUsd * 0.0625;
  const totalExpenses = processingFees + bonuses;
  const net = netSc - totalExpenses;
  const adjustedNet = net + carryoverIn;
  const payoutNet = Math.max(0, adjustedNet);

  let commissionRate;
  let tierBasis;
  if (rateOverride != null && rateOverride > 0) {
    commissionRate = rateOverride;
    tierBasis = 'manual override';
  } else {
    // Check affiliate-level override
    const affiliate = db.prepare('SELECT commission_rate_override FROM affiliates WHERE id = ?').get(affiliateId);
    if (affiliate && affiliate.commission_rate_override) {
      commissionRate = affiliate.commission_rate_override;
      tierBasis = 'affiliate override';
    } else {
      const tier = determineTier(playerAvg, soldUsd);
      commissionRate = tier.rate;
      tierBasis = `${Math.round(tier.rate * 100)}% tier (${tier.players}+ players, $${tier.sold.toLocaleString()}+ sold)`;
      if (tier.rate === 0) {
        tierBasis = 'below minimum tier';
      }
    }
  }

  const totalCommission = payoutNet * commissionRate;
  const carryoverOut = Math.min(0, adjustedNet);

  const nextTier = getNextTier(playerAvg, soldUsd);

  return {
    playerAvg: Math.round(playerAvg * 100) / 100,
    playerHistory: playerData.history,
    carryoverIn,
    processingFees: Math.round(processingFees * 100) / 100,
    totalExpenses: Math.round(totalExpenses * 100) / 100,
    net: Math.round(net * 100) / 100,
    adjustedNet: Math.round(adjustedNet * 100) / 100,
    payoutNet: Math.round(payoutNet * 100) / 100,
    commissionRate,
    tierBasis,
    totalCommission: Math.round(totalCommission * 100) / 100,
    carryoverOut: Math.round(carryoverOut * 100) / 100,
    nextTier,
    tiers: TIERS,
  };
}

module.exports = { calculate, getCarryoverIn, getPlayerHistory, determineTier, getNextTier, TIERS };
