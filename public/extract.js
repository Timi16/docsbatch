/* extract.js - turns almost any file into something Gemini can read, entirely in the browser.
 *
 * prepare(file, name) -> { blobs: [{ blob, mime, name }], note }
 *   - text-like files, Word, Excel, PowerPoint, OpenDocument, RTF, EPUB, text PDFs -> plain text
 *   - scanned PDFs -> the PDF itself (or page images if it is too big)
 *   - images -> as-is, or converted/downscaled to JPEG
 *   - audio / video -> as-is when small enough
 * expandZips(items) unpacks .zip files into their individual files.
 */
window.Extract = (() => {
  // Vercel limits a request body to ~4.5 MB, so every uploaded blob stays under this.
  const MAX = 4 * 1024 * 1024 - 64 * 1024;

  const CDN = {
    mammoth: 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
    xlsx: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
    jszip: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
    pdf: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
    pdfWorker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
  };
  const loaded = {};
  function load(key) {
    if (!loaded[key]) {
      loaded[key] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = CDN[key];
        s.onload = resolve;
        s.onerror = () => {
          delete loaded[key];
          reject(new Error('Could not load a helper library (' + key + '). Check your connection and try again.'));
        };
        document.head.append(s);
      });
    }
    return loaded[key];
  }

  const TEXT_EXT = new Set((
    'txt md markdown csv tsv json jsonl ndjson xml html htm xhtml svg eml log yaml yml toml ini cfg conf env ' +
    'js mjs cjs ts tsx jsx py rb php java c h cpp hpp cs go rs swift kt sql sh bat ps1 r tex bib srt vtt css ' +
    'scss less vue svelte ipynb rst org adoc properties gradle vcf ics'
  ).split(' '));
  const IMG_NATIVE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };
  const IMG_CONVERT = new Set(['gif', 'bmp', 'avif', 'ico', 'tif', 'tiff']);
  const AUDIO = { mp3: 'audio/mp3', wav: 'audio/wav', aac: 'audio/aac', m4a: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', aiff: 'audio/aiff', aif: 'audio/aiff' };
  const VIDEO = { mp4: 'video/mp4', mov: 'video/mov', webm: 'video/webm', mpeg: 'video/mpeg', mpg: 'video/mpg', avi: 'video/avi', wmv: 'video/wmv', flv: 'video/x-flv', '3gp': 'video/3gpp', m4v: 'video/mp4' };

  const ext = (n) => (String(n).split('.').length > 1 ? String(n).split('.').pop().toLowerCase() : '');
  const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

  function decodeEntities(s) {
    return s
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&amp;/g, '&');
  }

  // Wraps text as a plain-text blob, truncating to fit the upload limit.
  function finish(text, name, note) {
    text = String(text || '').replace(/\r\n?/g, '\n').trim();
    if (!text) throw new Error('No text found in this file.');
    const bytes = new TextEncoder().encode(text);
    let truncated = false;
    if (bytes.length > MAX) {
      text = new TextDecoder().decode(bytes.slice(0, MAX - 64)) + '\n\n[... truncated to fit the upload limit ...]';
      truncated = true;
    }
    return {
      blobs: [{ blob: new Blob([text], { type: 'text/plain' }), mime: 'text/plain', name: name + '.txt' }],
      note: [note, truncated ? 'truncated to ~4 MB of text' : ''].filter(Boolean).join(' · '),
    };
  }

  async function sniffText(file) {
    const buf = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    if (!buf.length) return false;
    let bad = 0;
    for (const b of buf) {
      if (b === 0) return false;
      if (b < 9 || (b > 13 && b < 32)) bad++;
    }
    return bad / buf.length < 0.02;
  }

  // ---- individual readers ------------------------------------------------
  async function readPdf(file, name) {
    await load('pdf');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = CDN.pdfWorker;
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await window.pdfjsLib.getDocument({ data }).promise;
    let text = '';
    let chars = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      let line = '';
      for (const it of tc.items) line += it.str + (it.hasEOL ? '\n' : ' ');
      line = line.trim();
      chars += line.length;
      text += `\n--- Page ${p} ---\n${line}`;
      page.cleanup();
    }
    if (chars / doc.numPages >= 40) return finish(text, name, `${doc.numPages} page${doc.numPages > 1 ? 's' : ''}, text read`);

    // Scanned / image-only PDF: let Gemini read it visually.
    if (file.size <= MAX) {
      return { blobs: [{ blob: file, mime: 'application/pdf', name }], note: 'scanned PDF, sent as-is for visual reading' };
    }
    const maxPages = Math.min(doc.numPages, 40);
    const blobs = [];
    for (let p = 1; p <= maxPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.72));
      if (blob) blobs.push({ blob, mime: 'image/jpeg', name: `${name}-p${p}.jpg` });
      page.cleanup();
    }
    return {
      blobs,
      note: `scanned PDF too big to send whole: ${maxPages} of ${doc.numPages} pages sent as images`,
    };
  }

  async function readDocx(file, name) {
    await load('mammoth');
    const r = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return finish(r.value, name, 'Word text read');
  }

  async function readSheet(file, name) {
    await load('xlsx');
    const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    const text = wb.SheetNames
      .map((n) => `## Sheet: ${n}\n` + window.XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false }))
      .join('\n\n');
    return finish(text, name, `${wb.SheetNames.length} sheet${wb.SheetNames.length > 1 ? 's' : ''} read`);
  }

  const numericSort = (a, b) => (parseInt(a.match(/(\d+)\.xml$/)?.[1] || 0, 10) - parseInt(b.match(/(\d+)\.xml$/)?.[1] || 0, 10));
  const xmlText = (xml) => decodeEntities(xml.replace(/<\/a:p>/g, '\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim();

  async function readPptx(file, name) {
    await load('jszip');
    const zip = await window.JSZip.loadAsync(file);
    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(numericSort);
    if (!slides.length) throw new Error('No slides found in this file.');
    const out = [];
    for (const n of slides) {
      const num = n.match(/slide(\d+)\.xml$/)[1];
      let t = `--- Slide ${num} ---\n` + xmlText(await zip.file(n).async('string'));
      const notes = zip.file(`ppt/notesSlides/notesSlide${num}.xml`);
      if (notes) {
        const nt = xmlText(await notes.async('string'));
        if (nt) t += `\n[Speaker notes] ${nt}`;
      }
      out.push(t);
    }
    return finish(out.join('\n\n'), name, `${slides.length} slides read`);
  }

  async function readOdf(file, name) {
    await load('jszip');
    const zip = await window.JSZip.loadAsync(file);
    const f = zip.file('content.xml');
    if (!f) throw new Error('Not a valid OpenDocument file.');
    const xml = await f.async('string');
    const text = decodeEntities(
      xml.replace(/<\/text:(p|h)>|<text:line-break\/>|<\/draw:page>/g, '\n').replace(/<text:tab\/>/g, '\t').replace(/<[^>]+>/g, '')
    ).replace(/\n{3,}/g, '\n\n');
    return finish(text, name, 'OpenDocument text read');
  }

  async function readEpub(file, name) {
    await load('jszip');
    const zip = await window.JSZip.loadAsync(file);
    const pages = Object.keys(zip.files).filter((n) => /\.(x?html?)$/i.test(n)).sort();
    const out = [];
    for (const n of pages) {
      const html = await zip.file(n).async('string');
      out.push(decodeEntities(
        html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<\/(p|div|h\d|li|tr|br)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
      ).replace(/\n{3,}/g, '\n\n').trim());
    }
    return finish(out.join('\n\n'), name, `${pages.length} sections read`);
  }

  async function readRtf(file, name) {
    const t = (await file.text())
      .replace(/\{\\\*[^{}]*\}/g, '')
      .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\par[d]?/g, '\n').replace(/\\tab/g, '\t')
      .replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '');
    return finish(t, name, 'RTF text read (basic)');
  }

  async function toJpeg(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('This image format cannot be decoded in the browser.'));
        i.src = url;
      });
      let max = 2400;
      let q = 0.85;
      for (let a = 0; a < 6; a++) {
        const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * s));
        const h = Math.max(1, Math.round(img.naturalHeight * s));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
        if (b && b.size <= MAX) return b;
        max = Math.round(max * 0.75);
        q = Math.max(0.6, q - 0.08);
      }
      throw new Error('Image is too large even after shrinking.');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function readImage(file, name, e) {
    const native = IMG_NATIVE[e];
    if (native && file.size <= MAX) return { blobs: [{ blob: file, mime: native, name }], note: 'image sent as-is' };
    const blob = await toJpeg(file);
    return {
      blobs: [{ blob, mime: 'image/jpeg', name: name.replace(/\.[^.]+$/, '') + '.jpg' }],
      note: native ? 'image downscaled to fit the upload limit' : 'image converted to JPEG',
    };
  }

  function readMedia(file, name, mime, kind) {
    if (file.size > MAX) {
      throw new Error(`${kind} file is ${mb(file.size)}; this deployment accepts up to about 4 MB per file.`);
    }
    return { blobs: [{ blob: file, mime, name }], note: `${kind.toLowerCase()} sent as-is` };
  }

  // ---- public ------------------------------------------------------------
  async function prepare(file, name) {
    const e = ext(file.name);
    const mime = (file.type || '').toLowerCase();
    name = name || file.name;

    if (e === 'pdf' || mime === 'application/pdf') return readPdf(file, name);
    if (['docx', 'docm', 'dotx'].includes(e)) return readDocx(file, name);
    if (['xlsx', 'xlsm', 'xlsb', 'xls', 'ods'].includes(e)) return readSheet(file, name);
    if (['pptx', 'pptm', 'ppsx'].includes(e)) return readPptx(file, name);
    if (['odt', 'odp'].includes(e)) return readOdf(file, name);
    if (e === 'epub') return readEpub(file, name);
    if (e === 'rtf') return readRtf(file, name);
    if (IMG_NATIVE[e] || IMG_CONVERT.has(e) || (mime.startsWith('image/') && e !== 'svg')) return readImage(file, name, e);
    if (AUDIO[e]) return readMedia(file, name, AUDIO[e], 'Audio');
    if (VIDEO[e]) return readMedia(file, name, VIDEO[e], 'Video');
    if (TEXT_EXT.has(e) || mime.startsWith('text/')) return finish(await file.text(), name, '');
    if (['doc', 'ppt'].includes(e)) {
      throw new Error('Old binary .' + e + ' files cannot be read in the browser. Save it as .' + e + 'x or PDF and add it again.');
    }
    if (['rar', '7z', 'tar', 'gz', 'tgz', 'bz2'].includes(e)) throw new Error('This archive type is not supported. Use .zip.');
    if (await sniffText(file)) return finish(await file.text(), name, 'read as plain text');
    throw new Error('Unsupported binary format (.' + (e || 'unknown') + ').');
  }

  // Unpacks .zip files (up to 2 levels deep) into separate items {file, name}.
  async function expandZips(items, depth = 0) {
    const out = [];
    for (const it of items) {
      if (ext(it.name) === 'zip' && depth < 2) {
        try {
          await load('jszip');
          const zip = await window.JSZip.loadAsync(it.file);
          const entries = Object.values(zip.files)
            .filter((z) => !z.dir && !z.name.split('/').some((seg) => seg.startsWith('.') || seg === '__MACOSX'))
            .slice(0, 300);
          const inner = [];
          for (const z of entries) {
            const blob = await z.async('blob');
            inner.push({ file: new File([blob], z.name.split('/').pop()), name: `${it.name}/${z.name}` });
          }
          out.push(...(await expandZips(inner, depth + 1)));
          continue;
        } catch (err) {
          /* corrupt zip: fall through and let prepare() report it */
        }
      }
      out.push(it);
    }
    return out;
  }

  return { prepare, expandZips, ext, MAX };
})();
