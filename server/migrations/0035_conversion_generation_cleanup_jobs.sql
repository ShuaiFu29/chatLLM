alter table artifact_cleanup_jobs
  drop constraint if exists artifact_cleanup_jobs_resource_type_check;

alter table artifact_cleanup_jobs
  add constraint artifact_cleanup_jobs_resource_type_check check (
    resource_type in (
      'file',
      'project_space',
      'account',
      'avatar',
      'conversion_generation'
    )
  );
