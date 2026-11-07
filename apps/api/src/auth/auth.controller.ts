import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { telegramId } from '../common/validate';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('telegram')
  login(@Body() body: { initData?: string }) {
    if (!body?.initData) throw new BadRequestException('initData لازم است');
    return this.auth.loginWithInitData(body.initData);
  }

  @Post('code/request')
  requestCode(@Body() body: { telegramId?: string }) {
    return this.auth.requestCode(telegramId(body?.telegramId));
  }

  @Post('code/verify')
  verifyCode(@Body() body: { telegramId?: string; code?: string }) {
    if (!body?.code) throw new BadRequestException('کد را وارد کنید');
    return this.auth.verifyCode(telegramId(body.telegramId), body.code);
  }
}
