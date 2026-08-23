"""
Not implemented: Airbnb has no public listings-search API and scraping
airbnb.com violates their Terms of Service.

What *is* legitimate: Airbnb's official Hosting API/Partner API for
listings YOU (or a client who grants access) own and manage -- built for
property-management and channel-manager integrations, not for pulling
other hosts' listings. If the goal is pulling comparable short-term-rental
market data rather than your own listings, a licensed STR data provider
(e.g. AirDNA) is the legitimate route.
"""


def fetch():
    raise NotImplementedError(
        "Airbnb feed not configured: no public search API, and scraping "
        "airbnb.com violates its Terms of Service. Wire this up via "
        "Airbnb's official Hosting/Partner API (for listings you manage) "
        "or a licensed STR data provider (e.g. AirDNA) instead."
    )
