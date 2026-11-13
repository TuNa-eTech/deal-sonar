use dealsonar_store::Store;
#[test]
fn restore_is_staged_validated_and_preserves_recovery_copy() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("dealsonar.db");
    let backups = tmp.path().join("backups");
    let live = Store::open(&db, &backups).unwrap();
    live.set_setting("test", &"original").unwrap();
    let source = tmp.path().join("external.sqlite3");
    live.backup_database(&source).unwrap();
    live.set_setting("test", &"newer").unwrap();
    let saved = rusqlite::Connection::open(&source).unwrap();
    saved.execute("INSERT INTO channels(id,kind,name,config,state,created_at) VALUES('restore-channel','telegram','Saved channel','{}','ok',0)",[]).unwrap();
    saved.execute("INSERT INTO outbox(id,channel_id,kind,payload,state,next_try_at,created_at) VALUES('restore-message','restore-channel','test','{}','pending',0,0)",[]).unwrap();
    drop(saved);
    Store::stage_restore(&source, tmp.path()).unwrap();
    assert_eq!(
        live.get_setting::<String>("test").unwrap().unwrap(),
        "newer"
    );
    drop(live);
    Store::apply_pending_restore(&db, &backups).unwrap();
    let inspect = rusqlite::Connection::open(&db).unwrap();
    assert_eq!(
        inspect
            .query_row(
                "SELECT state FROM channels WHERE id='restore-channel'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "error"
    );
    assert_eq!(
        inspect
            .query_row(
                "SELECT state FROM outbox WHERE id='restore-message'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "dropped"
    );
    drop(inspect);
    let restored = Store::open(&db, &backups).unwrap();
    assert_eq!(
        restored.get_setting::<String>("test").unwrap().unwrap(),
        "original"
    );
    assert!(!tmp.path().join("restore-pending.sqlite3").exists());
    let recovery = std::fs::read_dir(&backups)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("before-restore-")
        })
        .unwrap();
    let old = Store::open(recovery, tmp.path().join("other-backups")).unwrap();
    assert_eq!(old.get_setting::<String>("test").unwrap().unwrap(), "newer");
}
#[test]
fn invalid_backup_does_not_replace_pending_or_live() {
    let tmp = tempfile::tempdir().unwrap();
    let live = Store::open(tmp.path().join("dealsonar.db"), tmp.path().join("backups")).unwrap();
    live.set_setting("test", &"keep").unwrap();
    let invalid = tmp.path().join("not-a-db");
    std::fs::write(&invalid, b"bad").unwrap();
    assert!(Store::stage_restore(&invalid, tmp.path()).is_err());
    assert!(!tmp.path().join("restore-pending.sqlite3").exists());
    assert_eq!(live.get_setting::<String>("test").unwrap().unwrap(), "keep");
}
