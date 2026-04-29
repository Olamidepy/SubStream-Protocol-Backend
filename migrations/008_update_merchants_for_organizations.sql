-- Add organization support to existing tables
ALTER TABLE merchants 
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id),
ADD COLUMN IF NOT EXISTS owner_member_id UUID REFERENCES members(id),
ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(255);

-- Create indexes for organization support
CREATE INDEX IF NOT EXISTS idx_merchants_organization_id ON merchants(organization_id);
CREATE INDEX IF NOT EXISTS idx_merchants_owner_member_id ON merchants(owner_member_id);
CREATE INDEX IF NOT EXISTS idx_merchants_tenant_id ON merchants(tenant_id);

-- Update existing merchants to have tenant_id set to their id for backward compatibility
UPDATE merchants SET tenant_id = id::text WHERE tenant_id IS NULL;

-- Add organization support to merchant_balances table
ALTER TABLE merchant_balances 
ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(255);

-- Create index for tenant_id in merchant_balances
CREATE INDEX IF NOT EXISTS idx_merchant_balances_tenant_id ON merchant_balances(tenant_id);

-- Update existing merchant_balances to have tenant_id
UPDATE merchant_balances mb 
SET tenant_id = (SELECT tenant_id FROM merchants m WHERE m.id = mb.merchant_id) 
WHERE tenant_id IS NULL;

-- Add organization support to treasury_snapshots table
ALTER TABLE treasury_snapshots 
ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(255);

-- Create index for tenant_id in treasury_snapshots
CREATE INDEX IF NOT EXISTS idx_treasury_snapshots_tenant_id ON treasury_snapshots(tenant_id);

-- Update existing treasury_snapshots to have tenant_id
UPDATE treasury_snapshots ts 
SET tenant_id = (SELECT tenant_id FROM merchants m WHERE m.id = ts.merchant_id) 
WHERE tenant_id IS NULL;

-- Create function to ensure tenant_id consistency
CREATE OR REPLACE FUNCTION ensure_tenant_consistency()
RETURNS TRIGGER AS $$
BEGIN
    -- For merchants, set tenant_id based on organization
    IF NEW.organization_id IS NOT NULL THEN
        NEW.tenant_id = NEW.organization_id::text;
    ELSIF NEW.tenant_id IS NULL THEN
        NEW.tenant_id = NEW.id::text;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to ensure tenant consistency
CREATE TRIGGER ensure_merchants_tenant_consistency
    BEFORE INSERT OR UPDATE ON merchants
    FOR EACH ROW
    EXECUTE FUNCTION ensure_tenant_consistency();

-- Add RLS (Row Level Security) for tenant isolation
ALTER TABLE merchants ENABLE ROW Level Security;
ALTER TABLE merchant_balances ENABLE ROW Level Security;
ALTER TABLE treasury_snapshots ENABLE Row Level Security;

-- Create RLS policies for tenant isolation
CREATE POLICY tenant_isolation_merchants ON merchants
    FOR ALL TO authenticated_users
    USING (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation_merchant_balances ON merchant_balances
    FOR ALL TO authenticated_users
    USING (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation_treasury_snapshots ON treasury_snapshots
    FOR ALL TO authenticated_users
    USING (tenant_id = current_setting('app.current_tenant_id', true));
