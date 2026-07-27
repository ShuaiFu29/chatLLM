import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(serverRoot, 'src');
const modulesRoot = path.join(sourceRoot, 'modules');
const legacyControllersRoot = path.join(sourceRoot, 'controllers');
const failures = [];

const listFiles = (directory) => {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(absolutePath) : [absolutePath];
  });
};

for (const controller of listFiles(legacyControllersRoot)) {
  failures.push(`legacy controller remains: ${path.relative(serverRoot, controller)}`);
}

for (const absolutePath of listFiles(sourceRoot)) {
  if (!absolutePath.endsWith('.ts')) continue;
  const relativePath = path.relative(sourceRoot, absolutePath);
  const source = fs.readFileSync(absolutePath, 'utf8');

  if (/\b(?:from|require\(|import\()\s*['"][^'"]*controllers[\\/]/.test(source)) {
    failures.push(`${relativePath} imports a legacy controller handler`);
  }
  if (!absolutePath.startsWith(modulesRoot) || !absolutePath.endsWith('.controller.ts')) {
    continue;
  }
  if (/@(?:Res|Response)\s*\(/.test(source)) {
    failures.push(`${relativePath} takes over the native response`);
  }
  if (/@(?:Req|Request)\s*\(/.test(source) || /@Inject\s*\(\s*REQUEST\s*\)/.test(source)) {
    failures.push(`${relativePath} injects the native request directly`);
  }
  if (/\b(?:AppReply|AppRequest)\b/.test(source)) {
    failures.push(`${relativePath} depends on an adapter request or reply type`);
  }
}

if (failures.length > 0) {
  console.error('Native Nest controller check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Native Nest controller check passed.');
}
