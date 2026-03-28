-- Device Fingerprinting Migration for Multi-Accounting Fraud Prevention
-- This migration adds device tracking columns to support Sybil attack detection

-- Add device_id column to subscriptions table
ALTER TABLE subscriptions ADD COLUMN device_id TEXT;
ALTER TABLE subscriptions ADD COLUMN device_fingerprint TEXT;
ALTER TABLE subscriptions ADD COLUMN sybil_risk_score INTEGER DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN sybil_flagged BOOLEAN DEFAULT FALSE;

-- Create index on device_id for fast lookups
CREATE INDEX IF NOT EXISTS idx_subscriptions_device_id 
ON subscriptions (device_id);

-- Create index on sybil_risk_score for fraud monitoring
CREATE INDEX IF NOT EXISTS idx_subscriptions_sybil_risk 
ON subscriptions (sybil_risk_score DESC);

-- Create composite index for Sybil detection queries
CREATE INDEX IF NOT EXISTS idx_subscriptions_device_wallet 
ON subscriptions (device_id, wallet_address);

-- Add device_id to creator_audit_logs for enhanced audit trail
ALTER TABLE creator_audit_logs ADD COLUMN device_id TEXT;
CREATE INDEX IF NOT EXISTS idx_creator_audit_logs_device 
ON creator_audit_logs (device_id);

-- Comments for documentation
COMMENT ON COLUMN subscriptions.device_id IS 'Unique device identifier for fraud detection';
COMMENT ON COLUMN subscriptions.device_fingerprint IS 'SHA256 hash of device fingerprint components';
COMMENT ON COLUMN subscriptions.sybil_risk_score IS 'Risk score 0-100 based on device-wallet patterns';
COMMENT ON COLUMN subscriptions.sybil_flagged IS 'TRUE if flagged as potential Sybil attack';
