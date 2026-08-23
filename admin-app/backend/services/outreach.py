"""
Placeholder for outreach automation (email/SMS/DM to leads offering the
Estly video-generation service). Not implemented yet -- wire this up once
a provider (e.g. SendGrid, Twilio, Postmark) is chosen. Kept as a single
seam so the routes/frontend don't need to change when it lands.
"""


class OutreachNotConfigured(Exception):
    pass


def send_outreach(lead, channel="email", template=None):
    raise OutreachNotConfigured(
        "Outreach automation isn't wired up yet. Pick a provider "
        "(e.g. SendGrid/Postmark for email, Twilio for SMS) and implement "
        "send_outreach() in services/outreach.py."
    )
