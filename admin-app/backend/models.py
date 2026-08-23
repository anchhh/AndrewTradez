import json
from datetime import datetime, timezone

from extensions import db

VALID_STATUSES = ("new", "contacted", "responded", "converted", "dead")
VALID_SOURCES = ("zillow", "realtor", "airbnb", "manual", "csv", "sample")


def _utcnow():
    return datetime.now(timezone.utc)


class Lead(db.Model):
    __tablename__ = "leads"

    id = db.Column(db.Integer, primary_key=True)

    source = db.Column(db.String(20), nullable=False, default="manual")
    external_id = db.Column(db.String(120), nullable=True)
    listing_url = db.Column(db.String(500), nullable=True)

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

    agent_name = db.Column(db.String(120), nullable=True)
    agent_email = db.Column(db.String(255), nullable=True)
    agent_phone = db.Column(db.String(40), nullable=True)

    status = db.Column(db.String(20), nullable=False, default="new")
    notes = db.Column(db.Text, nullable=True)

    created_at = db.Column(db.DateTime, nullable=False, default=_utcnow)
    updated_at = db.Column(db.DateTime, nullable=False, default=_utcnow, onupdate=_utcnow)

    @property
    def photo_urls(self):
        return json.loads(self.photo_urls_json or "[]")

    @photo_urls.setter
    def photo_urls(self, value):
        self.photo_urls_json = json.dumps(value or [])

    def to_dict(self):
        return {
            "id": self.id,
            "source": self.source,
            "external_id": self.external_id,
            "listing_url": self.listing_url,
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
            "agent_name": self.agent_name,
            "agent_email": self.agent_email,
            "agent_phone": self.agent_phone,
            "status": self.status,
            "notes": self.notes,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }
