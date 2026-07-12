import { query } from '../lib/db';

interface RateLimitBucketRow {
  request_count: number | string;
  expires_at: Date | string;
}

export interface ConsumeRateLimitBucketInput {
  bucketKey: string;
  windowMs: number;
}

export interface ConsumedRateLimitBucket {
  count: number;
  resetAt: number;
}

export type RateLimitBucketConsumer = (
  input: ConsumeRateLimitBucketInput
) => Promise<ConsumedRateLimitBucket>;

export const consumeRateLimitBucket = async (
  input: ConsumeRateLimitBucketInput,
  runQuery: typeof query = query
): Promise<ConsumedRateLimitBucket> => {
  if (!input.bucketKey || input.bucketKey.length > 256) {
    throw new Error('Invalid rate-limit bucket key');
  }
  if (!Number.isSafeInteger(input.windowMs) || input.windowMs <= 0) {
    throw new Error('Invalid rate-limit window');
  }

  const { rows } = await runQuery<RateLimitBucketRow>(
    `insert into rate_limit_buckets (
       bucket_key,
       window_started_at,
       request_count,
       expires_at
     )
     select
       $1,
       clock.current_time,
       1,
       clock.current_time + ($2::double precision * interval '1 millisecond')
     from (select clock_timestamp() as current_time) as clock
     on conflict (bucket_key) do update
     set
       window_started_at = case
         when rate_limit_buckets.expires_at <= excluded.window_started_at
           then excluded.window_started_at
         else rate_limit_buckets.window_started_at
       end,
       request_count = case
         when rate_limit_buckets.expires_at <= excluded.window_started_at then 1
         else rate_limit_buckets.request_count + 1
       end,
       expires_at = case
         when rate_limit_buckets.expires_at <= excluded.window_started_at
           then excluded.expires_at
         else rate_limit_buckets.expires_at
       end
     returning request_count, expires_at`,
    [input.bucketKey, input.windowMs]
  );

  const row = rows[0];
  const count = Number(row?.request_count);
  const resetAt = row ? new Date(row.expires_at).getTime() : Number.NaN;
  if (!Number.isSafeInteger(count) || count <= 0 || !Number.isFinite(resetAt)) {
    throw new Error('Invalid rate-limit store response');
  }

  return { count, resetAt };
};
export const deleteExpiredRateLimitBuckets = async (
  limit = 1000,
  runQuery: typeof query = query
) => {
  const boundedLimit = Number.isSafeInteger(limit)
    ? Math.min(Math.max(limit, 1), 10000)
    : 1000;
  const { rowCount } = await runQuery(
    `with expired as (
       select bucket_key
       from rate_limit_buckets
       where expires_at <= clock_timestamp()
       order by expires_at asc
       limit $1
     )
     delete from rate_limit_buckets as bucket
     using expired
     where bucket.bucket_key = expired.bucket_key
       and bucket.expires_at <= clock_timestamp()`,
    [boundedLimit]
  );
  return rowCount || 0;
};
