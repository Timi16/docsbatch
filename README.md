# DocBatch

Drop files, type what you want done, get one answer per file. Choose quick live answers for a few files
or asynchronous batch processing for larger runs. Your processing API key lives only in Vercel
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
read each file, make text   ->  /api/upload  (<4 MB each)            ->  Files API
create batch from file refs -> /api/submit                          -> Batch API
poll every few seconds      -> /api/status (returns answers)       <- Batch API
(quick mode)                 -> /api/instant (one live call per file)-> generateContent
```

Vercel limits a request to about 4.5 MB, so files are uploaded one at a time to Google's Files API and
the batch job only references them. That keeps the batch request tiny however many files you add.

## Formats

| Kind | How it is read |
|---|---|
| PDF with text | text extracted in the browser (pdf.js) |
| Scanned PDF | sent for visual reading (or as page images if over 4 MB, first 40 pages) |
| Word `.docx` `.docm` | text via mammoth |
| Excel `.xlsx` `.xls` `.xlsm` `.ods` | every sheet as CSV text (SheetJS) |
| PowerPoint `.pptx` | slide text + speaker notes |
| OpenDocument `.odt` `.odp`, `.rtf`, `.epub` | text extracted |
| Images png/jpg/webp/heic | sent as-is; gif/bmp/avif/tiff converted to JPEG; large ones downscaled |
| Audio / video | sent as-is if under ~4 MB |
| Text, code, CSV, JSON, HTML, XML, emails, logs, subtitles, and anything that looks like plain text | read as text |
| `.zip` | unpacked, every file inside is processed (2 levels deep) |

Not supported: old binary `.doc` / `.ppt` (save as `.docx`/`.pptx` or PDF), `.rar` `.7z` `.tar`, password-protected files,
audio/video over ~4 MB (needs a direct-to-storage upload, see below).

## Limits to know

- **4 MB per uploaded file** (Vercel body limit). Text files and spreadsheets are truncated to fit. To lift this,
  upload straight from the browser to Vercel Blob or Google Cloud Storage and reference the URL.
- **150 files per run** so the answers fit in one 4.5 MB response.
- Batch jobs are asynchronous. Google targets 24 hours; small jobs often finish in minutes. Use Quick mode for live
  responses on a few files. The page stores the batch job id
  in your browser, so closing the tab is fine: reopen it and the results load. Google keeps results for 6 weeks.
- Uploaded files are deleted by Google after 48 hours.
- Free-tier keys: Google may use submitted content to improve its products. Use a billing-enabled key for private documents.
- "Allow web search" adds grounded search to each request and is billed separately by Google. It is enabled by default.
- Results support headings, lists, and basic inline Markdown. Use Download > Save as PDF to open the browser print dialog, then choose Save as PDF.

## Files

```
public/index.html   page
public/style.css    styles
public/extract.js   reads any file type in the browser
public/app.js       UI, upload, batch polling, results, downloads
api/*.js            serverless functions (key stays here)
vercel.json         serves public/, 60 s function limit
```
