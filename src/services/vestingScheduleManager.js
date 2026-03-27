const {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} = require('@stellar/stellar-sdk');

/**
 * Service for managing vesting schedules including consolidation and merging functionality.
 */
class VestingScheduleManager {
  constructor(config) {
    this.config = config;
    this.server = config.soroban.rpcUrl ? new rpc.Server(config.soroban.rpcUrl) : null;
    this.contractId = config.soroban.contractId;
  }

  getContract() {
    return new Contract(this.contractId);
  }

  async consolidateSchedules(beneficiaryAddress, scheduleId1, scheduleId2, adminPublicKey, adminSignature) {
    this.assertConfigured();

    const schedule1 = await this.getScheduleDetails(scheduleId1);
    const schedule2 = await this.getScheduleDetails(scheduleId2);

    if (schedule1.beneficiary !== schedule2.beneficiary || 
        schedule1.beneficiary !== beneficiaryAddress) {
      const error = new Error('Schedule beneficiary mismatch');
      error.statusCode = 400;
      throw error;
    }

    const consolidatedUnvestedBalance = this.sumUnvestedBalances(schedule1, schedule2);
    const weightedAverageCliff = this.calculateWeightedAverageDate(schedule1, schedule2, 'cliff');
    const weightedAverageEnd = this.calculateWeightedAverageDate(schedule1, schedule2, 'end');
    const consolidatedStartDate = this.earlierDate(schedule1.startDate, schedule2.startDate);
    const weightedAverageDuration = this.calculateWeightedAverageDuration(
      schedule1, 
      schedule2, 
      consolidatedUnvestedBalance
    );

    const sourceKeypair = Keypair.fromSecret(this.config.soroban.sourceSecret);
    const contract = this.getContract();

    try {
      const sourceAccount = await this.server.getAccount(sourceKeypair.publicKey());
      
      const consolidateOp = contract.call(
        'consolidate_schedules',
        Address.fromString(beneficiaryAddress).toScVal(),
        nativeToScVal(scheduleId1, { type: 'string' }),
        nativeToScVal(scheduleId2, { type: 'string' }),
        nativeToScVal(adminPublicKey, { type: 'string' }),
        nativeToScVal(adminSignature, { type: 'string' })
      );

      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.config.soroban.networkPassphrase,
      })
        .addOperation(consolidateOp)
        .setTimeout(30)
        .build();

      tx.sign(sourceKeypair);
      const sentTx = await this.server.sendTransaction(tx);

      if (sentTx.status !== 'PENDING') {
        throw new Error('Transaction not accepted');
      }

      const txResponse = await this.pollTransaction(sentTx.hash);
      
      return {
        success: true,
        transactionHash: sentTx.hash,
        consolidatedSchedule: {
          beneficiary: beneficiaryAddress,
          unvestedBalance: consolidatedUnvestedBalance,
          cliffDate: weightedAverageCliff,
          endDate: weightedAverageEnd,
          startDate: consolidatedStartDate,
          vestingDuration: weightedAverageDuration,
        },
        mergedSchedules: [scheduleId1, scheduleId2],
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Schedule consolidation failed:', error);
      throw new Error(`Failed to consolidate schedules: ${error.message}`);
    }
  }

  async getScheduleDetails(scheduleId) {
    this.assertConfigured();
    const contract = this.getContract();
    const sourceKeypair = Keypair.fromSecret(this.config.soroban.sourceSecret);

    try {
      const sourceAccount = await this.server.getAccount(sourceKeypair.publicKey());
      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.config.soroban.networkPassphrase,
      })
        .addOperation(contract.call('get_schedule', nativeToScVal(scheduleId, { type: 'string' })))
        .setTimeout(30)
        .build();

      const simulation = await this.server.simulateTransaction(tx);

      if (rpc.Api.isSimulationError(simulation)) {
        throw new Error(`Simulation failed: ${simulation.error || 'unknown error'}`);
      }

      const result = simulation.result ? scValToNative(simulation.result.retval) : null;
      return this.normalizeSchedule(result);
    } catch (error) {
      console.error('Error fetching schedule details:', error);
      throw new Error('Failed to fetch schedule details');
    }
  }

  sumUnvestedBalances(schedule1, schedule2) {
    const balance1 = Number(schedule1.unvestedBalance || schedule1.unvested_balance || 0);
    const balance2 = Number(schedule2.unvestedBalance || schedule2.unvested_balance || 0);
    return balance1 + balance2;
  }

  calculateWeightedAverageDate(schedule1, schedule2, dateField) {
    const balance1 = Number(schedule1.unvestedBalance || schedule1.unvested_balance || 0);
    const balance2 = Number(schedule2.unvestedBalance || schedule2.unvested_balance || 0);
    const totalBalance = balance1 + balance2;

    if (totalBalance === 0) {
      return schedule1[dateField] || schedule1[`${dateField}_date`];
    }

    const date1 = new Date(schedule1[dateField] || schedule1[`${dateField}_date`]);
    const date2 = new Date(schedule2[dateField] || schedule2[`${dateField}_date`]);

    const timestamp1 = date1.getTime();
    const timestamp2 = date2.getTime();

    const weightedTimestamp = (timestamp1 * balance1 + timestamp2 * balance2) / totalBalance;
    return new Date(weightedTimestamp).toISOString();
  }

  calculateWeightedAverageDuration(schedule1, schedule2, totalBalance) {
    const balance1 = Number(schedule1.unvestedBalance || schedule1.unvested_balance || 0);
    const balance2 = Number(schedule2.unvestedBalance || schedule2.unvested_balance || 0);

    if (totalBalance === 0) {
      return Number(schedule1.vestingDuration || schedule1.vesting_duration || 0);
    }

    const duration1 = Number(schedule1.vestingDuration || schedule1.vesting_duration || 0);
    const duration2 = Number(schedule2.vestingDuration || schedule2.vesting_duration || 0);

    return Math.floor((duration1 * balance1 + duration2 * balance2) / totalBalance);
  }

  earlierDate(date1, date2) {
    const d1 = new Date(date1);
    const d2 = new Date(date2);
    return d1 <= d2 ? date1 : date2;
  }

  normalizeSchedule(result) {
    if (!result || typeof result !== 'object') {
      return {
        id: '',
        beneficiary: '',
        unvestedBalance: 0,
        cliff: null,
        end: null,
        startDate: null,
        vestingDuration: 0,
      };
    }

    return {
      id: result.id || result.schedule_id || '',
      beneficiary: result.beneficiary || result.beneficiary_address || '',
      unvestedBalance: Number(result.unvested_balance || result.unvestedBalance || 0),
      cliff: result.cliff || result.cliff_date || null,
      end: result.end || result.end_date || null,
      startDate: result.start_date || result.start || null,
      vestingDuration: Number(result.vesting_duration || result.vestingDuration || 0),
      totalAmount: Number(result.total_amount || result.totalAmount || 0),
      vestedAmount: Number(result.vested_amount || result.vestedAmount || 0),
    };
  }

  async pollTransaction(txHash) {
    const maxAttempts = 10;
    const delayMs = 1000;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await this.server.getTransaction(txHash);
        
        if (response.status === 'SUCCESS') {
          return response;
        }
        
        if (response.status === 'FAILED') {
          throw new Error('Transaction failed');
        }
      } catch (error) {
        if (i === maxAttempts - 1) {
          throw error;
        }
      }

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    throw new Error('Transaction polling timeout');
  }

  assertConfigured() {
    if (!this.server) {
      const error = new Error('SOROBAN_RPC_URL is required');
      error.statusCode = 503;
      throw error;
    }

    if (!this.config.soroban.sourceSecret) {
      const error = new Error('SOROBAN_SOURCE_SECRET is required');
      error.statusCode = 503;
      throw error;
    }

    if (!this.contractId) {
      const error = new Error('Contract ID is required');
      error.statusCode = 503;
      throw error;
    }
  }
}

module.exports = {
  VestingScheduleManager,
};
