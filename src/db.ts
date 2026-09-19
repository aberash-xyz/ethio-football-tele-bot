import { Database } from "bun:sqlite";

export interface PostRow {
  channel: string;
  post_id: number;
  posted_at: string;
  fetched_at: string;
  text_am: string | null;
  text_en: string | null;
  photo_urls: string; // JSON array
  url: string;
}

export interface NewPost {
  channel: string;
  post_id: number;
  posted_at: string;
  text_am: string | null;
  photo_urls: string[];
  url: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS posts (
  channel     TEXT NOT NULL,
  post_id     INTEGER NOT NULL,
  posted_at   TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  text_am     TEXT,
  text_en     TEXT,
  photo_urls  TEXT,
  url         TEXT NOT NULL,
  PRIMARY KEY (channel, post_id)
);
CREATE INDEX IF NOT EXISTS posts_posted_at ON posts (posted_at);
`;

export function openDb(path = "data/digest.sqlite"): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = DELETE;"); // single-file so git commit sees everything
  db.exec(SCHEMA);
  return db;
}

export function lastSeen(db: Database, channel: string): number {
  const row = db
    .query<{ m: number | null }, [string]>("SELECT MAX(post_id) AS m FROM posts WHERE channel = ?")
    .get(channel);
  return row?.m ?? 0;
}

/** Inserts new posts; returns count actually inserted. */
export function insertPosts(db: Database, posts: NewPost[]): number {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO posts (channel, post_id, posted_at, fetched_at, text_am, text_en, photo_urls, url)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
  );
  const now = new Date().toISOString();
  let n = 0;
  const tx = db.transaction((rows: NewPost[]) => {
    for (const p of rows) {
      const r = stmt.run(p.channel, p.post_id, p.posted_at, now, p.text_am, JSON.stringify(p.photo_urls), p.url);
      n += r.changes;
    }
  });
  tx(posts);
  return n;
}

/** Untranslated posts in [since, until), grouped by channel. */
export function pendingByChannel(db: Database, since: string, until: string): Map<string, PostRow[]> {
  const rows = db
    .query<PostRow, [string, string]>(
      `SELECT * FROM posts
       WHERE text_en IS NULL AND posted_at >= ? AND posted_at < ?
       ORDER BY channel, post_id`,
    )
    .all(since, until);
  const out = new Map<string, PostRow[]>();
  for (const r of rows) {
    if (!out.has(r.channel)) out.set(r.channel, []);
    out.get(r.channel)!.push(r);
  }
  return out;
}

export function writeTranslations(db: Database, channel: string, items: { id: number; en: string }[]): void {
  const stmt = db.prepare("UPDATE posts SET text_en = ? WHERE channel = ? AND post_id = ?");
  const tx = db.transaction((rows: { id: number; en: string }[]) => {
    for (const r of rows) stmt.run(r.en, channel, r.id);
  });
  tx(items);
}
