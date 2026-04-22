const { xdr } = require('@stellar/stellar-sdk');

/**
 * Soroban XDR Parser Utilities
 * Handles parsing of Soroban event XDR payloads into typed TypeScript objects
 */
class SorobanXdrParser {
  constructor(logger = console) {
    this.logger = logger;
    
    // Event type mappings
    this.eventTypes = {
      SubscriptionBilled: 'SubscriptionBilled',
      TrialStarted: 'TrialStarted', 
      PaymentFailed: 'PaymentFailed'
    };
  }

  /**
   * Parse Soroban event from XDR payload
   */
  parseEvent(event) {
    try {
      const parsed = {
        id: event.id,
        contractId: event.contractId,
        type: this.extractEventType(event),
        transactionHash: event.transactionHash,
        eventIndex: event.eventIndex || 0,
        ledgerSequence: event.ledgerSequence,
        ledgerTimestamp: event.ledgerTimestamp,
        rawXdr: event.body,
        parsedData: null,
        isValid: false,
        error: null
      };

      // Parse the XDR body
      const eventBody = xdr.ScVal.fromXDR(event.body, 'base64');
      parsed.parsedData = this.parseEventData(eventBody, parsed.type);
      parsed.isValid = true;

      return parsed;
    } catch (error) {
      this.logger.error('Failed to parse Soroban event', {
        eventId: event.id,
        error: error.message,
        rawXdr: event.body
      });

      return {
        id: event.id,
        contractId: event.contractId,
        type: 'Unknown',
        transactionHash: event.transactionHash,
        eventIndex: event.eventIndex || 0,
        ledgerSequence: event.ledgerSequence,
        ledgerTimestamp: event.ledgerTimestamp,
        rawXdr: event.body,
        parsedData: null,
        isValid: false,
        error: error.message
      };
    }
  }

  /**
   * Extract event type from XDR
   */
  extractEventType(event) {
    try {
      const eventBody = xdr.ScVal.fromXDR(event.body, 'base64');
      return this.extractEventTypeFromScVal(eventBody);
    } catch (error) {
      this.logger.warn('Failed to extract event type', {
        eventId: event.id,
        error: error.message
      });
      return 'Unknown';
    }
  }

  /**
   * Extract event type from ScVal
   */
  extractEventTypeFromScVal(scVal) {
    if (scVal.switch().name !== 'instance') {
      return 'Unknown';
    }

    const instanceVal = scVal.instance();
    
    // Handle different instance types
    switch (instanceVal.switch().name) {
      case 'vec':
        return this.extractEventTypeFromVec(instanceVal.vec());
      case 'map':
        return this.extractEventTypeFromMap(instanceVal.map());
      default:
        return 'Unknown';
    }
  }

  /**
   * Extract event type from vector
   */
  extractEventTypeFromVec(vec) {
    if (vec.length === 0) {
      return 'Unknown';
    }

    // First element is typically the event type symbol
    const firstVal = vec[0];
    if (firstVal.switch().name === 'symbol') {
      const symbol = firstVal.symbol().toString();
      
      // Map to known event types
      for (const [key, value] of Object.entries(this.eventTypes)) {
        if (symbol.toLowerCase().includes(key.toLowerCase())) {
          return value;
        }
      }
      
      return symbol;
    }

    return 'Unknown';
  }

  /**
   * Extract event type from map
   */
  extractEventTypeFromMap(map) {
    for (const entry of map) {
      const key = entry.key();
      if (key.switch().name === 'symbol') {
        const keyName = key.symbol().toString();
        if (keyName.toLowerCase() === 'type' || keyName.toLowerCase() === 'event_type') {
          const value = entry.val();
          if (value.switch().name === 'symbol') {
            return value.symbol().toString();
          }
        }
      }
    }

    return 'Unknown';
  }

  /**
   * Parse event data based on event type
   */
  parseEventData(scVal, eventType) {
    switch (eventType) {
      case 'SubscriptionBilled':
        return this.parseSubscriptionBilledEvent(scVal);
      case 'TrialStarted':
        return this.parseTrialStartedEvent(scVal);
      case 'PaymentFailed':
        return this.parsePaymentFailedEvent(scVal);
      default:
        return this.parseGenericEvent(scVal);
    }
  }

  /**
   * Parse SubscriptionBilled event
   */
  parseSubscriptionBilledEvent(scVal) {
    try {
      const data = this.extractEventFields(scVal);
      
      return {
        eventType: 'SubscriptionBilled',
        subscriberAddress: data.subscriber_address || data.wallet_address || data.address,
        creatorAddress: data.creator_address || data.creator,
        amount: this.parseAmount(data.amount),
        currency: data.currency || 'XLM',
        billingPeriod: data.billing_period || data.period,
        nextBillingDate: this.parseTimestamp(data.next_billing_date),
        subscriptionId: data.subscription_id || data.id,
        metadata: data.metadata || {}
      };
    } catch (error) {
      throw new Error(`Failed to parse SubscriptionBilled event: ${error.message}`);
    }
  }

  /**
   * Parse TrialStarted event
   */
  parseTrialStartedEvent(scVal) {
    try {
      const data = this.extractEventFields(scVal);
      
      return {
        eventType: 'TrialStarted',
        subscriberAddress: data.subscriber_address || data.wallet_address || data.address,
        creatorAddress: data.creator_address || data.creator,
        trialDuration: this.parseDuration(data.trial_duration || data.duration),
        trialEndDate: this.parseTimestamp(data.trial_end_date || data.end_date),
        subscriptionId: data.subscription_id || data.id,
        metadata: data.metadata || {}
      };
    } catch (error) {
      throw new Error(`Failed to parse TrialStarted event: ${error.message}`);
    }
  }

  /**
   * Parse PaymentFailed event
   */
  parsePaymentFailedEvent(scVal) {
    try {
      const data = this.extractEventFields(scVal);
      
      return {
        eventType: 'PaymentFailed',
        subscriberAddress: data.subscriber_address || data.wallet_address || data.address,
        creatorAddress: data.creator_address || data.creator,
        amount: this.parseAmount(data.amount),
        currency: data.currency || 'XLM',
        reason: data.reason || data.failure_reason,
        retryCount: this.parseNumber(data.retry_count || data.retries),
        nextRetryDate: this.parseTimestamp(data.next_retry_date),
        subscriptionId: data.subscription_id || data.id,
        metadata: data.metadata || {}
      };
    } catch (error) {
      throw new Error(`Failed to parse PaymentFailed event: ${error.message}`);
    }
  }

  /**
   * Parse generic event structure
   */
  parseGenericEvent(scVal) {
    try {
      const data = this.extractEventFields(scVal);
      
      return {
        eventType: 'Generic',
        data: data,
        rawFields: Object.keys(data)
      };
    } catch (error) {
      throw new Error(`Failed to parse generic event: ${error.message}`);
    }
  }

  /**
   * Extract fields from ScVal structure
   */
  extractEventFields(scVal) {
    const fields = {};
    
    if (scVal.switch().name !== 'instance') {
      return fields;
    }

    const instanceVal = scVal.instance();
    
    switch (instanceVal.switch().name) {
      case 'vec':
        return this.extractFieldsFromVec(instanceVal.vec());
      case 'map':
        return this.extractFieldsFromMap(instanceVal.map());
      default:
        return fields;
    }
  }

  /**
   * Extract fields from vector
   */
  extractFieldsFromVec(vec) {
    const fields = {};
    
    // Skip first element if it's the event type
    const startIndex = (vec.length > 0 && vec[0].switch().name === 'symbol') ? 1 : 0;
    
    for (let i = startIndex; i < vec.length; i++) {
      const val = vec[i];
      const fieldName = `field_${i - startIndex}`;
      fields[fieldName] = this.scValToJs(val);
    }
    
    return fields;
  }

  /**
   * Extract fields from map
   */
  extractFieldsFromMap(map) {
    const fields = {};
    
    for (const entry of map) {
      const key = entry.key();
      const value = entry.val();
      
      if (key.switch().name === 'symbol') {
        const keyName = key.symbol().toString();
        fields[keyName] = this.scValToJs(value);
      }
    }
    
    return fields;
  }

  /**
   * Convert ScVal to JavaScript value
   */
  scValToJs(scVal) {
    switch (scVal.switch().name) {
      case 'void':
        return null;
      case 'bool':
        return scVal.bool();
      case 'i32':
        return scVal.i32();
      case 'i64':
        return scVal.i64().toString();
      case 'u32':
        return scVal.u32();
      case 'u64':
        return scVal.u64().toString();
      case 'f32':
        return scVal.f32();
      case 'f64':
        return scVal.f64();
      case 'string':
        return scVal.string().toString();
      case 'symbol':
        return scVal.symbol().toString();
      case 'bytes':
        return Buffer.from(scVal.bytes()).toString('base64');
      case 'address':
        return this.parseAddress(scVal.address());
      case 'vec':
        return scVal.vec().map(val => this.scValToJs(val));
      case 'map':
        const map = {};
        for (const entry of scVal.map()) {
          const key = this.scValToJs(entry.key());
          const value = this.scValToJs(entry.val());
          map[key] = value;
        }
        return map;
      default:
        return null;
    }
  }

  /**
   * Parse Stellar address
   */
  parseAddress(addressScVal) {
    if (addressScVal.switch().name === 'account') {
      return addressScVal.account().accountId().ed25519().toString('hex');
    } else if (addressScVal.switch().name === 'contract') {
      return addressScVal.contract().contractId().toString('hex');
    }
    return null;
  }

  /**
   * Parse amount from ScVal
   */
  parseAmount(amountScVal) {
    if (!amountScVal) return null;
    
    if (typeof amountScVal === 'object' && amountScVal.switch) {
      return this.scValToJs(amountScVal);
    }
    
    return amountScVal;
  }

  /**
   * Parse duration from ScVal
   */
  parseDuration(durationScVal) {
    if (!durationScVal) return null;
    
    const duration = this.scValToJs(durationScVal);
    return typeof duration === 'number' ? duration : parseInt(duration, 10);
  }

  /**
   * Parse timestamp from ScVal
   */
  parseTimestamp(timestampScVal) {
    if (!timestampScVal) return null;
    
    const timestamp = this.scValToJs(timestampScVal);
    
    // Handle both Unix timestamp seconds and ISO strings
    if (typeof timestamp === 'number') {
      return new Date(timestamp * 1000).toISOString();
    } else if (typeof timestamp === 'string') {
      return timestamp;
    }
    
    return null;
  }

  /**
   * Parse number from ScVal
   */
  parseNumber(numberScVal) {
    if (!numberScVal) return 0;
    
    const number = this.scValToJs(numberScVal);
    return typeof number === 'number' ? number : parseInt(number, 10) || 0;
  }

  /**
   * Validate parsed event data
   */
  validateEventData(parsedEvent) {
    const errors = [];
    
    if (!parsedEvent.parsedData) {
      errors.push('Missing parsed event data');
      return { isValid: false, errors };
    }
    
    const data = parsedEvent.parsedData;
    
    // Common validations
    if (!data.subscriberAddress) {
      errors.push('Missing subscriber address');
    }
    
    if (!data.creatorAddress) {
      errors.push('Missing creator address');
    }
    
    // Event-specific validations
    switch (data.eventType) {
      case 'SubscriptionBilled':
        if (!data.amount) errors.push('Missing amount for SubscriptionBilled event');
        break;
      case 'TrialStarted':
        if (!data.trialDuration) errors.push('Missing trial duration for TrialStarted event');
        break;
      case 'PaymentFailed':
        if (!data.reason) errors.push('Missing reason for PaymentFailed event');
        break;
    }
    
    return {
      isValid: errors.length === 0,
      errors
    };
  }
}

module.exports = { SorobanXdrParser };
