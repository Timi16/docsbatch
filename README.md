# DocBatch

A chat app for documents. Ask anything, or attach files and say what to do with them: every file gets its own
answer. Long tasks, such as researching a list of 200 leads, keep going until they are finished without anyone
typing "continue". Your OpenAI API key lives only in Vercel environment variables, never in the browser.

Many people can use one deployment at once. There are no accounts: each person's chats are saved in their own
browser, so nobody sees anyone else's chats. Set `APP_PASSWORD` so only people you give it to can spend your credit.

## Deploy (about 5 minutes)

1. Put this folder in a GitHub repo (or use the Vercel CLI: `npx vercel`).
2. On vercel.com: **Add New > Project**, import the repo. Framework preset: **Other**. No build command.
3. **Settings > Environment Variables**, add:
   - `OPENAI_API_KEY` (required): from https://platform.openai.com/api-keys
   - `APP_PASSWORD` (strongly recommended): without it, anyone with the link can spend your credit
   - `TAVILY_API_KEY` (needed for web search): from https://tavily.com; the free plan covers 1,000 searches a month
   - `OPENAI_MODELS` (optional): comma-separated list of allowed models; `gpt-6-luna` is used by default when allowed
4. Redeploy so the variables take effect.

The functions may run for up to 300 seconds (`vercel.json`), which needs Fluid Compute (on by default for new
Vercel projects).

Local test: `npx vercel dev` with a `.env.local` copied from `.env.example`.

## Using it

- **Sidebar:** your chats, newest first, grouped by day. Search them, and use **⋯** to rename or delete one.
  **New chat** (or ⌘/Ctrl+Shift+O) starts over. The panel button hides the sidebar on wide screens.
- **Chat box:** type and press Enter (Shift+Enter for a new line). Attach files with the paperclip, or drop files or
  folders anywhere on the page. With files attached, your message is the instruction for each file.
- **Follow-ups:** the model sees the earlier messages and answers in the chat, so "now make that a table" works.
  It does not see files attached to earlier messages, only the answers about them.
- **Web search:** the toggle in the chat box. On by default. Searches run only through Tavily; OpenAI's own web
  search (billed per search) is never used. Without `TAVILY_API_KEY`, searching is refused with a message.
- **Live progress:** answers stream in as they are written. Above each answer a line shows what the model is doing
  (Thinking, Searching the web, Writing). Click it to see every search it ran and the sites it found; when it is
  done it sums up, e.g. "Searched the web 8 times · 25 sites · 50s". Sources sit behind a **Sources** button.
- **Stop / Continue:** Stop ends a run and keeps what was written. **Continue** picks up a stopped answer where it
  left off; **Retry** reruns a failed one. Uploaded files can be reused this way for 40 hours.
- **Download:** the arrow at the top right saves the chat as a PDF file (your messages and every answer), or every
  answer as CSV, JSON, Markdown or plain text. Each answer also has its own **PDF** button. PDFs use a standard font,
  so text in non-Latin scripts may not show correctly in them.

## How it works

```
browser                         Vercel functions (hold the key)          OpenAI
-------                         --------------------------------         ------
read each file, make text   ->  /api/upload  (4 MB chunks)           ->  Uploads API (files expire after 48 h)
one request per file        ->  /api/instant (file ids or message)  ->  Responses API, streamed
progress as it happens      <-  one JSON event per line (searches, text, then the result)
answer cut off? ask again   ->  /api/instant (with the text so far) ->  Responses API, streamed
```

Vercel limits a request to about 4.5 MB, so files go up in 4 MB parts that OpenAI joins into one file.
Each request only references the uploaded files, so it stays small however big the documents are.

An answer that does not fit in one request is continued automatically:

- Web searches are function calls the server answers with Tavily results (5 short snippets each), so the model
  only pays for the text it reads.
- For research on many items, such as a list of leads, the model does 8 items per turn and ends the turn with
  `[[CONTINUE]]`. The page then sends back the answer so far and asks for the next items, up to 100 turns per file.
- The same happens when the model hits its output limit or the function gets close to its time limit. If a research
  turn runs out of time before writing anything, the next turns take 3 items at a time.
- Inline citation links are taken out of the answer text (they break requested formats) and shown as source chips.

## Formats

| Kind | How it is read |
|---|---|
| PDF with text | text extracted in the browser (pdf.js) |
| Scanned PDF | sent as-is for visual reading (up to 20 MB) |
| Word `.docx` `.docm` | text via mammoth |
| Excel `.xlsx` `.xls` `.xlsm` `.ods` | every sheet as CSV text (SheetJS) |
| PowerPoint `.pptx` | slide text + speaker notes |
| OpenDocument `.odt` `.odp`, `.rtf`, `.epub` | text extracted |
| Images png/jpg/webp | sent as-is; gif/bmp/avif/tiff/heic converted to JPEG; large ones downscaled |
| Text `.txt` `.md`, code, CSV, JSON, HTML, XML, emails, logs, subtitles, and anything that looks like plain text | read as text (UTF-8, UTF-16 or Windows-1252) |
| `.zip` | unpacked, every file inside is processed (2 levels deep) |

Not supported: audio and video, old binary `.doc` / `.ppt` (save as `.docx`/`.pptx` or PDF), `.rar` `.7z` `.tar`,
password-protected files.

## Limits to know

- **20 MB per uploaded file**, **150 files per message**, answered three at a time.
  Extracted text and spreadsheets are truncated to about 4 MB.
- Failed requests are retried automatically with increasing delays, up to every five minutes, until they succeed or
  you press **Stop**; the reason is shown while it retries. Requests OpenAI rejects outright (for example when the
  account has no credit left) are not retried: the file keeps what was written so far and shows the reason.
- Keep the page open while a run is going. If it is closed mid-run, the chat keeps what was written and offers
  **Continue**.
- Chats live in the browser's local storage. Clearing site data deletes them, and they do not sync between devices.
  When storage is full, the oldest chats are dropped first.
- **Cost:** with `gpt-6-luna` the model itself is cheap: a 12-lead research test used about $0.004 of OpenAI credit and
  23 Tavily searches. Searches are the limit: each costs 1 Tavily credit (1,000 free a month, then $0.008 each), and
  each request is capped at 16 searches. A 200-lead list with a second REVIEW pass needs roughly 300–400.
  Set a monthly budget limit in your OpenAI settings as a safety net.

## Files

```
public/index.html   page
public/style.css    styles
public/extract.js   reads any file type in the browser
public/app.js       chats, sidebar, chat box, uploads, live answers, downloads
api/*.js            serverless functions (key stays here)
vercel.json         serves public/, 300 s function limit
```
