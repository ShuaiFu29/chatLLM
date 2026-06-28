import fs from 'fs';
import path from 'path';
import { withTransaction } from './db';

export const getMigrationFileNames = (fileNames: string[]) => {
  return fileNames
    .filter((fileName) => /^\d+_.+\.sql$/.test(fileName))
    .sort((a, b) => a.localeCompare(b));
};

export const runMigrations = async () => {
  const migrationsDir = path.resolve(__dirname, '../../migrations');
  const migrationFileNames = getMigrationFileNames(fs.readdirSync(migrationsDir));

  await withTransaction(async (client) => {
    await client.query(`
      create table if not exists schema_migrations (
        filename text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    for (const fileName of migrationFileNames) {
      const applied = await client.query<{ filename: string }>(
        'select filename from schema_migrations where filename = $1',
        [fileName]
      );

      if (applied.rows.length > 0) continue;

      const sql = fs.readFileSync(path.join(migrationsDir, fileName), 'utf8');
      await client.query(sql);
      await client.query('insert into schema_migrations (filename) values ($1)', [fileName]);
      console.log(`[Migrations] Applied ${fileName}`);
    }
  });
};
