const EventEmitter = require('events');

class StorageService extends EventEmitter {
  constructor() {
    super();
    this.pinningServices = new Map();
    this.replicationStatus = new Map(); // contentId -> replication info
    this.healthChecks = new Map();
    
    this.initializeServices();
    this.startHealthChecks();
  }

  initializeServices() {
    // Initialize multiple pinning services with their configurations
    this.pinningServices.set('pinata', {
      name: 'Pinata',
      region: 'us-east-1',
      endpoint: 'https://api.pinata.cloud',
      apiKey: process.env.PINATA_API_KEY,
      secretKey: process.env.PINATA_SECRET_KEY,
      priority: 1,
      isActive: true
    });

    this.pinningServices.set('web3storage', {
      name: 'Web3.Storage',
      region: 'eu-west-1',
      endpoint: 'https://api.web3.storage',
      apiKey: process.env.WEB3STORAGE_API_KEY,
      priority: 2,
      isActive: true
    });

    this.pinningServices.set('infura', {
      name: 'Infura IPFS',
      region: 'ap-southeast-1',
      endpoint: 'https://ipfs.infura.io',
      apiKey: process.env.INFURA_API_KEY,
      priority: 3,
      isActive: true
    });
  }

  // Pin content to multiple regions
  async pinContent(contentId, contentBuffer, options = {}) {
    const replicationInfo = {
      contentId,
      pinnedServices: [],
      failedServices: [],
      timestamp: Date.now(),
      status: 'replicating'
    };

    console.log(`Starting replication for content ${contentId}`);

    // Pin to all active services in parallel
    const pinPromises = [];
    
    for (const [serviceId, service] of this.pinningServices) {
      if (!service.isActive) continue;
      
      pinPromises.push(
        this.pinToService(serviceId, service, contentId, contentBuffer)
          .then(result => {
            replicationInfo.pinnedServices.push({
              serviceId,
              service: service.name,
              region: service.region,
              cid: result.cid,
              timestamp: Date.now(),
              latency: result.latency
            });
            return result;
          })
          .catch(error => {
            replicationInfo.failedServices.push({
              serviceId,
              service: service.name,
              error: error.message,
              timestamp: Date.now()
            });
            throw error;
          })
      );
    }

    try {
      const results = await Promise.allSettled(pinPromises);
      
      // Check if we have at least one successful pin
      const successfulPins = results.filter(r => r.status === 'fulfilled');
      
      if (successfulPins.length === 0) {
        replicationInfo.status = 'failed';
        this.replicationStatus.set(contentId, replicationInfo);
        throw new Error('All pinning services failed');
      }

      replicationInfo.status = 'completed';
      this.replicationStatus.set(contentId, replicationInfo);
      
      console.log(`Successfully pinned ${contentId} to ${successfulPins.length} services`);
      
      this.emit('replicationComplete', {
        contentId,
        replicationInfo,
        successfulPins: successfulPins.length,
        totalServices: pinPromises.length
      });

      return {
        success: true,
        contentId,
        replicationInfo,
        primaryCid: successfulPins[0].value.cid
      };

    } catch (error) {
      console.error(`Replication failed for ${contentId}:`, error);
      throw error;
    }
  }

  // Pin to individual service
  async pinToService(serviceId, service, contentId, contentBuffer) {
    const startTime = Date.now();
    
    try {
      let cid;
      
      switch (serviceId) {
        case 'pinata':
          cid = await this.pinToPinata(service, contentBuffer);
          break;
        case 'web3storage':
          cid = await this.pinToWeb3Storage(service, contentBuffer);
          break;
        case 'infura':
          cid = await this.pinToInfura(service, contentBuffer);
          break;
        default:
          throw new Error(`Unknown service: ${serviceId}`);
      }

      const latency = Date.now() - startTime;
      
      return {
        cid,
        latency,
        serviceId
      };

    } catch (error) {
      console.error(`Failed to pin to ${service.name}:`, error);
      throw error;
    }
  }

  // Pinata implementation
  async pinToPinata(service, contentBuffer) {
    const FormData = require('form-data');
    const axios = require('axios');
    
    const form = new FormData();
    form.append('file', contentBuffer, {
      filename: 'content',
      contentType: 'application/octet-stream'
    });

    const response = await axios.post(
      `${service.endpoint}/pinning/pinFileToIPFS`,
      form,
      {
        headers: {
          'pinata_api_key': service.apiKey,
          'pinata_secret_api_key': service.secretKey,
          ...form.getHeaders()
        },
        timeout: 30000
      }
    );

    return response.data.IpfsHash;
  }

  // Web3.Storage implementation
  async pinToWeb3Storage(service, contentBuffer) {
    const { Web3Storage } = require('web3.storage');
    
    const client = new Web3Storage({ token: service.apiKey });
    const files = [new File([contentBuffer], 'content')];
    
    const cid = await client.put(files);
    return cid;
  }

  // Infura implementation
  async pinToInfura(service, contentBuffer) {
    const { create } = require('ipfs-http-client');
    
    const client = create({
      host: 'ipfs.infura.io',
      port: 5001,
      protocol: 'https',
      headers: {
        authorization: `Basic ${Buffer.from(`${service.apiKey}:`).toString('base64')}`
      }
    });

    const result = await client.add(contentBuffer);
    return result.cid.toString();
  }

  // Get content with automatic failover
  async getContent(contentId, preferredRegion = null) {
    const replicationInfo = this.replicationStatus.get(contentId);
    
    if (!replicationInfo || replicationInfo.pinnedServices.length === 0) {
      throw new Error(`Content ${contentId} not found or not replicated`);
    }

    // Sort services by priority and region preference
    const sortedServices = replicationInfo.pinnedServices
      .sort((a, b) => {
        // Prefer services in the requested region
        if (preferredRegion) {
          const aInRegion = a.region === preferredRegion;
          const bInRegion = b.region === preferredRegion;
          if (aInRegion && !bInRegion) return -1;
          if (!aInRegion && bInRegion) return 1;
        }
        
        // Then by priority (lower priority number = higher priority)
        const aPriority = this.pinningServices.get(a.serviceId)?.priority || 999;
        const bPriority = this.pinningServices.get(b.serviceId)?.priority || 999;
        return aPriority - bPriority;
      });

    // Try each service in order
    for (const serviceInfo of sortedServices) {
      try {
        const content = await this.getContentFromService(
          serviceInfo.serviceId,
          serviceInfo.cid
        );
        
        // Record successful access for analytics
        this.emit('contentAccess', {
          contentId,
          serviceId: serviceInfo.serviceId,
          region: serviceInfo.region,
          latency: serviceInfo.latency
        });
        
        return content;

      } catch (error) {
        console.warn(`Failed to get content from ${serviceInfo.service}:`, error.message);
        
        // Mark service as potentially unhealthy
        this.markServiceUnhealthy(serviceInfo.serviceId);
        
        // Continue to next service
        continue;
      }
    }

    throw new Error(`Unable to retrieve content ${contentId} from any service`);
  }

  // Get content from specific service
  async getContentFromService(serviceId, cid) {
    const service = this.pinningServices.get(serviceId);
    if (!service) {
      throw new Error(`Unknown service: ${serviceId}`);
    }

    const axios = require('axios');
    
    // Use IPFS gateway URLs for content retrieval
    const gatewayUrls = {
      'pinata': `https://gateway.pinata.cloud/ipfs/${cid}`,
      'web3storage': `https://dweb.link/ipfs/${cid}`,
      'infura': `https://ipfs.io/ipfs/${cid}`
    };

    const gatewayUrl = gatewayUrls[serviceId] || `https://ipfs.io/ipfs/${cid}`;
    
    const response = await axios.get(gatewayUrl, {
      timeout: 15000,
      responseType: 'arraybuffer'
    });

    return response.data;
  }

  // Health check for services
  async checkServiceHealth(serviceId) {
    const service = this.pinningServices.get(serviceId);
    if (!service) return false;

    try {
      const axios = require('axios');
      const startTime = Date.now();
      
      await axios.get(`${service.endpoint}/health`, {
        timeout: 5000
      });
      
      const latency = Date.now() - startTime;
      
      this.healthChecks.set(serviceId, {
        isHealthy: true,
        latency,
        lastCheck: Date.now()
      });
      
      return true;

    } catch (error) {
      this.healthChecks.set(serviceId, {
        isHealthy: false,
        error: error.message,
        lastCheck: Date.now()
      });
      
      return false;
    }
  }

  // Mark service as unhealthy
  markServiceUnhealthy(serviceId) {
    const service = this.pinningServices.get(serviceId);
    if (service) {
      service.isActive = false;
      console.warn(`Marked ${service.name} as inactive due to failures`);
      
      // Schedule reactivation check
      setTimeout(() => {
        this.reactivateService(serviceId);
      }, 60000); // Check again after 1 minute
    }
  }

  // Attempt to reactivate a service
  async reactivateService(serviceId) {
    const isHealthy = await this.checkServiceHealth(serviceId);
    
    if (isHealthy) {
      const service = this.pinningServices.get(serviceId);
      if (service) {
        service.isActive = true;
        console.log(`Reactivated ${service.name}`);
      }
    }
  }

  // Start periodic health checks
  startHealthChecks() {
    setInterval(async () => {
      for (const serviceId of this.pinningServices.keys()) {
        await this.checkServiceHealth(serviceId);
      }
    }, 30000); // Check every 30 seconds
  }

  // Get replication status
  getReplicationStatus(contentId) {
    return this.replicationStatus.get(contentId) || null;
  }

  // Get service health status
  getHealthStatus() {
    const status = {};
    
    for (const [serviceId, health] of this.healthChecks) {
      const service = this.pinningServices.get(serviceId);
      status[serviceId] = {
        name: service?.name,
        region: service?.region,
        isActive: service?.isActive,
        ...health
      };
    }
    
    return status;
  }
}

// Singleton instance
const storageService = new StorageService();

module.exports = storageService;
