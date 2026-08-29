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

    created_at = db.Column(db.DateTime, nullable=False, default=_utcnow)
    updated_at = db.Column(db.DateTime, nullable=False, default=_utcnow, onupdate=_utcnow)

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
