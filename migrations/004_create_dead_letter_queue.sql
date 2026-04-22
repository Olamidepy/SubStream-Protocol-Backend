-- Dead-Letter Queue (DLQ) Database Schema
-- This migration creates tables for handling failed Soroban event processing
-- with 14-day retention and retry capabilities

-- Drop existing tables if they exist (for clean migration)
DROP TABLE IF EXISTS soroban_dlq_items CASCADE;
DROP TABLE IF EXISTS soroban_dlq_retry_attempts CASCADE;

-- Main DLQ items table
-- Stores failed events that couldn't be processed after retry attempts
CREATE TABLE soroban_dlq_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Event identification
    contract_id VARCHAR(64) NOT NULL,
    transaction_hash VARCHAR(64) NOT NULL,
    event_index INTEGER NOT NULL,
    ledger_sequence BIGINT NOT NULL,
    
    -- Original event data
    raw_event_payload JSONB NOT NULL,
    raw_xdr TEXT,
    event_type VARCHAR(100),
    
    -- Error information
    error_message TEXT NOT NULL,
    error_stack_trace TEXT,
    error_category VARCHAR(50) NOT NULL, -- 'xdr_parsing', 'validation', 'processing', 'network'
    
    -- Processing metadata
    original_attempt_count INTEGER NOT NULL DEFAULT 3,
    final_attempt_timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    -- Status and lifecycle
    status VARCHAR(20) NOT NULL DEFAULT 'failed' CHECK (status IN ('failed', 'retrying', 'retried', 'resolved', 'expired')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_retry_at TIMESTAMP WITH TIME ZONE,
    resolved_at TIMESTAMP WITH TIME ZONE,
    resolved_by VARCHAR(100), -- 'system', 'admin', 'auto'
    resolution_notes TEXT,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() + INTERVAL '14 days'),
    
    -- Constraints
    UNIQUE (transaction_hash, event_index),
    CHECK (expires_at > created_at),
    CHECK (retry_count >= 0),
    CHECK (original_attempt_count > 0)
);

-- Retry attempts tracking table
-- Maintains detailed history of each retry attempt
CREATE TABLE soroban_dlq_retry_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dlq_item_id UUID NOT NULL REFERENCES soroban_dlq_items(id) ON DELETE CASCADE,
    
    -- Attempt details
    attempt_number INTEGER NOT NULL,
    attempted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    attempted_by VARCHAR(100) NOT NULL, -- 'system', 'admin'
    
    -- Attempt result
    success BOOLEAN NOT NULL DEFAULT false,
    error_message TEXT,
    execution_time_ms INTEGER,
    
    -- Payload state (for debugging)
    payload_at_attempt JSONB,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    -- Constraints
    CHECK (attempt_number > 0),
    CHECK (execution_time_ms >= 0)
);

-- Create indexes for efficient querying
CREATE INDEX idx_soroban_dlq_items_contract_id 
ON soroban_dlq_items (contract_id);

CREATE INDEX idx_soroban_dlq_items_ledger_sequence 
ON soroban_dlq_items (ledger_sequence);

CREATE INDEX idx_soroban_dlq_items_status 
ON soroban_dlq_items (status);

CREATE INDEX idx_soroban_dlq_items_error_category 
ON soroban_dlq_items (error_category);

CREATE INDEX idx_soroban_dlq_items_created_at 
ON soroban_dlq_items (created_at);

CREATE INDEX idx_soroban_dlq_items_expires_at 
ON soroban_dlq_items (expires_at);

CREATE INDEX idx_soroban_dlq_items_status_created 
ON soroban_dlq_items (status, created_at DESC);

-- Composite index for finding expired items
CREATE INDEX idx_soroban_dlq_items_expired 
ON soroban_dlq_items (expires_at, status) 
WHERE status IN ('failed', 'retrying');

-- Index for retry attempts lookup
CREATE INDEX idx_soroban_dlq_retry_attempts_dlq_item_id 
ON soroban_dlq_retry_attempts (dlq_item_id);

CREATE INDEX idx_soroban_dlq_retry_attempts_attempted_at 
ON soroban_dlq_retry_attempts (attempted_at DESC);

-- GIN index for efficient JSONB queries on event payload
CREATE INDEX idx_soroban_dlq_items_payload_gin 
ON soroban_dlq_items USING GIN (raw_event_payload);

-- Create views for monitoring and management
CREATE OR REPLACE VIEW soroban_dlq_summary AS
SELECT 
    COUNT(*) as total_items,
    COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_items,
    COUNT(CASE WHEN status = 'retrying' THEN 1 END) as retrying_items,
    COUNT(CASE WHEN status = 'retried' THEN 1 END) as retried_items,
    COUNT(CASE WHEN status = 'resolved' THEN 1 END) as resolved_items,
    COUNT(CASE WHEN status = 'expired' THEN 1 END) as expired_items,
    COUNT(CASE WHEN created_at >= NOW() - INTERVAL '24 hours' THEN 1 END) as items_last_24h,
    COUNT(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 END) as items_last_7d,
    AVG(retry_count) as avg_retry_count,
    MAX(created_at) as latest_failure,
    MIN(created_at) as earliest_failure
FROM soroban_dlq_items
WHERE expires_at > NOW();

CREATE OR REPLACE VIEW soroban_dlq_error_categories AS
SELECT 
    error_category,
    COUNT(*) as count,
    COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_count,
    COUNT(CASE WHEN status = 'resolved' THEN 1 END) as resolved_count,
    AVG(retry_count) as avg_retry_count,
    MAX(created_at) as latest_occurrence
FROM soroban_dlq_items
WHERE expires_at > NOW()
GROUP BY error_category
ORDER BY count DESC;

CREATE OR REPLACE VIEW soroban_dlq_recent_failures AS
SELECT 
    id,
    contract_id,
    transaction_hash,
    event_index,
    ledger_sequence,
    event_type,
    error_category,
    error_message,
    retry_count,
    status,
    created_at,
    expires_at
FROM soroban_dlq_items
WHERE created_at >= NOW() - INTERVAL '24 hours'
  AND expires_at > NOW()
ORDER BY created_at DESC;

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_soroban_dlq_items_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to automatically update updated_at
CREATE TRIGGER trigger_soroban_dlq_items_updated_at
    BEFORE UPDATE ON soroban_dlq_items
    FOR EACH ROW
    EXECUTE FUNCTION update_soroban_dlq_items_updated_at();

-- Function to automatically expire old items
CREATE OR REPLACE FUNCTION expire_soroban_dlq_items()
RETURNS INTEGER AS $$
DECLARE
    expired_count INTEGER;
BEGIN
    -- Update expired items to 'expired' status
    UPDATE soroban_dlq_items 
    SET status = 'expired',
        updated_at = NOW()
    WHERE expires_at <= NOW()
      AND status IN ('failed', 'retrying');
    
    GET DIAGNOSTICS expired_count = ROW_COUNT;
    
    RETURN expired_count;
END;
$$ LANGUAGE plpgsql;

-- Function to clean up expired items (remove after 30 days)
CREATE OR REPLACE FUNCTION cleanup_soroban_dlq_items()
RETURNS INTEGER AS $$
DECLARE
    cleanup_count INTEGER;
BEGIN
    -- Delete items that expired more than 30 days ago
    DELETE FROM soroban_dlq_items 
    WHERE expires_at <= NOW() - INTERVAL '30 days';
    
    GET DIAGNOSTICS cleanup_count = ROW_COUNT;
    
    RETURN cleanup_count;
END;
$$ LANGUAGE plpgsql;

-- Create a function to add items to DLQ
CREATE OR REPLACE FUNCTION add_to_soroban_dlq(
    p_contract_id VARCHAR(64),
    p_transaction_hash VARCHAR(64),
    p_event_index INTEGER,
    p_ledger_sequence BIGINT,
    p_raw_event_payload JSONB,
    p_raw_xdr TEXT,
    p_event_type VARCHAR(100),
    p_error_message TEXT,
    p_error_stack_trace TEXT,
    p_error_category VARCHAR(50),
    p_original_attempt_count INTEGER DEFAULT 3
) RETURNS UUID AS $$
DECLARE
    dlq_id UUID;
BEGIN
    -- Insert new DLQ item
    INSERT INTO soroban_dlq_items (
        contract_id,
        transaction_hash,
        event_index,
        ledger_sequence,
        raw_event_payload,
        raw_xdr,
        event_type,
        error_message,
        error_stack_trace,
        error_category,
        original_attempt_count
    ) VALUES (
        p_contract_id,
        p_transaction_hash,
        p_event_index,
        p_ledger_sequence,
        p_raw_event_payload,
        p_raw_xdr,
        p_event_type,
        p_error_message,
        p_error_stack_trace,
        p_error_category,
        p_original_attempt_count
    ) RETURNING id INTO dlq_id;
    
    RETURN dlq_id;
END;
$$ LANGUAGE plpgsql;

-- Grant necessary permissions (adjust as needed)
-- GRANT SELECT, INSERT, UPDATE ON soroban_dlq_items TO indexer_user;
-- GRANT SELECT, INSERT, UPDATE ON soroban_dlq_retry_attempts TO indexer_user;
-- GRANT SELECT ON soroban_dlq_summary TO readonly_user;
-- GRANT SELECT ON soroban_dlq_error_categories TO readonly_user;
-- GRANT SELECT ON soroban_dlq_recent_failures TO readonly_user;
-- GRANT EXECUTE ON FUNCTION add_to_soroban_dlq TO indexer_user;

-- Add table comments for documentation
COMMENT ON TABLE soroban_dlq_items IS 'Dead-Letter Queue for failed Soroban event processing with 14-day retention';
COMMENT ON TABLE soroban_dlq_retry_attempts IS 'Detailed tracking of retry attempts for DLQ items';
COMMENT ON COLUMN soroban_dlq_items.raw_event_payload IS 'Original event payload that failed processing';
COMMENT ON COLUMN soroban_dlq_items.error_category IS 'Category of error: xdr_parsing, validation, processing, or network';
COMMENT ON COLUMN soroban_dlq_items.expires_at IS 'Automatic expiration date (14 days from creation)';
COMMENT ON COLUMN soroban_dlq_items.status IS 'Current status: failed, retrying, retried, resolved, or expired';

-- Update table statistics for optimal query planning
ANALYZE soroban_dlq_items;
ANALYZE soroban_dlq_retry_attempts;
