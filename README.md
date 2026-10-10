# notesync

Syncs my Simplenote notes to Google Drive as Word documents.

It runs [SimpleNotesScraper](../SimpleNotesScraper) to export the notes, converts each one from Markdown to `.docx`, and uploads it to a Drive folder. Only notes that changed since the last run get uploaded, and existing Drive files are updated in place rather than re-uploaded.

## Requirements

- Node.js 20.12+
- SimpleNotesScraper, installed and working (`simplenotesscraper --env-dir ...`)
- A Google Cloud project with the Drive API enabled

## Install

```powershell
npm install
npm run build
npm link        # optional, makes `notesync` available globally
Copy-Item config\config.example.yaml config\config.yaml
```

Without `npm link`, run `node dist\cli\index.js <command>` instead of `notesync <command>`.

## SimpleNotesScraper

notesync just calls the scraper:

```powershell
simplenotesscraper --env-dir "C:\Users\Hp\Documents\SimpleNotesScraper"
```

Run `npm link` in the scraper project so the command is on your PATH, and make sure its `.env` has `TOKEN` and `GMAIL`. The command and env dir can be changed under `simplenote:` in the config.
A few things about the scraper that affect how it's used:

- It deletes and recreates `output\` in whatever directory it's started from. notesync always starts it in `data\scraper`.
- Note IDs, tags and dates are only in its console output (the `NOTES:` block), so notesync parses that.
- That output cuts notes off at 10,000 characters. For those notes the text is read from the `.txt` file instead.
- It also only lists the first 100 notes. With more than that, notesync syncs the 100 it sees and doesn't process any deletions that run. To fix it, change the `console.dir` line in the scraper's `src/index.ts` to:

  ```ts
  console.dir(notes, { depth: null, maxArrayLength: null, maxStringLength: null });
  ```

- It exits with code 0 even when login fails, so notesync treats a run with no `NOTES:` block as a failure.

## Google Drive setup

1. Create a project at https://console.cloud.google.com/.
2. APIs & Services → Library → enable **Google Drive API**.
3. Set up the OAuth consent screen: External, add yourself as a test user. Then publish the app. In "Testing" mode Google expires the login after 7 days.
4. Credentials → Create credentials → OAuth client ID → **Desktop app**. Download the JSON and save it as `config\google_credentials.json`.

By default the app uses the `drive.file` scope, which only gives it access to files it created. It creates the folder from `folder_path` itself. If you want to sync into a folder you made yourself (`folder_id`), set `scope: drive` and log in again.

Then sign in:

```powershell
notesync auth
```

The refresh token is stored in Windows Credential Manager. `notesync auth --logout` removes it.

Check that everything is set up:

```powershell
notesync doctor
```

## Configuration

Everything is in `config/config.yaml`; the example file has every option with comments. The main ones:

```yaml
simplenote:
  scraper_command: "simplenotesscraper"
  env_dir: "C:\\Users\\Hp\\Documents\\SimpleNotesScraper"
  timeout_seconds: 120

sync:
  title_keywords: []         # e.g. ["[NOTE]", "[BOOK]"]; empty = all notes
  deleted_notes: keep        # keep, move_to_trash, archive, delete

google_drive:
  folder_path: "Simplenote"
  folder_id: ""              # overrides folder_path if set

document:
  font: "Aptos"
  font_size: 11
  include_metadata: false
```

Settings can be overridden with environment variables (or a `.env` file), and CLI flags override both. For example `SNSYNC_GOOGLE_FOLDER_ID`, `SNSYNC_DELETED_NOTES`, `SNSYNC_LOG_LEVEL`, `SNSYNC_SCRAPER_ENV_DIR`. See `.env.example` for the full list. `notesync config` prints the config it's actually using.

Relative paths are relative to the project folder, not the current directory.

To sync only some notes, list keywords in `title_keywords`. A note is synced if its title contains any of them (case doesn't matter). With `["[NOTE]", "[BOOK]"]`, `[BOOK] Dune` is synced and `Shopping list` isn't. Notes that don't match are ignored. If one was synced before, its Drive file is left as it is, not deleted. The keyword stays in the file name.

When a note is deleted in Simplenote, `deleted_notes` decides what happens to its Drive file:

- `keep` (default): leave it alone
- `move_to_trash`: move it to the Drive trash
- `archive`: move it into an `Archive` subfolder
- `delete`: delete it permanently

If more than half the notes disappear in one run, deletions are skipped for that run, since it's more likely the scraper returned a partial list. `notesync --force` applies them anyway.

## Usage

```powershell
notesync              # sync
notesync --dry-run    # show what would change, without changing anything
notesync --force      # re-upload everything
notesync status       # last run, failures, etc.
```

`--verbose` shows a line per note. Ctrl+C during a sync lets the current uploads finish first.

Exit codes: 0 ok, 1 some notes failed, 2 unexpected error, 3 config error, 4 Google auth error, 5 another sync already running, 6 scraper failed.

## Markdown support

Bold, italic, strikethrough, headings, ordered/unordered/nested lists, task lists, blockquotes, inline code, code blocks, horizontal rules, links, plain URLs and tables are all converted to normal Word formatting. Single line breaks are kept, like in Simplenote. Notes without Markdown enabled in Simplenote are converted as plain text.

Fonts, sizes, spacing, margins and colours are all under `document:` in the config. Changing them makes the next sync re-upload every note once.

## Files

- `data/state.json`: maps each note ID to its Drive file ID, plus content hashes for change detection
- `data/generated/`: local copies of the `.docx` files
- `data/scraper/output/`: the scraper's raw export
- `logs/sync.log`: log file, rotated at 5 MB

The state file is written atomically, and a backup of the last good copy is kept next to it. If both get lost, nothing gets duplicated: each Drive file is tagged with its note ID, so the next sync just re-links them.

## Troubleshooting

- **Scraper not found:** run `npm link` in the scraper project, or set `scraper_command` to the full path.
- **"finished without printing a NOTES listing":** the scraper couldn't log in. Check its `.env` and try running it by hand.
- **Google auth errors:** run `notesync auth` again. If it happens again after a week, publish the OAuth app.
- **"Configured Google Drive folder ... is not accessible":** with `drive.file` the app can't see folders you created. Use `folder_path` or switch to `scope: drive`.
- **"Another synchronization is already running":** something else is syncing. If not, delete `data\sync.lock`.
- **A long note fails with "output file does not match the listing":** two notes start with the same line, and the scraper only kept one `.txt` file. Rename one, or apply the scraper fix above.

Otherwise, check `notesync status` and `logs\sync.log`.

## Security

- No credentials are stored in the repo. `config.yaml`, `google_credentials.json`, `.env`, `data/` and `logs/` are all git-ignored.
- The default Drive scope only allows access to files the app created.
- Tokens and secrets are masked in the logs; note contents are never logged.
- `data/` contains your notes in plain text, so keep the folder private.

## Development

```powershell
npm run dev -- --dry-run   # run from source
npm test
npm run typecheck
```

Drive is mocked in the tests.
