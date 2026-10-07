CREATE TABLE `package_version_artifacts` (
	`package_version_id` text PRIMARY KEY NOT NULL,
	`manifest_id` text,
	`content_digest` text,
	`size_bytes` integer,
	`file_count` integer,
	`digest_problem` text,
	`computed_at` integer NOT NULL,
	FOREIGN KEY (`package_version_id`) REFERENCES `package_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `package_version_artifacts_manifest_id_idx` ON `package_version_artifacts` (`manifest_id`);