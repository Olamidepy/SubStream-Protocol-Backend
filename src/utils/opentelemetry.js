const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { ConsoleSpanExporter } = require('@opentelemetry/sdk-trace-base');
const { diag, DiagConsoleLogger, DiagLogLevel } = require('@opentelemetry/api');

function parseOtlpHeaders(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') {
    return undefined;
  }

  return Object.fromEntries(
    headerValue
      .split(',')
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => pair.split('=').map((value) => value.trim()))
      .filter((tuple) => tuple.length === 2)
  );
}

function createTraceExporter() {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const headers = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);

  if (endpoint) {
    return new OTLPTraceExporter({ url: endpoint, headers });
  }

  return new ConsoleSpanExporter();
}

function getDiagLevel() {
  const level = (process.env.OTEL_DIAG_LEVEL || 'error').toUpperCase();
  return DiagLogLevel[level] || DiagLogLevel.ERROR;
}

function initTracing(options = {}) {
  if (process.env.OTEL_DISABLED === 'true' || global.__substreamOtelInitialized) {
    return;
  }

  diag.setLogger(new DiagConsoleLogger(), getDiagLevel());

  const serviceName = process.env.OTEL_SERVICE_NAME || options.serviceName || 'substream-protocol-backend';
  const serviceVersion = process.env.OTEL_SERVICE_VERSION || options.serviceVersion || '1.0.0';

  const sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: serviceVersion,
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
    }),
    traceExporter: createTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingPaths: process.env.OTEL_IGNORE_PATHS ? process.env.OTEL_IGNORE_PATHS.split(',') : ['/health', '/metrics'],
        },
        '@opentelemetry/instrumentation-express': {
          requestHook: (span, info) => {
            if (span && info) {
              span.setAttribute('http.route', info.route || info.request?.url || '/');
            }
          },
        },
      }),
    ],
  });

  sdk.start()
    .then(() => {
      console.log('[Tracing] OpenTelemetry initialized', {
        serviceName,
        serviceVersion,
      });
    })
    .catch((error) => {
      console.error('[Tracing] Failed to initialize OpenTelemetry', error);
    });

  const shutdown = async () => {
    try {
      await sdk.shutdown();
      console.log('[Tracing] OpenTelemetry shutdown complete');
    } catch (error) {
      console.error('[Tracing] OpenTelemetry shutdown failed', error);
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  global.__substreamOtelInitialized = true;
}

module.exports = {
  initTracing,
};
