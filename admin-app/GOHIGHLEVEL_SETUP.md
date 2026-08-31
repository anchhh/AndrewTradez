# Connecting GoHighLevel

Estly decides *who* is worth mailing. GoHighLevel does the actual sending, so
it owns unsubscribes, bounces, sending reputation and follow-ups — and it keeps
working when this app isn't running.

Four steps, once.

## 0. Use a sub-account of its own

Do this first, before anything else. In GoHighLevel: **Sub-Accounts → Create
Sub-Account**, name it Estly, and skip the snapshot so another business's
automations aren't copied in.

Sub-accounts are fully isolated — separate contacts, workflows, custom fields,
pipelines and sending domain. Three reasons that matters here:

- A Private Integration token is created *inside* a sub-account and can only
  reach that sub-account's data. A token minted in the Estly sub-account is
  structurally incapable of touching another business's contacts, whatever this
  app does.
- The six `estly_*` custom fields will exist only here, rather than cluttering
  every contact record in another business.
- Each sub-account verifies its own sending domain, so cold outreach from Estly
  can't damage the email reputation of anything else you run.

Every step below — the token, the location id, the custom fields, the workflow —
happens **inside this sub-account**. Pointing the integration at the wrong one
would file real-estate leads into another business's CRM, which is tedious to
unpick.

Sub-account limits go by plan: Starter allows 3 (1 agency + 2 client);
Unlimited and Agency Pro are uncapped.

## 1. Make a Private Integration token

In GoHighLevel, inside the sub-account you want the contacts to land in:

**Settings → Private Integrations → Create new integration**

Give it these scopes:

- `contacts.readonly`
- `contacts.write`
- `locations/customFields.readonly`
- `locations/customFields.write` — only needed for step 4 below, which
  creates the merge fields. Safe to remove afterwards: sending outreach never
  creates a field. Leave it out and step 4 fails with
  `401: The token is not authorized for this scope`.

Copy the token it shows you. You only get to see it once.

## 2. Find your location id

**Settings → Business Info**, or read it out of the URL while that sub-account
is open — it's the string after `/location/`.

## 3. Put both in the config file

Copy `backend/studio/gohighlevel.example.json` to
`backend/studio/gohighlevel.json` and fill it in:

```json
{
  "api_key": "pit-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "location_id": "ve9EPM428h8vShlRW1KT",
  "version": "2021-07-28"
}
```

That file is gitignored — this repo is public, so the token must never be
committed. `GHL_API_KEY` / `GHL_LOCATION_ID` environment variables work too and
take priority, which is how this should be configured once it's hosted.

Leave `version` alone unless a call fails; the app already retries with `v3`
automatically if `2021-07-28` is rejected.

## 4. Create the custom fields

Run this from `admin-app/backend`:

```
python setup_ghl.py
```

It checks the connection and lists which fields exist. Then create the missing
ones:

```
python setup_ghl.py --create
```

That is the only command here that writes to your GHL account, and it only
creates fields — it never touches a contact or sends anything.

If you would rather do it by hand: **Settings → Custom Fields**, one TEXT field
on the contact model for each row below.

| Field key the app sends | Name it in GHL | Holds |
|---|---|---|
| `estly_property_address` | Estly Property Address | 319 S Kathleen Ave |
| `estly_listing_url` | Estly Listing Url | link to the listing |
| `estly_video_url` | Estly Video Url | the finished video |
| `estly_price` | Estly Price | $425,000 |
| `estly_beds_baths` | Estly Beds Baths | 3 bd / 2 ba / 2,016 sqft |
| `estly_brokerage` | Estly Brokerage | Sears Real Estate |

GHL generates the key from the name, so the names matter. The script reads the
fields back afterwards and tells you if the generated keys don't match what the
app sends.

A missing field does **not** error — GHL ignores the unknown key and the email
goes out with a blank where the address or video link should have been. The
banner on `/studio/outreach` flags this too.

## 5. Build the workflow in GHL

**Automation → Workflows → Create**

- **Trigger:** Contact Tag — tag is `estly-video-ready`
- **Action:** Send Email

Write the email with the merge fields, e.g.

> Hi `{{contact.first_name}}`,
>
> I put together a short marketing video for `{{contact.estly_property_address}}` —
> you can watch it here: `{{contact.estly_video_url}}`
>
> No charge and no catch; if it's useful it's yours to post.

Include your physical postal address and a working unsubscribe link. GHL adds
both if you use its footer element — leave it in. Cold B2B email is legal in the
US under CAN-SPAM, but only with an honest sender, a real address and a
functioning opt-out.

## How a send actually happens

1. A lead is captured and the app researches the agent's email in the background.
2. You produce the video and paste its link on the lead's profile, or straight
   into the **Waiting** list on `/studio/outreach`.
3. The lead moves to **Ready to send**, showing the address with the case for and
   against it being the right person.
4. You click **Send via GoHighLevel**. The contact is upserted with the listing
   details and tagged `estly-video-ready`.
5. Your workflow sees the tag and sends the email.

Nothing sends on its own. **Preview payload** shows exactly what would be pushed
without pushing it, which is the safe way to test the connection.

## When something breaks

- **"GoHighLevel isn't connected"** — the config file is missing or empty.
- **HTTP 401** — the token is wrong, expired, or from a different sub-account
  than the location id.
- **HTTP 403** — the token is missing one of the scopes in step 1.
- **Email arrives with blanks** — a custom field in step 4 is missing or its key
  is misspelled. Check the banner on the outreach page.
- **Contact created but no email** — the workflow is paused, or its trigger tag
  doesn't match `estly-video-ready` exactly.
