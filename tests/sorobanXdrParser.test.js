const { SorobanXdrParser } = require('../src/utils/sorobanXdrParser');
const { xdr } = require('@stellar/stellar-sdk');

describe('SorobanXdrParser', () => {
  let parser;

  beforeEach(() => {
    parser = new SorobanXdrParser();
  });

  describe('parseEvent', () => {
    test('should parse valid SubscriptionBilled event', () => {
      const mockEvent = {
        id: 'test-event-1',
        contractId: 'CAOUX2FZ65IDC4F2X7LJJ2SVF23A35CCTZB7KVVN475JCLKTTU4CEY6L',
        transactionHash: 'abc123',
        eventIndex: 0,
        ledgerSequence: 12345,
        ledgerTimestamp: '2023-01-01T00:00:00Z',
        body: createMockSubscriptionBilledXdr()
      };

      const result = parser.parseEvent(mockEvent);

      expect(result.isValid).toBe(true);
      expect(result.type).toBe('SubscriptionBilled');
      expect(result.parsedData.eventType).toBe('SubscriptionBilled');
      expect(result.parsedData.subscriberAddress).toBe('GABC123...');
      expect(result.parsedData.creatorAddress).toBe('GDEF456...');
      expect(result.parsedData.amount).toBe('10000000');
    });

    test('should parse valid TrialStarted event', () => {
      const mockEvent = {
        id: 'test-event-2',
        contractId: 'CAOUX2FZ65IDC4F2X7LJJ2SVF23A35CCTZB7KVVN475JCLKTTU4CEY6L',
        transactionHash: 'def456',
        eventIndex: 1,
        ledgerSequence: 12346,
        ledgerTimestamp: '2023-01-01T01:00:00Z',
        body: createMockTrialStartedXdr()
      };

      const result = parser.parseEvent(mockEvent);

      expect(result.isValid).toBe(true);
      expect(result.type).toBe('TrialStarted');
      expect(result.parsedData.eventType).toBe('TrialStarted');
      expect(result.parsedData.subscriberAddress).toBe('GABC123...');
      expect(result.parsedData.trialDuration).toBe(86400); // 24 hours
    });

    test('should parse valid PaymentFailed event', () => {
      const mockEvent = {
        id: 'test-event-3',
        contractId: 'CAOUX2FZ65IDC4F2X7LJJ2SVF23A35CCTZB7KVVN475JCLKTTU4CEY6L',
        transactionHash: 'ghi789',
        eventIndex: 0,
        ledgerSequence: 12347,
        ledgerTimestamp: '2023-01-01T02:00:00Z',
        body: createMockPaymentFailedXdr()
      };

      const result = parser.parseEvent(mockEvent);

      expect(result.isValid).toBe(true);
      expect(result.type).toBe('PaymentFailed');
      expect(result.parsedData.eventType).toBe('PaymentFailed');
      expect(result.parsedData.reason).toBe('insufficient_funds');
      expect(result.parsedData.retryCount).toBe(1);
    });

    test('should handle invalid XDR gracefully', () => {
      const mockEvent = {
        id: 'test-event-invalid',
        contractId: 'CAOUX2FZ65IDC4F2X7LJJ2SVF23A35CCTZB7KVVN475JCLKTTU4CEY6L',
        transactionHash: 'invalid',
        eventIndex: 0,
        ledgerSequence: 12348,
        ledgerTimestamp: '2023-01-01T03:00:00Z',
        body: 'invalid-xdr-data'
      };

      const result = parser.parseEvent(mockEvent);

      expect(result.isValid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.type).toBe('Unknown');
    });

    test('should handle missing required fields', () => {
      const mockEvent = {
        id: 'test-event-missing',
        contractId: 'CAOUX2FZ65IDC4F2X7LJJ2SVF23A35CCTZB7KVVN475JCLKTTU4CEY6L',
        transactionHash: 'missing',
        eventIndex: 0,
        ledgerSequence: 12349,
        ledgerTimestamp: '2023-01-01T04:00:00Z',
        body: createMockIncompleteXdr()
      };

      const result = parser.parseEvent(mockEvent);

      expect(result.isValid).toBe(true); // Parsing succeeds but validation will fail
      const validation = parser.validateEventData(result);
      expect(validation.isValid).toBe(false);
      expect(validation.errors).toContain('Missing subscriber address');
    });
  });

  describe('validateEventData', () => {
    test('should validate complete SubscriptionBilled event', () => {
      const parsedEvent = {
        type: 'SubscriptionBilled',
        parsedData: {
          eventType: 'SubscriptionBilled',
          subscriberAddress: 'GABC123...',
          creatorAddress: 'GDEF456...',
          amount: '10000000',
          currency: 'XLM'
        }
      };

      const validation = parser.validateEventData(parsedEvent);
      expect(validation.isValid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    test('should validate complete TrialStarted event', () => {
      const parsedEvent = {
        type: 'TrialStarted',
        parsedData: {
          eventType: 'TrialStarted',
          subscriberAddress: 'GABC123...',
          creatorAddress: 'GDEF456...',
          trialDuration: 86400
        }
      };

      const validation = parser.validateEventData(parsedEvent);
      expect(validation.isValid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    test('should validate complete PaymentFailed event', () => {
      const parsedEvent = {
        type: 'PaymentFailed',
        parsedData: {
          eventType: 'PaymentFailed',
          subscriberAddress: 'GABC123...',
          creatorAddress: 'GDEF456...',
          reason: 'insufficient_funds'
        }
      };

      const validation = parser.validateEventData(parsedEvent);
      expect(validation.isValid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    test('should reject events with missing subscriber address', () => {
      const parsedEvent = {
        type: 'SubscriptionBilled',
        parsedData: {
          eventType: 'SubscriptionBilled',
          creatorAddress: 'GDEF456...',
          amount: '10000000'
        }
      };

      const validation = parser.validateEventData(parsedEvent);
      expect(validation.isValid).toBe(false);
      expect(validation.errors).toContain('Missing subscriber address');
    });

    test('should reject events with missing creator address', () => {
      const parsedEvent = {
        type: 'SubscriptionBilled',
        parsedData: {
          eventType: 'SubscriptionBilled',
          subscriberAddress: 'GABC123...',
          amount: '10000000'
        }
      };

      const validation = parser.validateEventData(parsedEvent);
      expect(validation.isValid).toBe(false);
      expect(validation.errors).toContain('Missing creator address');
    });

    test('should reject SubscriptionBilled events without amount', () => {
      const parsedEvent = {
        type: 'SubscriptionBilled',
        parsedData: {
          eventType: 'SubscriptionBilled',
          subscriberAddress: 'GABC123...',
          creatorAddress: 'GDEF456...'
        }
      };

      const validation = parser.validateEventData(parsedEvent);
      expect(validation.isValid).toBe(false);
      expect(validation.errors).toContain('Missing amount for SubscriptionBilled event');
    });
  });

  describe('scValToJs', () => {
    test('should convert basic ScVal types', () => {
      // Test boolean
      const boolVal = xdr.ScVal.scvBool(true);
      expect(parser.scValToJs(boolVal)).toBe(true);

      // Test string
      const strVal = xdr.ScVal.scvString('test');
      expect(parser.scValToJs(strVal)).toBe('test');

      // Test symbol
      const symVal = xdr.ScVal.scvSymbol('test_symbol');
      expect(parser.scValToJs(symVal)).toBe('test_symbol');

      // Test number
      const numVal = xdr.ScVal.scvU32(42);
      expect(parser.scValToJs(numVal)).toBe(42);
    });

    test('should convert vector ScVal', () => {
      const vec = [
        xdr.ScVal.scvString('item1'),
        xdr.ScVal.scvString('item2'),
        xdr.ScVal.scvU32(123)
      ];
      const vecVal = xdr.ScVal.scvVec(vec);

      const result = parser.scValToJs(vecVal);
      expect(result).toEqual(['item1', 'item2', 123]);
    });

    test('should convert map ScVal', () => {
      const map = [
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('key1'),
          val: xdr.ScVal.scvString('value1')
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('key2'),
          val: xdr.ScVal.scvU32(456)
        })
      ];
      const mapVal = xdr.ScVal.scvMap(map);

      const result = parser.scValToJs(mapVal);
      expect(result).toEqual({
        key1: 'value1',
        key2: 456
      });
    });
  });

  describe('parseTimestamp', () => {
    test('should parse Unix timestamp', () => {
      const timestamp = 1672531200; // 2023-01-01 00:00:00 UTC
      const result = parser.parseTimestamp(timestamp);
      expect(result).toBe('2023-01-01T00:00:00.000Z');
    });

    test('should parse ISO string timestamp', () => {
      const timestamp = '2023-01-01T00:00:00Z';
      const result = parser.parseTimestamp(timestamp);
      expect(result).toBe('2023-01-01T00:00:00Z');
    });

    test('should handle null/undefined timestamp', () => {
      expect(parser.parseTimestamp(null)).toBeNull();
      expect(parser.parseTimestamp(undefined)).toBeNull();
    });
  });

  describe('parseAmount', () => {
    test('should parse amount from ScVal', () => {
      const amountVal = xdr.ScVal.scvU64(10000000);
      const result = parser.parseAmount(amountVal);
      expect(result).toBe('10000000');
    });

    test('should handle string amount', () => {
      const result = parser.parseAmount('10000000');
      expect(result).toBe('10000000');
    });

    test('should handle null/undefined amount', () => {
      expect(parser.parseAmount(null)).toBeNull();
      expect(parser.parseAmount(undefined)).toBeNull();
    });
  });
});

// Helper functions to create mock XDR data
function createMockSubscriptionBilledXdr() {
  // Create a mock SubscriptionBilled event XDR
  const vec = [
    xdr.ScVal.scvSymbol('SubscriptionBilled'), // Event type
    xdr.ScVal.scvSymbol('subscriber_address'), // Field name
    xdr.ScVal.scvString('GABC123...'), // Field value
    xdr.ScVal.scvSymbol('creator_address'),
    xdr.ScVal.scvString('GDEF456...'),
    xdr.ScVal.scvSymbol('amount'),
    xdr.ScVal.scvU64(10000000),
    xdr.ScVal.scvSymbol('currency'),
    xdr.ScVal.scvString('XLM')
  ];
  
  return xdr.ScVal.scvInstance(xdr.ScVal.scvVec(vec)).toXDR('base64');
}

function createMockTrialStartedXdr() {
  const vec = [
    xdr.ScVal.scvSymbol('TrialStarted'),
    xdr.ScVal.scvSymbol('subscriber_address'),
    xdr.ScVal.scvString('GABC123...'),
    xdr.ScVal.scvSymbol('creator_address'),
    xdr.ScVal.scvString('GDEF456...'),
    xdr.ScVal.scvSymbol('trial_duration'),
    xdr.ScVal.scvU32(86400)
  ];
  
  return xdr.ScVal.scvInstance(xdr.ScVal.scvVec(vec)).toXDR('base64');
}

function createMockPaymentFailedXdr() {
  const vec = [
    xdr.ScVal.scvSymbol('PaymentFailed'),
    xdr.ScVal.scvSymbol('subscriber_address'),
    xdr.ScVal.scvString('GABC123...'),
    xdr.ScVal.scvSymbol('creator_address'),
    xdr.ScVal.scvString('GDEF456...'),
    xdr.ScVal.scvSymbol('reason'),
    xdr.ScVal.scvString('insufficient_funds'),
    xdr.ScVal.scvSymbol('retry_count'),
    xdr.ScVal.scvU32(1)
  ];
  
  return xdr.ScVal.scvInstance(xdr.ScVal.scvVec(vec)).toXDR('base64');
}

function createMockIncompleteXdr() {
  const vec = [
    xdr.ScVal.scvSymbol('SubscriptionBilled'),
    xdr.ScVal.scvSymbol('creator_address'),
    xdr.ScVal.scvString('GDEF456...')
    // Missing subscriber_address and amount
  ];
  
  return xdr.ScVal.scvInstance(xdr.ScVal.scvVec(vec)).toXDR('base64');
}
