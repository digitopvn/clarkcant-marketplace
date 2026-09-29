-- Published package versions are immutable: the identity, manifest, readme source, and npm integrity
-- recorded at index time never change. Derived columns stay writable so they can be refreshed:
-- `readme_html` (re-sanitization), `tarball_sha512_verified`, `provenance`, and `indexed_at`.
-- Deleting a version (package removal, data lifecycle) remains allowed.
CREATE TRIGGER `package_versions_immutable`
BEFORE UPDATE OF `package_id`, `version`, `manifest`, `readme_md`, `npm_integrity`, `published_at` ON `package_versions`
FOR EACH ROW
WHEN OLD.`package_id` IS NOT NEW.`package_id`
  OR OLD.`version` IS NOT NEW.`version`
  OR OLD.`manifest` IS NOT NEW.`manifest`
  OR OLD.`readme_md` IS NOT NEW.`readme_md`
  OR OLD.`npm_integrity` IS NOT NEW.`npm_integrity`
  OR OLD.`published_at` IS NOT NEW.`published_at`
BEGIN
  SELECT RAISE(ABORT, 'package_versions rows are immutable');
END;
