import {
  Controller, Post, Get, Body, Req, HttpCode, HttpStatus, Query,
} from '@nestjs/common';
import { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { TelegramAuthService } from './telegram-auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { TelegramAuthDto } from './dto/telegram-auth.dto';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private auth: AuthService,
    private telegramAuth: TelegramAuthService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  @ApiOperation({ summary: 'Register with email + password' })
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.auth.register(dto, req.ip);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email + password' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, req.ip);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('telegram')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Login / register via Telegram Login Widget',
    description:
      'Validates the HMAC-SHA256 signed payload from the Telegram Login Widget. ' +
      'Creates a new user on first call, reuses existing on subsequent calls. ' +
      'Returns the same JWT pair as email/password login.',
  })
  telegramLogin(@Body() dto: TelegramAuthDto, @Req() req: Request) {
    return this.telegramAuth.loginWithTelegram(dto, req.ip);
  }

  /**
   * GET /auth/telegram/callback — for Telegram Login Widget redirect mode.
   * The widget can be configured to redirect to this URL with params in query string.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Get('telegram/callback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Telegram Login Widget redirect callback (GET)' })
  telegramCallback(@Query() dto: TelegramAuthDto, @Req() req: Request) {
    return this.telegramAuth.loginWithTelegram(dto, req.ip);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate refresh token' })
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Logout and revoke tokens' })
  logout(@CurrentUser() user: JwtPayload, @Req() req: Request) {
    return this.auth.logout(user.sub, req.ip, user.jti, user.exp);
  }

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get current authenticated user' })
  me(@CurrentUser() user: JwtPayload) {
    return this.auth.getMe(user.sub);
  }
}
