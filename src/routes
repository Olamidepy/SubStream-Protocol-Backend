import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { auditMiddleware } from '../utils/audit';
import { treasuryService } from '../services/treasuryService';
import { logger } from '../utils/logger';

const router = Router();

// GET /api/v1/merchants/:id/treasury/consolidated
router.get('/:id/treasury/consolidated', 
  auditMiddleware('get_consolidated_treasury', 'data_access'),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    
    try {
      const consolidatedTreasury = await treasuryService.getConsolidatedTreasury(id);
      
      if (!consolidatedTreasury) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Merchant not found or no treasury data available for merchant ID: ${id}`,
          timestamp: new Date().toISOString()
        });
      }

      res.json({
        success: true,
        data: consolidatedTreasury,
        timestamp: new Date().toISOString(),
        message: 'Consolidated treasury retrieved successfully'
      });
    } catch (error) {
      logger.error('Error in consolidated treasury endpoint', { merchantId: id, error });
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to retrieve consolidated treasury data',
        timestamp: new Date().toISOString()
      });
    }
  })
);

// GET /api/v1/merchants/:id/treasury/history
router.get('/:id/treasury/history',
  auditMiddleware('get_treasury_history', 'data_access'),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { days = '30' } = req.query;
    
    try {
      const history = await treasuryService.getTreasuryHistory(id, parseInt(days as string));
      
      res.json({
        success: true,
        data: {
          merchantId: id,
          history,
          period: `${days} days`
        },
        timestamp: new Date().toISOString(),
        message: 'Treasury history retrieved successfully'
      });
    } catch (error) {
      logger.error('Error in treasury history endpoint', { merchantId: id, error });
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to retrieve treasury history',
        timestamp: new Date().toISOString()
      });
    }
  })
);

export { router as merchantRoutes };
