-- Soroban Event Indexer Database Schema
-- This migration creates tables for idempotent Soroban event ingestion

-- Drop existing tables if they exist (for clean migration)
DROP TABLE IF EXISTS soroban_events CASCADE;
DROP TABLE IF EXISTS soroban_ingestion_state CASCADE;

-- Table to track the last ingested ledger for each contract
-- This ensures we can resume safely after server restarts
CREATE TABLE soroban_ingestion_state (
    id SERIAL PRIMARY KEY,
    contract_id VARCHAR(64) NOT NULL,
    last_ingested_ledger BIGINT NOT NULL DEFAULT 0,
    last_ingested_timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    -- Ensure one record per contract
    UNIQUE (contract_id)
);

-- Create index for fast lookup of ingestion state
CREATE INDEX idx_soroban_ingestion_state_contract_id 
ON soroban_ingestion_state (contract_id);

-- Table to store Soroban events with idempotent constraints
-- The unique constraint on transaction_hash + event_index prevents duplicates
CREATE TABLE soroban_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id VARCHAR(64) NOT NULL,
    transaction_hash VARCHAR(64) NOT NULL,
    event_index INTEGER NOT NULL,
    ledger_sequence BIGINT NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    
    -- Parsed event data (JSON)
    event_data JSONB NOT NULL,
    
    -- Raw XDR payload for debugging/auditing
    raw_xdr TEXT,
    
    -- Timestamps
    ledger_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    ingested_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE,
    
    -- Processing status
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    
    -- Idempotent constraint - prevents duplicate events
    UNIQUE (transaction_hash, event_index)
);

-- Create indexes for efficient querying
CREATE INDEX idx_soroban_events_contract_id 
ON soroban_events (contract_id);

CREATE INDEX idx_soroban_events_ledger_sequence 
ON soroban_events (ledger_sequence);

CREATE INDEX idx_soroban_events_event_type 
ON soroban_events (event_type);

CREATE INDEX idx_soroban_events_status 
ON soroban_events (status);

CREATE INDEX idx_soroban_events_ingested_at 
ON soroban_events (ingested_at);

-- Composite index for finding unprocessed events
CREATE INDEX idx_soroban_events_pending_processing 
ON soroban_events (status, ingested_at) 
WHERE status = 'pending';

-- Composite index for event lookups by contract and type
CREATE INDEX idx_soroban_events_contract_type 
ON soroban_events (contract_id, event_type, ledger_sequence DESC);

-- GIN index for efficient JSONB queries on event_data
CREATE INDEX idx_soroban_events_data_gin 
ON soroban_events USING GIN (event_data);

-- Partial index for recent events (useful for analytics)
CREATE INDEX idx_soroban_events_recent 
ON soroban_events (contract_id, event_type, ledger_timestamp DESC)
WHERE ledger_timestamp >= NOW() - INTERVAL '30 days';

-- Create a view for monitoring ingestion progress
CREATE OR REPLACE VIEW soroban_ingestion_progress AS
SELECT 
    s.contract_id,
    s.last_ingested_ledger,
    s.last_ingested_timestamp,
    COUNT(e.id) as total_events_ingested,
    COUNT(CASE WHEN e.status = 'processed' THEN 1 END) as events_processed,
    COUNT(CASE WHEN e.status = 'failed' THEN 1 END) as events_failed,
    COUNT(CASE WHEN e.status = 'pending' THEN 1 END) as events_pending,
    MAX(e.ledger_sequence) as max_ledger_sequence,
    MIN(e.ingested_at) as first_ingestion,
    MAX(e.ingested_at) as last_ingestion
FROM soroban_ingestion_state s
LEFT JOIN soroban_events e ON s.contract_id = e.contract_id
GROUP BY s.contract_id, s.last_ingested_ledger, s.last_ingested_timestamp;

-- Create a view for event type statistics
CREATE OR REPLACE VIEW soroban_event_stats AS
SELECT 
    contract_id,
    event_type,
    COUNT(*) as event_count,
    MIN(ledger_timestamp) as first_event,
    MAX(ledger_timestamp) as last_event,
    COUNT(CASE WHEN status = 'processed' THEN 1 END) as processed_count,
    COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_count
FROM soroban_events
GROUP BY contract_id, event_type;

-- Function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_soroban_ingestion_state_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to automatically update updated_at
CREATE TRIGGER trigger_soroban_ingestion_state_updated_at
    BEFORE UPDATE ON soroban_ingestion_state
    FOR EACH ROW
    EXECUTE FUNCTION update_soroban_ingestion_state_updated_at();

-- Grant necessary permissions (adjust as needed)
-- GRANT SELECT, INSERT, UPDATE ON soroban_events TO indexer_user;
-- GRANT SELECT, INSERT, UPDATE ON soroban_ingestion_state TO indexer_user;
-- GRANT SELECT ON soroban_ingestion_progress TO readonly_user;
-- GRANT SELECT ON soroban_event_stats TO readonly_user;

-- Add table comments for documentation
COMMENT ON TABLE soroban_ingestion_state IS 'Tracks the last ingested ledger for each Soroban contract';
COMMENT ON TABLE soroban_events IS 'Stores Soroban events with idempotent constraints to prevent duplicates';
COMMENT ON COLUMN soroban_events.transaction_hash IS 'Hash of the transaction containing the event';
COMMENT ON COLUMN soroban_events.event_index IS 'Index of the event within the transaction (0-based)';
COMMENT ON COLUMN soroban_events.raw_xdr IS 'Raw XDR payload for debugging and auditing purposes';
COMMENT ON COLUMN soroban_events.event_data IS 'Parsed event data stored as JSONB for efficient querying';

-- Update table statistics for optimal query planning
ANALYZE soroban_ingestion_state;
ANALYZE soroban_events;
