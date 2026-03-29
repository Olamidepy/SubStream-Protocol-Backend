const {
  SubscriptionExpiryChecker,
  DAY_IN_MS,
  RISK_THRESHOLD_DAYS,
} = require('./src/services/subscriptionExpiryChecker');

describe('SubscriptionExpiryChecker', () => {
  test('marks users as At Risk and triggers low balance email when run-out is below threshold', async () => {
    const db = {
      listSubscriptionsForRiskCheck: jest.fn(() => [
        {
          creatorId: 'creator-1',
          walletAddress: 'wallet-1',
          balance: 2,
          dailySpend: 1,
          userEmail: 'user@example.com',
        },
      ]),
      updateSubscriptionRiskAssessment: jest.fn(),
    };

    const lowBalanceEmailService = {
      sendLowBalanceEmail: jest.fn().mockResolvedValue(undefined),
    };

    const checker = new SubscriptionExpiryChecker({
      database: db,
      lowBalanceEmailService,
    });

    const now = new Date('2026-03-25T00:00:00.000Z');
    const result = await checker.runDailyCheck({ now });

    expect(result).toEqual({ processed: 1, atRisk: 1 });
    expect(db.updateSubscriptionRiskAssessment).toHaveBeenCalledWith(
      expect.objectContaining({
        creatorId: 'creator-1',
        walletAddress: 'wallet-1',
        riskStatus: 'At Risk',
      }),
    );

    expect(lowBalanceEmailService.sendLowBalanceEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        creatorId: 'creator-1',
        walletAddress: 'wallet-1',
        userEmail: 'user@example.com',
      }),
    );
  });

  test('estimates run-out date and does not trigger low-balance email above threshold', async () => {
    const db = {
      listSubscriptionsForRiskCheck: jest.fn(() => [
        {
          creatorId: 'creator-2',
          walletAddress: 'wallet-2',
          balance: 10,
          dailySpend: 1,
          userEmail: 'healthy@example.com',
        },
      ]),
      updateSubscriptionRiskAssessment: jest.fn(),
    };

    const lowBalanceEmailService = {
      sendLowBalanceEmail: jest.fn().mockResolvedValue(undefined),
    };

    const checker = new SubscriptionExpiryChecker({
      database: db,
      lowBalanceEmailService,
    });

    const now = new Date('2026-03-25T00:00:00.000Z');
    await checker.runDailyCheck({ now });

    const call = db.updateSubscriptionRiskAssessment.mock.calls[0][0];
    const expectedRunOut = new Date(now.getTime() + 10 * DAY_IN_MS).toISOString();

    expect(call.estimatedRunOutAt).toBe(expectedRunOut);
    expect(call.riskStatus).toBeUndefined();
    expect(lowBalanceEmailService.sendLowBalanceEmail).not.toHaveBeenCalled();
    expect(RISK_THRESHOLD_DAYS).toBe(3);
  });
});
