import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { WebSocketGateway as WSGateway } from '../src/websocket/websocket.gateway.simple';
import { AuthService } from '../src/auth/auth.service';
import { RedisService } from '../src/redis/redis.service';
import { DunningService } from '../src/websocket/dunning.service';
import * as io from 'socket.io-client';

describe('WebSocket Integration Tests', () => {
  let app: INestApplication;
  let gateway: WSGateway;
  let authService: AuthService;
  let redisService: RedisService;
  let dunningService: DunningService;
  let clientSocket: any;

  const validToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJHQVpBTVRaUVc1UTZSWTJQNVNQTU9ZVjEzU1hUSlpYQ1hMSFVYIiwiZXhwIjoxNzUzNDIwODAwLCJpYXQiOjE3NTM0MTc5OTl9.test';
  const invalidToken = 'invalid.token.here';
  const expiredToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJHQVpBTVRaUVc1UTZSWTJQNVNQTU9ZVjEzU1hUSlpYQ1hMSFVYIiwiZXhwIjoxNjAwMDAwMDAwLCJpYXQiOjE2MDAwMDAwMDB9.test';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    gateway = moduleFixture.get<WSGateway>(WSGateway);
    authService = moduleFixture.get<AuthService>(AuthService);
    redisService = moduleFixture.get<RedisService>(RedisService);
    dunningService = moduleFixture.get<DunningService>(DunningService);

    await app.listen(3002);
  });

  afterAll(async () => {
    if (clientSocket) {
      clientSocket.disconnect();
    }
    await app.close();
  });

  beforeEach(() => {
    // Mock authService methods
    jest.spyOn(authService, 'validateSEP10Token').mockImplementation((token) => {
      if (token === validToken) {
        return Promise.resolve({
          stellarPublicKey: 'GAZAMTZQW5Q6RY2P5SPMOYV13SXTJXCXLHU',
          payload: { sub: 'GAZAMTZQW5Q6RY2P5SPMOYV13SXTJXCXLHU' }
        });
      }
      if (token === expiredToken) {
        throw new Error('Token has expired');
      }
      throw new Error('Invalid token');
    });

    jest.spyOn(authService, 'extractPublicKeyFromToken').mockImplementation((token) => {
      if (token === validToken) {
        return Promise.resolve('GAZAMTZQW5Q6RY2P5SPMOYV13SXTJXCXLHU');
      }
      throw new Error('Invalid token');
    });

    jest.spyOn(authService, 'isTokenExpired').mockImplementation((token) => {
      return token === expiredToken;
    });
  });

  describe('WebSocket Connection Tests', () => {
    it('should accept connection with valid SEP-10 JWT token', (done) => {
      clientSocket = io('http://localhost:3002/merchant', {
        auth: { token: validToken }
      });

      clientSocket.on('connect', () => {
        expect(clientSocket.connected).toBe(true);
        done();
      });

      clientSocket.on('error', (error) => {
        done(error);
      });
    });

    it('should reject connection without token', (done) => {
      const testSocket = io('http://localhost:3002/merchant');

      testSocket.on('connect_error', (error) => {
        expect(error.message).toContain('Authentication failed');
        testSocket.disconnect();
        done();
      });

      testSocket.on('connect', () => {
        testSocket.disconnect();
        done(new Error('Should not connect without token'));
      });
    });

    it('should reject connection with invalid token', (done) => {
      const testSocket = io('http://localhost:3002/merchant', {
        auth: { token: invalidToken }
      });

      testSocket.on('connect_error', (error) => {
        expect(error.message).toContain('Authentication failed');
        testSocket.disconnect();
        done();
      });

      testSocket.on('connect', () => {
        testSocket.disconnect();
        done(new Error('Should not connect with invalid token'));
      });
    });

    it('should handle ping-pong heartbeat', (done) => {
      clientSocket = io('http://localhost:3002/merchant', {
        auth: { token: validToken }
      });

      clientSocket.on('connect', () => {
        clientSocket.emit('ping');
      });

      clientSocket.on('pong', (data) => {
        expect(data).toHaveProperty('timestamp');
        done();
      });
    });
  });

  describe('Real-time Event Tests', () => {
    beforeEach(() => {
      clientSocket = io('http://localhost:3002/merchant', {
        auth: { token: validToken }
      });
    });

    afterEach(() => {
      if (clientSocket) {
        clientSocket.disconnect();
      }
    });

    it('should receive payment success events', (done) => {
      const paymentPayload = {
        stellarPublicKey: 'GAZAMTZQW5Q6RY2P5SPMOYV13SXTJXCXLHU',
        planId: 'plan_123',
        amount: '100.00',
        timestamp: new Date().toISOString(),
        transactionHash: '0x1234567890abcdef'
      };

      clientSocket.on('payment_success', (data) => {
        expect(data.type).toBe('payment_success');
        expect(data.data).toEqual(paymentPayload);
        expect(data.timestamp).toBeDefined();
        done();
      });

      // Emit payment success event
      setTimeout(() => {
        gateway.emitPaymentSuccess(paymentPayload);
      }, 100);
    });

    it('should receive payment failure events', (done) => {
      const failurePayload = {
        stellarPublicKey: 'GAZAMTZQW5Q6RY2P5SPMOYV13SXTJXCXLHU',
        planId: 'plan_123',
        userId: 'user_456',
        failureReason: 'INSUFFICIENT_FUNDS',
        timestamp: new Date().toISOString(),
        deepLinkRef: 'ref_789'
      };

      clientSocket.on('payment_failed', (data) => {
        expect(data.type).toBe('payment_failed');
        expect(data.data).toEqual(failurePayload);
        expect(data.timestamp).toBeDefined();
        done();
      });

      // Mock dunning service to return payload immediately
      jest.spyOn(dunningService, 'processPaymentFailure').mockResolvedValue(failurePayload);

      setTimeout(() => {
        gateway.emitPaymentFailure(failurePayload);
      }, 100);
    });

    it('should receive trial conversion events', (done) => {
      const trialPayload = {
        stellarPublicKey: 'GAZAMTZQW5Q6RY2P5SPMOYV13SXTJXCXLHU',
        planId: 'plan_123',
        userId: 'user_456',
        timestamp: new Date().toISOString()
      };

      clientSocket.on('trial_converted', (data) => {
        expect(data.type).toBe('trial_converted');
        expect(data.data).toEqual(trialPayload);
        expect(data.timestamp).toBeDefined();
        done();
      });

      setTimeout(() => {
        gateway.emitTrialConverted(trialPayload);
      }, 100);
    });
  });

  describe('Dunning Service Tests', () => {
    it('should batch payment failures when threshold is reached', async () => {
      const failurePayload = {
        stellarPublicKey: 'GAZAMTZQW5Q6RY2P5SPMOYV13SXTJXCXLHU',
        planId: 'plan_123',
        userId: 'user_456',
        failureReason: 'INSUFFICIENT_FUNDS',
        timestamp: new Date().toISOString(),
        deepLinkRef: 'ref_789'
      };

      // Process 11 failures to trigger batching
      const results = [];
      for (let i = 0; i < 11; i++) {
        const result = await dunningService.processPaymentFailure({
          ...failurePayload,
          userId: `user_${i}`,
          timestamp: new Date().toISOString()
        });
        results.push(result);
      }

      // Should have one batched result and 10 null results
      const batchedResult = results.find(r => r !== null);
      const nullResults = results.filter(r => r === null);

      expect(batchedResult).toHaveProperty('failures');
      expect(batchedResult).toHaveProperty('batchId');
      expect(batchedResult).toHaveProperty('totalCount', 11);
      expect(nullResults.length).toBe(10);
    });

    it('should emit high priority failures immediately', async () => {
      const highPriorityPayload = {
        stellarPublicKey: 'GAZAMTZQW5Q6RY2P5SPMOYV13SXTJXCXLHU',
        planId: 'plan_123',
        userId: 'user_456',
        failureReason: 'ACCOUNT_FROZEN',
        timestamp: new Date().toISOString(),
        deepLinkRef: 'ref_789'
      };

      jest.spyOn(dunningService, 'isHighPriorityFailure').mockReturnValue(true);
      jest.spyOn(dunningService, 'processHighPriorityFailure').mockResolvedValue(highPriorityPayload);

      const result = await dunningService.processPaymentFailure(highPriorityPayload);
      
      expect(dunningService.isHighPriorityFailure).toHaveBeenCalledWith(highPriorityPayload);
      expect(dunningService.processHighPriorityFailure).toHaveBeenCalledWith(highPriorityPayload);
    });
  });

  describe('Redis Integration Tests', () => {
    it('should publish and subscribe to payment success events', (done) => {
      const paymentPayload = {
        stellarPublicKey: 'GAZAMTZQW5Q6RY2P5SPMOYV13SXTJXCXLHU',
        planId: 'plan_123',
        amount: '100.00',
        timestamp: new Date().toISOString(),
        transactionHash: '0x1234567890abcdef'
      };

      // Mock Redis publish
      jest.spyOn(redisService, 'publish').mockResolvedValue();

      clientSocket = io('http://localhost:3002/merchant', {
        auth: { token: validToken }
      });

      clientSocket.on('connect', () => {
        clientSocket.on('payment_success', (data) => {
          expect(data.type).toBe('payment_success');
          expect(redisService.publish).toHaveBeenCalledWith('payment_success', paymentPayload);
          done();
        });

        // Simulate Redis message
        setTimeout(() => {
          // This would normally come from Redis subscription
          clientSocket.emit('payment_success', {
            type: 'payment_success',
            data: paymentPayload,
            timestamp: new Date().toISOString()
          });
        }, 100);
      });
    });

    it('should handle Redis connection failures gracefully', async () => {
      // Mock Redis failure
      jest.spyOn(redisService, 'publish').mockRejectedValue(new Error('Redis connection failed'));
      jest.spyOn(redisService, 'getPublisherStatus').mockReturnValue('error');

      const paymentPayload = {
        stellarPublicKey: 'GAZAMTZQW5Q6RY2P5SPMOYV13SXTJXCXLHU',
        planId: 'plan_123',
        amount: '100.00',
        timestamp: new Date().toISOString(),
        transactionHash: '0x1234567890abcdef'
      };

      // Should not throw error
      await expect(gateway.emitPaymentSuccess(paymentPayload)).resolves.not.toThrow();
    });
  });

  describe('Security Tests', () => {
    it('should disconnect clients with expired tokens', (done) => {
      const testSocket = io('http://localhost:3002/merchant', {
        auth: { token: expiredToken }
      });

      testSocket.on('connect_error', () => {
        testSocket.disconnect();
        done(new Error('Should not connect with expired token'));
      });

      testSocket.on('token_expired', (data) => {
        expect(data.message).toBe('Authentication token expired');
        testSocket.disconnect();
        done();
      });

      testSocket.on('connect', () => {
        // Simulate token expiration check
        setTimeout(() => {
          testSocket.emit('ping');
        }, 100);
      });
    });

    it('should prevent cross-tenant data leakage', (done) => {
      const merchant1Token = validToken;
      const merchant2Token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJHQVpBTVRaUVc1UTZSWTJQNVNQTU9ZVjEzU1hUSlpZQ1hMSFVZIiwiZXhwIjoxNzUzNDIwODAwLCJpYXQiOjE3NTM0MTc5OTl9.test';

      // Mock different public keys for different tokens
      jest.spyOn(authService, 'extractPublicKeyFromToken').mockImplementation((token) => {
        if (token === merchant1Token) {
          return Promise.resolve('GAZAMTZQW5Q6RY2P5SPMOYV13SXTJXCXLHU');
        }
        if (token === merchant2Token) {
          return Promise.resolve('GAZAMTZQW5Q6RY2P5SPMOYV13SXTJXCXLHY');
        }
        throw new Error('Invalid token');
      });

      const client1 = io('http://localhost:3002/merchant', {
        auth: { token: merchant1Token }
      });

      const client2 = io('http://localhost:3002/merchant', {
        auth: { token: merchant2Token }
      });

      let client1Connected = false;
      let client2Connected = false;

      client1.on('connect', () => {
        client1Connected = true;
        if (client2Connected) {
          testCrossTenantIsolation();
        }
      });

      client2.on('connect', () => {
        client2Connected = true;
        if (client1Connected) {
          testCrossTenantIsolation();
        }
      });

      const testCrossTenantIsolation = () => {
        const paymentPayload = {
          stellarPublicKey: 'GAZAMTZQW5Q6RY2P5SPMOYV13SXTJXCXLHU', // Only for merchant 1
          planId: 'plan_123',
          amount: '100.00',
          timestamp: new Date().toISOString(),
          transactionHash: '0x1234567890abcdef'
        };

        let client1Received = false;
        let client2Received = false;

        client1.on('payment_success', (data) => {
          client1Received = true;
        });

        client2.on('payment_success', (data) => {
          client2Received = true;
        });

        // Emit payment success for merchant 1
        setTimeout(() => {
          gateway.emitPaymentSuccess(paymentPayload);
          
          setTimeout(() => {
            expect(client1Received).toBe(true);
            expect(client2Received).toBe(false); // Should not receive
            
            client1.disconnect();
            client2.disconnect();
            done();
          }, 200);
        }, 100);
      };
    });
  });
});
