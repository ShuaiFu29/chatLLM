import { closeDatabasePool } from '../lib/db';
import { toSafeError } from '../lib/safeError';
import {
  countMarkdownFilesForReingestion,
  queueMarkdownFilesForReingestion,
} from '../repositories/files';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MARKDOWN_REINGESTION_USAGE = [
  'Markdown reingestion (dry-run by default)',
  '',
  'Preview all eligible Markdown files:',
  '  npm run reindex:markdown -- -- --limit 100',
  '',
  'Queue one project space:',
  '  npm run reindex:markdown -- -- --force --project-space-id <uuid> --limit 100',
  '',
  'Queue across the entire database:',
  '  npm run reindex:markdown -- -- --force --confirm-all --limit 100',
].join('\n');

export interface MarkdownReingestionCliOptions {
  force: boolean;
  confirmAll: boolean;
  help: boolean;
  limit: number;
  projectSpaceId: string | null;
}

const requireValue = (args: string[], index: number, flag: string) => {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
};

export const parseMarkdownReingestionArgs = (args: string[]): MarkdownReingestionCliOptions => {
  const options: MarkdownReingestionCliOptions = {
    force: false,
    confirmAll: false,
    help: false,
    limit: DEFAULT_LIMIT,
    projectSpaceId: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--force') options.force = true;
    else if (arg === '--confirm-all') options.confirmAll = true;
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
    } else {
      throw new Error(`Unsupported argument: ${arg}`);
    }
  }

  if (options.force && !options.projectSpaceId && !options.confirmAll) {
    throw new Error('Full-database reingestion requires --confirm-all together with --force');
  }
  return options;
};

interface MarkdownReingestionDependencies {
  countTargets?: typeof countMarkdownFilesForReingestion;
  queueTargets?: typeof queueMarkdownFilesForReingestion;
}

export const runMarkdownReingestion = async (
  options: MarkdownReingestionCliOptions,
  dependencies: MarkdownReingestionDependencies = {},
) => {
  if (options.force && !options.projectSpaceId && !options.confirmAll) {
    throw new Error('Full-database reingestion requires --confirm-all together with --force');
  }

  const countTargets = dependencies.countTargets || countMarkdownFilesForReingestion;
  const queueTargets = dependencies.queueTargets || queueMarkdownFilesForReingestion;
  const targetCount = await countTargets(options.projectSpaceId);
  const scope = options.projectSpaceId ? 'project-space' : 'all';

  if (!options.force) {
    return {
      mode: 'dry-run' as const,
      scope,
      project_space_id: options.projectSpaceId,
      target_count: targetCount,
      batch_limit: options.limit,
      would_queue_count: Math.min(targetCount, options.limit),
      next: options.projectSpaceId
        ? 'Run again with --force and the same --project-space-id to queue this batch.'
        : 'Run again with --force --confirm-all to queue a full-database batch.',
    };
  }

  const queued = await queueTargets({
    limit: options.limit,
    projectSpaceId: options.projectSpaceId,
  });
  return {
    mode: 'force' as const,
    scope,
    project_space_id: options.projectSpaceId,
    target_count: targetCount,
    batch_limit: options.limit,
    queued_count: queued.length,
    queued_file_ids: queued.map((file) => file.id),
    remaining_estimate: Math.max(0, targetCount - queued.length),
    dispatch: 'existing-file-ingestion-queue',
  };
};

const main = async () => {
  const options = parseMarkdownReingestionArgs(process.argv.slice(2));
  if (options.help) {
    console.log(MARKDOWN_REINGESTION_USAGE);
    return;
  }
  const result = await runMarkdownReingestion(options);
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main()
    .catch((error) => {
      console.error('[MarkdownReingestion] Failed:', toSafeError(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDatabasePool();
    });
}
