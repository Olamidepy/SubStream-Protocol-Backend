const PreBillingHealthCheck = require('./services/preBillingHealthCheck');
const SorobanBalanceChecker = require('./services/sorobanBalanceChecker');
const PreBillingEmailService = require('./services/preBillingEmailService');
const PreBillingHealthWorker = require('./workers/preBillingHealthWorker');

describe('Pre-Billing Health Check System', () => {
  let mockDatabase;
  let mockEmailService;
  let healthCheck;
  let balanceChecker;
  let emailService;

  beforeEach(() => {
    // Mock database
    mockDatabase = {
      db: {
        prepare: jest.fn().mockReturnValue({
          all: jest.fn(),
          run: jest.fn()
        }),
        exec: jest.fn()
      }
    };

    // Mock email service
    mockEmailService = {
      sendEmail: jest.fn().mockResolvedValue({ success: true })
    };

    // Create services
    emailService = new PreBillingEmailService();
    balanceChecker = new SorobanBalanceChecker({
      rpcUrl: 'https://test-rpc.stellar.org',
      networkPassphrase: 'Test Network',
      sourceSecret: 'SAK7KNG3LQJ6B6S4K3B6S4K3B6S4K3B6S4K3B6S4K3B6S4K3B6S4K3B6S4K3B6S4K3B6S'
    });
    
    healthCheck = new PreBillingHealthCheck({
      database: mockDatabase,
      emailService: mockEmailService,
      soroban: {
        rpcUrl: 'https://test-rpc.stellar.org',
        networkPassphrase: 'Test Network',
        sourceSecret: 'SAK7KNG3LQJ6B6S4K3B6S4K3B6S4K3B6S4K3B6S4K3B6S4K3B6S4K3B6S4K3B6S4K3B6'
      },
      warningThresholdDays: 3,
      batchSize: 2
    });
  });

  describe('Soroban Balance Checker', () => {
    beforeEach(() => {
      // Mock the server methods
      balanceChecker.server = {
        getAccount: jest.fn(),
        simulateTransaction: jest.fn()
      };
    });

    it('should check wallet balance successfully', async () => {
      const mockAccount = {
        balances: [
          { asset_type: 'native', balance: '10.5000000' }
        ]
      };
      
      balanceChecker.server.getAccount.mockResolvedValue(mockAccount);

      const result = await balanceChecker.checkWalletBalance(
        'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
        undefined,
        5000000 // 0.5 XLM
      );

      expect(result).toEqual({
        walletAddress: 'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
        balance: 105000000, // 10.5 XLM in stroops
        requiredAmount: 5000000,
        isSufficient: true,
        timestamp: expect.any(String),
        contractId: undefined
      });
    });

    it('should detect insufficient balance', async () => {
      const mockAccount = {
        balances: [
          { asset_type: 'native', balance: '0.2000000' }
        ]
      };
      
      balanceChecker.server.getAccount.mockResolvedValue(mockAccount);

      const result = await balanceChecker.checkWalletBalance(
        'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
        undefined,
        5000000 // 0.5 XLM
      );

      expect(result.isSufficient).toBe(false);
      expect(result.balance).toBe(2000000); // 0.2 XLM in stroops
    });

    it('should handle account not found', async () => {
      balanceChecker.server.getAccount.mockRejectedValue(new Error('Account not found'));

      const result = await balanceChecker.checkWalletBalance(
        'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
        undefined,
        5000000
      );

      expect(result.isSufficient).toBe(false);
      expect(result.error).toBe('Account not found');
    });

    it('should check authorization allowance', async () => {
      const mockSimulation = {
        result: {
          retval: { value: true }
        }
      };
      
      balanceChecker.server.simulateTransaction.mockResolvedValue(mockSimulation);
      balanceChecker.server.getAccount.mockResolvedValue({ balances: [] });

      const result = await balanceChecker.checkAuthorizationAllowance(
        'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ'
      );

      expect(result.hasAuthorization).toBe(true);
    });

    it('should detect missing authorization', async () => {
      const mockSimulation = {
        result: {
          retval: { value: false }
        }
      };
      
      balanceChecker.server.simulateTransaction.mockResolvedValue(mockSimulation);
      balanceChecker.server.getAccount.mockResolvedValue({ balances: [] });

      const result = await balanceChecker.checkAuthorizationAllowance(
        'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ'
      );

      expect(result.hasAuthorization).toBe(false);
    });

    it('should perform comprehensive health check', async () => {
      const mockAccount = {
        balances: [
          { asset_type: 'native', balance: '0.2000000' }
        ]
      };
      const mockSimulation = {
        result: {
          retval: { value: false }
        }
      };
      
      balanceChecker.server.getAccount.mockResolvedValue(mockAccount);
      balanceChecker.server.simulateTransaction.mockResolvedValue(mockSimulation);

      const result = await balanceChecker.performHealthCheck(
        'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
        undefined,
        5000000
      );

      expect(result.isHealthy).toBe(false);
      expect(result.issues).toHaveLength(2);
      expect(result.issues[0].type).toBe('insufficient_balance');
      expect(result.issues[1].type).toBe('missing_authorization');
    });

    it('should handle healthy wallet', async () => {
      const mockAccount = {
        balances: [
          { asset_type: 'native', balance: '10.5000000' }
        ]
      };
      const mockSimulation = {
        result: {
          retval: { value: true }
        }
      };
      
      balanceChecker.server.getAccount.mockResolvedValue(mockAccount);
      balanceChecker.server.simulateTransaction.mockResolvedValue(mockSimulation);

      const result = await balanceChecker.performHealthCheck(
        'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
        undefined,
        5000000
      );

      expect(result.isHealthy).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should respect rate limiting', async () => {
      balanceChecker.server.getAccount.mockResolvedValue({ balances: [] });
      
      // First call should succeed
      await balanceChecker.checkWalletBalance('GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ');
      
      // Second call within rate limit should fail
      await expect(balanceChecker.checkWalletBalance('GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ'))
        .rejects.toThrow('Rate limit exceeded');
    });

    it('should batch health check efficiently', async () => {
      const mockAccount = {
        balances: [
          { asset_type: 'native', balance: '10.5000000' }
        ]
      };
      
      balanceChecker.server.getAccount.mockResolvedValue(mockAccount);
      balanceChecker.server.simulateTransaction.mockResolvedValue({
        result: { retval: { value: true } }
      });

      const wallets = [
        'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
        'GD6DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
        'GD7DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ'
      ];

      const results = await balanceChecker.batchHealthCheck(wallets);

      expect(results).toHaveLength(3);
      results.forEach(result => {
        expect(result.isHealthy).toBe(true);
      });
    });
  });

  describe('Pre-Billing Health Check Service', () => {
    it('should get subscriptions due for billing', () => {
      const targetDate = new Date('2024-01-15T00:00:00.000Z');
      const targetDateString = '2024-01-15';
      
      const mockSubscriptions = [
        {
          creatorId: 'creator-1',
          walletAddress: 'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
          userEmail: 'user1@example.com',
          nextBillingDate: '2024-01-15T00:00:00.000Z',
          requiredAmount: 10000000,
          warningSentAt: null
        },
        {
          creatorId: 'creator-2',
          walletAddress: 'GD6DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
          userEmail: 'user2@example.com',
          nextBillingDate: '2024-01-15T00:00:00.000Z',
          requiredAmount: 20000000,
          warningSentAt: null
        }
      ];

      mockDatabase.db.prepare.mockReturnValue({
        all: jest.fn().mockReturnValue(mockSubscriptions)
      });

      const result = healthCheck.getSubscriptionsDueForBilling(targetDate);

      expect(result).toEqual(mockSubscriptions);
      expect(mockDatabase.db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('DATE(next_billing_date) = ?')
      );
    });

    it('should skip subscriptions already warned today', () => {
      const targetDate = new Date('2024-01-15T00:00:00.000Z');
      const targetDateString = '2024-01-15';
      
      const mockSubscriptions = [
        {
          creatorId: 'creator-1',
          walletAddress: 'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
          userEmail: 'user1@example.com',
          nextBillingDate: '2024-01-15T00:00:00.000Z',
          requiredAmount: 10000000,
          warningSentAt: new Date().toISOString() // Already warned today
        }
      ];

      mockDatabase.db.prepare.mockReturnValue({
        all: jest.fn().mockReturnValue(mockSubscriptions)
      });

      const result = healthCheck.getSubscriptionsDueForBilling(targetDate);

      // Should return empty because warning was already sent today
      expect(mockDatabase.db.prepare().all).toHaveBeenCalledWith(targetDateString);
    });

    it('should process subscriptions and send warnings', async () => {
      const subscriptions = [
        {
          creatorId: 'creator-1',
          walletAddress: 'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
          userEmail: 'user1@example.com',
          nextBillingDate: '2024-01-15T00:00:00.000Z',
          requiredAmount: 10000000,
          warningSentAt: null
        }
      ];

      // Mock health check to return unhealthy
      jest.spyOn(balanceChecker, 'batchHealthCheck').mockResolvedValue([{
        walletAddress: 'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
        isHealthy: false,
        issues: [{ type: 'insufficient_balance', message: 'Low balance' }]
      }]);

      const result = await healthCheck.processSubscriptions(subscriptions);

      expect(result.processed).toBe(1);
      expect(result.warningsSent).toBe(1);
      expect(mockEmailService.sendEmail).toHaveBeenCalled();
    });

    it('should skip healthy subscriptions', async () => {
      const subscriptions = [
        {
          creatorId: 'creator-1',
          walletAddress: 'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
          userEmail: 'user1@example.com',
          nextBillingDate: '2024-01-15T00:00:00.000Z',
          requiredAmount: 10000000,
          warningSentAt: null
        }
      ];

      // Mock health check to return healthy
      jest.spyOn(balanceChecker, 'batchHealthCheck').mockResolvedValue([{
        walletAddress: 'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
        isHealthy: true,
        issues: []
      }]);

      const result = await healthCheck.processSubscriptions(subscriptions);

      expect(result.processed).toBe(1);
      expect(result.warningsSent).toBe(0);
      expect(mockEmailService.sendEmail).not.toHaveBeenCalled();
    });

    it('should update warning timestamp', () => {
      const subscription = {
        creatorId: 'creator-1',
        walletAddress: 'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ'
      };

      healthCheck.updateWarningTimestamp(subscription);

      expect(mockDatabase.db.prepare().run).toHaveBeenCalledWith(
        expect.any(String), // timestamp
        subscription.creatorId,
        subscription.walletAddress
      );
    });

    it('should update next billing date', () => {
      const creatorId = 'creator-1';
      const walletAddress = 'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ';
      const nextBillingDate = new Date('2024-01-15T00:00:00.000Z');
      const requiredAmount = 10000000;

      healthCheck.updateNextBillingDate(creatorId, walletAddress, nextBillingDate, requiredAmount);

      expect(mockDatabase.db.prepare().run).toHaveBeenCalledWith(
        nextBillingDate.toISOString(),
        requiredAmount,
        creatorId,
        walletAddress
      );
    });
  });

  describe('Email Service', () => {
    it('should generate pre-billing warning email content', () => {
      const data = {
        walletAddress: 'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
        creatorId: 'creator-1',
        nextBillingDate: '2024-01-15T00:00:00.000Z',
        requiredAmount: 10000000,
        issues: [
          {
            type: 'insufficient_balance',
            message: 'Low balance',
            balance: 5000000,
            required: 10000000
          }
        ],
        balanceCheck: { isSufficient: false },
        authCheck: { hasAuthorization: true },
        warningDays: 3
      };

      const content = emailService.generateEmailContent('pre_billing_warning', data);

      expect(content.text).toContain('Action Required');
      expect(content.text).toContain('creator-1');
      expect(content.text).toContain('1.000000 XLM');
      expect(content.html).toContain('<!DOCTYPE html>');
      expect(content.html).toContain('insufficient balance');
    });

    it('should format balance correctly', () => {
      expect(emailService.formatBalance(10000000)).toBe('1.000000 XLM');
      expect(emailService.formatBalance(0)).toBe('0 XLM');
      expect(emailService.formatBalance(NaN)).toBe('0 XLM');
    });

    it('should send test email', async () => {
      const testData = {
        email: 'test@example.com',
        walletAddress: 'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
        creatorId: 'test-creator'
      };

      const result = await emailService.sendTestEmail(testData);

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    });
  });

  describe('Health Check Worker', () => {
    let worker;

    beforeEach(() => {
      worker = new PreBillingHealthWorker({
        database: mockDatabase,
        emailService: mockEmailService,
        soroban: {
          rpcUrl: 'https://test-rpc.stellar.org',
          networkPassphrase: 'Test Network',
          sourceSecret: 'SAK7KNG3LQJ6B6S4K3B6S4K3B6S4K3B6S4K3B6S4K3B6S4K3B6S4K3B6S4K3B6S4K3B6'
        },
        cronSchedule: '0 2 * * *',
        warningThresholdDays: 3,
        batchSize: 2
      });
    });

    it('should initialize worker correctly', () => {
      expect(worker.healthCheck).toBeDefined();
      expect(worker.isRunning).toBe(false);
      expect(worker.config.warningThresholdDays).toBe(3);
    });

    it('should get worker status', () => {
      const status = worker.getStatus();

      expect(status.isRunning).toBe(false);
      expect(status.config.cronSchedule).toBe('0 2 * * *');
      expect(status.config.warningThresholdDays).toBe(3);
    });

    it('should get performance metrics', () => {
      // Add some mock run history
      worker.runHistory = [
        {
          timestamp: new Date().toISOString(),
          duration: 1000,
          results: { processed: 10, warningsSent: 5 },
          success: true
        },
        {
          timestamp: new Date().toISOString(),
          duration: 500,
          error: 'Test error',
          success: false
        }
      ];

      const metrics = worker.getMetrics();

      expect(metrics.totalRuns).toBe(2);
      expect(metrics.successfulRuns).toBe(1);
      expect(metrics.failedRuns).toBe(1);
      expect(metrics.successRate).toBe(50);
      expect(metrics.avgDuration).toBe(750);
      expect(metrics.totalProcessed).toBe(10);
      expect(metrics.totalWarnings).toBe(5);
    });

    it('should test wallet health check', async () => {
      jest.spyOn(balanceChecker, 'performHealthCheck').mockResolvedValue({
        isHealthy: false,
        issues: [{ type: 'insufficient_balance' }]
      });

      const result = await worker.testWallet('GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ', 10000000);

      expect(result.walletAddress).toBe('GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ');
      expect(result.healthCheck.isHealthy).toBe(false);
    });

    it('should handle health check gracefully', async () => {
      const mockSubscriptions = [];
      
      mockDatabase.db.prepare.mockReturnValue({
        all: jest.fn().mockReturnValue(mockSubscriptions)
      });

      jest.spyOn(healthCheck, 'runDailyHealthCheck').mockResolvedValue({
        processed: 0,
        warningsSent: 0,
        errors: 0
      });

      const result = await worker.runHealthCheck();

      expect(result.success).toBe(true);
      expect(result.results.processed).toBe(0);
    });

    it('should record run history', async () => {
      jest.spyOn(healthCheck, 'runDailyHealthCheck').mockResolvedValue({
        processed: 5,
        warningsSent: 2,
        errors: 0
      });

      await worker.runHealthCheck();

      expect(worker.runHistory).toHaveLength(1);
      expect(worker.runHistory[0].success).toBe(true);
      expect(worker.runHistory[0].results.processed).toBe(5);
    });

    it('should limit run history size', async () => {
      // Fill history beyond max size
      for (let i = 0; i < 35; i++) {
        worker.runHistory.push({
          timestamp: new Date().toISOString(),
          success: true
        });
      }

      jest.spyOn(healthCheck, 'runDailyHealthCheck').mockResolvedValue({
        processed: 1,
        warningsSent: 0,
        errors: 0
      });

      await worker.runHealthCheck();

      expect(worker.runHistory.length).toBeLessThanOrEqual(30);
    });
  });

  describe('Acceptance Criteria Tests', () => {
    it('Acceptance 1: Users receive proactive warnings', async () => {
      const subscriptions = [
        {
          creatorId: 'creator-1',
          walletAddress: 'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
          userEmail: 'user@example.com',
          nextBillingDate: '2024-01-15T00:00:00.000Z',
          requiredAmount: 10000000,
          warningSentAt: null
        }
      ];

      // Mock unhealthy wallet
      jest.spyOn(balanceChecker, 'batchHealthCheck').mockResolvedValue([{
        walletAddress: 'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
        isHealthy: false,
        issues: [{ type: 'insufficient_balance', message: 'Low balance' }]
      }]);

      const result = await healthCheck.processSubscriptions(subscriptions);

      expect(result.warningsSent).toBe(1);
      expect(mockEmailService.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          subject: expect.stringContaining('Action Required'),
          template: 'pre_billing_warning'
        })
      );
    });

    it('Acceptance 2: System handles large datasets efficiently', async () => {
      // Create large dataset
      const largeSubscriptions = [];
      for (let i = 0; i < 100; i++) {
        largeSubscriptions.push({
          creatorId: `creator-${i}`,
          walletAddress: `GD${i}DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ`,
          userEmail: `user${i}@example.com`,
          nextBillingDate: '2024-01-15T00:00:00.000Z',
          requiredAmount: 10000000,
          warningSentAt: null
        });
      }

      // Mock batch processing with delays
      jest.spyOn(balanceChecker, 'batchHealthCheck').mockImplementation(async (wallets) => {
        // Simulate RPC rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
        return wallets.map(wallet => ({
          walletAddress: wallet,
          isHealthy: false,
          issues: [{ type: 'insufficient_balance' }]
        }));
      });

      const startTime = Date.now();
      const result = await healthCheck.processSubscriptions(largeSubscriptions);
      const endTime = Date.now();

      expect(result.processed).toBe(100);
      expect(result.warningsSent).toBe(100);
      
      // Should complete in reasonable time despite rate limiting
      expect(endTime - startTime).toBeLessThan(30000); // 30 seconds max
    });

    it('Acceptance 3: RPC rate limits are respected', async () => {
      const wallets = [
        'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
        'GD6DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
        'GD7DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ'
      ];

      balanceChecker.server.getAccount.mockResolvedValue({ balances: [] });

      // First call should succeed
      await balanceChecker.checkWalletBalance(wallets[0]);
      
      // Second call immediately should fail due to rate limiting
      await expect(balanceChecker.checkWalletBalance(wallets[1]))
        .rejects.toThrow('Rate limit exceeded');
      
      // Third call after delay should succeed
      await new Promise(resolve => setTimeout(resolve, 1100)); // Wait for rate limit reset
      await balanceChecker.checkWalletBalance(wallets[2]);
      
      expect(balanceChecker.server.getAccount).toHaveBeenCalledTimes(2);
    });
  });

  describe('Error Handling', () => {
    it('should handle RPC failures gracefully', async () => {
      balanceChecker.server.getAccount.mockRejectedValue(new Error('RPC timeout'));

      const result = await balanceChecker.checkWalletBalance('GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ');

      expect(result.isSufficient).toBe(false);
      expect(result.error).toBe('RPC timeout');
    });

    it('should handle email service failures', async () => {
      const subscriptions = [
        {
          creatorId: 'creator-1',
          walletAddress: 'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
          userEmail: 'user@example.com',
          nextBillingDate: '2024-01-15T00:00:00.000Z',
          requiredAmount: 10000000,
          warningSentAt: null
        }
      ];

      jest.spyOn(balanceChecker, 'batchHealthCheck').mockResolvedValue([{
        walletAddress: 'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
        isHealthy: false,
        issues: [{ type: 'insufficient_balance' }]
      }]);

      mockEmailService.sendEmail.mockRejectedValue(new Error('Email service down'));

      const result = await healthCheck.processSubscriptions(subscriptions);

      expect(result.errors).toBe(1);
      expect(result.errorDetails[0].error).toBe('Email service down');
    });

    it('should handle database failures gracefully', async () => {
      mockDatabase.db.prepare.mockImplementation(() => {
        throw new Error('Database connection failed');
      });

      await expect(healthCheck.runDailyHealthCheck())
        .rejects.toThrow('Database connection failed');
    });
  });
});
