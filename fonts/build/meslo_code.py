# FontForge script for the Meslo Code build steps.
#
#   fontforge -lang=py -script meslo_code.py metrics <in.ttf> <out.ttf>
#   fontforge -lang=py -script meslo_code.py names   <in.ttf> <out.ttf> <version>
#
# metrics: sets Menlo's line spacing (Meslo LG S has 200 units more per line).
# names:   rewrites the name table after all glyphs are merged.
import sys
import fontforge

FAMILY = "Meslo Code"

# Vertical metrics of the original Menlo, identical in all four styles.
MENLO_METRICS = {
    "hhea_ascent": 1901, "hhea_ascent_add": 0,
    "hhea_descent": -483, "hhea_descent_add": 0,
    "hhea_linegap": 0,
    "os2_typoascent": 1556, "os2_typoascent_add": 0,
    "os2_typodescent": -492, "os2_typodescent_add": 0,
    "os2_typolinegap": 410,
    "os2_winascent": 1901, "os2_winascent_add": 0,
    "os2_windescent": 483, "os2_windescent_add": 0,
    "os2_use_typo_metrics": 0,
}

COPYRIGHT_EXTRA = (
    "\nProgramming ligatures from Fira Code, Copyright (c) 2014 The Fira Code Project Authors."
    "\nIcons from Nerd Fonts, Copyright (c) 2014 Ryan L McIntyre, and the authors of each icon set."
)

DESCRIPTION = (
    "Meslo Code: Meslo LG S with Menlo's line spacing, "
    "Fira Code programming ligatures and Nerd Fonts icons."
)

LICENSE = (
    "Licensed under the SIL Open Font License, Version 1.1. "
    "Includes Bitstream Vera (Bitstream Vera Fonts License), Meslo LG (Apache License 2.0), "
    "Fira Code (SIL OFL 1.1) and Nerd Fonts icons (licenses listed in LICENSES/). "
    "See https://github.com/microbians/AI.SKILLS/tree/main/fonts"
)
LICENSE_URL = "https://openfontlicense.org"


def set_metrics(font):
    for attr, value in MENLO_METRICS.items():
        setattr(font, attr, value)


def set_names(font, version):
    style = font.fontname.split("-")[-1]
    names = {name[1]: name[2] for name in font.sfnt_names if name[0] == "English (US)"}
    copyright_text = names.get("Copyright", "").split("\nProgramming ligatures")[0] + COPYRIGHT_EXTRA

    # Drop every English entry, then write the clean set.
    for key in list(names):
        font.appendSFNTName("English (US)", key, "")

    entries = {
        "Copyright": copyright_text,
        "Family": FAMILY,
        "SubFamily": names.get("SubFamily", style),
        "UniqueID": "%s %s %s" % (FAMILY, style, version),
        "Fullname": "%s %s" % (FAMILY, names.get("SubFamily", style)),
        "Version": "Version %s" % version,
        "PostScriptName": font.fontname,
        "Manufacturer": names.get("Manufacturer", ""),
        "Designer": names.get("Designer", ""),
        "Descriptor": DESCRIPTION,
        "License": LICENSE,
        "License URL": LICENSE_URL,
        "Preferred Family": FAMILY,
        "Preferred Styles": names.get("SubFamily", style),
    }
    for key, value in entries.items():
        if value:
            font.appendSFNTName("English (US)", key, value)

    font.familyname = FAMILY
    font.fullname = entries["Fullname"]
    font.copyright = copyright_text
    font.version = version


def main():
    step, src, out = sys.argv[1:4]
    font = fontforge.open(src)
    if step == "metrics":
        set_metrics(font)
    elif step == "names":
        set_names(font, sys.argv[4])
    else:
        sys.exit("unknown step: " + step)
    font.generate(out)


main()
