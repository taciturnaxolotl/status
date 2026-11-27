DROP INDEX IF EXISTS idx_incidents_github;
ALTER TABLE incidents DROP COLUMN github_repo;
ALTER TABLE incidents DROP COLUMN github_issue_number;
