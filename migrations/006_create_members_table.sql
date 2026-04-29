-- Create members table
CREATE TABLE IF NOT EXISTS members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    stellar_public_key VARCHAR(56),
    role VARCHAR(50) NOT NULL CHECK (role IN ('ADMIN', 'VIEWER', 'BILLING_MANAGER')),
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'INACTIVE')),
    invited_by UUID REFERENCES members(id),
    invited_at TIMESTAMP,
    joined_at TIMESTAMP,
    last_login_at TIMESTAMP,
    email_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for members table
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_organization_email ON members(organization_id, email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_organization_stellar_pubkey ON members(organization_id, stellar_public_key) WHERE stellar_public_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_members_organization_id ON members(organization_id);
CREATE INDEX IF NOT EXISTS idx_members_role ON members(role);
CREATE INDEX IF NOT EXISTS idx_members_status ON members(status);
CREATE INDEX IF NOT EXISTS idx_members_invited_by ON members(invited_by);

-- Create trigger to update updated_at timestamp
CREATE TRIGGER update_members_updated_at 
    BEFORE UPDATE ON members 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();
