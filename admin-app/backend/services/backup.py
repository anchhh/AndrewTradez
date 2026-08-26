"""
Point-in-time snapshots of the SQLite lead database.

Exists because there was no copy of leads.db anywhere. When the leads table
was emptied on 2026-08-26 there was no WAL, no journal and no backup, so
five leads were simply gone -- and the file is gitignored, so source control
was never going to help either.

Snapshots are taken on startup and immediately before any destructive bulk
operation. They use SQLite's own backup API rather than a file copy, so a
snapshot taken while the app is mid-write is still a consistent database
rather than a torn one.

No-ops on anything other than SQLite: on Postgres (the eventual deployment)
this is the hosting provider's job, not ours.
"""
import os
import re
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

BACKUP_DIR_NAME = "backups"
KEEP = 20  # ~81KB each today, so twenty costs a couple of megabytes
_STAMP_RE = re.compile(r"^leads-(\d{8}-\d{6})-([a-z0-9-]+)\.db$")

# estly Studio keeps accounts and video projects in flat JSON beside its
# package rather than in the database, so a snapshot of leads.db alone would
# leave the drafts and the logins themselves unprotected.
SIDECAR_FILES = ("projects.json", "users.json")


def _sqlite_path(app):
    """The database file, or None when this isn't SQLite."""
    uri = app.config.get("SQLALCHEMY_DATABASE_URI") or ""
    if not uri.startswith("sqlite:///"):
        return None
    path = Path(uri[len("sqlite:///"):])
    return path if path.is_file() else None


def backup_dir(app):
    return Path(os.path.dirname(os.path.abspath(app.root_path))) / "backend" / BACKUP_DIR_NAME


def snapshot(app, reason="manual", skip_if_unchanged=False):
    """Copy the database aside, labelled with why. Returns the new path, or
    None when there's nothing to snapshot. Never raises: a failed backup must
    not take down the request that triggered it.

    skip_if_unchanged exists for the startup snapshot. The dev server's
    reloader restarts on every file edit, so a working session would
    otherwise fill all KEEP slots with identical copies within minutes and
    prune away genuinely older ones. If the database hasn't been written
    since the newest snapshot, there is nothing new to save.
    """
    try:
        source = _sqlite_path(app)
        if source is None:
            return None

        target_dir = source.parent / BACKUP_DIR_NAME

        if skip_if_unchanged and target_dir.is_dir():
            newest = max(
                (p.stat().st_mtime for p in target_dir.glob("leads-*.db")),
                default=None,
            )
            if newest is not None and source.stat().st_mtime <= newest:
                return None
        target_dir.mkdir(parents=True, exist_ok=True)

        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        safe_reason = re.sub(r"[^a-z0-9-]+", "-", reason.lower()).strip("-") or "manual"
        target = target_dir / f"leads-{stamp}-{safe_reason}.db"

        src = sqlite3.connect(str(source))
        try:
            dst = sqlite3.connect(str(target))
            try:
                src.backup(dst)  # consistent even against a live database
            finally:
                dst.close()
        finally:
            src.close()

        _snapshot_sidecars(source, target_dir, stamp, safe_reason)
        prune(target_dir)
        return target
    except Exception:  # noqa: BLE001 -- a backup must never break the app
        return None


def _snapshot_sidecars(source, target_dir, stamp, reason):
    """Copy Studio's flat-file stores alongside the database snapshot, under
    the same timestamp so a restore can take a matching set."""
    studio_dir = source.parent / "studio"
    for name in SIDECAR_FILES:
        src = studio_dir / name
        if not src.is_file():
            continue
        try:
            shutil.copy2(src, target_dir / f"{name.rsplit('.',1)[0]}-{stamp}-{reason}.json")
        except OSError:
            pass


def prune(target_dir, keep=KEEP):
    """Keep the newest `keep` snapshots, oldest deleted first."""
    try:
        snaps = sorted(
            (p for p in target_dir.glob("leads-*.db") if _STAMP_RE.match(p.name)),
            key=lambda p: p.name,
            reverse=True,
        )
        for old in snaps[keep:]:
            old.unlink(missing_ok=True)
        # Sidecars are pruned by the same retention, matched on timestamp.
        keep_stamps = {_STAMP_RE.match(p.name).group(1) for p in snaps[:keep]}
        for side in target_dir.glob("*.json"):
            stamp_match = re.search(r"(\d{8}-\d{6})", side.name)
            if stamp_match and stamp_match.group(1) not in keep_stamps:
                side.unlink(missing_ok=True)
    except Exception:  # noqa: BLE001
        pass


def list_snapshots(app):
    """Newest first, for reporting. Each entry is (path, when, reason, bytes)."""
    source = _sqlite_path(app)
    if source is None:
        return []
    target_dir = source.parent / BACKUP_DIR_NAME
    if not target_dir.is_dir():
        return []

    out = []
    for path in target_dir.glob("leads-*.db"):
        match = _STAMP_RE.match(path.name)
        if not match:
            continue
        when = datetime.strptime(match.group(1), "%Y%m%d-%H%M%S").replace(tzinfo=timezone.utc)
        out.append((path, when, match.group(2), path.stat().st_size))
    return sorted(out, key=lambda row: row[1], reverse=True)
