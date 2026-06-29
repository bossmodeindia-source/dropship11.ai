import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TelegramAuthService } from './telegram-auth.service';
import { TokenService } from './token.service';
import { PasswordService } from './password.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { RedisModule } from '../common/redis/redis.module';

// NOTE: JwtAuthGuard and RolesGuard are registered globally in AppModule via APP_GUARD.
// Do NOT add APP_GUARD here — duplicate registration causes guards to run twice,
// breaking JWT blacklist checks and RBAC idempotency.

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get('JWT_EXPIRES_IN', '15m') },
      }),
    }),
    RedisModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TelegramAuthService,
    TokenService,
    PasswordService,
    JwtStrategy,
  ],
  exports: [AuthService, TelegramAuthService, TokenService, JwtModule],
})
export class AuthModule {}
