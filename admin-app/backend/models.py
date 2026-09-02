import json
from datetime import datetime, timezone

from extensions import db

VALID_STATUSES = ("new", "contacted", "responded", "converted", "dead")
VALID_SOURCES = ("zillow", "realtor", "redfin", "homes", "airbnb", "manual", "csv")


def _utcnow():
    return datetime.now(timezone.utc)


class Lead(db.Model):
    __tablename__ = "leads"

    id = db.Column(db.Integer, primary_key=True)

    # Which Studio account this lead belongs to (studio/users.json id).
    # Every /studio/* lead route filters on it, so one user never sees
    # another's leads. Nullable only because the column was added to an
    # existing table; new rows always set it.
    owner_id = db.Column(db.String(64), nullable=True, index=True)

    source = db.Column(db.String(20), nullable=False, default="manual")
    external_id = db.Column(db.String(120), nullable=True)
    listing_url = db.Column(db.String(500), nullable=True)

    # Cross-source dedup: one row per physical property, even if seen from
    # multiple feeds. See services/dedup.py for how this key is built.
    dedup_key = db.Column(db.String(300), nullable=True, index=True)
    sources_json = db.Column(db.Text, nullable=False, default="[]")
    external_ids_json = db.Column(db.Text, nullable=False, default="{}")
    times_seen = db.Column(db.Integer, nullable=False, default=1)
    last_seen_at = db.Column(db.DateTime, nullable=False, default=_utcnow)

    address = db.Column(db.String(255), nullable=False)
    city = db.Column(db.String(120), nullable=True)
    state = db.Column(db.String(40), nullable=True)
    zip_code = db.Column(db.String(20), nullable=True)

    price = db.Column(db.Integer, nullable=True)
    beds = db.Column(db.Float, nullable=True)
    baths = db.Column(db.Float, nullable=True)
    sqft = db.Column(db.Integer, nullable=True)
    property_type = db.Column(db.String(60), nullable=True)

    photo_urls_json = db.Column(db.Text, nullable=False, default="[]")

    # The listing agent's brokerage, taken from the site's own structured
    # data rather than page text. Needed to look up an agent whose email the
    # listing doesn't publish, and worth having on its own.
    brokerage = db.Column(db.String(160), nullable=True)

    agent_name = db.Column(db.String(120), nullable=True)
    agent_email = db.Column(db.String(255), nullable=True)

    # Ranked addresses the automatic lookup turned up, each with the reason it
    # might be this agent's. Kept even when one was confident enough to fill
    # in, so the choice can be reviewed and changed.
    email_candidates_json = db.Column(db.Text, nullable=False, default="[]")
    agent_phone = db.Column(db.String(40), nullable=True)

    status = db.Column(db.String(20), nullable=False, default="new")
    notes = db.Column(db.Text, nullable=True)

    # Every lead captured (e.g. via the Chrome extension) lands on the
    # Lead Manager page first for sorting; only leads explicitly marked
    # qualified here surface on the polished Dashboard view.
    qualified = db.Column(db.Boolean, nullable=False, default=False)

    # Outreach checklist (Lead manager dashboard) -- a timestamp rather
    # than a plain boolean so "done today" can be computed for the daily
    # activity counters without a separate log table. None = not done;
    # toggling sets/clears it (see api_toggle_outreach).
    outreach_email_sent_at = db.Column(db.DateTime, nullable=True)
    outreach_phone_called_at = db.Column(db.DateTime, nullable=True)
    outreach_video_sent_at = db.Column(db.DateTime, nullable=True)

    # The finished marketing video for this listing, somewhere the agent can
    # actually watch it. Nothing in this app renders video yet, so this is
    # filled in by hand from wherever the video was produced -- and it is what
    # makes a lead eligible for outreach at all, since the pitch is the video.
    video_url = db.Column(db.String(500), nullable=True)

    # Which room each photo shows, keyed by photo URL. Filled in automatically
    # when a lead is captured; absent for photos the classifier skipped or
    # could not read, which stay unsorted rather than being guessed at.
    photo_rooms_json = db.Column(db.Text, nullable=True)

    # Set once this lead has been pushed to GoHighLevel, so a re-send updates
    # that contact instead of creating a second one.
    ghl_contact_id = db.Column(db.String(64), nullable=True)

    # Dismissed from the outreach queue by hand. Distinct from "sent": this
    # lead is one we decided not to mail, and it should stop coming back.
    outreach_skipped = db.Column(db.Boolean, nullable=False, default=False)

    created_at = db.Column(db.DateTime, nullable=False, default=_utcnow)
    updated_at = db.Column(db.DateTime, nullable=False, default=_utcnow, onupdate=_utcnow)

    @property
    def photo_rooms(self):
        return json.loads(self.photo_rooms_json or "{}")

    @photo_rooms.setter
    def photo_rooms(self, value):
        self.photo_rooms_json = json.dumps(value or {})

    @property
    def email_candidates(self):
        return json.loads(self.email_candidates_json or "[]")

    @email_candidates.setter
    def email_candidates(self, value):
        self.email_candidates_json = json.dumps(value or [])

    @property
    def photo_urls(self):
        return json.loads(self.photo_urls_json or "[]")

    @photo_urls.setter
    def photo_urls(self, value):
        self.photo_urls_json = json.dumps(value or [])

    @property
    def sources(self):
        return json.loads(self.sources_json or "[]")

    @sources.setter
    def sources(self, value):
        self.sources_json = json.dumps(value or [])

    @property
    def external_ids(self):
        return json.loads(self.external_ids_json or "{}")

    @external_ids.setter
    def external_ids(self, value):
        self.external_ids_json = json.dumps(value or {})

    def to_dict(self):
        return {
            "id": self.id,
            "source": self.source,
            "external_id": self.external_id,
            "listing_url": self.listing_url,
            "sources": self.sources,
            "external_ids": self.external_ids,
            "times_seen": self.times_seen,
            "last_seen_at": self.last_seen_at.isoformat(),
            "address": self.address,
            "city": self.city,
            "state": self.state,
            "zip_code": self.zip_code,
            "price": self.price,
            "beds": self.beds,
            "baths": self.baths,
            "sqft": self.sqft,
            "property_type": self.property_type,
            "photo_urls": self.photo_urls,
            "brokerage": self.brokerage,
            "agent_name": self.agent_name,
            "agent_email": self.agent_email,
            "email_candidates": self.email_candidates,
            "agent_phone": self.agent_phone,
            "status": self.status,
            "notes": self.notes,
            "qualified": self.qualified,
            "outreach_email_sent": self.outreach_email_sent_at is not None,
            "outreach_phone_called": self.outreach_phone_called_at is not None,
            "outreach_video_sent": self.outreach_video_sent_at is not None,
            "outreach_skipped": bool(self.outreach_skipped),
            "video_url": self.video_url,
            "photo_rooms": self.photo_rooms,
            "ghl_contact_id": self.ghl_contact_id,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }


class VideoJob(db.Model):
    """One run of the video generator for a lead.

    Generation takes minutes and happens on a background thread, so the state
    has to live somewhere the browser can poll and a restart can recover. Each
    selected photo becomes one clip; `clips_json` is updated as they land, so
    the UI can say "3 of 6" rather than spinning.
    """

    __tablename__ = "video_jobs"

    id = db.Column(db.Integer, primary_key=True)
    # Nullable for the same reason StagingJob's is: photos can arrive from a
    # pasted link or an upload with no lead behind them, and refusing those
    # would make two of the three ways into Create Video dead ends.
    lead_id = db.Column(db.Integer, index=True, nullable=True)
    owner_id = db.Column(db.String(64), index=True, nullable=True)

    # queued -> running -> completed | failed | cancelled
    status = db.Column(db.String(20), nullable=False, default="queued")
    error = db.Column(db.Text, nullable=True)

    # What was asked for, kept so a result can be reproduced or judged later --
    # "the model changed the room" is only actionable if the prompt is known.
    model = db.Column(db.String(120), nullable=True)
    prompt = db.Column(db.Text, nullable=True)
    duration = db.Column(db.Integer, nullable=False, default=5)
    resolution = db.Column(db.String(20), nullable=False, default="720p")

    photos_json = db.Column(db.Text, nullable=False, default="[]")
    # One spec per photo, parallel to photos_json: {move, duration, resolution}.
    # Its own list rather than folded into photos_json, because `photos` must
    # stay a list of urls -- local_path_for and the clip count both rely on
    # that. The job's own duration/resolution stay as the run's summary.
    specs_json = db.Column(db.Text, nullable=False, default="[]")
    clips_json = db.Column(db.Text, nullable=False, default="[]")

    # The finished video. With one clip that is the clip itself; with several
    # it stays empty until they are stitched together.
    output_url = db.Column(db.String(500), nullable=True)

    # What it actually cost, in dollars, estimated at submit time.
    estimated_cost = db.Column(db.Float, nullable=True)

    created_at = db.Column(db.DateTime, nullable=False, default=_utcnow)
    updated_at = db.Column(db.DateTime, nullable=False, default=_utcnow, onupdate=_utcnow)

    @property
    def photos(self):
        return json.loads(self.photos_json or "[]")

    @photos.setter
    def photos(self, value):
        self.photos_json = json.dumps(value or [])

    @property
    def specs(self):
        return json.loads(self.specs_json or "[]")

    @specs.setter
    def specs(self, value):
        self.specs_json = json.dumps(value or [])

    def spec_for(self, index):
        """The spec for one clip, falling back to the job's own settings."""
        specs = self.specs
        spec = specs[index] if index < len(specs) else {}
        return {
            "move": spec.get("move"),
            "duration": spec.get("duration") or self.duration,
            "resolution": spec.get("resolution") or self.resolution,
        }

    @property
    def clips(self):
        return json.loads(self.clips_json or "[]")

    @clips.setter
    def clips(self, value):
        self.clips_json = json.dumps(value or [])

    def to_dict(self):
        clips = self.clips
        done = sum(1 for c in clips if c.get("video_url"))
        return {
            "id": self.id,
            "lead_id": self.lead_id,
            "status": self.status,
            "error": self.error,
            "model": self.model,
            "prompt": self.prompt,
            "duration": self.duration,
            "resolution": self.resolution,
            "photos": self.photos,
            "clips": clips,
            "specs": self.specs,
            "clips_done": done,
            # Photos is the real total: clips is appended to as they run,
            # so trusting its length reports "1 of 2" on a 3-photo job.
            "clips_total": max(len(clips), len(self.photos)),
            "output_url": self.output_url,
            "estimated_cost": round(self.estimated_cost, 2) if self.estimated_cost else None,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }


class DailyGoal(db.Model):
    """One row per Studio account holding that user's daily outreach
    targets, shown in the Dashboard's sidebar checklist. Was a single
    shared row before leads became per-user."""

    __tablename__ = "daily_goals"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.String(64), nullable=True, index=True, unique=True)
    calls_target = db.Column(db.Integer, nullable=False, default=0)
    emails_target = db.Column(db.Integer, nullable=False, default=0)
    videos_target = db.Column(db.Integer, nullable=False, default=0)

    def to_dict(self):
        return {
            "calls_target": self.calls_target,
            "emails_target": self.emails_target,
            "videos_target": self.videos_target,
        }


class StagingJob(db.Model):
    """One Scenery run: several rooms staged from one listing.

    Unlike a video job, the rooms here are independent of each other -- there
    is no stitching step and no order that matters -- so they generate in
    parallel and each one's state lives in its own entry. That is also why a
    single failure is recorded on the room rather than the job: nine good
    rooms should not be thrown away because the tenth came back badly.

    `lead_id` is nullable on purpose. Photos can arrive from a pasted link or
    a manual upload with no lead behind them, and refusing to stage those
    would make two of the three ways in dead ends.
    """

    __tablename__ = "staging_jobs"

    id = db.Column(db.Integer, primary_key=True)
    lead_id = db.Column(db.Integer, index=True, nullable=True)
    owner_id = db.Column(db.String(64), index=True, nullable=True)

    # queued -> running -> completed | failed | cancelled
    status = db.Column(db.String(20), nullable=False, default="queued")
    error = db.Column(db.Text, nullable=True)

    model = db.Column(db.String(120), nullable=True)
    address = db.Column(db.String(300), nullable=True)

    # [{photo, label, style, status, prediction_id, staged_url, error}, ...]
    rooms_json = db.Column(db.Text, nullable=False, default="[]")

    # The project this run was filed under, created when the run completes.
    project_id = db.Column(db.String(64), nullable=True)

    estimated_cost = db.Column(db.Float, nullable=True)

    created_at = db.Column(db.DateTime, nullable=False, default=_utcnow)
    updated_at = db.Column(db.DateTime, nullable=False, default=_utcnow, onupdate=_utcnow)

    @property
    def rooms(self):
        return json.loads(self.rooms_json or "[]")

    @rooms.setter
    def rooms(self, value):
        self.rooms_json = json.dumps(value or [])

    def to_dict(self):
        rooms = self.rooms
        done = [r for r in rooms if r.get("staged_url")]
        return {
            "id": self.id,
            "lead_id": self.lead_id,
            "status": self.status,
            "error": self.error,
            "model": self.model,
            "address": self.address,
            "rooms": rooms,
            "project_id": self.project_id,
            "estimated_cost": self.estimated_cost,
            "done": len(done),
            "total": len(rooms),
        }
