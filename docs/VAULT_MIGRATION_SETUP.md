# Vault Integration for Database Migration Credentials

This document outlines the setup for HashiCorp Vault integration to securely manage database migration credentials.

## Overview

The migration initContainer requires elevated database privileges to execute schema changes. These credentials should never be hardcoded in the Docker image or Helm values. Instead, we use Vault to dynamically provide credentials with the necessary permissions.

## Prerequisites

- HashiCorp Vault deployed in your Kubernetes cluster
- Vault Kubernetes authentication configured
- Database secrets engine enabled

## Vault Policy for Migration

Create a Vault policy with the necessary permissions for database migrations:

```hcl
# File: vault-policy-migration.hcl
path "database/creds/migration" {
  capabilities = ["read"]
}

path "sys/leases/renew" {
  capabilities = ["update"]
}

path "sys/leases/lookup" {
  capabilities = ["read"]
}
```

## Database Role Configuration

Configure the database secrets engine with a migration role that has elevated privileges:

```bash
# Enable database secrets engine (if not already enabled)
vault secrets enable database

# Configure PostgreSQL database connection
vault write database/config/substream-prod \
  plugin_name=postgresql-database-plugin \
  connection_url="postgresql://{{username}}:{{password}}@postgres-prod:5432/substream" \
  allowed_roles="migration,app"

# Create migration role with elevated privileges
vault write database/roles/migration \
  db_name=substream-prod \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; \
    GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO \"{{name}}\"; \
    GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO \"{{name}}\"; \
    GRANT CREATE ON SCHEMA public TO \"{{name}}\"; \
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO \"{{name}}\";" \
  default_ttl="1h" \
  max_ttl="24h"
```

## Kubernetes Authentication Setup

Configure Vault to authenticate Kubernetes service accounts:

```bash
# Enable Kubernetes authentication
vault auth enable kubernetes

# Configure Kubernetes authentication
vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc:443" \
  kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt

# Create role for migration service account
vault write auth/kubernetes/role/substream-migration \
  bound_service_account_names=substream-backend-migration \
  bound_service_account_namespaces=substream \
  policies=migration \
  ttl=1h
```

## Helm Chart Configuration

Update your Helm values to enable Vault integration:

```yaml
migration:
  enabled: true
  strategy: "initContainer"
  vault:
    enabled: true
    role: "substream-migration"
    secretPath: "database/creds/migration"
    address: "http://vault:8200"
```

## Service Account Annotation

Annotate the service account to allow Vault authentication:

```yaml
serviceAccount:
  create: true
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::ACCOUNT_ID:role/vault-auth-role"
  name: ""
```

## Environment Variables in InitContainer

The initContainer will receive the following environment variables when Vault is enabled:

- `VAULT_ADDR`: Vault server address
- `VAULT_ROLE`: Kubernetes authentication role
- `VAULT_SECRET_PATH`: Path to database credentials
- `DATABASE_URL`: Dynamically fetched from Vault

## Security Considerations

1. **Least Privilege**: The migration role should only have permissions needed for schema changes
2. **Short TTL**: Credentials should have a short TTL (1 hour default)
3. **Rotation**: Enable automatic credential rotation
4. **Audit Logging**: Enable Vault audit logging for all credential access
5. **Namespace Isolation**: Use separate Vault namespaces for different environments

## Testing Vault Integration

Test the Vault integration locally:

```bash
# Set Vault address
export VAULT_ADDR="http://vault:8200"

# Login with Kubernetes auth
vault write auth/kubernetes/login role=substream-migration jwt=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)

# Retrieve database credentials
vault read database/creds/migration
```

## Troubleshooting

### Migration fails with "permission denied"

- Verify the Vault policy has `read` access to `database/creds/migration`
- Check that the database role has sufficient privileges (CREATE, ALTER, etc.)
- Ensure the service account has the correct Vault role annotation

### Credentials expire during migration

- Increase the `default_ttl` and `max_ttl` for the database role
- Implement credential renewal in the migration script
- Break long-running migrations into smaller batches

### Vault authentication fails

- Verify the Kubernetes auth method is properly configured
- Check that the service account name matches the Vault role binding
- Ensure the service account token is mounted in the pod
