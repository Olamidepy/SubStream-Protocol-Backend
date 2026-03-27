const express = require('express');
const router = express.Router();
const { VestingScheduleManager } = require('../services/vestingScheduleManager');
const { loadConfig } = require('../config');

const config = loadConfig();
const scheduleManager = new VestingScheduleManager(config);

router.get('/schedule/:scheduleId', async (req, res) => {
  try {
    const { scheduleId } = req.params;
    
    if (!scheduleId) {
      return res.status(400).json({
        success: false,
        error: 'scheduleId is required',
      });
    }

    const schedule = await scheduleManager.getScheduleDetails(scheduleId);
    
    res.json({
      success: true,
      data: {
        scheduleId,
        schedule,
      },
    });
  } catch (error) {
    console.error('Error fetching schedule:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch schedule',
    });
  }
});

router.post('/consolidate', async (req, res) => {
  try {
    const { 
      beneficiaryAddress, 
      scheduleId1, 
      scheduleId2, 
      adminPublicKey, 
      adminSignature 
    } = req.body;

    if (!beneficiaryAddress || !scheduleId1 || !scheduleId2 || !adminPublicKey || !adminSignature) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: beneficiaryAddress, scheduleId1, scheduleId2, adminPublicKey, adminSignature',
      });
    }

    const result = await scheduleManager.consolidateSchedules(
      beneficiaryAddress,
      scheduleId1,
      scheduleId2,
      adminPublicKey,
      adminSignature
    );

    res.json({
      success: true,
      data: result,
      message: 'Vesting schedules consolidated successfully',
    });
  } catch (error) {
    console.error('Schedule consolidation failed:', error);
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to consolidate schedules',
    });
  }
});

router.post('/calculate-weighted-average', async (req, res) => {
  try {
    const { schedule1, schedule2 } = req.body;

    if (!schedule1 || !schedule2) {
      return res.status(400).json({
        success: false,
        error: 'Both schedule1 and schedule2 are required',
      });
    }

    const unvestedBalance = scheduleManager.sumUnvestedBalances(schedule1, schedule2);
    const weightedAverageCliff = scheduleManager.calculateWeightedAverageDate(schedule1, schedule2, 'cliff');
    const weightedAverageEnd = scheduleManager.calculateWeightedAverageDate(schedule1, schedule2, 'end');
    const weightedAverageDuration = scheduleManager.calculateWeightedAverageDuration(
      schedule1, 
      schedule2, 
      unvestedBalance
    );

    res.json({
      success: true,
      data: {
        totalUnvestedBalance: unvestedBalance,
        weightedAverageCliff,
        weightedAverageEnd,
        weightedAverageDuration,
      },
      message: 'Weighted averages calculated successfully',
    });
  } catch (error) {
    console.error('Calculation failed:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to calculate weighted averages',
    });
  }
});

module.exports = router;
