import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import {
  CurrentUser,
  RequestCookies,
  RequestId,
} from '../../common/http/request-context.decorator';
import { ValidateMutation } from '../../common/interceptors/mutation-validation.interceptor';
import {
  AuthCookies,
  AuthService,
  UpdateProfileInput,
} from './auth.service';
import { mutationSchemas } from '../../lib/mutationSchemas';
import { User } from '../../types';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('github/login')
  githubLogin() {
    return this.authService.githubLogin();
  }

  @Get('github/callback')
  githubCallback(
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @RequestCookies() cookies: AuthCookies,
    @RequestId() requestId?: string,
  ) {
    return this.authService.githubCallback({
      code: typeof code === 'string' ? code : undefined,
      state: typeof state === 'string' ? state : undefined,
      cookies,
      requestId,
    });
  }

  @Post('refresh')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.authRefresh)
  refresh(
    @RequestCookies() cookies: AuthCookies,
    @RequestId() requestId?: string,
  ) {
    return this.authService.refresh(cookies, requestId);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: User) {
    return this.authService.getMe(user);
  }

  @Put('me')
  @UseGuards(AuthGuard)
  @ValidateMutation(mutationSchemas.authUpdateProfile)
  update(
    @CurrentUser() user: User,
    @Body() input: UpdateProfileInput,
  ) {
    return this.authService.updateProfile(user, input);
  }

  @Delete('me')
  @UseGuards(AuthGuard)
  @ValidateMutation(mutationSchemas.authDeleteAccount)
  delete(
    @CurrentUser() user: User,
    @RequestId() requestId?: string,
  ) {
    return this.authService.deleteAccount(user, requestId);
  }

  @Post('logout')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.authLogout)
  logout(@RequestCookies() cookies: AuthCookies) {
    return this.authService.logout(cookies);
  }
}
