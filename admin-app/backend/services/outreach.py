"""
Deciding which leads are ready to be mailed, and handing them to GoHighLevel.

The pitch is the video: the email exists to show an agent a finished marketing
video of their own listing. That makes the video, not the lead, the thing that
gates a send -- a lead captured this morning with no video yet has nothing to
say. So a lead becomes sendable only once it has all three of an agent email,
a video the agent can watch, and a human deciding to send it.

Nothing here sends on its own. Every send is one explicit click in the review
queue, because the addresses come from research and are sometimes wrong, and a
wrong address means a stranger gets a cold pitch about someone else's listing.
See services/email_lookup.py for how much confidence any given address carries.
"""
from datetime import datetime, timezone

from services.gohighlevel import (
    TAG_VIDEO_READY,
    GoHighLevelError,
    GoHighLevelNotConfigured,
    push_contact,
)


class OutreachNotReady(Exception):
    """This lead is missing something a send needs."""


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def blockers(lead):
    """Everything standing between this lead and a send, in plain English."""
    out = []
    if not lead.agent_email:
        out.append("no agent email yet")
    if not lead.agent_name:
        out.append("no agent name to address it to")
    if not lead.video_url:
        out.append("no finished video for this listing")
    if lead.outreach_email_sent_at:
        out.append("already sent")
    if lead.outreach_skipped:
        out.append("skipped")
    return out


def is_ready(lead):
    return not blockers(lead)


def email_confidence(lead):
    """How much to trust this lead's email address, for the reviewer.

    Reuses whatever the research pass recorded. An address with no candidate
    entry was either published on the listing page or typed in by hand -- both
    more trustworthy than anything researched, but we say so rather than
    silently calling it verified.
    """
    email = (lead.agent_email or "").lower()
    if not email:
        return {"level": "none", "label": "No email", "supports": [], "concerns": []}

    for candidate in lead.email_candidates or []:
        if (candidate.get("email") or "").lower() != email:
            continue
        confident = candidate.get("confident")
        return {
            "level": "high" if confident else "low",
            "label": "Researched - looks right" if confident else "Researched - unconfirmed",
            "score": candidate.get("score"),
            "source": candidate.get("source"),
            "supports": candidate.get("supports") or [],
            "concerns": candidate.get("concerns") or [],
        }

    return {
        "level": "direct",
        "label": "From the listing page or entered by hand",
        "supports": ["it was not guessed by the research pass"],
        "concerns": [],
    }


def review_item(lead):
    """Everything the review queue needs to show for one lead."""
    return {
        "lead": lead.to_dict(),
        "ready": is_ready(lead),
        "blockers": blockers(lead),
        "confidence": email_confidence(lead),
    }


def send(lead, db_session, dry_run=False):
    """Hand this lead to GoHighLevel for mailing.

    Pushes the agent as a contact carrying the listing details and the video
    link, then adds the tag a GHL workflow triggers on. With dry_run the
    payload is built and returned without contacting GHL, so a send can be
    inspected before anyone is actually mailed.

    Raises OutreachNotReady, GoHighLevelNotConfigured or GoHighLevelError --
    all with a message worth showing the user.
    """
    problems = blockers(lead)
    if problems:
        raise OutreachNotReady("; ".join(problems))

    result = push_contact(lead, extra_tags=[TAG_VIDEO_READY], dry_run=dry_run)
    if dry_run:
        return result

    if result.get("contact_id"):
        lead.ghl_contact_id = result["contact_id"]

    # The two checklist items this actually completes. They were manual
    # toggles before; an automated send should tick them itself rather than
    # leave the dashboard counters lying.
    now = _utcnow()
    lead.outreach_email_sent_at = now
    lead.outreach_video_sent_at = now
    db_session.commit()

    return result


def skip(lead, db_session, undo=False):
    """Drop this lead out of the queue (or put it back)."""
    lead.outreach_skipped = not undo
    db_session.commit()
    return lead


__all__ = [
    "GoHighLevelError",
    "GoHighLevelNotConfigured",
    "OutreachNotReady",
    "blockers",
    "email_confidence",
    "is_ready",
    "review_item",
    "send",
    "skip",
]
