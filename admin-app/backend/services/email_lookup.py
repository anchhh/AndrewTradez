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
    score_email_for_agent,
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


NAME_WORDING = {
    "first+last": "the address is the agent's full name",
    "last+first": "the address is the agent's name, surname first",
    "initial+last": "the address is the agent's initial and surname",
    "last+initial": "the address is the agent's surname and initial",
    "first+initial": "the address is the agent's first name and surname initial",
    "first name only": "the address is the agent's first name",
    "surname present": "the address contains the agent's surname",
}

# Sites that list many agents. An address found only here is weaker than one
# on the agent's own page, because directories go stale and mix people up.
AGGREGATOR_HINTS = ("directory", "agents", "findglocal", "nestfully", "sold.com",
                    "agentpronto", "fastexpert", "homelight", "realsatisfied")


def _weigh(candidate, agent_name, brokerage):
    """The case for and against this address being the agent's.

    Both sides are returned so a person can judge rather than trust a number.
    An address with no case against it and a corroborating phone number is
    about as good as this gets without sending mail to it.
    """
    supports, concerns = [], []

    wording = NAME_WORDING.get(candidate["reason"])
    if wording:
        supports.append(wording)
    else:
        concerns.append("the address does not obviously match the agent's name")

    if candidate["reason"] in ("first name only", "surname present"):
        concerns.append("that alone could match a colleague with a similar name")
    if candidate["reason"] == "shared mailbox":
        concerns.append("it looks like a shared or office mailbox rather than a person")

    if candidate["phone_confirmed"]:
        supports.append("the page carrying it also shows the phone number from the listing")
    else:
        concerns.append("the page does not show the listing's phone number to confirm the person")

    host = urlparse(candidate["source"] or "").netloc.lower()
    domain = candidate["email"].split("@")[-1].lower()
    if brokerage and domain and domain.split(".")[0] in host:
        supports.append("it is on the brokerage's own website")
    elif any(h in host for h in AGGREGATOR_HINTS):
        concerns.append(f"{host} is a directory rather than the agent's own site")

    if candidate.get("domain_conflict"):
        concerns.append(
            f"{domain} is not the mail domain already confirmed for this brokerage, "
            "which can mean a typo on the source page"
        )
    elif candidate.get("domain_known"):
        supports.append("the domain matches one already confirmed for this brokerage")

    # Where it came from is context, not an argument -- listing it as a point
    # in favour while also warning the site is a directory reads as a
    # contradiction. The UI shows it separately.
    return supports, concerns


def research_agent_email(agent_name, brokerage=None, city=None, state=None, phone=None,
                         known_domains=None):
    """Every address on the open web that might belong to this agent, ranked.

    Returns {candidates, best, blocked, searched}. `candidates` is ordered
    most-likely first, each carrying a plain-English `why`. Nothing is written
    anywhere: the caller decides, and a human can pick between them.
    """
    out = {"candidates": [], "best": None, "blocked": False, "searched": None}
    if not agent_name or len(agent_name.split()) < 2:
        return out

    terms = [f'"{agent_name}"']
    if brokerage:
        terms.append(f'"{brokerage}"')
    if city:
        terms.append(city)
    if state:
        terms.append(state)
    terms.append("realtor email")
    query = " ".join(terms)
    out["searched"] = query

    urls, blocked = _search(query)
    if not urls and not blocked:
        loose = " ".join([agent_name, brokerage or "", city or "", "realtor email"]).strip()
        out["searched"] = f"{query} | {loose}"
        urls, blocked = _search(loose)
    if blocked:
        out["blocked"] = True
        return out

    seen = {}
    for url in urls[:MAX_PAGES]:
        try:
            page = requests.get(url, headers=HEADERS, timeout=PAGE_TIMEOUT)
            if page.status_code != 200 or not page.text:
                continue
        except requests.RequestException:
            continue

        confirmed = page_confirms_phone(page.text, phone)
        for email in find_emails(page.text):
            score, reason = score_email_for_agent(email, agent_name)
            domain = email.split("@")[-1].lower()
            known = bool(known_domains) and domain in known_domains
            # Keep weak addresses too, with the case against them stated. An
            # office mailbox on the right brokerage is worth seeing; an
            # unrelated address on an unrelated page is not.
            if not score and not confirmed and not known:
                continue
            candidate = {
                "email": email,
                "score": score,
                "reason": reason,
                "source": url,
                "phone_confirmed": confirmed,
                "domain_conflict": bool(known_domains) and domain not in known_domains,
            }
            candidate["domain_known"] = known
            candidate["confident"] = (
                score >= AUTOFILL_THRESHOLD
                or (confirmed and score >= CORROBORATED_THRESHOLD)
            ) and not candidate["domain_conflict"]
            supports, concerns = _weigh(candidate, agent_name, brokerage)
            candidate["supports"] = supports
            candidate["concerns"] = concerns
            candidate["why"] = "; ".join(supports)
            prior = seen.get(email)
            if prior:
                # Seen on more than one page: corroboration anywhere counts.
                prior["phone_confirmed"] = prior["phone_confirmed"] or confirmed
                sup, con = _weigh(prior, agent_name, brokerage)
                prior["supports"], prior["concerns"] = sup, con
                prior["why"] = "; ".join(sup)
                if candidate["score"] > prior["score"]:
                    seen[email] = candidate
            else:
                seen[email] = candidate
        time.sleep(0.4)  # be a considerate visitor

    ranked = sorted(
        seen.values(),
        key=lambda c: (c["confident"], c["phone_confirmed"], c["score"], not c["domain_conflict"]),
        reverse=True,
    )
    out["candidates"] = ranked
    out["best"] = ranked[0] if ranked and ranked[0]["confident"] else None
    return out


def find_agent_email(agent_name, brokerage=None, city=None, state=None, phone=None,
                     known_domains=None):
    """Single best address, for the automatic pass. A thin wrapper so the
    automatic and on-demand paths rank identically."""
    found = research_agent_email(agent_name, brokerage, city, state, phone, known_domains)
    top = found["candidates"][0] if found["candidates"] else None
    return {
        "email": top["email"] if top else None,
        "score": top["score"] if top else 0,
        "reason": top["why"] if top else (
            "search unavailable" if found["blocked"] else "no address found"
        ),
        "source": top["source"] if top else None,
        "phone_confirmed": bool(top and top["phone_confirmed"]),
        "domain_conflict": bool(top and top["domain_conflict"]),
        "autofill": bool(top and top["confident"]),
        "blocked": found["blocked"],
        "searched": found["searched"],
        "candidates": found["candidates"],
    }
