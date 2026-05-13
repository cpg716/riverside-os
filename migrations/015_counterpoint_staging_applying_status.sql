-- Allow staged Counterpoint batch application to claim durable ownership
-- before payload mutations run.
ALTER TABLE counterpoint_staging_batch
DROP CONSTRAINT IF EXISTS counterpoint_staging_batch_status_check;

ALTER TABLE counterpoint_staging_batch
ADD CONSTRAINT counterpoint_staging_batch_status_check
CHECK (status IN ('pending', 'applying', 'applied', 'discarded', 'failed'));
