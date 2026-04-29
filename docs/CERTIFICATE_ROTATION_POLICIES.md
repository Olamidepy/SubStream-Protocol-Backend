# Certificate Rotation Policies for Istio Service Mesh

**Document Version:** 1.0  
**Last Updated:** 2026-04-26  
**Service Mesh:** Istio 1.18+

---

## Overview

This document defines the certificate rotation policies for the Istio service mesh control plane, ensuring continuous security while maintaining service availability. Istio Citadel (now part of istiod) automatically manages certificate lifecycle for all workloads in the mesh.

---

## Certificate Lifecycle

### Istio-Managed Certificates

Istio uses a built-in Certificate Authority (Citadel) to issue workload certificates. These certificates are:

- **Validity:** 24 hours (default)
- **Rotation:** Automatic before expiration
- **Format:** X.509
- **Key Type:** RSA 2048 or ECDSA P-256
- **Trust Domain:** substream.local

### Certificate Hierarchy

```
Root CA (Istio Citadel)
├── Intermediate CA (per namespace)
├── Workload Certificates (per pod)
│   ├── Backend Service
│   ├── Worker Service
│   ├── Soroban Indexer
│   └── PostgreSQL
└── Gateway Certificates
    ├── Ingress Gateway
    └── Egress Gateway
```

---

## Automatic Rotation

### Default Behavior

Istio automatically rotates workload certificates without manual intervention:

**Timeline:**
- **Certificate Issued:** T0
- **Certificate Expires:** T0 + 24 hours
- **Rotation Triggered:** T0 + 22 hours (2 hours before expiration)
- **New Certificate Issued:** T0 + 22 hours
- **Old Certificate Revoked:** T0 + 24 hours

**Process:**
1. Istio sidecar agent checks certificate expiration every 10 seconds
2. When certificate approaches expiration (within 2 hours), agent requests new certificate
3. Citadel issues new certificate with updated validity period
4. Sidecar agent rotates certificates without dropping connections
5. Old certificate is gracefully phased out

**Configuration:**
```yaml
apiVersion: security.istio.io/v1beta1
kind: MeshConfig
metadata:
  name: mesh-config
spec:
  trustDomain: substream.local
  certificateRotationFrequency: 24h
  certificateExpiryGracePeriod: 2h
```

### Verification

**Check certificate expiration:**
```bash
# Get workload certificate
kubectl exec -it <pod-name> -n substream -- \
  openssl x509 -in /etc/certs/cert-chain.pem -noout -dates

# Check Istio agent status
kubectl exec -it <pod-name> -n substream -- \
  /usr/local/bin/pilot-agent request GET /healthz/ready
```

**Monitor rotation events:**
```bash
# Check Istiod logs for certificate issuance
kubectl logs -n istio-system -l app=istiod --tail=100 | grep -i certificate

# Check sidecar agent logs
kubectl logs -n substream <pod-name> -c istio-proxy --tail=100 | grep -i certificate
```

---

## Manual Rotation

### Root CA Rotation

**Scenario:** Root CA compromise or policy change (every 12 months recommended)

**Procedure:**

1. **Generate new Root CA:**
```bash
# Create new CA key and certificate
openssl ecparam -genkey -name prime256v1 -out new-ca.key
openssl req -x509 -new -nodes -key new-ca.key -sha256 -days 3650 \
  -out new-ca.crt \
  -subj "/C=US/ST=CA/L=San Francisco/O=SubStream/CN=substream-root-ca-new"
```

2. **Create new intermediate CA:**
```bash
openssl ecparam -genkey -name prime256v1 -out new-intermediate.key
openssl req -new -key new-intermediate.key -out new-intermediate.csr \
  -subj "/C=US/ST=CA/L=San Francisco/O=SubStream/CN=substream-intermediate-ca-new"
openssl x509 -req -in new-intermediate.csr -CA new-ca.crt -CAkey new-ca.key \
  -CAcreateserial -out new-intermediate.crt -days 1825 -sha256
```

3. **Update Istio configuration:**
```bash
# Create secret with new CA
kubectl create secret generic cacerts -n istio-system \
  --from-file=ca.crt=new-ca.crt \
  --from-file=ca.key=new-ca.key \
  --from-file=cert-chain.pem=new-intermediate.crt \
  --from-file=key.pem=new-intermediate.key

# Restart Istiod to pick up new CA
kubectl rollout restart deployment istiod -n istio-system
```

4. **Rolling restart workloads:**
```bash
# Restart all pods to get new certificates
kubectl rollout restart deployment substream-backend -n substream
kubectl rollout restart deployment substream-worker -n substream
kubectl rollout restart deployment soroban-indexer -n substream
kubectl rollout restart statefulset postgres -n substream
```

5. **Verify new certificates:**
```bash
# Check that pods have new certificates
kubectl exec -it <pod-name> -n substream -- \
  openssl x509 -in /etc/certs/cert-chain.pem -noout -issuer
```

6. **Remove old CA (after 30 days):**
```bash
# Once all workloads are using new CA, remove old CA secret
kubectl delete secret cacerts-old -n istio-system
```

### Workload Certificate Force Rotation

**Scenario:** Compromised workload or immediate security concern

**Procedure:**

1. **Delete workload pod:**
```bash
kubectl delete pod <pod-name> -n substream
```

2. **Pod will be recreated with new certificate:**
```bash
# Verify new certificate
kubectl exec -it <new-pod-name> -n substream -- \
  openssl x509 -in /etc/certs/cert-chain.pem -noout -serial
```

3. **For all workloads in namespace:**
```bash
kubectl delete pods -n substream -l app=substream-backend
kubectl delete pods -n substream -l app=substream-worker
kubectl delete pods -n substream -l app=soroban-indexer
```

---

## External CA Integration

### Production Recommendation

For production, use an external CA (e.g., cert-manager, HashiCorp Vault) instead of Istio's built-in CA.

### cert-manager Integration

**Install cert-manager:**
```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.13.0/cert-manager.yaml
```

**Configure Istio to use cert-manager:**
```yaml
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
metadata:
  name: istio-control-plane
  namespace: istio-system
spec:
  values:
    global:
      caAddress: cert-manager.istio-system.svc
```

**Create Issuer:**
```yaml
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: istio-ca
  namespace: istio-system
spec:
  ca:
    secretName: istio-ca-secret
```

### HashiCorp Vault Integration

**Configure Vault as CA:**
```yaml
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
metadata:
  name: istio-control-plane
  namespace: istio-system
spec:
  values:
    global:
      caAddress: vault.vault-system.svc:8200
      caCert: /etc/vault/ca.crt
```

**Vault PKI configuration:**
```bash
# Enable PKI secrets engine
vault secrets enable pki

# Configure PKI
vault write pki/config/cluster \
  max_lease_ttl=87600h

# Create intermediate CA
vault secrets tune -max-lease-ttl=43800h pki
vault write pki/intermediate/generate/internal \
  common_name="SubStream Intermediate CA" \
  ttl=43800h
```

---

## PostgreSQL Certificate Rotation

### Server Certificates

**Rotation Schedule:** Every 90 days

**Procedure:**

1. **Generate new server certificate:**
```bash
# Generate new private key
openssl ecparam -genkey -name prime256v2 -out postgres-server-new.key

# Generate CSR
openssl req -new -key postgres-server-new.key -out postgres-server-new.csr \
  -subj "/C=US/ST=CA/L=San Francisco/O=SubStream/CN=postgres.substream.svc"

# Sign with CA
openssl x509 -req -in postgres-server-new.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out postgres-server-new.crt -days 90 -sha256
```

2. **Update Kubernetes secret:**
```bash
kubectl create secret tls postgres-server-certs-new \
  --cert=postgres-server-new.crt \
  --key=postgres-server-new.key \
  --ca-file=ca.crt \
  -n substream
```

3. **Rolling update PostgreSQL:**
```bash
kubectl patch statefulset postgres -n substream -p \
  '{"spec":{"template":{"spec":{"volumes":[{"name":"postgres-certs","secret":{"secretName":"postgres-server-certs-new"}}]}}}}'

kubectl rollout restart statefulset postgres -n substream
```

4. **Verify new certificate:**
```bash
kubectl exec -it postgres-0 -n substream -- \
  openssl s_client -connect localhost:5432 -showcerts
```

### Client Certificates

**Rotation Schedule:** Every 90 days

**Procedure:**

1. **Generate new client certificate:**
```bash
# Generate new client key
openssl ecparam -genkey -name prime256v2 -out postgres-client-new.key

# Generate CSR
openssl req -new -key postgres-client-new.key -out postgres-client-new.csr \
  -subj "/C=US/ST=CA/L=San Francisco/O=SubStream/CN=substream-backend"

# Sign with CA
openssl x509 -req -in postgres-client-new.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out postgres-client-new.crt -days 90 -sha256
```

2. **Update Kubernetes secret:**
```bash
kubectl create secret tls postgres-client-certs-new \
  --cert=postgres-client-new.crt \
  --key=postgres-client-new.key \
  --ca-file=ca.crt \
  -n substream
```

3. **Rolling update workloads:**
```bash
kubectl patch deployment substream-backend -n substream -p \
  '{"spec":{"template":{"spec":{"volumes":[{"name":"postgres-client-certs","secret":{"secretName":"postgres-client-certs-new"}}]}}}}'

kubectl rollout restart deployment substream-backend -n substream
kubectl rollout restart deployment substream-worker -n substream
```

---

## Prometheus Certificate Rotation

**Rotation Schedule:** Every 90 days

**Procedure:**

1. **Generate new Prometheus client certificate:**
```bash
# Generate new client key
openssl ecparam -genkey -name prime256v2 -out prometheus-client-new.key

# Generate CSR
openssl req -new -key prometheus-client-new.key -out prometheus-client-new.csr \
  -subj "/C=US/ST=CA/L=San Francisco/O=SubStream/CN=prometheus"

# Sign with Istio CA
openssl x509 -req -in prometheus-client-new.csr -CA istio-ca.crt -CAkey istio-ca.key \
  -CAcreateserial -out prometheus-client-new.crt -days 90 -sha256
```

2. **Update Kubernetes secret:**
```bash
kubectl create secret tls prometheus-certs-new \
  --cert=prometheus-client-new.crt \
  --key=prometheus-client-new.key \
  --ca-file=istio-ca.crt \
  -n monitoring
```

3. **Rolling update Prometheus:**
```bash
kubectl patch deployment prometheus -n monitoring -p \
  '{"spec":{"template":{"spec":{"volumes":[{"name":"prometheus-certs","secret":{"secretName":"prometheus-certs-new"}}]}}}}'

kubectl rollout restart deployment prometheus -n monitoring
```

---

## Monitoring and Alerting

### Certificate Expiration Monitoring

**Prometheus Alert:**
```yaml
groups:
- name: certificate_expiry
  rules:
  - alert: CertificateExpiringSoon
    expr: |
      istio_certificate_expiration_timestamp_seconds < (time() + 86400 * 7)
    for: 1h
    labels:
      severity: warning
    annotations:
      summary: "Certificate expiring soon"
      description: "Certificate for {{ $labels.service }} expires in less than 7 days"
  
  - alert: CertificateExpired
    expr: |
      istio_certificate_expiration_timestamp_seconds < time()
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "Certificate expired"
      description: "Certificate for {{ $labels.service }} has expired"
```

### Rotation Failure Monitoring

**Alert on rotation failures:**
```yaml
- alert: CertificateRotationFailed
  expr: |
    rate(istio_agent_certificate_rotation_failure_total[5m]) > 0
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "Certificate rotation failed"
    description: "Certificate rotation failed for {{ $labels.service }}"
```

---

## Rollback Procedures

### Failed Rotation Rollback

**If rotation causes issues:**

1. **Identify problematic change:**
```bash
kubectl rollout status deployment substream-backend -n substream
```

2. **Rollback to previous revision:**
```bash
kubectl rollout undo deployment substream-backend -n substream
```

3. **Restore old certificates:**
```bash
kubectl patch secret postgres-server-certs -n substream \
  --from-file=tls.crt=postgres-server-old.crt \
  --from-file=tls.key=postgres-server-old.key
```

4. **Restart workloads:**
```bash
kubectl rollout restart deployment substream-backend -n substream
```

---

## Compliance

### SOC 2 Requirements

- **Certificate Management:** Automated rotation with audit logging
- **Key Management:** Secure key storage in Kubernetes secrets
- **Monitoring:** Certificate expiration alerts
- **Incident Response:** Rollback procedures documented

### ISO 27001 Requirements

- **Cryptography:** Certificate lifecycle management
- **Access Control:** Certificate-based authentication
- **Operations Management:** Automated rotation procedures
- **Supplier Relationships:** External CA integration for production

---

## References

- [Istio Certificate Management](https://istio.io/latest/docs/concepts/security/cert-mgmt/)
- [Istio PKI](https://istio.io/latest/docs/concepts/security/pki/)
- [PostgreSQL SSL](https://www.postgresql.org/docs/current/ssl-tcp.html)
- [cert-manager](https://cert-manager.io/)
- [HashiCorp Vault PKI](https://developer.hashicorp.com/vault/docs/secrets/pki)

---

**Document Classification:** Confidential  
**Next Review:** 2026-10-26 (6 months)
