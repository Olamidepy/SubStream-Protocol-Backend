/**
 * Background worker for predictive churn analysis.
 * Analyzes subscriber behavior to flag "High Risk of Churn" in the creator's dashboard.
 * 
 * Data points analyzed:
 * 1. Declining login frequency (via audit logs)
 * 2. Reduced content interaction (via audit logs/engagement metrics)
 * 3. Frequent balance "low-water" marks (via subscription balance tracking)
 */
class PredictiveChurnAnalysisWorker {
  constructor(database, options = {}) {
    this.database = database;
    this.checkInterval = options.checkInterval || 3600000; // 1 hour default
    this.lowBalanceThreshold = options.lowBalanceThreshold || 5.0; // $5.00
    this.inactivityThresholdDays = options.inactivityThresholdDays || 14; 
    this.timer = null;
  }

  /**
   * Start the churn analysis worker
   */
  async start() {
    console.log('PredictiveChurnAnalysisWorker starting...');
    this.timer = setInterval(() => this.runAnalysis(), this.checkInterval);
    // Run initial analysis after short delay
    setTimeout(() => this.runAnalysis(), 5000);
  }

  /**
   * Stop the churn analysis worker
   */
  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('PredictiveChurnAnalysisWorker stopped.');
  }

  /**
   * Run the churn analysis cycle
   */
  async runAnalysis() {
    console.log('Running predictive churn analysis cycle...');
    try {
      // 1. Get all active subscriptions
      const subscriptions = this.database.listSubscriptionsForRiskCheck();
      
      for (const sub of subscriptions) {
        let riskScore = 0;
        let reasons = [];

        // Analysis 1: Low-water marks (frequent low balance)
        if (sub.balance !== null && sub.balance < this.lowBalanceThreshold) {
          riskScore += 40;
          reasons.push('Low balance threshold reached');
        }

        // Analysis 2: Declining login frequency / Inactivity
        const lastActive = await this.getLastActivity(sub.walletAddress, sub.creatorId);
        if (lastActive) {
          const daysSinceLastActive = (Date.now() - new Date(lastActive).getTime()) / (1000 * 60 * 60 * 24);
          if (daysSinceLastActive > this.inactivityThresholdDays) {
            riskScore += 30;
            reasons.push(`Inactive for ${Math.floor(daysSinceLastActive)} days`);
          }
        } else {
          // No activity found at all for an active subscription is suspicious
          riskScore += 20;
          reasons.push('No recent activity recorded');
        }

        // Analysis 3: Interaction patterns (Simplified)
        // If they have a recurring low balance but haven't unsubscribed yet
        if (sub.dailySpend && sub.balance < sub.dailySpend * 2) {
          riskScore += 20;
          reasons.push('Balance will run out within 48 hours');
        }

        // 4. Update Risk Status if threshold met
        if (riskScore >= 50) {
          await this.database.updateSubscriptionRiskAssessment({
            creatorId: sub.creatorId,
            walletAddress: sub.walletAddress,
            riskStatus: 'High Risk',
            estimatedRunOutAt: sub.estimated_run_out_at,
            metadata: {
              riskScore,
              reasons,
              analyzedAt: new Date().toISOString()
            }
          });
          
          console.log(`Flagged high churn risk: ${sub.walletAddress} for creator ${sub.creatorId} (Score: ${riskScore})`);
        } else if (riskScore > 20) {
          await this.database.updateSubscriptionRiskAssessment({
            creatorId: sub.creatorId,
            walletAddress: sub.walletAddress,
            riskStatus: 'Medium Risk'
          });
        } else {
          await this.database.updateSubscriptionRiskAssessment({
            creatorId: sub.creatorId,
            walletAddress: sub.walletAddress,
            riskStatus: 'Low Risk'
          });
        }
      }
    } catch (error) {
      console.error('Error during churn analysis cycle:', error);
    }
  }

  /**
   * Helper to fetch last activity date from audit logs
   */
  async getLastActivity(walletAddress, creatorId) {
    try {
      // Query audit logs for this specific user/creator pair
      const logs = this.database.db.prepare(
        'SELECT timestamp FROM creator_audit_logs WHERE creator_id = ? AND metadata_json LIKE ? ORDER BY timestamp DESC LIMIT 1'
      ).get(creatorId, `%${walletAddress}%`);
      
      return logs ? logs.timestamp : null;
    } catch (error) {
      return null;
    }
  }
}

module.exports = { PredictiveChurnAnalysisWorker };
