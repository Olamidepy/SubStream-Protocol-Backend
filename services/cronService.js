const cron = require('node-cron');
const badgeService = require('./badgeService');
const gdprService = require('./gdprService');

class CronService {
  constructor() {
    this.jobs = new Map();
    this.setupDefaultJobs();
  }

  setupDefaultJobs() {
    // Run badge milestone check daily at 2 AM UTC
    this.scheduleJob('daily-badge-check', '0 2 * * *', async () => {
      console.log('Running daily badge milestone check...');
      try {
        await badgeService.runDailyMilestoneCheck();
        console.log('Daily badge milestone check completed successfully');
      } catch (error) {
        console.error('Error in daily badge milestone check:', error);
      }
    });

    // Clean up expired exports daily at 3 AM UTC
    this.scheduleJob('cleanup-exports', '0 3 * * *', async () => {
      console.log('Running daily export cleanup...');
      try {
        const expiredFiles = await gdprService.cleanupExpiredExports();
        console.log(`Cleaned up ${expiredFiles.length} expired export files`);
      } catch (error) {
        console.error('Error in export cleanup:', error);
      }
    });

    // Rotate feed tokens every 6 hours
    this.scheduleJob('rotate-feed-tokens', '0 */6 * * *', async () => {
      console.log('Running feed credential rotation...');
      try {
        const feedService = require('./feedService');
        feedService.cleanupExpiredTokens();
        console.log('Feed credential rotation completed');
      } catch (error) {
        console.error('Error in feed credential rotation:', error);
      }
    });
  }

  scheduleJob(name, schedule, task) {
    // Stop existing job if it exists
    if (this.jobs.has(name)) {
      this.jobs.get(name).stop();
    }

    const job = cron.schedule(schedule, task, {
      scheduled: true,
      timezone: 'UTC'
    });

    this.jobs.set(name, job);
    console.log(`Scheduled job '${name}' with schedule: ${schedule}`);

    return job;
  }

  stopJob(name) {
    if (this.jobs.has(name)) {
      this.jobs.get(name).stop();
      this.jobs.delete(name);
      console.log(`Stopped job '${name}'`);
      return true;
    }
    return false;
  }

  stopAllJobs() {
    for (const [name, job] of this.jobs) {
      job.stop();
    }
    this.jobs.clear();
    console.log('All cron jobs stopped');
  }

  getJobStatus() {
    const status = {};
    for (const [name, job] of this.jobs) {
      status[name] = {
        running: job.running || false,
        scheduled: true
      };
    }
    return status;
  }

  // Manual job execution for testing
  async executeJob(name) {
    switch (name) {
      case 'daily-badge-check':
        await badgeService.runDailyMilestoneCheck();
        break;
      case 'cleanup-exports':
        await gdprService.cleanupExpiredExports();
        break;
      case 'rotate-feed-tokens':
        const feedService = require('./feedService');
        feedService.cleanupExpiredTokens();
        break;
      default:
        throw new Error(`Unknown job: ${name}`);
    }
  }
}

module.exports = new CronService();
