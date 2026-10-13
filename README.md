# DocBatch

Drop files, type what you want done, get one answer per file. You can also send a message without uploading files
for a live answer. Every file is answered live, and an answer that is too long for one request is continued
automatically until it is finished.
Your processing API key lives only in Vercel
environment variables, never in the browser.

## Deploy (about 5 minutes)

1. Put this folder in a GitHub repo (or use the Vercel CLI: `npx vercel`).
2. On vercel.com: **Add New > Project**, import the repo. Framework preset: **Other**. No build command.
3. **Settings > Environment Variables**, add:
   - `GEMINI_API_KEY` (required): from https://aistudio.google.com/apikey
   - `APP_PASSWORD` (strongly recommended): without it, anyone with the link can spend your quota
   - `GEMINI_MODELS` (optional): comma-separated list of allowed models; `gemini-3.8-flash` is used by default when allowed
4. Redeploy so the variables take effect. Open the site, drop files, run.

Local test: `npx vercel dev` with a `.env.local` copied from `.env.example`.

## How it works

```
browser                         Vercel functions (hold the key)          Google
-------                         --------------------------------         ------
read each file, make text   ->  /api/upload  (4 MB chunks)           ->  Files API
one request per file        ->  /api/instant (file refs or message) ->  streamGenerateContent
answer cut off? ask again   ->  /api/instant (with the text so far) ->  streamGenerateContent
```

Vercel limits a request to about 4.5 MB, so files are uploaded in 4 MB chunks to Google's Files API.
Each request only references the uploaded files, so it stays tiny however big the documents are.

An answer that does not fit in one request is continued automatically; nobody has to type "continue":

- With web search on, one request can only make a limited number of searches (Google ends it with
  `TOO_MANY_TOOL_CALLS` and no answer). So for research on many items, such as a list of leads, the model does
  8 items per turn and ends the turn with `[[CONTINUE]]`. The page then sends back the answer so far and asks for
  the next items, up to 100 turns per file.
- The same happens when the model hits its output limit or the function gets close to its 300-second limit.

## Formats

| Kind | How it is read |
|---|---|
| PDF with text | text extracted in the browser (pdf.js) |
| Scanned PDF | sent as-is for visual reading (up to 20 MB) |
| Word `.docx` `.docm` | text via mammoth |
| Excel `.xlsx` `.xls` `.xlsm` `.ods` | every sheet as CSV text (SheetJS) |
| PowerPoint `.pptx` | slide text + speaker notes |
| OpenDocument `.odt` `.odp`, `.rtf`, `.epub` | text extracted |
| Images png/jpg/webp/heic | sent as-is; gif/bmp/avif/tiff converted to JPEG; large ones downscaled |
| Audio / video | sent as-is if under 20 MB |
| Text `.txt` `.md`, code, CSV, JSON, HTML, XML, emails, logs, subtitles, and anything that looks like plain text | read as text (UTF-8, UTF-16 or Windows-1252) |
| `.zip` | unpacked, every file inside is processed (2 levels deep) |

Not supported: old binary `.doc` / `.ppt` (save as `.docx`/`.pptx` or PDF), `.rar` `.7z` `.tar`, password-protected files,
audio/video over 20 MB.

## Limits to know

- **20 MB per uploaded file**. Files are sent in 4 MB chunks to stay below Vercel's request-body limit.
  Extracted text and spreadsheets are truncated to about 4 MB.
- **150 files per run**, answered three at a time.
- Failed requests are retried automatically with increasing delays, up to every five minutes, until they succeed
  or you press **Stop**. Requests Google rejects outright (for example when the key has no credit left) are not
  retried: the file keeps what was written so far and shows the reason. Answers that were already finished are kept. Keep the page open while a run is going.
  After a run, use **Run previous files again** to repeat it with the same prompt and options while the uploaded
  copies are available (up to 40 hours); this shortcut lasts only in the current tab.
- Uploaded files are deleted by Google after 48 hours.
- Free-tier keys: Google may use submitted content to improve its products. Use a billing-enabled key for private documents.
- "Allow web search" adds grounded search to each request and is billed separately by Google. It is enabled by default.
- Results use Markdown rendering with HTML sanitization and MathJax for equations. Use Download > Save as PDF to open the browser print dialog, then choose Save as PDF.

## Files

```
public/index.html   page
public/style.css    styles
public/extract.js   reads any file type in the browser
public/app.js       UI, upload, live answers, results, downloads
api/*.js            serverless functions (key stays here)
vercel.json         serves public/, 300 s function limit
```
