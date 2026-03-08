CREATE INDEX idx_pings_timestamp ON pings (timestamp);
CREATE INDEX idx_incidents_github ON incidents (github_repo, github_issue_number);
