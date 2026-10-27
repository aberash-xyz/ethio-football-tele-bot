# Visibility Index — Methodology

**Current version: v1** (2026-10-26)

A weekly ranking of Ethiopian Premier League clubs by how much attention they got on public Telegram football channels. One number per club per week: its share of all club-attributed post views.

## Principles

1. **Raw facts are stored; the index is computed.** The DB holds what we observed (posts, view counts at a point in time). The index is a deterministic function of that data plus this document. Any past week can be recomputed.
2. **No LLM in the scoring path.** Views come from HTML parsing, club attribution from alias matching. Same input, same output. The LLM only writes the commentary around the finished table.
3. **Every published number carries a method version.** Changing anything below bumps the version; history is recomputed under the new version and the change is logged at the bottom of this file.

## Inputs

| Input | Source | Stored in |
|---|---|---|
| Posts (id, time, Amharic text) | `t.me/s/<handle>` HTML | `posts` |
| Views, reactions at time *t* | same pages, `.tgme_widget_message_views` / `.tgme_reaction` | `post_metrics`, one row per observation, append-only |
| Channel set and kind | `channels.json` | git |
| Club roster and aliases | `clubs.json` | git |

Telegram shows views rounded to 3 significant figures (`6.08K`). We store the expanded integer (`6080`); precision is ±0.5% at that scale.

## Definitions

**Week.** Monday 00:00 to the following Monday 00:00, East Africa Time (UTC+3). A post belongs to the week of its `posted_at`.

**Eligible channel.** Any channel in `channels.json` whose `kind` is `media`, `federation` or `league`. Channels with `kind: club_owned` are excluded from the index. A club posting about itself is not visibility. They are reported separately as the club's own output (posts, views).

**Club tag.** A post is tagged with a club if its Amharic text (`text_am`) contains any of that club's `aliases_am` as a substring, or, when `text_am` is empty, its `text_en` contains any of `aliases_en`. Amharic prefixes and suffixes (`የ…`, `…ን`) attach to the word, so substring matching covers them. A post can carry several club tags.

Aliases are **full club names or unambiguous nicknames only**. Bare city names (`ሀዋሳ`, `ድሬዳዋ`) are not aliases: they mostly name venues ("at Dire Dawa Stadium"), not clubs.

**Measured views.** For each post, the `views` from the **first `post_metrics` row observed at least 48 hours after `posted_at`**. If no such row exists, the latest row is used and the post is counted in the report's "measured early" footnote. Posts with no metrics row at all score 0 and are footnoted.

**Club views.** Sum of measured views over the week's eligible posts tagged with the club. A post tagged with two clubs credits its full views to both (a match post is fully about both teams).

**Visibility share (the index).**

```
share(club) = club_views(club) / Σ club_views(all ranked clubs) × 100
```

Shares sum to 100. Ranked clubs are the `clubs.json` entries whose `seasons` includes the current season.

**Reported alongside the share:** rank, rank change vs. previous week (same method version), club views, tagged post count.

## Schedule

The weekly job runs **Wednesday 08:00**, after that morning's 06:00 daily run, for the week that ended Monday 00:00 EAT. The daily run takes the 48h view counts for Sunday's posts, so every post in the week has a ≥48h observation by the time the index is computed.

The daily job records metrics on every page it reads: once when a post is new, and again when it re-reads the pages holding posts aged 48–72h.

## Known limitations (v1)

- **Promotional posts are not excluded.** The promo/noise judgement lives in the LLM pass and is not stored per post. Betting ads rarely name a club, so impact is expected to be small. Revisit if spot checks show otherwise.
- **Substring matching misses** spelling variants and nicknames not in `clubs.json`, and can false-match. Alias lists are spot-checked against the corpus before each version.
- **Measurement age is 48–72h**, not exactly 48h, because the daily job runs once a day.
- **Channel mix drives the index.** A high-volume channel weighs more because it gets more views. That is intended (visibility is reach), but adding or removing a channel shifts every share, so it is a version change.
- National teams (Walias, Lucy) are not clubs and are not ranked.
- **Backfilled weeks (12 Sep – 26 Oct 2026)** were measured once, on 27 Oct 2026, so their posts are 1–6 weeks old rather than 48–72h. Views grow slowly after 48h, so these weeks read slightly high compared with later weeks.

## Changelog

| Version | Date | Change |
|---|---|---|
| v1 | 2026-10-26 | Initial definition. |
| v1 | 2026-10-27 | Before first publication: 2019 EC roster (18 clubs); Amharic aliases checked against every scoreline in the corpus, adding the common spelling ነጌሌ አርሲ. |
