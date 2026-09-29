-- Full-text index over listings. Maintained by application code (write-through in the indexing and curation
-- commands), not by triggers, so the indexed text can include values joined from other tables (publisher name,
-- facet kinds) without trigger fan-out. `package_id` joins back to `packages.id` and is not tokenized.
CREATE VIRTUAL TABLE `packages_fts` USING fts5(
	`package_id` UNINDEXED,
	`name`,
	`display_name`,
	`description`,
	`keywords`,
	`publisher`,
	`facets`,
	tokenize = 'unicode61 remove_diacritics 2',
	prefix = '2 3 4'
);
