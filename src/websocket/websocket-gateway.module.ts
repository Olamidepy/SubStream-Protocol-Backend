import { Module } from '@nestjs/common';
import { MerchantWebSocketGateway } from './websocket.gateway.simple';
import { DunningService } from './dunning.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  providers: [MerchantWebSocketGateway, DunningService],
  exports: [MerchantWebSocketGateway, DunningService],
})
export class WebSocketGatewayModule {}
