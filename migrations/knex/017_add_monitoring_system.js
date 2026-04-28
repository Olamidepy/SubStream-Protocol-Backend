/**
 * Add Monitoring System for 5xx Error Tracking and Alerting
 */

exports.up = async function(knex) {
  // Monitoring Alerts table
  await knex.schema.createTable('monitoring_alerts', function(table) {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('endpoint', 255).notNullable().index();
    table.enum('severity', ['info', 'warning', 'critical']).notNullable();
    table.string('alert_type', 50).notNullable(); // error_spike, critical_error_spike, manual, etc.
    table.integer('error_count').notNullable();
    table.integer('threshold').notNullable();
    table.integer('monitoring_window').notNullable(); // in seconds
    table.json('alert_data'); // Additional endpoint stats
    table.boolean('acknowledged').defaultTo(false);
    table.uuid('acknowledged_by');
    table.timestamp('acknowledged_at');
    table.text('acknowledgment_notes');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    // Indexes
    table.index(['endpoint', 'created_at']);
    table.index(['severity', 'created_at']);
    table.index(['alert_type', 'created_at']);
    table.index(['acknowledged']);
  });

  // Monitoring Notifications table
  await knex.schema.createTable('monitoring_notifications', function(table) {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('name', 255).notNullable();
    table.enum('notification_type', ['email', 'webhook', 'slack']).notNullable();
    table.string('recipient', 255); // Email address or webhook URL
    table.string('endpoint_patterns', 1000); // Comma-separated patterns or '*' for all
    table.enum('severity_filter', ['warning', 'critical', 'all']).defaultTo('critical');
    table.boolean('active').defaultTo(true);
    table.string('webhook_secret', 255); // For webhook signature verification
    table.json('notification_config'); // Additional config per notification type
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    
    // Indexes
    table.index(['active']);
    table.index(['notification_type']);
    table.index(['severity_filter']);
  });

  // Endpoint Performance Metrics table
  await knex.schema.createTable('endpoint_performance_metrics', function(table) {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('endpoint', 255).notNullable().index();
    table.string('method', 10).notNullable();
    table.timestamp('window_start').notNullable().index();
    table.timestamp('window_end').notNullable();
    table.integer('total_requests').notNullable().defaultTo(0);
    table.integer('total_errors').notNullable().defaultTo(0);
    table.integer('total_5xx_errors').notNullable().defaultTo(0);
    table.decimal('avg_response_time', 10, 3).defaultTo(0); // in milliseconds
    table.decimal('p95_response_time', 10, 3).defaultTo(0); // 95th percentile
    table.decimal('p99_response_time', 10, 3).defaultTo(0); // 99th percentile
    table.decimal('error_rate', 5, 2).defaultTo(0); // percentage
    table.decimal('throughput', 10, 2).defaultTo(0); // requests per second
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    // Indexes
    table.index(['endpoint', 'window_start']);
    table.index(['window_start']);
    table.unique(['endpoint', 'method', 'window_start']);
  });

  // Create indexes for performance
  await knex.raw('CREATE INDEX idx_monitoring_alerts_endpoint_created ON monitoring_alerts(endpoint, created_at DESC)');
  await knex.raw('CREATE INDEX idx_monitoring_alerts_severity_created ON monitoring_alerts(severity, created_at DESC)');
  await knex.raw('CREATE INDEX idx_endpoint_performance_endpoint_window ON endpoint_performance_metrics(endpoint, window_start DESC)');
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('endpoint_performance_metrics');
  await knex.schema.dropTableIfExists('monitoring_notifications');
  await knex.schema.dropTableIfExists('monitoring_alerts');
};
