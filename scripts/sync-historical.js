#!/usr/bin/env node

const { program } = require('commander');
const cliProgress = require('cli-progress');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Import core services from your existing structure
const { loadConfig } = require('../src/config');
const { SorobanIndexerWorker } = require('../src/services/sorobanIndexerWorker'); // Adjust if path differs
const { getVaultService } = require('../src/services/vaultService');

// CLI Setup
program
  .name('sync:historical')
  .description('Historical backfill tool for SubStream Soroban subscription events')
  .option('--start-ledger <number>', 'Starting ledger sequence (inclusive)', parseInt)
  .option('--end-ledger <number>', 'Ending ledger sequence (inclusive)', parseInt)
  .option('--start <number>', 'Alias for --start-ledger', parseInt)
  .option('--end <number>', 'Alias for --end-ledger', parseInt)
  .option('--batch-size <number>', 'Number of events per DB batch', parseInt)
  .option('--contract-ids <string>', 'Comma-separated Soroban contract IDs to filter')
  .parse(process.argv);

const opts = program.opts();
const startLedger = opts.startLedger || opts.start;
const endLedger = opts.endLedger || opts.end;
const batchSize = opts.batchSize || 800; // Safe default to avoid overwhelming DB/RPC

if (!startLedger || !endLedger || startLedger > endLedger) {
  console.error('❌ Error: --start-ledger and --end-ledger are required and start must be <= end');
  console.error('Example: node scripts/sync-historical.js --start 45000000 --end 45100000');
  process.exit(1);
}

console.log(`🚀 SubStream Historical Backfill Started`);
console.log(`   Range: ${startLedger} → ${endLedger}`);
console.log(`   Batch size: ${batchSize} events\n`);

const progressBar = new cliProgress.SingleBar({
  format: 'Backfill Progress | {bar} | {percentage}% | Ledger {value}/{total} | ETA: {eta}s',
  barCompleteChar: '█',
  barIncompleteChar: '░',
  hideCursor: true
});

async function main() {
  let vaultService = null;
  let config = null;

  try {
    // Initialize Vault if enabled (same as your worker.js)
    if (process.env.VAULT_ENABLED === 'true') {
      vaultService = getVaultService({
        vaultAddr: process.env.VAULT_ADDR,
        vaultRole: process.env.VAULT_ROLE,
        authPath: process.env.VAULT_AUTH_PATH,
        secretPath: process.env.VAULT_SECRET_PATH,
        dbPath: process.env.VAULT_DB_PATH
      });
      await vaultService.initialize();
      console.log('[Vault] Secrets loaded successfully');
    }

    config = await loadConfig(process.env, vaultService);

    // Initialize the same SorobanIndexerWorker used in live indexing
    const indexer = new SorobanIndexerWorker(config);   // Pass config if constructor accepts it

    progressBar.start(endLedger - startLedger + 1, 0);

    let currentLedger = startLedger;
    let totalProcessed = 0;

    while (currentLedger <= endLedger) {
      const batchEnd = Math.min(currentLedger + 99, endLedger); // Fetch in safe ledger chunks (RPC limit friendly)

      console.log(`\nFetching events from ledger ${currentLedger} to ${batchEnd}...`);

      // Use the same method your SorobanIndexerWorker uses internally for fetching events
      const events = await fetchEventsInRange(indexer, currentLedger, batchEnd, opts.contractIds);

      if (events && events.length > 0) {
        // Push through the EXACT same ingestion pipeline as live events
        const processed = await processEventsThroughIndexer(indexer, events, batchSize);
        totalProcessed += processed;
        console.log(`   ✓ Processed ${processed} events`);
      } else {
        console.log(`   No relevant events in this range`);
      }

      progressBar.update(currentLedger - startLedger + 1);
      currentLedger = batchEnd + 1;
    }

    progressBar.stop();
    console.log(`\n✅ Historical backfill completed successfully!`);
    console.log(`   Total events processed: ${totalProcessed}`);
    console.log(`   Range: ${startLedger} - ${endLedger}`);

  } catch (error) {
    progressBar.stop();
    console.error('❌ Backfill failed:', error.message);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  } finally {
    if (vaultService) {
      try { await vaultService.cleanup(); } catch (e) {}
    }
  }
}

/**
 * Fetch events using the same Soroban RPC logic as your live indexer
 */
async function fetchEventsInRange(indexer, startLedger, endLedger, contractIdsStr) {
  try {
    // Prefer using internal method from SorobanIndexerWorker if exposed
    // Otherwise fall back to direct RPC call
    if (typeof indexer.fetchEvents === 'function') {
      return await indexer.fetchEvents({
        startLedger,
        endLedger,
        contractIds: contractIdsStr ? contractIdsStr.split(',') : (process.env.SUBSTREAM_CONTRACT_IDS || '').split(',')
      });
    }

    // Direct RPC fallback using soroban-client (you already have this dependency)
    const { Server } = require('soroban-client');
    const rpcUrl = process.env.SOROBAN_RPC_URL || config?.soroban?.rpcUrl || 'https://rpc.mainnet.stellar.org';
    const server = new Server(rpcUrl);

    const filters = [{
      type: 'contract',
      contractIds: contractIdsStr ? contractIdsStr.split(',') : [],
      // Add topic filters for subscription events if needed, e.g.:
      // topics: [[Buffer.from('subscribe').toString('base64')]]
    }];

    const response = await server.getEvents({
      startLedger: startLedger.toString(),
      endLedger: endLedger.toString(),
      filters,
      pagination: { limit: 5000 }   // High but safe limit
    });

    return response.events || [];
  } catch (err) {
    console.warn(`Warning: Failed to fetch events ${startLedger}-${endLedger}:`, err.message);
    return [];
  }
}

/**
 * Process events using the exact same ingestion pipeline as live SorobanIndexerWorker
 * This ensures full consistency and reuses all business logic + idempotency
 */
async function processEventsThroughIndexer(indexer, events, batchSize) {
  if (!events.length) return 0;

  let processedCount = 0;
  const chunks = chunkArray(events, batchSize);

  for (const chunk of chunks) {
    // If your SorobanIndexerWorker has a method like ingestEvents or processEventBatch, use it
    if (typeof indexer.processEvents === 'function') {
      await indexer.processEvents(chunk);
      processedCount += chunk.length;
    } 
    else if (typeof indexer.ingestEvent === 'function') {
      // Fallback: process one by one (slower but safe)
      for (const event of chunk) {
        try {
          await indexer.ingestEvent(event);   // This should contain your idempotency logic
          processedCount++;
        } catch (e) {
          console.warn('Failed to ingest single event:', e.message);
        }
      }
    } 
    else {
      console.error('Error: SorobanIndexerWorker does not expose processEvents or ingestEvent method.');
      console.error('Please expose a public method in SorobanIndexerWorker for batch ingestion.');
      process.exit(1);
    }
  }

  return processedCount;
}

function chunkArray(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

// Run the tool
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});