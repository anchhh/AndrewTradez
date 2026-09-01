"""
Phase 1: turn one listing photo into one clip, so the model can be judged
before anything is built on top of it.

    python make_clip.py --list                 # leads and how many photos each has
    python make_clip.py --lead 1               # cost, then ask before spending
    python make_clip.py --lead 1 --photo 3     # a specific photo
    python make_clip.py --lead 1 --yes         # skip the confirmation

The question this exists to answer is not "does the API work". It is whether
the model leaves the room alone. A listing video where the cabinets rearrange
themselves or a window becomes a door is not merely bad, it misrepresents the
property, and no agent will send it to a client. Watch the clip against the
source photo before deciding anything.

Clips land in studio/static/uploads/clips/ and nothing is written to the lead.
"""
import argparse
import os
import sys

from services.video import (
    MAX_DURATION,
    MIN_DURATION,
    REAL_ESTATE_PROMPT,
    VideoError,
    VideoNotConfigured,
    download,
    estimate_cost,
    load_config,
    submit_clip,
    upload_image,
    wait_for_clip,
)

OUT_DIR = os.path.join("studio", "static", "uploads", "clips")


def local_path_for(photo_url):
    """The file on disk behind a stored photo URL."""
    name = os.path.basename(photo_url.split("?")[0])
    return os.path.join("studio", "static", "uploads", name)


def list_leads(app):
    from models import Lead

    with app.app_context():
        for lead in Lead.query.order_by(Lead.id).all():
            photos = lead.photo_urls or []
            on_disk = sum(1 for p in photos if os.path.exists(local_path_for(p)))
            print(f"  lead {lead.id}: {str(lead.address)[:36]:36} "
                  f"{len(photos):3} photos ({on_disk} on disk)")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true",
                        help="verify the API key works (generates nothing, costs nothing)")
    parser.add_argument("--list", action="store_true", help="show leads and photo counts")
    parser.add_argument("--lead", type=int, help="lead id to pull a photo from")
    parser.add_argument("--photo", type=int, default=0, help="which photo (default: first)")
    parser.add_argument("--prompt", help="override the real-estate prompt")
    parser.add_argument("--seconds", type=int, default=5, help="clip length, 4-30")
    parser.add_argument("--resolution", default="720p", help="720p (default) or 1080p")
    parser.add_argument("--last-photo", type=int, dest="last_photo",
                        help="second photo index: generate the move between two rooms")
    parser.add_argument("--audio", action="store_true",
                        help="let the model generate audio (off by default; costs more)")
    parser.add_argument("--yes", action="store_true", help="don't ask before spending")
    args = parser.parse_args()

    if args.check:
        from services.video import verify_connection

        try:
            info = verify_connection()
        except (VideoNotConfigured, VideoError) as exc:
            print(f"Not working: {exc}")
            return 1
        print("Connected to Atlas Cloud.")
        print(f"  model: {info['model']}")
        print(f"  a 5s clip would cost about ${info['cost_5s']}")
        print()
        print("Nothing was generated and nothing was charged.")
        return 0

    from app import create_app
    from models import Lead

    app = create_app()

    if args.list or not args.lead:
        list_leads(app)
        if not args.lead:
            print("\nPick one:  python make_clip.py --lead <id>")
        return 0

    cfg = load_config()
    if not cfg["api_key"]:
        print("Atlas Cloud isn't connected.")
        print("  Put your key in studio/atlascloud.json, or set ATLASCLOUD_API_KEY.")
        return 1

    with app.app_context():
        lead = Lead.query.get(args.lead)
        if lead is None:
            print(f"No lead {args.lead}.")
            return 1
        photos = lead.photo_urls or []
        if not photos:
            print(f"Lead {args.lead} has no photos.")
            return 1
        if args.photo >= len(photos):
            print(f"Lead {args.lead} has {len(photos)} photos (0-{len(photos) - 1}).")
            return 1
        address = lead.address
        photo_url = photos[args.photo]
        last_photo_url = None
        if args.last_photo is not None:
            if args.last_photo >= len(photos):
                print(f"Lead {args.lead} has {len(photos)} photos (0-{len(photos) - 1}).")
                return 1
            last_photo_url = photos[args.last_photo]

    path = local_path_for(photo_url)
    if not os.path.exists(path):
        print(f"That photo isn't on disk: {path}")
        return 1

    last_path = None
    if last_photo_url:
        last_path = local_path_for(last_photo_url)
        if not os.path.exists(last_path):
            print(f"That last-frame photo isn't on disk: {last_path}")
            return 1

    if not (MIN_DURATION <= args.seconds <= MAX_DURATION):
        print(f"Duration must be {MIN_DURATION}-{MAX_DURATION} seconds.")
        return 1

    cost = estimate_cost(args.seconds, cfg)
    print(f"Lead {args.lead}: {address}")
    print(f"  photo {args.photo}: {os.path.basename(path)}")
    print(f"  model:  {cfg['model']}")
    print(f"  cost:   about ${cost} for {args.seconds:g}s at ${cfg['rate_per_second']}/s")
    print(f"  prompt: {(args.prompt or REAL_ESTATE_PROMPT)[:70]}...")

    if not args.yes:
        # Spending money should take a deliberate keystroke.
        if input("\nGenerate this clip? [y/N] ").strip().lower() not in ("y", "yes"):
            print("Nothing generated.")
            return 0

    try:
        print("\nUploading the photo...")
        image_url = upload_image(path, cfg)

        last_url = None
        if args.last_photo is not None:
            print("Uploading the last-frame photo...")
            last_url = upload_image(last_path, cfg)

        print("Submitting the generation...")
        prediction_id = submit_clip(
            image_url,
            prompt=args.prompt,
            cfg=cfg,
            duration=args.seconds,
            resolution=args.resolution,
            last_image=last_url,
            generate_audio=args.audio,
        )
        print(f"  prediction {prediction_id}")

        print("Waiting (this takes a few minutes)...")
        seen = {}

        def tick(state):
            if state["status"] != seen.get("status"):
                seen["status"] = state["status"]
                print(f"  {state['status']}")

        state = wait_for_clip(prediction_id, cfg, on_tick=tick)

        dest = os.path.join(OUT_DIR, f"lead{args.lead}-photo{args.photo}-{prediction_id[:8]}.mp4")
        print("Downloading...")
        download(state["video_url"], dest)

    except VideoNotConfigured as exc:
        print(f"\n  {exc}")
        return 1
    except VideoError as exc:
        print(f"\n  Failed: {exc}")
        return 1

    print(f"\nSaved: {dest}")
    print("\nWatch it next to the source photo. The thing to check is whether the room")
    print("stayed the same room -- not whether the motion looks nice.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
