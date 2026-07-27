import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  deleteAccount,
  getMe,
  githubCallback,
  githubLogin,
  logout,
  refreshToken,
  updateProfile,
} from '../../controllers/auth';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AppReply, AppRequest } from '../../common/http/app-request';
import { ValidateMutation } from '../../common/interceptors/mutation-validation.interceptor';
import { mutationSchemas } from '../../lib/mutationSchemas';

@Controller('auth')
export class AuthController {
  @Get('github/login')
  githubLogin(@Req() request: AppRequest, @Res() reply: AppReply) {
    return githubLogin(request, reply);
  }

  @Get('github/callback')
  githubCallback(@Req() request: AppRequest, @Res() reply: AppReply) {
    return githubCallback(request, reply);
  }

  @Post('refresh')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.authRefresh)
  refresh(@Req() request: AppRequest, @Res() reply: AppReply) {
    return refreshToken(request, reply);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() request: AppRequest, @Res() reply: AppReply) {
    return getMe(request, reply);
  }

  @Put('me')
  @UseGuards(AuthGuard)
  @ValidateMutation(mutationSchemas.authUpdateProfile)
  update(@Req() request: AppRequest, @Res() reply: AppReply) {
    return updateProfile(request, reply);
  }

  @Delete('me')
  @UseGuards(AuthGuard)
  @ValidateMutation(mutationSchemas.authDeleteAccount)
  delete(@Req() request: AppRequest, @Res() reply: AppReply) {
    return deleteAccount(request, reply);
  }

  @Post('logout')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.authLogout)
  logout(@Req() request: AppRequest, @Res() reply: AppReply) {
    return logout(request, reply);
  }
}
