import { verifyAccessToken } from '../lib/jwt';
import { findUserById } from '../repositories/users';

type FindUserById = typeof findUserById;

export const resolveAuthenticatedUser = async (
  accessToken: string,
  findUser: FindUserById = findUserById,
) => {
  const tokenUser = verifyAccessToken(accessToken);
  if (!tokenUser) return null;

  const user = await findUser(tokenUser.id);
  if (!user || user.deletion_status !== 'active') return null;
  return user;
};
