const amqp = require('amqplib');

/**
 * RabbitMQ connection manager for handling message queue operations
 */
class RabbitMQConnection {
  constructor(config) {
    this.config = config;
    this.connection = null;
    this.channel = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000; // 5 seconds
  }

  /**
   * Connect to RabbitMQ server
   */
  async connect() {
    try {
      const url = this.config.url || `amqp://${this.config.host}:${this.config.port}`;
      this.connection = await amqp.connect(url, {
        hostname: this.config.host,
        port: this.config.port,
        username: this.config.username,
        password: this.config.password,
        vhost: this.config.vhost || '/',
      });

      this.connection.on('error', (err) => {
        console.error('RabbitMQ connection error:', err);
        this.isConnected = false;
        this.handleReconnect();
      });

      this.connection.on('close', () => {
        console.warn('RabbitMQ connection closed');
        this.isConnected = false;
        this.handleReconnect();
      });

      this.channel = await this.connection.createChannel();
      this.isConnected = true;
      this.reconnectAttempts = 0;

      console.log('Connected to RabbitMQ successfully');
      return this.channel;
    } catch (error) {
      console.error('Failed to connect to RabbitMQ:', error);
      this.isConnected = false;
      throw error;
    }
  }

  /**
   * Handle automatic reconnection
   */
  async handleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached. Giving up.');
      return;
    }

    this.reconnectAttempts++;
    console.log(`Attempting to reconnect to RabbitMQ (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        console.error('Reconnection failed:', error);
        this.handleReconnect();
      }
    }, this.reconnectDelay * this.reconnectAttempts);
  }

  /**
   * Get the channel, creating it if necessary
   */
  async getChannel() {
    if (!this.isConnected || !this.channel) {
      await this.connect();
    }
    return this.channel;
  }

  /**
   * Close the connection
   */
  async close() {
    try {
      if (this.channel) {
        await this.channel.close();
      }
      if (this.connection) {
        await this.connection.close();
      }
      this.isConnected = false;
      console.log('RabbitMQ connection closed');
    } catch (error) {
      console.error('Error closing RabbitMQ connection:', error);
    }
  }

  /**
   * Setup exchanges and queues
   */
  async setupTopology() {
    const channel = await this.getChannel();
    
    // Setup event exchange
    await channel.assertExchange(this.config.eventExchange, 'topic', {
      durable: true,
    });

    // Setup queues
    const queues = [
      this.config.eventQueue,
      this.config.notificationQueue,
      this.config.emailQueue,
      this.config.leaderboardQueue,
    ];

    for (const queueName of queues) {
      await channel.assertQueue(queueName, {
        durable: true,
      });
    }

    // Bind queues to exchange with routing keys
    await channel.bindQueue(
      this.config.eventQueue,
      this.config.eventExchange,
      'subscription.*'
    );

    await channel.bindQueue(
      this.config.notificationQueue,
      this.config.eventExchange,
      'notification.*'
    );

    await channel.bindQueue(
      this.config.emailQueue,
      this.config.eventExchange,
      'email.*'
    );

    await channel.bindQueue(
      this.config.leaderboardQueue,
      this.config.eventExchange,
      'leaderboard.*'
    );

    console.log('RabbitMQ topology setup completed');
  }
}

module.exports = { RabbitMQConnection };
