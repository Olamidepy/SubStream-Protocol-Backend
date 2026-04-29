-- Usage Quota System Database Schema
-- Migration for Issue #221: Developer API "Usage Limits" and Monetization Hook

-- API Keys table
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_hash VARCHAR(255) UNIQUE NOT NULL,
    developer_id UUID NOT NULL,
    tier VARCHAR(20) NOT NULL DEFAULT 'standard' CHECK (tier IN ('standard', 'premium')),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Developers table
CREATE TABLE IF NOT EXISTS developers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    wallet_address VARCHAR(255) UNIQUE,
    subscription_status VARCHAR(20) DEFAULT 'free' CHECK (subscription_status IN ('free', 'premium', 'enterprise')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Usage tracking table
CREATE TABLE IF NOT EXISTS api_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key_id UUID REFERENCES api_keys(id),
    endpoint VARCHAR(255) NOT NULL,
    method VARCHAR(10) NOT NULL,
    status_code INTEGER NOT NULL,
    response_time_ms INTEGER NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ip_address INET,
    user_agent TEXT
);

-- Hourly usage aggregation for fast lookups
CREATE TABLE IF NOT EXISTS hourly_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key_id UUID REFERENCES api_keys(id),
    hour_timestamp TIMESTAMP NOT NULL,
    request_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(api_key_id, hour_timestamp)
);

-- Monthly usage aggregation
CREATE TABLE IF NOT EXISTS monthly_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key_id UUID REFERENCES api_keys(id),
    month_timestamp TIMESTAMP NOT NULL,
    request_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(api_key_id, month_timestamp)
);

-- Developer analytics table
CREATE TABLE IF NOT EXISTS developer_analytics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    developer_id UUID REFERENCES developers(id),
    period_type VARCHAR(10) NOT NULL CHECK (period_type IN ('hourly', 'daily', 'monthly')),
    period_start TIMESTAMP NOT NULL,
    total_requests INTEGER DEFAULT 0,
    unique_endpoints INTEGER DEFAULT 0,
    avg_response_time DECIMAL(10,2) DEFAULT 0,
    error_rate DECIMAL(5,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(developer_id, period_type, period_start)
);

-- Billing events table
CREATE TABLE IF NOT EXISTS billing_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    developer_id UUID REFERENCES developers(id),
    event_type VARCHAR(50) NOT NULL,
    amount DECIMAL(10,2),
    currency VARCHAR(10) DEFAULT 'USD',
    transaction_hash VARCHAR(255),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_api_usage_api_key_timestamp ON api_usage(api_key_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_hourly_usage_key_timestamp ON hourly_usage(api_key_id, hour_timestamp);
CREATE INDEX IF NOT EXISTS idx_monthly_usage_key_timestamp ON monthly_usage(api_key_id, month_timestamp);
CREATE INDEX IF NOT EXISTS idx_developer_analytics_period ON developer_analytics(developer_id, period_type, period_start);
CREATE INDEX IF NOT EXISTS idx_billing_events_developer ON billing_events(developer_id, created_at);

-- Insert sample data for testing
INSERT INTO developers (id, email, wallet_address, subscription_status) VALUES
    ('550e8400-e29b-41d4-a716-446655440001', 'standard-dev@example.com', '0x1234567890abcdef', 'free'),
    ('550e8400-e29b-41d4-a716-446655440002', 'premium-dev@example.com', '0xabcdef1234567890', 'premium')
ON CONFLICT (id) DO NOTHING;

-- Insert sample API keys
INSERT INTO api_keys (id, key_hash, developer_id, tier, is_active) VALUES
    ('550e8400-e29b-41d4-a716-446655440003', '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae', '550e8400-e29b-41d4-a716-446655440001', 'standard', true),
    ('550e8400-e29b-41d4-a716-446655440004', '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7af', '550e8400-e29b-41d4-a716-446655440002', 'premium', true)
ON CONFLICT (key_hash) DO NOTHING;
