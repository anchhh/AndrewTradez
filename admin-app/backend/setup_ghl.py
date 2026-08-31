"""
One-time GoHighLevel setup: check the connection, then create the custom
fields the outreach email merges from.

Run it with no arguments to see where things stand without changing anything:

    python setup_ghl.py

Then, once the connection is good, create the missing fields:

    python setup_ghl.py --create

Creating fields is the only thing here that writes to your GHL account, and it
only happens with that flag. Nothing in this script sends email or touches a
contact.

GHL generates a field's key from its name rather than letting us set it, so
after creating anything this reads the fields back and checks the keys really
are the ones the app sends. A mismatch means the email would merge a blank, so
it is reported loudly rather than assumed.
"""
import getpass
import json
import os
import sys
import time

from services.gohighlevel import (
    CONFIG_PATH,
    CUSTOM_FIELDS,
    GoHighLevelError,
    GoHighLevelNotConfigured,
    _existing_custom_field_keys,
    _explain,
    _request,
    load_config,
    verify_connection,
)

# What each field is called in GHL's own UI. The key GHL derives from the name
# is what the app sends, so these names are not cosmetic -- "Estly Property
# Address" is what produces the key "estly_property_address".
FIELD_NAMES = {
    "estly_property_address": ("Estly Property Address", "319 S Kathleen Ave"),
    "estly_listing_url": ("Estly Listing Url", "https://www.zillow.com/homedetails/..."),
    "estly_video_url": ("Estly Video Url", "https://player.vimeo.com/video/..."),
    "estly_price": ("Estly Price", "$425,000"),
    "estly_beds_baths": ("Estly Beds Baths", "3 bd / 2 ba / 2,016 sqft"),
    "estly_brokerage": ("Estly Brokerage", "Sears Real Estate"),
}


def create_field(cfg, key):
    name, placeholder = FIELD_NAMES[key]
    resp = _request(
        "POST",
        f"/locations/{cfg['location_id']}/customFields",
        cfg,
        json={
            "name": name,
            "dataType": "TEXT",
            "model": "contact",
            "placeholder": placeholder,
        },
    )
    if resp is None or resp.status_code >= 400:
        return None, _explain(resp)
    try:
        field = resp.json().get("customField") or resp.json()
    except ValueError:
        return None, "GoHighLevel returned a response we could not read"
    return field.get("fieldKey") or field.get("key") or "(no key returned)", None


def set_token():
    """Read the token from the terminal and write it to the config file.

    Typed straight into your own terminal and never echoed, so it doesn't land
    in a chat transcript or your shell history. Leaves location_id alone.
    """
    # getpass reads the terminal directly, so with nothing attached it would
    # hang forever rather than fail -- which is what happens if this is run
    # from a button or a pipe instead of a real terminal window. Say so.
    if not sys.stdin.isatty():
        print("  This needs a real terminal window, because it prompts for the")
        print("  token without echoing it. Open PowerShell, cd to this folder,")
        print("  and run:")
        print("      python setup_ghl.py --set-token")
        print()
        print("  Or just paste the token into studio/gohighlevel.json yourself.")
        return 1

    print("Paste your GoHighLevel Private Integration token.")
    print("Nothing will appear as you type or paste -- that is deliberate.\n")
    token = getpass.getpass("Token: ").strip()

    if not token:
        print("\n  Nothing entered. Config unchanged.")
        return 1
    if not token.startswith("pit-"):
        print("\n  That doesn't look like a Private Integration token")
        print("  (they start with 'pit-'). Config unchanged.")
        return 1

    try:
        with open(CONFIG_PATH, encoding="utf-8") as fh:
            cfg = json.load(fh)
    except (OSError, ValueError):
        cfg = {}

    cfg["api_key"] = token
    cfg.setdefault("location_id", "")
    cfg.setdefault("version", "2021-07-28")

    with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2)
        fh.write("\n")

    print(f"\n  Saved to {os.path.relpath(CONFIG_PATH)}")
    if not cfg["location_id"]:
        print("  Still missing location_id -- add it to that file.")
        return 1
    print(f"  Using location {cfg['location_id']}.")
    return 0


def main():
    if "--set-token" in sys.argv:
        if set_token() != 0:
            return 1

    create = "--create" in sys.argv

    print("\nChecking the GoHighLevel connection...\n")
    try:
        info = verify_connection()
    except GoHighLevelNotConfigured as exc:
        print(f"  Not connected: {exc}")
        print("\n  Fill in studio/gohighlevel.json, then run this again.")
        return 1
    except GoHighLevelError as exc:
        print(f"  GoHighLevel rejected the request: {exc}")
        print("\n  A 401 means a bad token, a token from a different sub-account")
        print("  than the location id, or a missing scope -- GHL uses 401 for all")
        print("  three. The message above says which.")
        return 1

    print(f"  Connected. Location {info['location_id']}, API version {info['version_used']}.")

    present = set(info["custom_fields_present"])
    missing = list(info["custom_fields_missing"])

    for key in sorted(CUSTOM_FIELDS):
        print(f"    {'present' if key in present else 'MISSING':>8}  {key}")

    if not missing:
        print("\n  All merge fields exist. Nothing left to do here.")
        print_workflow_reminder()
        return 0

    if not create:
        print(f"\n  {len(missing)} field(s) missing. To create them:")
        print("      python setup_ghl.py --create")
        print("\n  Or add them by hand under Settings -> Custom Fields as TEXT fields")
        print("  on the contact model, named:")
        for key in missing:
            print(f"      {FIELD_NAMES[key][0]}")
        return 1

    cfg = load_config()
    print(f"\nCreating {len(missing)} field(s)...\n")
    failures = []
    scope_problem = False
    for key in missing:
        created_key, error = create_field(cfg, key)
        if error:
            print(f"  FAILED  {FIELD_NAMES[key][0]}: {error}")
            failures.append(key)
            if "scope" in error.lower():
                scope_problem = True
        else:
            print(f"  created {FIELD_NAMES[key][0]}  ->  {created_key}")

    # GHL answers a missing scope with 401 rather than 403, which reads like a
    # bad token when the token is fine. Name the scope instead.
    if scope_problem:
        print("\n  The token is missing the scope needed to create fields.")
        print("  In GHL: Settings -> Private Integrations -> edit this integration")
        print("  and add:")
        print("      locations/customFields.write")
        print()
        print("  Only this one-time setup needs it. You can remove it again")
        print("  afterwards; sending outreach never creates fields.")
        print("\n  If editing the scopes issues a new token, run:")
        print("      python setup_ghl.py --set-token")
        return 1

    # GHL derives the key from the name, so confirm what it actually assigned
    # rather than trusting that it matched. A silent mismatch merges a blank
    # into a real email.
    print("\nReading the fields back to confirm the keys match what the app sends...\n")

    # GHL's field list is eventually consistent: read straight after creating
    # and the last field created is reliably absent, which looks alarming and
    # isn't. Retry a few times before believing it.
    still_missing = list(CUSTOM_FIELDS)
    for attempt in range(4):
        if attempt:
            time.sleep(2)
        actual = _existing_custom_field_keys(cfg)
        still_missing = [k for k in CUSTOM_FIELDS if k not in actual]
        if not still_missing:
            break

    if still_missing:
        print("  These keys are still not what the app expects:")
        for key in still_missing:
            print(f"      {key}")
        print("\n  The field may exist under a different key. Check Settings -> Custom")
        print("  Fields in GHL and tell Claude the real key so the app can be adjusted.")
        return 1

    print("  All merge fields confirmed.")
    print_workflow_reminder()
    return 1 if failures else 0


def print_workflow_reminder():
    print("\n" + "-" * 66)
    print("Still to do by hand, in GHL (Automation -> Workflows -> Create):")
    print()
    print("  Trigger:  Contact Tag  ->  tag is  estly-video-ready")
    print("  Action:   Send Email")
    print()
    print("  Merge fields available in the email body:")
    for key in sorted(CUSTOM_FIELDS):
        print(f"      {{{{contact.{key}}}}}")
    print()
    print("  Keep GHL's footer element so the email carries your postal address")
    print("  and a working unsubscribe link.")
    print("-" * 66)


if __name__ == "__main__":
    sys.exit(main())
