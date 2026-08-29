"""
Finding a listing agent's email when the listing doesn't publish one.

Zillow never publishes an agent email -- the field exists and has been null on
every listing checked -- so those leads arrive with a name, a brokerage and a
phone, and nothing to write to. This does what a person would: search for the
agent by name *and brokerage*, open the results, and read the address off the
page.

Two rules keep it honest, both learned from doing it by hand:

  The brokerage goes in the query. Searching a name alone surfaced a
  same-name appraiser in another state who would otherwise have been filed as
  a Cincinnati agent.

  The page must corroborate. An address is only trusted when the page it came
  from also carries the lead's phone number, or when the local part matches
  the agent's name specifically enough to be that person. A weak name match on
  a page that also shows the agent's number beats a strong name match on a
  page about somebody else.

Anything that clears neither bar is recorded for a human to confirm rather
than written into the lead. A wrong address means a stranger gets the first
approach about someone else's listing.
"""
import re
import time
from urllib.parse import parse_qs, quote_plus, unquote, urlparse

import requests

from services.contacts import (
    AUTOFILL_THRESHOLD,
    find_emails,
    page_confirms_phone,
    pick_agent_email,
)

SEARCH_URL = "https://html.duckduckgo.com/html/?q="

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

# Profiles here are behind logins or contact forms and never show an address,
# so fetching them only costs time.
SKIP_HOSTS = (
    "facebook.", "instagram.", "linkedin.", "twitter.", "x.com", "youtube.",
    "pinterest.", "tiktok.", "zillow.com", "redfin.com", "realtor.com",
    "homes.com", "trulia.com", "yelp.com", "zoominfo.com", "spokeo.com",
    "instantcheckmate.com", "whitepages.com", "wikipedia.org",
)

MAX_PAGES = 5          # how many search results to open
PAGE_TIMEOUT = 12      # seconds per page
# Weak name matches (a first name, a bare surname) become usable only when the
# page also shows the lead's phone.
CORROBORATED_THRESHOLD = 55


# The free search endpoint starts refusing after a dozen or so queries,
# answering 202 with an "anomaly" notice rather than an error status. Being
# throttled is a different thing from an agent having no published address,
# and the lead's note should not confuse the two.
BLOCK_SIGNS = ("anomaly", "unusual traffic", "captcha", "are you a robot")


def _search(query, limit=8):
    """Result URLs for a query, most relevant first, one per host.

    Returns (urls, blocked) so the caller can tell "nothing found" apart from
    "we were not allowed to look".
    """
    try:
        response = requests.get(SEARCH_URL + quote_plus(query), headers=HEADERS, timeout=15)
    except requests.RequestException:
        return [], False

    body = response.text or ""
    blocked = response.status_code != 200 or any(s in body.lower() for s in BLOCK_SIGNS)
    if blocked:
        return [], True

    urls = []
    seen_hosts = set()
    pattern = r'href="(//duckduckgo\.com/l/\?uddg=[^"]+|https?://[^"]+)"'
    for href in re.findall(pattern, response.text):
        if href.startswith("//duckduckgo.com/l/"):
            wrapped = parse_qs(urlparse("https:" + href).query).get("uddg")
            href = unquote(wrapped[0]) if wrapped else None
        if not href:
            continue
        host = urlparse(href).netloc.lower()
        if not host or "duckduckgo" in host or host in seen_hosts:
            continue
        if any(skip in host for skip in SKIP_HOSTS):
            continue
        seen_hosts.add(host)
        urls.append(href)
        if len(urls) >= limit:
            break
    return urls, False


def find_agent_email(agent_name, brokerage=None, city=None, state=None, phone=None,
                     known_domains=None):
    """Look up an agent's email on the open web.

    Returns a dict describing what was found and how confident it is:
    {email, score, reason, source, phone_confirmed, autofill, searched}.
    `autofill` is the caller's signal that it is safe to write in.
    """
    result = {
        "email": None, "score": 0, "reason": "no agent name",
        "source": None, "phone_confirmed": False, "autofill": False,
        "domain_conflict": False, "blocked": False, "searched": None,
    }
    if not agent_name or len(agent_name.split()) < 2:
        return result

    terms = [f'"{agent_name}"']
    if brokerage:
        terms.append(f'"{brokerage}"')
    if city:
        terms.append(city)
    if state:
        terms.append(state)
    terms.append("realtor email")
    query = " ".join(terms)
    result["searched"] = query
    result["reason"] = "no address found"

    # Quoting the brokerage exactly can return nothing at all -- it found no
    # page for an agent whose address was there to be read. Fall back to a
    # looser phrasing before giving up.
    urls, blocked = _search(query)
    if not urls and not blocked:
        loose = " ".join([agent_name, brokerage or "", city or "", "realtor email"]).strip()
        result["searched"] = f"{query} | {loose}"
        urls, blocked = _search(loose)
    if blocked:
        result["reason"] = "search unavailable (rate limited) - worth retrying later"
        result["blocked"] = True
        return result
    urls = urls[:MAX_PAGES]

    best = None
    for url in urls:
        try:
            page = requests.get(url, headers=HEADERS, timeout=PAGE_TIMEOUT)
            if page.status_code != 200 or not page.text:
                continue
        except requests.RequestException:
            continue

        email, score, reason = pick_agent_email(find_emails(page.text), agent_name)
        if not email:
            continue
        confirmed = page_confirms_phone(page.text, phone)

        # If we already know this brokerage's real mail domain from a
        # previously confirmed lead, an address on a different domain is
        # suspect. A real directory published "rolando@searsrealestate.co" --
        # the brokerage's actual domain is searsrealestate.com, and mail to
        # the typo would simply vanish.
        domain = email.split("@")[-1].lower()
        domain_conflict = bool(known_domains) and domain not in known_domains

        candidate = {
            "email": email, "score": score, "reason": reason,
            "source": url, "phone_confirmed": confirmed,
            "autofill": (
                score >= AUTOFILL_THRESHOLD
                or (confirmed and score >= CORROBORATED_THRESHOLD)
            )
            and not domain_conflict,
            "domain_conflict": domain_conflict,
            "searched": result["searched"],
        }
        if domain_conflict:
            candidate["reason"] = (
                f"{reason}, but {domain} is not this brokerage's known mail domain "
                f"({', '.join(sorted(known_domains))}) - possible typo on the source page"
            )
        # A corroborated hit is the best outcome; take it and stop.
        if candidate["autofill"] and confirmed:
            return candidate
        if best is None or candidate["score"] > best["score"]:
            best = candidate
        time.sleep(0.4)  # be a considerate visitor

    return best or result
