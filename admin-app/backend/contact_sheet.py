"""
Building numbered contact sheets from a lead's photos, and applying labels back.

This is the free path for room sorting: instead of the app paying an API to
classify each photo, Claude reads a handful of contact sheets directly and
writes the labels back. One sheet carries twenty photos, so a 57-photo lead is
three images to look at rather than fifty-seven.

    python contact_sheet.py --lead 1          # build sheets
    python contact_sheet.py --lead 1 --apply labels.json

The numbers drawn on each tile are the photo's index in the lead's own photo
list, so a label file is just {"0": "kitchen", "1": "bath", ...} and nothing
depends on the order the sheets happen to be built in.
"""
import argparse
import json
import os
import sys

from PIL import Image, ImageDraw

OUT_DIR = os.path.join("studio", "static", "_sheets")
COLS, ROWS = 5, 4
TILE_W, TILE_H = 320, 240
PAD = 4
PER_SHEET = COLS * ROWS


def local_path_for(photo_url):
    name = os.path.basename((photo_url or "").split("?")[0])
    return os.path.join("studio", "static", "uploads", name)


def build_sheets(lead_id, photo_urls, out_dir=OUT_DIR):
    """Numbered grids of every photo. Returns the sheet paths."""
    os.makedirs(out_dir, exist_ok=True)
    sheets = []

    for sheet_no, start in enumerate(range(0, len(photo_urls), PER_SHEET)):
        chunk = photo_urls[start:start + PER_SHEET]
        sheet = Image.new(
            "RGB",
            (COLS * (TILE_W + PAD) + PAD, ROWS * (TILE_H + PAD) + PAD),
            (30, 26, 22),
        )
        draw = ImageDraw.Draw(sheet)

        for i, url in enumerate(chunk):
            index = start + i
            col, row = i % COLS, i // COLS
            x = PAD + col * (TILE_W + PAD)
            y = PAD + row * (TILE_H + PAD)

            path = local_path_for(url)
            try:
                with Image.open(path) as img:
                    img = img.convert("RGB")
                    img.thumbnail((TILE_W, TILE_H))
                    sheet.paste(img, (x + (TILE_W - img.width) // 2,
                                      y + (TILE_H - img.height) // 2))
            except Exception:  # noqa: BLE001 -- an unreadable photo just stays blank
                draw.rectangle([x, y, x + TILE_W, y + TILE_H], fill=(60, 54, 48))

            # The index, drawn big enough to read at a glance and boxed so it
            # stays legible over a bright photo.
            tag = str(index)
            draw.rectangle([x, y, x + 14 + 11 * len(tag), y + 26], fill=(0, 0, 0))
            draw.text((x + 7, y + 6), tag, fill=(255, 210, 90))

        path = os.path.join(out_dir, f"lead{lead_id}-sheet{sheet_no}.jpg")
        sheet.save(path, format="JPEG", quality=82)
        sheets.append(path)

    return sheets


def apply_labels(lead_id, labels):
    """Write {index: room} onto the lead. Returns how many were applied."""
    sys.path.insert(0, os.getcwd())
    from app import create_app
    from extensions import db
    from models import Lead
    from services.rooms import ROOMS, ROOM_DISPLAY

    app = create_app()
    with app.app_context():
        lead = db.session.get(Lead, lead_id)
        if lead is None:
            raise SystemExit(f"No lead {lead_id}.")

        photos = lead.photo_urls or []
        rooms = lead.photo_rooms
        applied, skipped = 0, []

        for key, room in labels.items():
            try:
                index = int(key)
            except (TypeError, ValueError):
                skipped.append((key, "not a number"))
                continue
            if not (0 <= index < len(photos)):
                skipped.append((key, "out of range"))
                continue
            if room not in ROOMS:
                skipped.append((key, f"unknown room {room!r}"))
                continue
            rooms[photos[index]] = {
                "room": room,
                "label": ROOM_DISPLAY.get(room, room),
                # Read off the photo rather than researched, so no probability
                # is invented -- it either was identified or it wasn't.
                "confidence": 1.0,
            }
            applied += 1

        lead.photo_rooms = rooms
        db.session.commit()

    for key, why in skipped:
        print(f"  skipped {key}: {why}")
    return applied


def db_get_lead(lead_id):
    from extensions import db
    from models import Lead

    return db.session.get(Lead, lead_id)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--lead", type=int)
    parser.add_argument("--pending", action="store_true",
                        help="build sheets for every lead with unsorted photos")
    parser.add_argument("--apply", help="a JSON file of {index: room}")
    parser.add_argument("--clean", action="store_true", help="delete this lead's sheets")
    args = parser.parse_args()

    sys.path.insert(0, os.getcwd())
    from app import create_app
    from models import Lead

    if args.pending:
        app = create_app()
        with app.app_context():
            pending = []
            for lead in Lead.query.order_by(Lead.id).all():
                photos = lead.photo_urls or []
                unsorted_count = sum(1 for u in photos if u not in lead.photo_rooms)
                if unsorted_count:
                    pending.append((lead.id, lead.address, photos, unsorted_count))

        if not pending:
            print("Every lead's photos are already sorted.")
            return 0

        for lead_id, address, photos, unsorted_count in pending:
            sheets = build_sheets(lead_id, photos)
            print(f"lead {lead_id}: {address} — {unsorted_count} of {len(photos)} unsorted")
            for path in sheets:
                print(f"  {path}")
        return 0

    if not args.lead:
        print("Pass --lead <id> or --pending.")
        return 1

    if args.apply:
        with open(args.apply, encoding="utf-8") as fh:
            labels = json.load(fh)
        applied = apply_labels(args.lead, labels)
        print(f"applied {applied} label(s) to lead {args.lead}")
        return 0

    app = create_app()
    with app.app_context():
        lead = db_get_lead(args.lead)
        if lead is None:
            print(f"No lead {args.lead}.")
            return 1
        photos = lead.photo_urls or []
        address = lead.address

    if args.clean:
        removed = 0
        for name in os.listdir(OUT_DIR) if os.path.isdir(OUT_DIR) else []:
            if name.startswith(f"lead{args.lead}-sheet"):
                os.remove(os.path.join(OUT_DIR, name))
                removed += 1
        print(f"removed {removed} sheet(s)")
        return 0

    sheets = build_sheets(args.lead, photos)
    print(f"lead {args.lead}: {address} — {len(photos)} photos")
    for path in sheets:
        print(f"  {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
