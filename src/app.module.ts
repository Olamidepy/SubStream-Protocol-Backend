import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { WebSocketGatewayModule } from './websocket/websocket-gateway.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    AuthModule,
    WebSocketGatewayModule,
    RedisModule,
  ],
})
export class AppModule {}
