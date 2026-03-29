// Performance Test Suite for Subscriber Map Indexing
// Tests query performance to ensure <100ms response times for fan list queries

const { Pool } = require('pg');
const { performance } = require('perf_hooks');

class SubscriberPerformanceTest {
    constructor(connectionString) {
        this.pool = new Pool({
            connectionString: connectionString,
            max: 20, // Connection pool size
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 2000,
        });
    }

    async runPerformanceTests() {
        console.log('🚀 Starting Subscriber Performance Tests...\n');

        try {
            await this.setupTestData();
            await this.runQueryPerformanceTests();
            await this.runLoadTests();
            await this.generatePerformanceReport();
        } catch (error) {
            console.error('❌ Performance tests failed:', error);
        } finally {
            await this.cleanup();
            await this.pool.end();
        }
    }

    async setupTestData() {
        console.log('📊 Setting up test data...');
        
        const client = await this.pool.connect();
        
        try {
            // Clean up existing test data
            await client.query('DELETE FROM subscriptions WHERE creator_id LIKE \'test-creator-%\'');
            
            // Create test creators with varying subscriber counts
            const testCreators = [
                { id: 'test-creator-small', expectedSubs: 10 },
                { id: 'test-creator-medium', expectedSubs: 1000 },
                { id: 'test-creator-large', expectedSubs: 10000 },
                { id: 'test-creator-xlarge', expectedSubs: 100000 }
            ];

            for (const creator of testCreators) {
                console.log(`  Creating ${creator.expectedSubs} subscribers for ${creator.id}`);
                
                const insertPromises = [];
                for (let i = 0; i < creator.expectedSubs; i++) {
                    const walletAddress = `0x${i.toString(16).padStart(40, '0')}`;
                    const subscribedAt = new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000);
                    const isActive = Math.random() > 0.1; // 90% active rate
                    
                    insertPromises.push(
                        client.query(
                            `INSERT INTO subscriptions (creator_id, wallet_address, active, subscribed_at) 
                             VALUES ($1, $2, $3, $4) 
                             ON CONFLICT (creator_id, wallet_address) DO NOTHING`,
                            [creator.id, walletAddress, isActive ? 1 : 0, subscribedAt]
                        )
                    );
                    
                    // Batch inserts to avoid memory issues
                    if (insertPromises.length >= 1000) {
                        await Promise.all(insertPromises);
                        insertPromises.length = 0;
                    }
                }
                
                // Insert remaining records
                if (insertPromises.length > 0) {
                    await Promise.all(insertPromises);
                }
            }
            
            // Update table statistics
            await client.query('ANALYZE subscriptions');
            
            console.log('✅ Test data setup complete\n');
        } finally {
            client.release();
        }
    }

    async runQueryPerformanceTests() {
        console.log('⚡ Running query performance tests...\n');
        
        const testQueries = [
            {
                name: 'Small Creator Fan List (10 subs)',
                creatorId: 'test-creator-small',
                query: 'SELECT wallet_address, subscribed_at FROM subscriptions WHERE creator_id = $1 AND active = 1 ORDER BY subscribed_at DESC LIMIT 50'
            },
            {
                name: 'Medium Creator Fan List (1,000 subs)',
                creatorId: 'test-creator-medium',
                query: 'SELECT wallet_address, subscribed_at FROM subscriptions WHERE creator_id = $1 AND active = 1 ORDER BY subscribed_at DESC LIMIT 50'
            },
            {
                name: 'Large Creator Fan List (10,000 subs)',
                creatorId: 'test-creator-large',
                query: 'SELECT wallet_address, subscribed_at FROM subscriptions WHERE creator_id = $1 AND active = 1 ORDER BY subscribed_at DESC LIMIT 50'
            },
            {
                name: 'XLarge Creator Fan List (100,000 subs)',
                creatorId: 'test-creator-xlarge',
                query: 'SELECT wallet_address, subscribed_at FROM subscriptions WHERE creator_id = $1 AND active = 1 ORDER BY subscribed_at DESC LIMIT 50'
            },
            {
                name: 'Count Active Fans (Large)',
                creatorId: 'test-creator-large',
                query: 'SELECT COUNT(*) as count FROM subscriptions WHERE creator_id = $1 AND active = 1'
            },
            {
                name: 'Recent Fans Query (Large)',
                creatorId: 'test-creator-large',
                query: 'SELECT wallet_address, subscribed_at FROM subscriptions WHERE creator_id = $1 AND active = 1 AND subscribed_at >= NOW() - INTERVAL \'30 days\' ORDER BY subscribed_at DESC'
            }
        ];

        const results = [];

        for (const test of testQueries) {
            console.log(`Testing: ${test.name}`);
            
            const times = [];
            const iterations = 10; // Run each query 10 times
            
            for (let i = 0; i < iterations; i++) {
                const startTime = performance.now();
                
                const client = await this.pool.connect();
                try {
                    const result = await client.query(test.query, [test.creatorId]);
                    const endTime = performance.now();
                    
                    times.push(endTime - startTime);
                } finally {
                    client.release();
                }
            }
            
            const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
            const minTime = Math.min(...times);
            const maxTime = Math.max(...times);
            
            results.push({
                query: test.name,
                avgTime: avgTime.toFixed(2),
                minTime: minTime.toFixed(2),
                maxTime: maxTime.toFixed(2),
                passesThreshold: avgTime < 100
            });
            
            console.log(`  Average: ${avgTime.toFixed(2)}ms | Min: ${minTime.toFixed(2)}ms | Max: ${maxTime.toFixed(2)}ms`);
            console.log(`  Status: ${avgTime < 100 ? '✅ PASS' : '❌ FAIL'} (<100ms target)\n`);
        }
        
        this.queryResults = results;
    }

    async runLoadTests() {
        console.log('🔄 Running concurrent load tests...\n');
        
        const concurrentQueries = 50; // Simulate 50 concurrent users
        const queriesPerSecond = 100; // Target QPS
        
        const creatorIds = [
            'test-creator-small',
            'test-creator-medium', 
            'test-creator-large',
            'test-creator-xlarge'
        ];
        
        const startTime = performance.now();
        const promises = [];
        
        for (let i = 0; i < concurrentQueries; i++) {
            const creatorId = creatorIds[i % creatorIds.length];
            
            promises.push(this.executeLoadTestQuery(creatorId, i));
        }
        
        const results = await Promise.all(promises);
        const endTime = performance.now();
        
        const totalTime = endTime - startTime;
        const successfulQueries = results.filter(r => r.success).length;
        const avgQueryTime = results.reduce((sum, r) => sum + r.time, 0) / results.length;
        
        console.log(`Load Test Results:`);
        console.log(`  Total Queries: ${concurrentQueries}`);
        console.log(`  Successful: ${successfulQueries}`);
        console.log(`  Failed: ${concurrentQueries - successfulQueries}`);
        console.log(`  Total Time: ${totalTime.toFixed(2)}ms`);
        console.log(`  Average Query Time: ${avgQueryTime.toFixed(2)}ms`);
        console.log(`  QPS Achieved: ${(concurrentQueries / (totalTime / 1000)).toFixed(2)}`);
        console.log(`  Status: ${avgQueryTime < 100 ? '✅ PASS' : '❌ FAIL'}\n`);
        
        this.loadTestResults = {
            totalQueries: concurrentQueries,
            successful: successfulQueries,
            totalTime: totalTime,
            avgQueryTime: avgQueryTime,
            qps: concurrentQueries / (totalTime / 1000)
        };
    }

    async executeLoadTestQuery(creatorId, queryId) {
        const startTime = performance.now();
        
        try {
            const client = await this.pool.connect();
            try {
                await client.query(
                    'SELECT wallet_address, subscribed_at FROM subscriptions WHERE creator_id = $1 AND active = 1 ORDER BY subscribed_at DESC LIMIT 50',
                    [creatorId]
                );
                
                const endTime = performance.now();
                return {
                    queryId,
                    success: true,
                    time: endTime - startTime
                };
            } finally {
                client.release();
            }
        } catch (error) {
            const endTime = performance.now();
            return {
                queryId,
                success: false,
                time: endTime - startTime,
                error: error.message
            };
        }
    }

    async generatePerformanceReport() {
        console.log('📋 Generating Performance Report...\n');
        
        const report = {
            timestamp: new Date().toISOString(),
            queryPerformanceTests: this.queryResults,
            loadTestResults: this.loadTestResults,
            summary: {
                totalQueryTests: this.queryResults.length,
                passedQueryTests: this.queryResults.filter(r => r.passesThreshold).length,
                loadTestPassed: this.loadTestResults.avgQueryTime < 100,
                overallPerformance: this.calculateOverallPerformance()
            }
        };
        
        // Save report to file
        const fs = require('fs');
        const path = require('path');
        const reportPath = path.join(__dirname, 'performance-report.json');
        
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
        
        console.log('Performance Summary:');
        console.log(`  Query Tests: ${report.summary.passedQueryTests}/${report.summary.totalQueryTests} passed`);
        console.log(`  Load Test: ${report.summary.loadTestPassed ? 'PASSED' : 'FAILED'}`);
        console.log(`  Overall Performance: ${report.summary.overallPerformance}`);
        console.log(`  Report saved to: ${reportPath}\n`);
        
        return report;
    }

    calculateOverallPerformance() {
        const allQueryTimes = this.queryResults.map(r => parseFloat(r.avgTime));
        const maxQueryTime = Math.max(...allQueryTimes);
        const avgQueryTime = allQueryTimes.reduce((a, b) => a + b, 0) / allQueryTimes.length;
        
        if (maxQueryTime < 50 && this.loadTestResults.avgQueryTime < 50) {
            return 'EXCELLENT';
        } else if (maxQueryTime < 100 && this.loadTestResults.avgQueryTime < 100) {
            return 'GOOD';
        } else if (maxQueryTime < 200 && this.loadTestResults.avgQueryTime < 200) {
            return 'ACCEPTABLE';
        } else {
            return 'NEEDS_IMPROVEMENT';
        }
    }

    async cleanup() {
        console.log('🧹 Cleaning up test data...');
        
        const client = await this.pool.connect();
        try {
            await client.query('DELETE FROM subscriptions WHERE creator_id LIKE \'test-creator-%\'');
            console.log('✅ Cleanup complete\n');
        } finally {
            client.release();
        }
    }
}

// Run tests if this file is executed directly
if (require.main === module) {
    const connectionString = process.env.DATABASE_URL || 'postgresql://username:password@localhost:5432/substream';
    
    const tester = new SubscriberPerformanceTest(connectionString);
    tester.runPerformanceTests().catch(console.error);
}

module.exports = SubscriberPerformanceTest;
