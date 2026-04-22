const request = require("supertest");
const fs = require("fs");
const path = require("path");
const app = require("./index");
const StripeMigrationService = require("./services/stripeMigrationService");

describe("Stripe-to-Substream Migration Tests", () => {
  let migrationService;
  let testDatabase;
  let testMerchantId;
  let authToken;

  beforeAll(async () => {
    // Set up test environment
    testMerchantId = "test-merchant-123";
    
    // Initialize migration service with test database
    const { AppDatabase } = require('./src/db/appDatabase');
    testDatabase = new AppDatabase(':memory:');
    migrationService = new StripeMigrationService(testDatabase);

    // Create a test JWT token for authentication
    const jwt = require('jsonwebtoken');
    authToken = jwt.sign(
      {
        publicKey: testMerchantId,
        type: 'stellar',
        tier: 'gold'
      },
      process.env.JWT_SECRET || 'test-secret',
      { expiresIn: '1h' }
    );
  });

  describe("CSV Parsing Functionality", () => {
    it("should parse valid Stripe CSV export correctly", async () => {
      const csvContent = `Customer Email,Subscription Plan,Renewal Date,Status
john.doe@example.com,premium_basic,2024-02-15,active
jane.smith@example.com,premium_pro,2024-02-20,active
bob.wilson@example.com,basic_tier,2024-03-01,canceled`;

      const tempFilePath = path.join(__dirname, 'temp-test-stripe.csv');
      fs.writeFileSync(tempFilePath, csvContent);

      const records = await migrationService.parseStripeCSV(tempFilePath);
      
      expect(records).toHaveLength(2); // Only active subscriptions
      expect(records[0].customerEmail).toBe('john.doe@example.com');
      expect(records[0].stripePlanId).toBe('premium_basic');
      expect(records[0].status).toBe('active');
      
      // Clean up
      fs.unlinkSync(tempFilePath);
    });

    it("should handle various CSV column formats", async () => {
      const csvContent = `Email,Plan,Next Billing Date,Subscription Status
user1@test.com,plan_a,2024-02-15,active
user2@test.com,plan_b,2024-02-20,trialing`;

      const tempFilePath = path.join(__dirname, 'temp-test-stripe-variants.csv');
      fs.writeFileSync(tempFilePath, csvContent);

      const records = await migrationService.parseStripeCSV(tempFilePath);
      
      expect(records).toHaveLength(2);
      expect(records[0].customerEmail).toBe('user1@test.com');
      expect(records[0].stripePlanId).toBe('plan_a');
      
      fs.unlinkSync(tempFilePath);
    });

    it("should skip malformed rows gracefully", async () => {
      const csvContent = `Customer Email,Subscription Plan,Renewal Date,Status
valid@email.com,valid_plan,2024-02-15,active
invalid-email,no_plan,2024-02-20,active
another@valid.com,another_plan,2024-02-25,active`;

      const tempFilePath = path.join(__dirname, 'temp-test-malformed.csv');
      fs.writeFileSync(tempFilePath, csvContent);

      const records = await migrationService.parseStripeCSV(tempFilePath);
      
      expect(records).toHaveLength(2); // Should skip invalid email row
      expect(records.some(r => r.customerEmail === 'invalid-email')).toBe(false);
      
      fs.unlinkSync(tempFilePath);
    });

    it("should reject empty or missing files", async () => {
      await expect(migrationService.parseStripeCSV('nonexistent.csv')).rejects.toThrow();
    });
  });

  describe("Plan Mapping Functionality", () => {
    it("should correctly map Stripe plans to Substream plans", async () => {
      const planMappings = {
        'premium_basic': 'creator123_basic',
        'premium_pro': 'creator123_pro',
        'basic_tier': 'creator123_starter'
      };

      const csvContent = `Customer Email,Subscription Plan,Renewal Date,Status
user1@test.com,premium_basic,2024-02-15,active
user2@test.com,premium_pro,2024-02-20,active`;

      const tempFilePath = path.join(__dirname, 'temp-test-mapping.csv');
      fs.writeFileSync(tempFilePath, csvContent);

      const result = await migrationService.processStripeCSV(tempFilePath, testMerchantId, planMappings);
      
      expect(result.success).toBe(true);
      expect(result.results.total).toBe(2);
      expect(result.results.processed).toBe(2);
      expect(result.results.failed).toBe(0);
      
      // Verify records were created with correct mappings
      const jobStatus = migrationService.getMigrationJobStatus(result.jobId);
      expect(jobStatus.records[0].substreamPlanId).toBe('creator123_basic');
      expect(jobStatus.records[1].substreamPlanId).toBe('creator123_pro');
      
      fs.unlinkSync(tempFilePath);
    });

    it("should fail when Stripe plan has no mapping", async () => {
      const planMappings = {
        'premium_basic': 'creator123_basic'
        // Missing mapping for premium_pro
      };

      const csvContent = `Customer Email,Subscription Plan,Renewal Date,Status
user1@test.com,premium_basic,2024-02-15,active
user2@test.com,premium_pro,2024-02-20,active`;

      const tempFilePath = path.join(__dirname, 'temp-test-missing-mapping.csv');
      fs.writeFileSync(tempFilePath, csvContent);

      const result = await migrationService.processStripeCSV(tempFilePath, testMerchantId, planMappings);
      
      expect(result.success).toBe(true);
      expect(result.results.total).toBe(2);
      expect(result.results.processed).toBe(1); // Only one with valid mapping
      expect(result.results.failed).toBe(1); // One failed due to missing mapping
      
      fs.unlinkSync(tempFilePath);
    });
  });

  describe("Migration Link Generation", () => {
    it("should generate secure migration links", () => {
      const recordId = "test-record-123";
      const email = "test@example.com";
      
      const link = migrationService.generateMigrationLink(recordId, email);
      
      expect(link).toContain('record=test-record-123');
      expect(link).toContain('email=test%40example.com');
      expect(link).toContain('ts=');
      expect(link).toContain('sig=');
    });

    it("should verify migration link signatures correctly", () => {
      const recordId = "test-record-123";
      const email = "test@example.com";
      const timestamp = Date.now();
      
      const link = migrationService.generateMigrationLink(recordId, email);
      const url = new URL(link);
      
      const isValid = migrationService.verifyMigrationLink(
        url.searchParams.get('record'),
        url.searchParams.get('email'),
        url.searchParams.get('ts'),
        url.searchParams.get('sig')
      );
      
      expect(isValid).toBe(true);
    });

    it("should reject invalid or expired links", () => {
      const recordId = "test-record-123";
      const email = "test@example.com";
      const oldTimestamp = Date.now() - (25 * 60 * 60 * 1000); // 25 hours ago
      
      const isValid = migrationService.verifyMigrationLink(
        recordId,
        email,
        oldTimestamp.toString(),
        'invalid-signature'
      );
      
      expect(isValid).toBe(false);
    });
  });

  describe("API Endpoint Tests", () => {
    it("should accept Stripe CSV upload via POST /api/v1/merchants/import/stripe", async () => {
      const csvContent = `Customer Email,Subscription Plan,Renewal Date,Status
user1@test.com,premium_basic,2024-02-15,active
user2@test.com,premium_pro,2024-02-20,active`;

      const planMappings = {
        'premium_basic': 'creator123_basic',
        'premium_pro': 'creator123_pro'
      };

      const response = await request(app)
        .post("/api/v1/merchants/import/stripe")
        .set("Authorization", `Bearer ${authToken}`)
        .attach('csvFile', Buffer.from(csvContent), 'stripe-export.csv')
        .field('planMappings', JSON.stringify(planMappings))
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.jobId).toBeDefined();
      expect(response.body.data.summary.total).toBe(2);
      expect(response.body.data.summary.processed).toBe(2);
      expect(response.body.data.summary.failed).toBe(0);
    });

    it("should reject requests without authentication", async () => {
      const response = await request(app)
        .post("/api/v1/merchants/import/stripe")
        .attach('csvFile', Buffer.from('test'), 'test.csv')
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Access token required');
    });

    it("should reject non-CSV files", async () => {
      const response = await request(app)
        .post("/api/v1/merchants/import/stripe")
        .set("Authorization", `Bearer ${authToken}`)
        .attach('csvFile', Buffer.from('not csv'), 'test.txt')
        .field('planMappings', '{}')
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Only CSV files are allowed');
    });

    it("should reject requests without plan mappings", async () => {
      const response = await request(app)
        .post("/api/v1/merchants/import/stripe")
        .set("Authorization", `Bearer ${authToken}`)
        .attach('csvFile', Buffer.from('test'), 'test.csv')
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Plan mappings are required');
    });

    it("should get migration job status", async () => {
      // First create a migration job
      const csvContent = `Customer Email,Subscription Plan,Renewal Date,Status
user1@test.com,premium_basic,2024-02-15,active`;

      const planMappings = {
        'premium_basic': 'creator123_basic'
      };

      const importResponse = await request(app)
        .post("/api/v1/merchants/import/stripe")
        .set("Authorization", `Bearer ${authToken}`)
        .attach('csvFile', Buffer.from(csvContent), 'stripe-export.csv')
        .field('planMappings', JSON.stringify(planMappings))
        .expect(200);

      const jobId = importResponse.body.data.jobId;

      // Then get the status
      const statusResponse = await request(app)
        .get(`/api/v1/merchants/migration/${jobId}/status`)
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(statusResponse.body.success).toBe(true);
      expect(statusResponse.body.data.jobId).toBe(jobId);
      expect(statusResponse.body.data.status).toBe('completed');
      expect(statusResponse.body.data.records).toHaveLength(1);
    });

    it("should verify migration links", async () => {
      // Create a migration job first
      const csvContent = `Customer Email,Subscription Plan,Renewal Date,Status
test@example.com,premium_basic,2024-02-15,active`;

      const planMappings = {
        'premium_basic': 'creator123_basic'
      };

      const importResponse = await request(app)
        .post("/api/v1/merchants/import/stripe")
        .set("Authorization", `Bearer ${authToken}`)
        .attach('csvFile', Buffer.from(csvContent), 'stripe-export.csv')
        .field('planMappings', JSON.stringify(planMappings))
        .expect(200);

      const jobId = importResponse.body.data.jobId;
      const jobStatus = migrationService.getMigrationJobStatus(jobId);
      const record = jobStatus.records[0];
      
      // Parse the migration link to get parameters
      const linkUrl = new URL(record.migration_link);
      
      const verifyResponse = await request(app)
        .get('/api/v1/merchants/migration/verify')
        .query({
          record: linkUrl.searchParams.get('record'),
          email: linkUrl.searchParams.get('email'),
          ts: linkUrl.searchParams.get('ts'),
          sig: linkUrl.searchParams.get('sig')
        })
        .expect(200);

      expect(verifyResponse.body.success).toBe(true);
      expect(verifyResponse.body.data.customerEmail).toBe('test@example.com');
      expect(verifyResponse.body.data.substreamPlanId).toBe('creator123_basic');
    });

    it("should complete migration with wallet connection", async () => {
      // Create a migration job first
      const csvContent = `Customer Email,Subscription Plan,Renewal Date,Status
test@example.com,premium_basic,2024-02-15,active`;

      const planMappings = {
        'premium_basic': 'creator123_basic'
      };

      const importResponse = await request(app)
        .post("/api/v1/merchants/import/stripe")
        .set("Authorization", `Bearer ${authToken}`)
        .attach('csvFile', Buffer.from(csvContent), 'stripe-export.csv')
        .field('planMappings', JSON.stringify(planMappings))
        .expect(200);

      const jobId = importResponse.body.data.jobId;
      const jobStatus = migrationService.getMigrationJobStatus(jobId);
      const record = jobStatus.records[0];
      
      // Complete the migration
      const completeResponse = await request(app)
        .post('/api/v1/merchants/migration/complete')
        .send({
          recordId: record.id,
          stellarPublicKey: 'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ'
        })
        .expect(200);

      expect(completeResponse.body.success).toBe(true);
      expect(completeResponse.body.data.recordId).toBe(record.id);
      expect(completeResponse.body.data.stellarPublicKey).toBe('GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ');
    });

    it("should handle plan mappings CRUD operations", async () => {
      const mappings = {
        'plan_a': 'substream_a',
        'plan_b': 'substream_b'
      };

      // Save mappings
      const saveResponse = await request(app)
        .post('/api/v1/merchants/plan-mappings')
        .set("Authorization", `Bearer ${authToken}`)
        .send({ mappings })
        .expect(200);

      expect(saveResponse.body.success).toBe(true);

      // Get mappings
      const getResponse = await request(app)
        .get('/api/v1/merchants/plan-mappings')
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(getResponse.body.success).toBe(true);
      expect(getResponse.body.data).toEqual(mappings);
    });

    it("should list migration jobs", async () => {
      const response = await request(app)
        .get('/api/v1/merchants/migration-jobs')
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });

  describe("Error Handling", () => {
    it("should handle large files gracefully", async () => {
      // Create a large CSV (simulate many records)
      let csvContent = "Customer Email,Subscription Plan,Renewal Date,Status\n";
      for (let i = 0; i < 1000; i++) {
        csvContent += `user${i}@test.com,plan_${i % 3},2024-02-${15 + (i % 28)},active\n`;
      }

      const planMappings = {
        'plan_0': 'creator123_basic',
        'plan_1': 'creator123_pro',
        'plan_2': 'creator123_premium'
      };

      const response = await request(app)
        .post("/api/v1/merchants/import/stripe")
        .set("Authorization", `Bearer ${authToken}`)
        .attach('csvFile', Buffer.from(csvContent), 'large-stripe-export.csv')
        .field('planMappings', JSON.stringify(planMappings))
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.summary.total).toBe(1000);
      expect(response.body.data.summary.processed).toBe(1000);
      expect(response.body.data.summary.failed).toBe(0);
    });

    it("should handle malformed CSV data", async () => {
      const csvContent = `Invalid CSV format
missing,columns,here
also,broken,data`;

      const tempFilePath = path.join(__dirname, 'temp-test-broken.csv');
      fs.writeFileSync(tempFilePath, csvContent);

      const response = await request(app)
        .post("/api/v1/merchants/import/stripe")
        .set("Authorization", `Bearer ${authToken}`)
        .attach('csvFile', Buffer.from(csvContent), 'broken.csv')
        .field('planMappings', JSON.stringify({}))
        .expect(200);

      // Should succeed but with 0 processed records
      expect(response.body.success).toBe(true);
      expect(response.body.data.summary.total).toBe(0);
      expect(response.body.data.summary.processed).toBe(0);
      
      fs.unlinkSync(tempFilePath);
    });

    it("should validate Stellar public key format", async () => {
      const response = await request(app)
        .post('/api/v1/merchants/migration/complete')
        .send({
          recordId: 'test-record',
          stellarPublicKey: 'invalid-public-key'
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid Stellar public key format');
    });
  });

  describe("Acceptance Criteria Tests", () => {
    it("Acceptance 1: Web2 SaaS merchants can programmatically map their existing user base", async () => {
      const csvContent = `Customer Email,Subscription Plan,Renewal Date,Status
alice@company.com,enterprise,2024-02-15,active
bob@company.com,pro,2024-02-20,active
charlie@company.com,basic,2024-02-25,active`;

      const planMappings = {
        'enterprise': 'creator123_enterprise',
        'pro': 'creator123_pro',
        'basic': 'creator123_basic'
      };

      const response = await request(app)
        .post("/api/v1/merchants/import/stripe")
        .set("Authorization", `Bearer ${authToken}`)
        .attach('csvFile', Buffer.from(csvContent), 'company-export.csv')
        .field('planMappings', JSON.stringify(planMappings))
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.summary.total).toBe(3);
      expect(response.body.data.summary.processed).toBe(3);
      
      // Verify all users were mapped correctly
      const jobId = response.body.data.jobId;
      const jobStatus = migrationService.getMigrationJobStatus(jobId);
      
      expect(jobStatus.records).toHaveLength(3);
      expect(jobStatus.records[0].customerEmail).toBe('alice@company.com');
      expect(jobStatus.records[0].substreamPlanId).toBe('creator123_enterprise');
      expect(jobStatus.records[1].customerEmail).toBe('bob@company.com');
      expect(jobStatus.records[1].substreamPlanId).toBe('creator123_pro');
      expect(jobStatus.records[2].customerEmail).toBe('charlie@company.com');
      expect(jobStatus.records[2].substreamPlanId).toBe('creator123_basic');
    });

    it("Acceptance 2: CSV parsing handles large files, malformed rows, and missing data gracefully", async () => {
      // Test with mixed valid/invalid data
      const csvContent = `Customer Email,Subscription Plan,Renewal Date,Status
valid@email.com,valid_plan,2024-02-15,active
invalid-email,no_plan,2024-02-20,active
another@valid.com,another_plan,2024-02-25,active
,missing_email,2024-02-26,active
good@email.com,good_plan,,active
bad@format.com,bad_plan,invalid-date,active`;

      const planMappings = {
        'valid_plan': 'creator123_valid',
        'another_plan': 'creator123_another',
        'good_plan': 'creator123_good'
      };

      const response = await request(app)
        .post("/api/v1/merchants/import/stripe")
        .set("Authorization", `Bearer ${authToken}`)
        .attach('csvFile', Buffer.from(csvContent), 'mixed-quality.csv')
        .field('planMappings', JSON.stringify(planMappings))
        .expect(200);

      expect(response.body.success).toBe(true);
      // Should process only valid records
      expect(response.body.data.summary.processed).toBeGreaterThan(0);
      expect(response.body.data.summary.failed).toBeGreaterThan(0);
    });

    it("Acceptance 3: Migration links provide frictionless bridge for end-users", async () => {
      // Create migration record
      const csvContent = `Customer Email,Subscription Plan,Renewal Date,Status
newuser@example.com,starter,2024-02-15,active`;

      const planMappings = {
        'starter': 'creator123_starter'
      };

      const importResponse = await request(app)
        .post("/api/v1/merchants/import/stripe")
        .set("Authorization", `Bearer ${authToken}`)
        .attach('csvFile', Buffer.from(csvContent), 'new-user.csv')
        .field('planMappings', JSON.stringify(planMappings))
        .expect(200);

      const jobId = importResponse.body.data.jobId;
      const jobStatus = migrationService.getMigrationJobStatus(jobId);
      const record = jobStatus.records[0];
      
      // Verify migration link is generated and accessible
      expect(record.migrationLink).toBeDefined();
      expect(record.migrationLink).toContain('migrate');
      
      // Simulate user clicking the link and connecting wallet
      const linkUrl = new URL(record.migrationLink);
      
      const verifyResponse = await request(app)
        .get('/api/v1/merchants/migration/verify')
        .query({
          record: linkUrl.searchParams.get('record'),
          email: linkUrl.searchParams.get('email'),
          ts: linkUrl.searchParams.get('ts'),
          sig: linkUrl.searchParams.get('sig')
        })
        .expect(200);

      expect(verifyResponse.body.success).toBe(true);
      expect(verifyResponse.body.data.customerEmail).toBe('newuser@example.com');
      
      // Complete the migration
      const completeResponse = await request(app)
        .post('/api/v1/merchants/migration/complete')
        .send({
          recordId: record.id,
          stellarPublicKey: 'GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ'
        })
        .expect(200);

      expect(completeResponse.body.success).toBe(true);
      expect(completeResponse.body.data.message).toContain('Migration completed successfully');
    });
  });

  afterAll(() => {
    // Clean up test database
    if (testDatabase && testDatabase.db) {
      testDatabase.db.close();
    }
  });
});
