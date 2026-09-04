"""
Guard the drone prompt's load-bearing clauses.

    python check_drone_prompt.py

Every rule below is in the prompt because a render came back wrong without
it, and every one of them has silently fallen out at least once. The
mechanism is always the same: the prompt runs against a 2,500-character
ceiling, exterior_prompt() drops whole sections when it overruns, and a
sentence added at the top quietly evicts one at the bottom. Nothing fails.
The next clip just goes back to an old fault.

So this asserts the clauses survive -- across every shape a drawn route can
take, and with the site facts both present and missing, because those change
the length too. Run it after touching services/video.py's exterior prompts,
services/dronepath.py's describe(), or the movement instruction.

The clip this was written against: job 14, 10 seconds at 1080p, front to
back over the roof with the camera coming about at the ridge. 2,463 of 2,500
characters, everything below present.
"""
import sys

from services import dronepath, video

# What must be in the prompt, and what went wrong the time it was not.
REQUIRED = [
    ("FULL HALF-CIRCLE",
     "the reveal itself. Without it the camera crests the ridge and yaws "
     "about ninety degrees, which is a glance to the side, not a reveal."),
    ("it is the CAMERA that comes about",
     "the aircraft kept flying forward and the model read the half-circle "
     "as a change of heading -- it banked instead of turning its head."),
    ("SAME HOUSE FROM OPPOSITE SIDES",
     "without it the front and the back read as two buildings: the clip "
     "crossed one roof, found a house that did not match, and put a fence "
     "between them."),
    ("do not orbit it or travel past the property",
     "'descending beyond it' was obeyed literally and the shot ended over "
     "the neighbouring plot."),
    ("FLY THIS ROUTE",
     "the drawn line reaching the model at all. It previously opened "
     "'planned on an overhead view', pointing at a picture not in the "
     "request."),
    ("in this order",
     "the shape of the line. Reduced to one bearing, a dogleg and a "
     "straight run produced the same sentence."),
    ("It must read exactly",
     "the house number. A flyover renumbered the property mid-clip, 8732 "
     "to 8753, inside two and a half seconds."),
    ("Do NOT dissolve",
     "the model crossfaded between the two frames instead of flying "
     "between them."),
]

# Every shape a route can take, because each produces a different length and
# the longest is the one that evicts something.
SHAPES = {
    "straight over the house": [[710, 700], [710, 100]],
    "two legs, both over": [[710, 700], [710, 400], [710, 100]],
    "dogleg round the left": [[710, 700], [300, 600], [300, 250], [710, 100]],
    "three legs over": [[710, 700], [300, 600], [600, 300], [710, 100]],
    "short hop": [[700, 420], [760, 380]],
    "beside the house": [[710, 700], [150, 560], [120, 220], [400, 120]],
}

# Site facts are optional and lengthen the prompt when present.
SITES = {
    "full site facts": {"front_faces": "south-west", "depth": "long",
                        "house_number": "1737"},
    "no site facts": {"front_faces": None, "depth": None,
                      "house_number": "1737"},
}


def main():
    cfg = video.load_config()
    limit = video.model_info(cfg).get("max_prompt", 2500)
    failures = []
    longest = 0

    for shape, points in SHAPES.items():
        route = dronepath.describe({"points": points, "width": 1420,
                                    "height": 742})
        if not route:
            failures.append(("%s / route" % shape,
                             "describe() returned nothing for a drawn line"))
            continue
        for label, facts in SITES.items():
            site = dict(facts, flight_path=route)
            prompt = video.exterior_prompt(dronepath.MOVE, cfg, site=site)
            longest = max(longest, len(prompt))

            if len(prompt) > limit:
                failures.append(("%s / %s" % (shape, label),
                                 "prompt is %d characters, over the %d limit"
                                 % (len(prompt), limit)))
            for clause, why in REQUIRED:
                if clause not in prompt:
                    failures.append(("%s / %s" % (shape, label),
                                     'missing "%s" -- %s' % (clause, why)))

    # The aerial reel's one move. No route, no ramp, no reveal -- but it
    # still has to fit and still has to carry the house number, and a
    # refactor of the ladder is how it would quietly stop doing either.
    # The aerial's prompt is sent as written, not built by the ladder, so
    # nothing here can be evicted. What CAN go wrong is somebody tidying its
    # negative prompt: the shot is speed, and the words that describe speed
    # -- motion blur, streaking, warp -- sit one synonym away from the words
    # that describe its fault, a building changing shape as the camera
    # passes. Ban the first set and the clip comes back as a slow drift.
    aerial_prompt = video.prompt_for_clip(move="aerial_warp", cfg=cfg)
    aerial_negative = video.negative_for("aerial_warp")
    for word in ("motion blur", "streaking", "warp"):
        if word in aerial_negative:
            failures.append(("aerial_warp / negative",
                             '"%s" is forbidden -- that is the shot, not the '
                             "fault. Name the geometry (morphing buildings, "
                             "houses growing) instead." % word))
    for clause, why in (
        ("morphing buildings", "the fault itself: the last house grew into "
                               "place rather than being flown up to"),
        ("moving cars", "cars drove off down the street of a still "
                        "photograph. 'moving vehicles' alone did not stop it"),
    ):
        if clause not in aerial_negative:
            failures.append(("aerial_warp / negative",
                             'missing "%s" -- %s' % (clause, why)))
    for clause, why in (
        ("FLOWN UP TO", "the arrival. Without it the house assembles itself "
                        "in the final second"),
        ("only thing that moves is the camera", "the parked cars"),
        ("OPEN LOCKED ON THE FIRST PHOTOGRAPH",
         "the opening beat. Without it the wide aerial starts moving and "
         "softening immediately, and the shot has no clean frame to leave "
         "from"),
        ("any blur comes from the speed of the camera",
         "the distinction the whole shot turns on. Blur is the subject; "
         "objects deforming is the fault, and one sentence has to say which "
         "is which because the negative cannot"),
    ):
        if clause not in aerial_prompt:
            failures.append(("aerial_warp / prompt",
                             'missing "%s" -- %s' % (clause, why)))
    cases = len(SHAPES) * len(SITES) + 1
    if failures:
        print("FAILED: %d problem(s) across %d cases\n" % (len(failures), cases))
        for where, what in failures:
            print("  %-28s %s" % (where, what))
        return 1

    print("OK: %d cases, every clause present, longest prompt %d of %d"
          % (cases, longest, limit))
    return 0


if __name__ == "__main__":
    sys.exit(main())
