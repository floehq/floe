# Key Management & Disaster Recovery Plan

## 1. Key Hierarchy

| Key / Secret | Purpose | Backend | Storage | Rotation Cadence | Compromise Impact |
|---|---|---|---|---|---|
| `SUI_PRIVATE_KEY` (Ed25519) | Signs Sui tx (env signer mode) | `EnvSuiSigner` | Env var / secrets manager | Every 90 days or on personnel change | Attacker can sign arbitrary Sui tx, drain gas coins, create/ modify file metadata |
| `FLOE_KMS_KEY_ID` + KMS key | Signs Sui tx (KMS signer mode) | `KmsSuiSigner` | AWS KMS (key never leaves HSM) | Every 180 days (key rotation) or on incident | Same as above, but key material stays in KMS |
| `FLOE_AUTH_TOKEN_SECRET` | HMAC-signs delegated JWT tokens | `token` auth provider | Env var | Every 90 days | Forge arbitrary auth tokens, access any upload/file |
| `FLOE_API_KEYS_JSON` | Static API key list | `EnvApiKeyStore` | Env var (JSON array) | On key revocation/rotation | Unauthorized API access at key's permission level |
| Postgres API key hashes | Long-lived API keys (hashed) | `PostgresApiKeyStore` | `api_keys` table | On key revocation/rotation | Unauthorized API access at key's permission level |
| `FLOE_S3_ACCESS_KEY_ID` | S3/R2/MinIO chunk staging | S3 client library | Env var | Every 90 days | Read/write access to staging bucket, can corrupt or exfiltrate in-flight uploads |
| `FLOE_S3_SECRET_ACCESS_KEY` | S3/R2/MinIO chunk staging | S3 client library | Env var | Every 90 days | Same as above |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis auth | Upstash Redis | Env var | Every 90 days | Read/write access to upload state, finalize queue, session data |
| `DATABASE_URL` | Postgres connection | `pg` pool | Env var (contains password) | On credential rotation | Full read/write access to file metadata, API key hashes, event log |
| `FLOE_AUTH_EXTERNAL_SHARED_SECRET` | SaaS verifier auth | External auth provider | Env var | Every 90 days | Impersonate Floe to external auth verifier |
| `FLOE_AUTH_EXTERNAL_AUTH_TOKEN` | Bearer token for verifier calls | External auth provider | Env var | Every 90 days | Access external auth verifier API |
| `FLOE_METRICS_TOKEN` | `/metrics` endpoint auth | Health/metrics | Env var | Every 90 days | Access operational metrics (info disclosure) |
| Gas coins on Sui signer address | SUI to pay for tx gas | Sui chain | On-chain balance | Continuous (monitor + top up) | Cannot finalize file metadata until replenished |

### Key classification

- **Critical** (compromise enables persistent unauthorized access or data loss): `SUI_PRIVATE_KEY`, KMS key, `FLOE_AUTH_TOKEN_SECRET`, S3 credentials
- **High** (compromise enables broad but limited access): Postgres DB credentials, Redis tokens, API key store
- **Medium** (compromise enables information disclosure or targeted abuse): `FLOE_AUTH_EXTERNAL_SHARED_SECRET`, `FLOE_AUTH_EXTERNAL_AUTH_TOKEN`, `FLOE_METRICS_TOKEN`

---

## 2. Key Rotation Procedures

### 2.1 Sui Env Signer (`SUI_PRIVATE_KEY`)

```
1. Generate new Ed25519 keypair
   $ sui keytool generate ed25519

   Or programmatically:
   $ node -e "const { Ed25519Keypair } = require('@mysten/sui/keypairs/ed25519'); \
     const kp = Ed25519Keypair.generate(); \
     console.log('Address:', kp.getPublicKey().toSuiAddress()); \
     console.log('Private key (suiprivkey format):', kp.getSecretKey())"

2. Transfer minimal SUI gas to the new address
   $ sui client pay --recipients <NEW_ADDRESS> --amounts <GAS_AMOUNT> \
     --gas-budget 10000000

3. Deploy new env var to production
   - Update secrets manager / env config with new SUI_PRIVATE_KEY
   - Do NOT remove the old key yet

4. Rolling restart of API instances
   - Restart one instance first, verify /health and a test finalize
   - Roll to remaining instances

5. Verify on-chain operations
   - Confirm a test file finalize succeeds via the new signer
   - Check signer balance via /health or getBalance()

6. Decommission old key
   - Transfer remaining gas from old address to new address
   - Remove old SUI_PRIVATE_KEY from secrets manager
   - Revoke any associated permissions

Rollback: Keep old SUI_PRIVATE_KEY in secrets manager for 72h.
Switch back by redeploying the old value and restarting.
```

### 2.2 Sui KMS Signer

```
1. Create new KMS Ed25519 key
   $ aws kms create-key --key-spec ECC_NIST_EDWARDS25519 \
     --key-usage SIGN_VERIFY --description "Floe signing key YYYY-MM-DD"

2. Derive Sui address from new KMS public key
   $ aws kms get-public-key --key-id <NEW_KEY_ID> --output json
   Then run deriveAddress() from sui.signer.kms.ts to compute the Sui address:
     SHA3-256(0x00 || rawPubKey)[0..32]

3. Transfer SUI gas to the new address (same as env signer step 2)

4. Update FLOE_KMS_KEY_ID and FLOE_SIGNER_ADDRESS in env config
   - Point to new key ID/ARN and derived address

5. Rolling restart (same as env signer step 4)

6. Verify on-chain operations (same as env signer step 5)

7. Decommission old KMS key
   - Schedule deletion: aws kms schedule-key-deletion --key-id <OLD_KEY_ID> --pending-window-in-days 7
   - Keep the old key material available for 7 days in case rollback is needed

Rollback: Restore old FLOE_KMS_KEY_ID/FLOE_SIGNER_ADDRESS and restart.
Cancel KMS deletion: aws kms cancel-key-deletion --key-id <OLD_KEY_ID>
```

### 2.3 `FLOE_AUTH_TOKEN_SECRET`

```
1. Generate new secret (32+ bytes, high entropy)
   $ node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

2. Update env var in all environments
   - Simultaneously update all instances (no rollout window needed)

3. Verify token-based auth still works
   - Issue a test JWT with new secret and call an authenticated endpoint

Note: All previously issued tokens become invalid immediately.
Use a token refresh flow to re-issue tokens to clients.
```

### 2.4 S3 Credentials

```
1. Generate new access key in S3-compatible provider

2. Update FLOE_S3_ACCESS_KEY_ID and FLOE_S3_SECRET_ACCESS_KEY

3. Rolling restart

4. Verify chunk upload and GC operations

5. Decommission old access key after 24h of monitored health
```

### 2.5 Upstash Redis Token

```
1. Rotate token in Upstash console

2. Update UPSTASH_REDIS_REST_TOKEN in env config

3. Rolling restart

4. Verify Redis connectivity via /health

5. Old token can be revoked in Upstash after all instances restart
```

---

## 3. Disaster Recovery

### 3.1 Signer Goes Offline

**KMS unavailable:**
```
Symptoms:
  - Sui finalize failures spike
  - Logs show KMS Sign/GetPublicKey timeouts or throttling
  - /health may show DEGRADED from finalize backlog

Actions:
  1. Check AWS KMS service health and regional status
  2. Verify IAM role permissions (kms:Sign, kms:GetPublicKey)
  3. Check KMS request quota (default 5,500 req/s per Region)
  4. Consider switching to env signer as emergency fallback:
     a. Export the KMS private key (not possible for Ed25519 - KMS only)
     b. OR deploy SUI_PRIVATE_KEY and set FLOE_SIGNER_BACKEND=env
     c. This requires a pre-registered env signer address with gas
  5. If KMS is permanently unavailable, create new KMS key and update config
  6. Requeue stuck finalize jobs (automatic on restart)

Prevention:
  - Configure KMS multi-Region keys (future enhancement)
  - Implement circuit breaker (FLOE_CB_SUI_FAILURE_THRESHOLD default 3)
  - Use a different KMS region as fallback
```

**Env signer key lost:**
```
Symptoms:
  - Startup fails: "SUI_PRIVATE_KEY is not set"
  - Or: "Unrecognized SUI_PRIVATE_KEY format"

Actions:
  1. Restore from secrets manager backup
  2. If key is irrecoverable, the signer address is dead
     - Funds on the old address are permanently inaccessible
     - All future finalize ops must use a new key
  3. Generate new key (section 2.1)
  4. The old address's on-chain FileMeta objects remain readable
     - They were created by the old signer and are immutable
     - No migration needed for existing metadata

Prevention:
  - Store SUI_PRIVATE_KEY in a secrets manager (AWS Secrets Manager, Vault)
  - Never store the only copy in plaintext
  - Document the derived address + private key fingerprint for recovery verification
```

### 3.2 Gas Coin Runs Out

```
Symptoms:
  - Sui finalize failures with "InsufficientGas" or "coin balance too low"
  - /health may show DEGRADED

Actions:
  1. Check signer balance:
     $ sui client gas --address <SIGNER_ADDRESS>
     Or via Floe /health endpoint

  2. Transfer SUI from operational wallet:
     $ sui client pay --recipients <SIGNER_ADDRESS> \
       --amounts <TOPUP_AMOUNT> --gas-budget 10000000

  3. Verify finalize resumes automatically

Prevention:
  - Set up balance monitoring and alerting (see section 4)
  - Maintain a dedicated operational wallet with sufficient SUI reserves
  - Consider auto-top-up from a cold wallet at a configurable threshold
```

### 3.3 Sui Private Key Compromised

```
Incident classification: CRITICAL

Immediate actions (within 15 minutes):
  1. Revoke the compromised key's ability to sign
     - If env signer: immediately rotate SUI_PRIVATE_KEY (section 2.1)
     - If KMS signer: disable KMS key (aws kms disable-key)
  2. Transfer any remaining gas to a new secure address
  3. Assess scope of unauthorized transactions on-chain

Investigation:
  1. Check Sui explorer for the signer address transaction history
     - Look for unexpected FileMeta creations or modifications
     - Look for gas coin transfers to unknown addresses
  2. Review Floe audit logs for suspicious finalize activity
  3. Check if any blobId/reference was minted to unknown FileMeta objects

Recovery:
  1. Deploy new signer key (section 2.1 or 2.2)
  2. If unauthorized FileMeta objects were created:
     a. Identify all affected blobIds
     b. Assess content impact (data was already on Walrus, metadata was forged)
     c. No on-chain deletion is possible; consider off-chain blocklist
  3. Rotate all other credentials (defense in depth)
  4. Post-incident review and update of key management procedures

Note: On Sui, transactions are signed by the sender's key.
A compromised private key allows the attacker to:
  - create new FileMeta objects (minting)
  - update existing FileMeta fields (if the contract permits)
  - drain gas from the signer address
The attacker CANNOT:
  - delete FileMeta objects (if the contract restricts deletion)
  - access Walrus blob data through the key alone
  - access Floe API endpoints without an API key or token
```

### 3.4 Postgres API Key Store Corrupted

```
Symptoms:
  - Auth failures for all Postgres-backed API keys
  - API key admin operations failing

Actions:
  1. Fail open or fail closed? Depends on access policy
     - If FLOE_ACCESS_POLICY=private, auth failures block ALL requests
     - Immediately switch to env-backed keys:
       FLOE_API_KEY_STORE=env with FLOE_API_KEYS_JSON containing emergency keys
  2. Restore api_keys table from backup
  3. If restoration fails, re-create keys via POST /ops/api-keys
     - This changes key secrets; coordinate with clients

Prevention:
  - Regular Postgres backups
  - Maintain a current FLOE_API_KEYS_JSON as emergency override source of truth
```

### 3.5 Redis Data Loss During Finalization

```
Symptoms:
  - In-progress finalize jobs lose state
  - Upload sessions disappear
  - /health shows Redis unavailable or finalize queue empty when it should not be

Actions:
  1. Redis data loss is NOT catastrophic for uploaded content
     - Walrus blobs are already published (finalize committed after publish)
     - S3/disk chunks are still in staging
     - Only in-flight finalize state is lost
  2. Startup recovery re-queues stuck finalizing uploads (built-in)
     - Startup scans tracked uploads
     - Requeues 'finalizing' and retryable-failed uploads
  3. If finalize state is partially lost:
     - Run GC to clean up orphaned upload sessions
     - Manually re-finalize any dangling uploads using stored chunk data
  4. Verify finalize queue depth recovers

Prevention:
  - Enable Redis persistence (RDB + AOF)
  - Use managed Redis (Upstash, ElastiCache) with automatic failover
```

---

## 4. Gas Management

### Strategy

Floe pays Sui gas for every `finalizeFileMetadata` and `renewFileMetadata` operation. Each call costs ~0.001–0.01 SUI depending on network conditions and transaction complexity.

### Monitoring

| Metric | Alert Threshold | Action |
|---|---|---|
| Signer SUI balance | < 10 SUI | Warn: top up within 24h |
| Signer SUI balance | < 1 SUI | Critical: immediate top-up needed |
| Failed finalize (insufficient gas) | Any occurrence | Auto-top-up or manual intervention |
| Daily gas spend | > 5 SUI/day | Review finalize volume and costs |

### Recommended Setup

1. **Maintain an operational wallet** with 100+ SUI that is not the signer address
2. **Scripted top-up**:
   ```bash
   #!/bin/bash
   THRESHOLD=10  # SUI
   TOPUP=50      # SUI
   SIGNER=0x<signer_address>
   OPS=0x<operational_wallet>

   BALANCE=$(sui client gas --address $SIGNER | grep -oP '[\d.]+(?= SUI)' | head -1)
   if (( $(echo "$BALANCE < $THRESHOLD" | bc -l) )); then
     sui client pay --recipients $SIGNER --amounts $TOPUP \
       --gas-budget 10000000 --sign-with-key-file /path/to/ops-key
   fi
   ```
3. **Alert on balance** via Prometheus metric (`floe_signer_balance`) or /health endpoint
4. **Estimate monthly gas** based on expected finalize volume × average tx cost

### Cost Estimation

Each Sui finalize transaction costs:
- **Testnet**: ~0.001 SUI (negligible, faucet can replenish)
- **Mainnet**: ~0.002–0.01 SUI depending on gas price

For 10,000 finalizes/month on mainnet: ~20–100 SUI/month
Budget 2–3x buffer: **50–300 SUI/month recommended reserve**

---

## 5. Backup Procedures

### What needs backing up

| Asset | Backup Method | Frequency | Retention |
|---|---|---|---|
| `SUI_PRIVATE_KEY` | Secrets manager (versioned) | On rotation | Indefinite (last 3 versions) |
| KMS key material | AWS KMS manages this; export is not supported | N/A | N/A |
| `FLOE_AUTH_TOKEN_SECRET` | Secrets manager | On creation/rotation | Indefinite |
| `FLOE_API_KEYS_JSON` | Version-controlled + secrets manager | On change | Last 5 versions |
| Postgres `api_keys` table | pg_dump | Daily | 30 days |
| Postgres file metadata index | pg_dump | Daily | 30 days |
| Sui FileMeta objects | On-chain (immutable by design) | Continuous | Indefinite |
| Walrus blob references | On-chain blob IDs | Continuous | Indefinite |
| Redis state | RDB/AOF snapshots | Hourly | 24h |
| Docker Compose / env config | Version-controlled (secrets redacted) | On change | Full git history |
| IAM policies / infra config | Version-controlled | On change | Full git history |

### Backup commands

```bash
# Postgres
pg_dump -h <host> -U floe -d floe --table=api_keys \
  > /backups/floe/api_keys_$(date +%Y%m%d).sql
pg_dump -h <host> -U floe -d floe --table=indexed_files \
  > /backups/floe/indexed_files_$(date +%Y%m%d).sql

# Redis (if self-hosted)
redis-cli SAVE
cp /var/lib/redis/dump.rdb /backups/floe/redis_$(date +%Y%m%d).rdb

# Environment (secrets redacted)
cp .env.production /backups/floe/env_$(date +%Y%m%d).env
```

### Restoration testing

Test restore from backup quarterly:
1. Spin up a staging environment
2. Restore Postgres dump and verify API key auth works
3. Verify Redis state is loadable
4. Confirm the Sui signer can still sign (test on testnet)

---

## 6. Incident Response Plan

### 6.1 Key Compromise Severity Matrix

| Scenario | Severity | Response SLA |
|---|---|---|
| `SUI_PRIVATE_KEY` leaked | CRITICAL | 15 min to contain |
| KMS key unauthorized access | CRITICAL | 15 min to contain |
| `FLOE_AUTH_TOKEN_SECRET` leaked | HIGH | 30 min to contain |
| S3 credentials leaked | HIGH | 30 min to contain |
| `FLOE_API_KEYS_JSON` leaked | MEDIUM | 1h to contain |
| Redis token leaked | MEDIUM | 1h to contain |
| `FLOE_METRICS_TOKEN` leaked | LOW | 24h to contain |

### 6.2 Compromise Response Playbook

```
Critical incident (e.g., SUI_PRIVATE_KEY leaked):

1. DETECT
   - Automated alert from secrets scanner (e.g., GitGuardian) or
     manual report of unauthorized on-chain transactions

2. CONTAIN (within 15 min)
   - Rotate the compromised key immediately (section 2.1 or 2.2)
   - If KMS: aws kms disable-key --key-id <ID>
   - If env: deploy new SUI_PRIVATE_KEY, restart
   - Transfer any remaining gas off the compromised address
   - Rotate ALL other credentials as precaution

3. ASSESS (within 1h)
   - Review on-chain transaction history from the compromised address
   - Check Floe logs for unauthorized finalize operations
   - Determine the leak vector (CI/CD logs, env dump, compromised dep)
   - Identify affected blobs or FileMeta objects

4. REMEDIATE
   - For forged FileMeta objects: off-chain blocklist
   - For unauthorized blob claims: document and assess data exposure
   - Patch the leak vector

5. POST-MORTEM (within 72h)
   - Root cause analysis
   - Update key management procedures
   - Improve detection mechanisms
   - Consider key ceremony improvements

High incident (e.g., FLOE_AUTH_TOKEN_SECRET leaked):

1. Rotate the secret immediately (section 2.3)
2. All previously issued tokens are invalidated
3. Notify clients to re-issue tokens
4. Investigate leak vector

Medium/Low incident:
   Follow the relevant rotation procedure (section 2)
   Document the incident and learnings
```

### 6.3 Communication Template

```
Subject: [SECURITY] Floe key rotation - <KEY_NAME>

Key: <KEY_NAME>
Action: Rotated at <TIMESTAMP>
Impact: <DESCRIPTION OF SERVICE IMPACT, IF ANY>
Duration: <DOWNTIME WINDOW>
Status: RESOLVED

If you experience auth failures, contact <ops-contact>.
```

---

## 7. Recommended Production Configuration

### Signer Choice: KMS vs Env

| Factor | KMS | Env |
|---|---|---|
| Key material location | AWS KMS HSM | Env var / secrets manager |
| Startup dependency | AWS KMS API | None (local only) |
| Latency per sign | ~50-100ms (network call) | ~0ms (local) |
| Operational complexity | Higher (IAM, region, quotas) | Lower |
| Audit trail | AWS CloudTrail (every Sign call) | None |
| Key rotation | AWS managed + manual | Manual |
| Cost | $1/key/month + $0.05/10k signs | Free |
| Geographic resilience | Single-region by default | N/A |

**Recommendation:**
- **Production (mainnet)**: Use **KMS**. The audit trail, HSM-backed key material, and IAM access controls are worth the operational overhead. The startup validation in `initSuiSigner()` already fails loudly if KMS is unreachable.
- **Production (testnet) or staging**: Use **env signer**. Simpler, faster startup, and testnet funds have negligible value.
- **Local development**: Use **env signer**. Generate a keypair once with `sui keytool`.

### Minimum Viable Production Settings

```env
# --- Critical ---
FLOE_SIGNER_BACKEND=kms
FLOE_KMS_KEY_ID=alias/floe-signer-prod
FLOE_SIGNER_ADDRESS=0x<64-hex-chars>
FLOE_AUTH_TOKEN_SECRET=<32+ byte hex string>
FLOE_AUTH_PROVIDER=token
FLOE_ACCESS_POLICY=private

# --- Auth ---
FLOE_METRICS_TOKEN=<16+ char token>
FLOE_API_KEY_STORE=postgres
DATABASE_URL=postgresql://...

# --- Sui ---
FLOE_NETWORK=mainnet
SUI_PACKAGE_ID=0x<package-id>
SUI_RPC_URL=https://fullnode.mainnet.sui.io:443

# --- Walrus ---
WALRUS_AGGREGATOR_URL=https://aggregator.walrus-testnet.net
FLOE_WALRUS_STORE_MODE=sdk
FLOE_WALRUS_SDK_BASE_URL=https://publisher.walrus-testnet.net

# --- Redis ---
FLOE_REDIS_PROVIDER=upstash
UPSTASH_REDIS_REST_URL=https://<upstash-redis-url>
UPSTASH_REDIS_REST_TOKEN=<token>

# --- S3 ---
FLOE_CHUNK_STORE_MODE=s3
FLOE_S3_BUCKET=floe-chunks
FLOE_S3_REGION=us-east-1
FLOE_S3_ENDPOINT=https://s3.amazonaws.com
FLOE_S3_ACCESS_KEY_ID=<access-key>
FLOE_S3_SECRET_ACCESS_KEY=<secret-key>

# --- Operations ---
FLOE_NODE_ROLE=full
UPLOAD_TMP_DIR=/var/lib/floe/upload
NODE_ENV=production
PORT=3001
```

### Required IAM Policy for KMS Mode

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "kms:Sign",
        "kms:GetPublicKey"
      ],
      "Resource": "arn:aws:kms:REGION:ACCOUNT:key/KEY_ID"
    }
  ]
}
```

---

## Appendix

### A. Deriving Sui Address from KMS Public Key

```typescript
import { createHash } from "node:crypto";

function deriveSuiAddress(publicKeyBytes: Uint8Array): string {
  const flagAndKey = Buffer.concat([
    Buffer.from([0x00]), // Ed25519 flag byte
    Buffer.from(publicKeyBytes),
  ]);
  const hash = createHash("sha3-256").update(flagAndKey).digest();
  return "0x" + hash.toString("hex");
}
```

### B. Checking Signer Balance

```bash
# Via Sui CLI
sui client gas --address 0x<SIGNER_ADDRESS>

# Via Floe /health (when health exposes balance)
curl -s http://localhost:3001/health | jq '.checks.suiSigner'
```

### C. Emergency Env Signer Deployment

```bash
# Generate a temporary env signer keypair
docker run --rm node:24-alpine node -e "
  const { Ed25519Keypair } = require('@mysten/sui/keypairs/ed25519');
  const kp = Ed25519Keypair.generate();
  console.log('Address:', kp.getPublicKey().toSuiAddress());
  console.log('Private key:', kp.getSecretKey());
"

# Deploy to production secrets manager, set FLOE_SIGNER_BACKEND=env
# Transfer gas from operational wallet to the new address
```
