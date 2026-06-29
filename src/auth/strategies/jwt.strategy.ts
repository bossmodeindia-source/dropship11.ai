import { Injectable, UnauthorizedException, Inject } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { JwtPayload } from '../../common/decorators/current-user.decorator';
import { REDIS_CLIENT } from '../../common/redis/redis.module';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<JwtPayload> {
    if (!payload.sub || !payload.email) {
      throw new UnauthorizedException('Malformed token');
    }
    // Reject blacklisted tokens (e.g. post-logout access tokens)
    if (payload.jti) {
      const blacklisted = await this.redis.exists(`bl:${payload.jti}`);
      if (blacklisted) throw new UnauthorizedException('Token revoked');
    }
    return payload;
  }
}
