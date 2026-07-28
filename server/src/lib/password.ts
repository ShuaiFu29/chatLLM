import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'crypto';
const ALGORITHM = 'scrypt';
const VERSION = 'v1';
const COST = 32768;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

const deriveKey = async (password: string, salt: Buffer) => (
  new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, KEY_LENGTH, {
      N: COST,
      r: BLOCK_SIZE,
      p: PARALLELIZATION,
      maxmem: MAX_MEMORY,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  })
);

export const hashPassword = async (password: string) => {
  const salt = randomBytes(16);
  const derivedKey = await deriveKey(password, salt);
  return [
    ALGORITHM,
    VERSION,
    COST,
    BLOCK_SIZE,
    PARALLELIZATION,
    salt.toString('base64url'),
    derivedKey.toString('base64url'),
  ].join('$');
};

export const verifyPassword = async (password: string, encodedHash: string) => {
  const parts = encodedHash.split('$');
  if (parts.length !== 7) return false;
  const [algorithm, version, cost, blockSize, parallelization, saltValue, hashValue] = parts;
  if (
    algorithm !== ALGORITHM
    || version !== VERSION
    || cost !== String(COST)
    || blockSize !== String(BLOCK_SIZE)
    || parallelization !== String(PARALLELIZATION)
    || !saltValue
    || !hashValue
  ) {
    return false;
  }

  try {
    const salt = Buffer.from(saltValue, 'base64url');
    const storedKey = Buffer.from(hashValue, 'base64url');
    if (salt.length !== 16 || storedKey.length !== KEY_LENGTH) return false;

    const candidateKey = await deriveKey(password, salt);
    return timingSafeEqual(candidateKey, storedKey);
  } catch {
    return false;
  }
};

export const DUMMY_PASSWORD_HASH = [
  ALGORITHM,
  VERSION,
  COST,
  BLOCK_SIZE,
  PARALLELIZATION,
  Buffer.alloc(16).toString('base64url'),
  Buffer.alloc(KEY_LENGTH).toString('base64url'),
].join('$');
