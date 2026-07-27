import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { AppRequest } from '../http/app-request';
import { resolveAuthenticatedUser } from '../../services/authentication';

@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AppRequest>();
    const accessToken = request.cookies?.access_token;

    if (typeof accessToken !== 'string' || !accessToken) {
      throw new HttpException({ error: 'Unauthorized: No access token' }, 401);
    }

    const user = await resolveAuthenticatedUser(accessToken);
    if (!user) {
      throw new HttpException(
        { error: 'Unauthorized: Invalid or expired token' },
        401,
      );
    }

    request.user = user;
    return true;
  }
}
