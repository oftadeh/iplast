import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('telegram')
  login(@Body() body: { initData?: string }) {
    if (!body?.initData) throw new BadRequestException('initData لازم است');
    return this.auth.loginWithInitData(body.initData);
  }
}
