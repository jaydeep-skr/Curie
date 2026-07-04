#!/usr/bin/env python3
"""
update_appcast.py

Inserts a new <item> at the top of appcast.xml for the given version.
Keeps the three most recent releases in the feed (older items are removed).

Usage:
    python3 update_appcast.py \
        --appcast  macos/appcast.xml \
        --version  1.2.0 \
        --build    202505120930 \
        --sig      BASE64_ED25519_SIGNATURE \
        --size     48234512 \
        --tag      v1.2.0 \
        --gh-org   YOUR_ORG \
        --gh-repo  curie
"""

import argparse
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

KEEP_ITEMS = 5          # how many release items to retain in the feed
MIN_OS     = "13.0"

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--appcast",  required=True)
    p.add_argument("--version",  required=True)
    p.add_argument("--build",    required=True)
    p.add_argument("--sig",      required=True)
    p.add_argument("--size",     required=True)
    p.add_argument("--tag",      required=True)
    p.add_argument("--gh-org",   default="YOUR_ORG")
    p.add_argument("--gh-repo",  default="curie")
    args = p.parse_args()

    appcast_path = Path(args.appcast)
    download_url = (
        f"https://github.com/{args.gh_org}/{args.gh_repo}"
        f"/releases/download/{args.tag}/Curie-{args.version}.zip"
    )
    release_notes_url = (
        f"https://github.com/{args.gh_org}/{args.gh_repo}"
        f"/releases/tag/{args.tag}"
    )
    pub_date = datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000")

    new_item = f"""\
    <item>
      <title>Version {args.version}</title>
      <pubDate>{pub_date}</pubDate>
      <sparkle:version>{args.build}</sparkle:version>
      <sparkle:shortVersionString>{args.version}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>{MIN_OS}</sparkle:minimumSystemVersion>
      <sparkle:releaseNotesLink>{release_notes_url}</sparkle:releaseNotesLink>
      <enclosure
        url="{download_url}"
        sparkle:edSignature="{args.sig}"
        length="{args.size}"
        type="application/octet-stream" />
    </item>"""

    if not appcast_path.exists():
        # Create fresh appcast
        xml = f"""\
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"
     xmlns:sparkle="http://www.andymatten.com/xml-namespaces/sparkle"
     xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Curie</title>
    <link>https://github.com/{args.gh_org}/{args.gh_repo}</link>
    <description>Curie release feed</description>
    <language>en</language>
{new_item}
  </channel>
</rss>
"""
        appcast_path.write_text(xml)
        print(f"Created {appcast_path}")
        return

    # Insert new item after <channel>...</description> block
    content = appcast_path.read_text()

    # Find insertion point (just before first <item> or before </channel>)
    insertion_re = re.compile(r'([ \t]*<item>)', re.MULTILINE)
    channel_close_re = re.compile(r'([ \t]*</channel>)')

    m = insertion_re.search(content)
    if m:
        content = content[:m.start()] + new_item + "\n" + content[m.start():]
    else:
        m2 = channel_close_re.search(content)
        if not m2:
            print("ERROR: could not find insertion point in appcast.xml", file=sys.stderr)
            sys.exit(1)
        content = content[:m2.start()] + new_item + "\n" + content[m2.start():]

    # Prune to KEEP_ITEMS items
    items = list(re.finditer(r'<item>[\s\S]*?</item>', content))
    if len(items) > KEEP_ITEMS:
        for old in items[KEEP_ITEMS:]:
            content = content.replace(old.group(), "", 1)

    appcast_path.write_text(content)
    print(f"Updated {appcast_path} (v{args.version}, build {args.build})")

if __name__ == "__main__":
    main()
