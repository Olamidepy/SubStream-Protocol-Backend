-- Subscriber Map Indexing Optimization for Postgres
-- This migration implements advanced indexing strategies to ensure <100ms query times
-- for creator fan lists regardless of size (10 to 100,000+ subscribers)

-- Drop existing indexes if they exist (for clean migration)
DROP INDEX IF EXISTS idx_subscriptions_creator_id;
DROP INDEX IF EXISTS idx_subscriptions_active;
DROP INDEX IF EXISTS idx_subscriptions_creator_active;
DROP INDEX IF EXISTS idx_subscriptions_active_creator_partial;

-- 1. B-Tree Index on creator_id column
-- Optimizes queries filtering by specific creator
CREATE INDEX CONCURRENTLY idx_subscriptions_creator_id 
ON subscriptions (creator_id);

-- 2. B-Tree Index on active status column
-- Optimizes queries filtering by subscription status
CREATE INDEX CONCURRENTLY idx_subscriptions_active 
ON subscriptions (active);

-- 3. Composite B-Tree Index on (creator_id, active)
-- Critical for fan list queries that filter by creator and active status
-- This is the most important index for the primary use case
CREATE INDEX CONCURRENTLY idx_subscriptions_creator_active 
ON subscriptions (creator_id, active);

-- 4. Partial Index for Active Subscribers Only
-- Most efficient index for fan list queries since we typically only want active subscribers
-- Smaller index size = better cache performance = faster queries
CREATE INDEX CONCURRENTLY idx_subscriptions_active_creator_partial 
ON subscriptions (creator_id, subscribed_at DESC)
WHERE active = 1;

-- 5. Partial Index for Creator Fan Count Optimization
-- Supports fast COUNT(*) queries for active subscribers per creator
CREATE INDEX CONCURRENTLY idx_subscriptions_creator_active_count 
ON subscriptions (creator_id)
WHERE active = 1;

-- 6. Time-based Partial Index for Recent Active Subscriptions
-- Useful for "recent fans" queries and analytics
CREATE INDEX CONCURRENTLY idx_subscriptions_recent_active 
ON subscriptions (creator_id, subscribed_at DESC)
WHERE active = 1 AND subscribed_at >= NOW() - INTERVAL '30 days';

-- 7. GIN Index on status (if status is an array or JSON type)
-- Note: Since 'active' is currently an integer, this would be more relevant
-- if we expand to a more complex status system in the future
-- CREATE INDEX CONCURRENTLY idx_subscriptions_status_gin 
-- ON subscriptions USING GIN (status);

-- 8. Covering Index for Fan List Queries
-- Includes all columns needed for typical fan list display
-- Eliminates table lookups (index-only scans)
CREATE INDEX CONCURRENTLY idx_subscriptions_fan_list_covering 
ON subscriptions (creator_id, active, subscribed_at DESC, wallet_address)
WHERE active = 1;

-- 9. Index for Subscription Analytics Queries
-- Supports analytics and reporting on subscription patterns
CREATE INDEX CONCURRENTLY idx_subscriptions_analytics 
ON subscriptions (active, subscribed_at DESC, creator_id);

-- 10. Unique Index Constraint (if not already present)
-- Ensures data integrity while providing lookup performance
-- Note: This may already exist as primary key
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_unique 
ON subscriptions (creator_id, wallet_address);

-- Update table statistics for optimal query planning
ANALYZE subscriptions;

-- Create index usage monitoring view
CREATE OR REPLACE VIEW subscription_index_usage AS
SELECT 
    schemaname,
    tablename,
    indexname,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch
FROM pg_stat_user_indexes 
WHERE tablename = 'subscriptions'
ORDER BY idx_scan DESC;

-- Create performance monitoring view for fan list queries
CREATE OR REPLACE VIEW fan_list_performance_stats AS
SELECT 
    query,
    calls,
    total_time,
    mean_time,
    rows
FROM pg_stat_statements 
WHERE query LIKE '%subscriptions%' 
  AND query LIKE '%creator_id%'
ORDER BY mean_time DESC;

-- Grant necessary permissions (adjust as needed for your setup)
-- GRANT SELECT ON subscription_index_usage TO readonly_user;
-- GRANT SELECT ON fan_list_performance_stats TO readonly_user;
