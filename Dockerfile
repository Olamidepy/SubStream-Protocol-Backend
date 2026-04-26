# Multi-stage optimized Dockerfile for Kubernetes deployment
# Stage 1: Builder
FROM node:18-alpine AS builder

# Set build arguments
ARG NODE_ENV=production
ARG NPM_REGISTRY=https://registry.npmjs.org/

# Install build dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Configure npm registry if provided
RUN if [ "$NPM_REGISTRY" != "https://registry.npmjs.org/" ]; then \
        npm config set registry "$NPM_REGISTRY"; \
    fi

# Install all dependencies including devDependencies
RUN npm ci --include=dev

# Copy source code
COPY . .

# Build TypeScript application
RUN npm run build

# Clean up dev dependencies to reduce final image size
RUN npm prune --production

# Stage 2: Production
FROM node:18-alpine AS production

# Security: Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Install runtime dependencies
RUN apk add --no-cache \
    curl \
    ca-certificates \
    && rm -rf /var/cache/apk/*

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production --ignore-scripts && \
    npm cache clean --force

# Copy compiled application from builder stage
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules

# Copy other necessary files
COPY --chown=nodejs:nodejs index.js ./
COPY --chown=nodejs:nodejs knexfile.js ./
COPY --chown=nodejs:nodejs .env.example ./.env.example

# Copy Knex migrations for initContainer
COPY --chown=nodejs:nodejs migrations ./migrations
COPY --chown=nodejs:nodejs scripts ./scripts

# Create data directory with proper permissions
RUN mkdir -p /app/data && \
    chown nodejs:nodejs /app/data

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Set entrypoint for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "index.js"]
