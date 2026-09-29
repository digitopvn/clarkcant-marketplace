-- Baseline categories. `INSERT OR IGNORE` keeps the migration safe if an operator created a slug by hand first.
INSERT OR IGNORE INTO `categories` (`slug`, `name`, `description`, `position`) VALUES
	('widgets', 'Widgets', 'Interactive widgets that render inside ClarkCant surfaces.', 10),
	('dashboards', 'Dashboards', 'Composed views that summarise data at a glance.', 20),
	('productivity', 'Productivity', 'Tools for planning, notes, tasks and focus.', 30),
	('data', 'Data', 'Charts, tables and connectors for working with data.', 40),
	('media', 'Media', 'Images, audio, video and other rich media experiences.', 50),
	('developer-tools', 'Developer tools', 'Utilities for building, testing and debugging.', 60);
