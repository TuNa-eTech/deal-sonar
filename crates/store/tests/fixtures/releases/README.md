# Release database fixtures

Each file here is a database written by a **released** DealSonar build, populated with
**synthetic data only** (no real posts, names, phone numbers or tokens). The test
`every_checked_in_release_database_still_migrates_and_opens`
(`crates/core/tests/upgrade_continuity.rs`) copies every `*.sqlite3` in this directory, opens it with
the current build (which applies pending migrations in place) and asserts the lead count is unchanged.

## Adding one when you cut a release

1. Install the release build on a scratch machine or profile. Create a test radar and at least one
   lead from fabricated posts. Do not use a real Facebook account's data.
2. Quit the app, then take a consistent copy: `sqlite3 <data-dir>/dealsonar.db ".backup 'vX.Y.Z.sqlite3'"`.
3. Clear anything secret or personal: `sqlite3 vX.Y.Z.sqlite3 "DELETE FROM settings; DELETE FROM outbox;"`
   and confirm with `sqlite3 vX.Y.Z.sqlite3 "SELECT name FROM sqlite_master"` that nothing else holds credentials.
4. Commit it as `vX.Y.Z.sqlite3` in this directory.

Until the first customer release exists this directory is empty on purpose; the upgrade test also
builds a database in the oldest schema (migration 0001) so the upgrade path is exercised today.
