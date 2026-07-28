import { closeDatabasePool } from '../lib/db';
import { toSafeError } from '../lib/safeError';
import type { DocumentKind } from '../lib/uploadInput';
import {
  countDocumentsForReingestion,
  queueDocumentsForReingestion,
  SUPPORTED_REINGESTION_DOCUMENT_KINDS,
} from '../repositories/files';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DOCUMENT_REINGESTION_USAGE = [
  'Document reingestion (dry-run, missing active generation only by default)',
  '',
  'Preview eligible documents:',
  '  npm run reindex:documents -- --limit 100',
  '',
  'Preview one document kind:',
  '  npm run reindex:documents -- --document-kind pdf --limit 100',
  '',
  'Queue one project space:',
  '  npm run reindex:documents -- --force --project-space-id <uuid> --limit 100',
  '',
  'Explicitly include documents that already have an active generation:',
  '  npm run reindex:documents -- --include-active --limit 100',
  '',
  'Queue across the entire database:',
  '  npm run reindex:documents -- --force --confirm-all --limit 100',
].join('\n');

export interface DocumentReingestionCliOptions {
  force: boolean;
  confirmAll: boolean;
  includeActive: boolean;
  help: boolean;
  limit: number;
  projectSpaceId: string | null;
  documentKind: DocumentKind | null;
}

const requireValue = (args: string[], index: number, flag: string) => {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
};

const parseDocumentKind = (value: string): DocumentKind => {
  if (!SUPPORTED_REINGESTION_DOCUMENT_KINDS.includes(value as DocumentKind)) {
    throw new Error(
      `--document-kind must be one of: ${SUPPORTED_REINGESTION_DOCUMENT_KINDS.join(', ')}`,
    );
  }
  return value as DocumentKind;
};

export const parseDocumentReingestionArgs = (args: string[]): DocumentReingestionCliOptions => {
  const options: DocumentReingestionCliOptions = {
    force: false,
    confirmAll: false,
    includeActive: false,
    help: false,
    limit: DEFAULT_LIMIT,
    projectSpaceId: null,
    documentKind: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--force') options.force = true;
    else if (arg === '--confirm-all') options.confirmAll = true;
    else if (arg === '--include-active') options.includeActive = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--limit') {
      const value = requireValue(args, index, arg);
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        throw new Error(`--limit must be an integer between 1 and ${MAX_LIMIT}`);
      }
      options.limit = parsed;
      index += 1;
    } else if (arg === '--project-space-id') {
      const value = requireValue(args, index, arg);
      if (!UUID_PATTERN.test(value)) throw new Error('--project-space-id must be a UUID');
      options.projectSpaceId = value;
      index += 1;
    } else if (arg === '--document-kind') {
      options.documentKind = parseDocumentKind(requireValue(args, index, arg));
      index += 1;
    } else {
      throw new Error(`Unsupported argument: ${arg}`);
    }
  }

  if (options.force && !options.projectSpaceId && !options.confirmAll) {
    throw new Error('Full-database reingestion requires --confirm-all together with --force');
  }
  return options;
};

interface DocumentReingestionDependencies {
  countTargets?: typeof countDocumentsForReingestion;
  queueTargets?: typeof queueDocumentsForReingestion;
}

export const runDocumentReingestion = async (
  options: DocumentReingestionCliOptions,
  dependencies: DocumentReingestionDependencies = {},
) => {
  if (options.force && !options.projectSpaceId && !options.confirmAll) {
    throw new Error('Full-database reingestion requires --confirm-all together with --force');
  }

  const countTargets = dependencies.countTargets || countDocumentsForReingestion;
  const queueTargets = dependencies.queueTargets || queueDocumentsForReingestion;
  const targetOptions = {
    projectSpaceId: options.projectSpaceId,
    includeActive: options.includeActive,
    documentKind: options.documentKind,
  };
  const targetCount = await countTargets(targetOptions);
  const scope = options.projectSpaceId ? 'project-space' : 'all';

  if (!options.force) {
    return {
      mode: 'dry-run' as const,
      scope,
      project_space_id: options.projectSpaceId,
      document_kind: options.documentKind,
      include_active: options.includeActive,
      target_count: targetCount,
      batch_limit: options.limit,
      would_queue_count: Math.min(targetCount, options.limit),
      next: options.projectSpaceId
        ? 'Run again with --force and the same filters to queue this batch.'
        : 'Run again with --force --confirm-all and the same filters to queue a full-database batch.',
    };
  }

  const queued = await queueTargets({
    ...targetOptions,
    limit: options.limit,
  });
  return {
    mode: 'force' as const,
    scope,
    project_space_id: options.projectSpaceId,
    document_kind: options.documentKind,
    include_active: options.includeActive,
    target_count: targetCount,
    batch_limit: options.limit,
    queued_count: queued.length,
    queued_file_ids: queued.map((file) => file.id),
    remaining_estimate: Math.max(0, targetCount - queued.length),
    dispatch: 'existing-file-ingestion-queue',
  };
};

const main = async () => {
  const options = parseDocumentReingestionArgs(process.argv.slice(2));
  if (options.help) {
    console.log(DOCUMENT_REINGESTION_USAGE);
    return;
  }
  const result = await runDocumentReingestion(options);
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main()
    .catch((error) => {
      console.error('[DocumentReingestion] Failed:', toSafeError(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDatabasePool();
    });
}
