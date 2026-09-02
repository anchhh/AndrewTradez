"""What a listing's marketing is sold for.

PLACEHOLDER PRICES. These are stand-ins until the real ones are set, which
is why they live here rather than being typed into a form -- changing a price
should be one edit in one file, not a hunt through templates.

Changing a price here does NOT change what past sales were worth. The amount
is copied onto the lead when the package is chosen, so revenue already earned
stays what it was. A price list is what things cost today; a sale is what
somebody actually paid.
"""

PACKAGES = [
    {"key": "p1", "name": "Package 1", "price": 250.0},
    {"key": "p2", "name": "Package 2", "price": 750.0},
    {"key": "p3", "name": "Package 3", "price": 5000.0},
]

BY_KEY = {p["key"]: p for p in PACKAGES}


def price_of(key):
    """The current price of a package, or None if there is no such package."""
    package = BY_KEY.get(key)
    return package["price"] if package else None


def name_of(key):
    """The display name, falling back to the key so an old sale whose package
    was later removed still reads as something rather than blank."""
    package = BY_KEY.get(key)
    return package["name"] if package else (key or "")
