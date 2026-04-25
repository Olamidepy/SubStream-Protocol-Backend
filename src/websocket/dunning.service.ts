import { Injectable, Logger } from '@nestjs/common';

export interface PaymentFailedPayload {
  stellarPublicKey: string;
  planId: string;
  userId: string;
  failureReason: string;
  timestamp: string;
  deepLinkRef: string;
}

export interface BatchedPaymentFailedPayload {
  stellarPublicKey: string;
  failures: PaymentFailedPayload[];
  batchId: string;
  timestamp: string;
  totalCount: number;
}

@Injectable()
export class DunningService {
  private readonly logger = new Logger(DunningService.name);
  private readonly BATCH_SIZE = 10; // Batch if more than 10 failures per second
  private readonly BATCH_WINDOW = 1000; // 1 second window
  private failureBatches = new Map<string, PaymentFailedPayload[]>();
  private batchTimers = new Map<string, NodeJS.Timeout>();

  async processPaymentFailure(payload: PaymentFailedPayload): Promise<BatchedPaymentFailedPayload | PaymentFailedPayload | null> {
    const merchantKey = payload.stellarPublicKey;
    
    // Add to batch for this merchant
    if (!this.failureBatches.has(merchantKey)) {
      this.failureBatches.set(merchantKey, []);
    }
    
    const batch = this.failureBatches.get(merchantKey)!;
    batch.push(payload);

    // Clear existing timer for this merchant
    const existingTimer = this.batchTimers.get(merchantKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // If batch size exceeded, emit immediately
    if (batch.length >= this.BATCH_SIZE) {
      this.logger.log(`Batch threshold reached for merchant ${merchantKey}, emitting ${batch.length} failures`);
      const batchedPayload = this.createBatchedPayload(merchantKey, batch);
      this.clearBatch(merchantKey);
      return batchedPayload;
    }

    // Set timer to emit after window expires
    const timer = setTimeout(() => {
      if (this.failureBatches.has(merchantKey)) {
        const currentBatch = this.failureBatches.get(merchantKey)!;
        if (currentBatch.length > 0) {
          this.logger.log(`Batch window expired for merchant ${merchantKey}, emitting ${currentBatch.length} failures`);
          const batchedPayload = this.createBatchedPayload(merchantKey, currentBatch);
          // Emit to Redis for cross-pod distribution
          this.emitBatchedPayload(batchedPayload);
          this.clearBatch(merchantKey);
        }
      }
    }, this.BATCH_WINDOW);

    this.batchTimers.set(merchantKey, timer);

    // Return null for individual failures that are being batched
    return null;
  }

  private createBatchedPayload(merchantKey: string, failures: PaymentFailedPayload[]): BatchedPaymentFailedPayload {
    return {
      stellarPublicKey: merchantKey,
      failures: failures.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()),
      batchId: this.generateBatchId(),
      timestamp: new Date().toISOString(),
      totalCount: failures.length,
    };
  }

  private generateBatchId(): string {
    return `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private clearBatch(merchantKey: string) {
    this.failureBatches.delete(merchantKey);
    const timer = this.batchTimers.get(merchantKey);
    if (timer) {
      clearTimeout(timer);
      this.batchTimers.delete(merchantKey);
    }
  }

  private async emitBatchedPayload(payload: BatchedPaymentFailedPayload) {
    // This would be called by the gateway when needed
    // The actual Redis publishing is handled by the gateway
    this.logger.log(`Emitting batched payload for ${payload.stellarPublicKey}: ${payload.totalCount} failures`);
  }

  // Method to handle immediate high-priority failures (should not be batched)
  async processHighPriorityFailure(payload: PaymentFailedPayload): Promise<PaymentFailedPayload> {
    this.logger.log(`High priority failure for merchant ${payload.stellarPublicKey}, emitting immediately`);
    return payload;
  }

  // Method to check if a failure should be high priority
  isHighPriorityFailure(payload: PaymentFailedPayload): boolean {
    // Define high priority criteria
    const highPriorityReasons = [
      'INSUFFICIENT_FUNDS',
      'ACCOUNT_FROZEN',
      'ACCOUNT_SUSPENDED',
      'CRITICAL_SYSTEM_ERROR',
    ];
    
    return highPriorityReasons.includes(payload.failureReason);
  }

  // Get batch statistics for monitoring
  getBatchStats(): { activeBatches: number; totalQueuedFailures: number } {
    const activeBatches = this.failureBatches.size;
    const totalQueuedFailures = Array.from(this.failureBatches.values())
      .reduce((total, batch) => total + batch.length, 0);
    
    return { activeBatches, totalQueuedFailures };
  }

  // Cleanup method for graceful shutdown
  async cleanup() {
    this.logger.log('Cleaning up DunningService...');
    
    // Process any remaining batches
    for (const [merchantKey, batch] of this.failureBatches.entries()) {
      if (batch.length > 0) {
        this.logger.log(`Processing final batch for merchant ${merchantKey}: ${batch.length} failures`);
        const batchedPayload = this.createBatchedPayload(merchantKey, batch);
        await this.emitBatchedPayload(batchedPayload);
      }
    }
    
    // Clear all timers
    for (const timer of this.batchTimers.values()) {
      clearTimeout(timer);
    }
    
    this.failureBatches.clear();
    this.batchTimers.clear();
  }
}
