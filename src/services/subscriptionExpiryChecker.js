const DAY_IN_MS = 24 * 60 * 60 * 1000;
const RISK_THRESHOLD_DAYS = 3;

/**
 * Runs a daily low-balance check for active subscriptions.
 */
class SubscriptionExpiryChecker {
  /**
   * @param {{database: import('../db/appDatabase').AppDatabase, lowBalanceEmailService?: {sendLowBalanceEmail: Function}}} options
   */
  constructor({ database, lowBalanceEmailService } = {}) {
    if (!database) {
      throw new Error('database is required');
    }

    this.database = database;
    this.lowBalanceEmailService = lowBalanceEmailService || null;
  }

  /**
   * Estimate subscription run-out dates and mark low balances as At Risk.
   *
   * @param {{now?: Date}} [options]
   * @returns {Promise<{processed: number, atRisk: number}>}
   */
  async runDailyCheck(options = {}) {
    const now = options.now instanceof Date ? options.now : new Date();
    const rows = this.database.listSubscriptionsForRiskCheck();

    let processed = 0;
    let atRisk = 0;

    for (const row of rows) {
      const balance = Number(row.balance);
      const dailySpend = Number(row.dailySpend);

      if (!Number.isFinite(balance) || !Number.isFinite(dailySpend) || dailySpend <= 0) {
        continue;
      }

      const daysRemaining = balance / dailySpend;
      const estimatedRunOutAt = new Date(now.getTime() + daysRemaining * DAY_IN_MS).toISOString();
      const isAtRisk = daysRemaining < RISK_THRESHOLD_DAYS;

      this.database.updateSubscriptionRiskAssessment({
        creatorId: row.creatorId,
        walletAddress: row.walletAddress,
        estimatedRunOutAt,
        ...(isAtRisk ? { riskStatus: 'At Risk' } : {}),
      });

      if (isAtRisk) {
        atRisk += 1;

        if (
          this.lowBalanceEmailService &&
          typeof this.lowBalanceEmailService.sendLowBalanceEmail === 'function'
        ) {
          await this.lowBalanceEmailService.sendLowBalanceEmail({
            creatorId: row.creatorId,
            walletAddress: row.walletAddress,
            userEmail: row.userEmail || null,
            estimatedRunOutAt,
            daysRemaining,
          });
        }
      }

      processed += 1;
    }

    return { processed, atRisk };
  }
}

module.exports = {
  SubscriptionExpiryChecker,
  DAY_IN_MS,
  RISK_THRESHOLD_DAYS,
};
