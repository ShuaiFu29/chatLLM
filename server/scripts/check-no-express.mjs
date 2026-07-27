import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbiddenPackages = [
  'express',
  '@nestjs/platform-express',
  'multer',
  'cookie-parser',
  'cors',
  '@types/express',
  '@types/multer',
  '@types/cookie-parser',
  '@types/cors',
];
const forbiddenPaths = [
  'src/index.ts',
  'src/routes',
  'src/middleware',
  'src/lib/uploadMiddleware.ts',
];
const sourcePatterns = [
  /(?:from\s+|require\()['"]express['"]\)?/,
  /(?:from\s+|require\()['"]multer['"]\)?/,
  /@nestjs\/platform-express/,
  /(?:from\s+|require\()['"]cookie-parser['"]\)?/,
  /\b(?:ErrorRequestHandler|RequestHandler|NextFunction|Multer\.)\b/,
  /\bExpress\.(?:Request|Response)\b/,
];

const failures = [];
const packageJson = JSON.parse(fs.readFileSync(path.join(serverRoot, 'package.json'), 'utf8'));
for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
  for (const dependency of Object.keys(packageJson[section] || {})) {
    if (forbiddenPackages.includes(dependency)) {
      failures.push(`package.json ${section} contains ${dependency}`);
    }
  }
}

const lock = JSON.parse(fs.readFileSync(path.join(serverRoot, 'package-lock.json'), 'utf8'));
for (const dependency of forbiddenPackages) {
  if (lock.packages?.[`node_modules/${dependency}`]) {
    failures.push(`package-lock.json contains node_modules/${dependency}`);
  }
}

for (const relativePath of forbiddenPaths) {
  if (fs.existsSync(path.join(serverRoot, relativePath))) {
    failures.push(`obsolete path remains: ${relativePath}`);
  }
}

const scanDirectory = (directory) => {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      scanDirectory(absolutePath);
      continue;
    }
    if (!/\.(?:ts|js|mjs|cjs)$/.test(entry.name)) continue;
    const source = fs.readFileSync(absolutePath, 'utf8');
    for (const pattern of sourcePatterns) {
      if (pattern.test(source)) {
        failures.push(`${path.relative(serverRoot, absolutePath)} matches ${pattern}`);
      }
    }
  }
};

for (const directory of ['src', 'dist', 'test']) {
  scanDirectory(path.join(serverRoot, directory));
}

if (failures.length > 0) {
  console.error('Express removal check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Express removal check passed.');
}
