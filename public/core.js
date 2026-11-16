/* Voice Closeout core: find sign-off labels in any PDF and write values next to them.
   Works in the browser (window.PDFLib + window.pdfjsLib) and in Node (for tests). */
(function (root) {
  const FIELD_DEFS = [
    { key: 'arrival', label: 'Arrival', kind: 'line',
      re: /^(arrival( time)?|time in|time arrived|check[- ]?in( time)?)\s*:?\s*$/i },
    { key: 'departure', label: 'Departure', kind: 'line',
      re: /^(departure( time)?|time out|time departed|check[- ]?out( time)?)\s*:?\s*$/i },
    { key: 'managerName', label: 'Manager (print)', kind: 'line',
      re: /^(((site|store|on[- ]site)\s+)?(manager|customer|contact|supervisor|representative|rep)\b[^:]{0,28}\b(print(ed)?|name)\)?\s*:?|print(ed)? name\s*:?)\s*$/i },
    { key: 'signature', label: 'Signature', kind: 'sig',
      re: /^[^:]{0,30}\bsignature\s*:?\s*$/i },
    { key: 'description', label: 'Description of work', kind: 'block',
      re: /^(description of (the )?work( performed| done)?|work performed|work description|work done|resolution|notes|comments)\s*:?\s*$/i },
    { key: 'techName', label: 'Tech name', kind: 'line', prefill: true,
      re: /^tech(nician)?('s)?\s+name\s*:?\s*$/i },
    { key: 'workOrder', label: 'Work order', kind: 'line', prefill: true,
      re: /^(work\s*order|wo|ticket)\s*(#|no\.?|number)?\s*:?\s*$/i },
    { key: 'date', label: 'Date', kind: 'line', prefill: true,
      re: /^date\s*:?\s*$/i },
    { key: 'address', label: 'Site address', kind: 'line', prefill: true,
      re: /^(street\s+)?address(\s+of\s+site)?\s*:?\s*$/i },
  ];

  /* Group pdf.js text items into runs: pieces of text on one baseline with small gaps. */
  function buildRuns(items) {
    const parts = items
      .filter(it => it.str && it.str.trim() !== '')
      .map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5],
                    w: it.width, h: Math.abs(it.transform[3]) || it.height || 8 }));
    parts.sort((a, b) => (Math.abs(a.y - b.y) < 1.5 ? a.x - b.x : b.y - a.y));
    const runs = [];
    for (const p of parts) {
      const r = runs[runs.length - 1];
      if (r && Math.abs(r.y - p.y) < 1.5 && p.x - (r.x + r.w) < 4.5 && p.x >= r.x) {
        const gap = p.x - (r.x + r.w);
        r.text += (gap > 0.8 && !r.text.endsWith(' ') && !p.str.startsWith(' ') ? ' ' : '') + p.str;
        r.w = p.x + p.w - r.x;
        r.h = Math.max(r.h, p.h);
      } else {
        runs.push({ text: p.str, x: p.x, y: p.y, w: p.w, h: p.h });
      }
    }
    runs.forEach(r => { r.text = r.text.replace(/\s+/g, ' ').trim(); });
    return runs;
  }

  /* Labels are often printed together with their value on one run ("Date: 05/20/24").
     Split "Label: value" runs so the label regex can match the label part. */
  function splitLabelRuns(runs, fontW) {
    const out = [];
    for (const r of runs) {
      const m = r.text.match(/^([^:]{2,40}:)\s+(.+)$/);
      if (m) {
        const lw = r.w * (m[1].length / r.text.length);
        out.push({ ...r, text: m[1], w: lw, inlineValue: m[2] });
      } else out.push(r);
    }
    return out;
  }

  async function analyzePdf(pdfjsLib, bytes) {
    const doc = await pdfjsLib.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
    const pages = [];
    let fullText = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const runs = splitLabelRuns(buildRuns(tc.items));
      fullText += runs.map(r => r.text + (r.inlineValue ? ' ' + r.inlineValue : '')).join('\n') + '\n\n';
      const found = {};
      for (const def of FIELD_DEFS) {
        for (const r of runs) {
          if (r.text.length > 45) continue;
          if (def.re.test(r.text) && !found[def.key]) { found[def.key] = r; }
        }
      }
      // A signature label that is really the manager-name label: keep them distinct.
      if (found.signature && found.managerName && found.signature === found.managerName) delete found.signature;
      pages.push({ index: i - 1, width: vp.width, height: vp.height, runs, found,
                   score: Object.keys(found).filter(k => !FIELD_DEFS.find(d => d.key === k).prefill).length * 2
                          + Object.keys(found).length });
    }
    const best = pages.slice().sort((a, b) => b.score - a.score)[0];
    const fields = {};
    if (best) {
      for (const def of FIELD_DEFS) {
        const lab = best.found[def.key];
        if (!lab) continue;
        fields[def.key] = layoutFor(def, lab, best);
      }
    }
    // Pre-printed values (tech, WO, date, address) to show in the app.
    const prefilled = {};
    for (const [k, f] of Object.entries(fields)) if (f.existing) prefilled[k] = f.existing;
    return { numPages: doc.numPages, pageIndex: best ? best.index : -1, page: best, fields, prefilled,
             text: fullText.slice(0, 12000) };
  }

  function layoutFor(def, lab, page) {
    const runs = page.runs;
    const right0 = lab.x + lab.w + 2;
    // Right boundary: next label on the same row.
    const isLabel = r => /:\s*$/.test(r.text) && r.text.length <= 45;
    const sameRow = runs.filter(r => r !== lab && r.x > right0 &&
      (Math.abs(r.y - lab.y) < 3.5 || (isLabel(r) && Math.abs(r.y - lab.y) < 7)));
    const maxX = sameRow.length ? Math.min(...sameRow.map(r => r.x)) - 6 : page.width - 52;
    // Value already printed under the label?
    let existing = lab.inlineValue || '';
    if (!existing) {
      const under = runs.filter(r => r !== lab && !isLabel(r) && r.y < lab.y - 1 && r.y > lab.y - 15
                                   && r.x >= lab.x - 3 && r.x < Math.min(Math.max(lab.x + 40, maxX), maxX + 1));
      if (under.length) existing = under.sort((a, b) => b.y - a.y)[0].text;
    }
    // Bottom boundary: nearest text below in this column, or the next row's label anywhere.
    const below = runs.filter(r => r.y < lab.y - 3 && r.text !== existing);
    const pool = below.filter(r => (r.x < maxX && r.x + r.w > lab.x - 2 && !(isLabel(r) && r.y > lab.y - 7))
                                 || (isLabel(r) && r.y < lab.y - 7));
    const nextY = pool.length ? Math.max(...pool.map(r => r.y + r.h)) : lab.y - 140;
    const minY = Math.max(nextY + 4, 24);
    return { key: def.key, kind: def.kind, x: lab.x, y: lab.y, h: lab.h, maxX, minY, existing,
             labelText: lab.text };
  }

  function winAnsi(s) {
    return String(s == null ? '' : s)
      .replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"')
      .replace(/[–—−]/g, '-').replace(/…/g, '...').replace(/•/g, '-')
      .replace(/[   ]/g, ' ').replace(/×/g, 'x')
      .replace(/[^\x09\x0A\x0D\x20-\x7E\xA1-\xFF]/g, '');
  }

  function wrap(text, font, size, maxW) {
    const lines = [];
    for (const para of winAnsi(text).split(/\n/)) {
      const words = para.split(/\s+/).filter(Boolean);
      let line = '';
      for (const w of words) {
        const t = line ? line + ' ' + w : w;
        if (font.widthOfTextAtSize(t, size) <= maxW || !line) line = t;
        else { lines.push(line); line = w; }
      }
      lines.push(line);
    }
    return lines;
  }

  async function embedPng(PDFLib, doc, dataUrlOrBytes) {
    if (typeof dataUrlOrBytes === 'string') {
      const b64 = dataUrlOrBytes.split(',')[1];
      const bin = (typeof atob === 'function') ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return doc.embedPng(arr);
    }
    return doc.embedPng(dataUrlOrBytes);
  }

  /* values: {arrival, departure, managerName, description, techName, workOrder, date, address,
              followUps:[], signaturePng (dataURL), photos:[{name, jpegBytes, w, h}]} */
  async function buildPdf(PDFLib, opts) {
    const { templateBytes, analysis, values, alwaysSummary } = opts;
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const doc = templateBytes ? await PDFDocument.load(templateBytes, { ignoreEncryption: true })
                              : await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const ink = rgb(0.05, 0.12, 0.42);
    const sig = values.signaturePng ? await embedPng(PDFLib, doc, values.signaturePng) : null;
    const placed = {};

    if (templateBytes && analysis && analysis.pageIndex >= 0) {
      const page = doc.getPage(analysis.pageIndex);
      for (const f of Object.values(analysis.fields)) {
        const v = f.key === 'signature' ? sig : values[f.key];
        if (!v) continue;
        if (f.existing && f.key !== 'description') { placed[f.key] = 'printed'; continue; }
        const width = Math.max(30, f.maxX - f.x);
        if (f.kind === 'line') {
          let size = 9.5;
          const t = winAnsi(v);
          while (size > 6 && font.widthOfTextAtSize(t, size) > width) size -= 0.5;
          const y = Math.max(f.y - f.h - 3.5, f.minY);
          page.drawText(t, { x: f.x + 1, y, size, font, color: ink });
          placed[f.key] = 'filled';
        } else if (f.kind === 'block') {
          const top = f.y - 4;
          const avail = top - f.minY;
          let size = 9.5, lines, lh;
          for (;;) {
            lh = size * 1.28;
            lines = wrap(v, font, size, width);
            if (lines.length * lh <= avail || size <= 6) break;
            size -= 0.5;
          }
          const maxLines = Math.max(1, Math.floor(avail / lh));
          if (lines.length > maxLines) {
            lines = lines.slice(0, maxLines);
            lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + ' (cont. on summary page)';
            placed.overflow = true;
          }
          lines.forEach((ln, i) => page.drawText(ln, { x: f.x + 1, y: top - size - i * lh, size, font, color: ink }));
          placed[f.key] = 'filled';
        } else if (f.kind === 'sig') {
          const availH = Math.max(14, Math.min(34, f.y - 2 - f.minY));
          const scale = Math.min(availH / sig.height, (width - 4) / sig.width);
          const w = sig.width * scale, h = sig.height * scale;
          page.drawImage(sig, { x: f.x + 4, y: Math.max(f.y - 2 - h, f.minY), width: w, height: h });
          placed[f.key] = 'filled';
        }
      }
    }

    const wanted = ['arrival', 'departure', 'managerName', 'description', 'signature'];
    const missing = wanted.filter(k => !placed[k] && (k === 'signature' ? sig : values[k]));
    const needSummary = !templateBytes || alwaysSummary || missing.length || placed.overflow
                        || (values.followUps && values.followUps.length && alwaysSummary);
    if (needSummary) drawSummary(doc, font, bold, rgb, values, sig);

    for (const ph of values.photos || []) {
      const img = await doc.embedJpg(ph.jpegBytes);
      const p = doc.addPage([612, 792]);
      const maxW = 612 - 72, maxH = 792 - 110;
      const s = Math.min(maxW / img.width, maxH / img.height);
      const w = img.width * s, h = img.height * s;
      p.drawText(winAnsi(`WO ${values.workOrder || ''}  |  ${ph.caption || ph.name}`), { x: 36, y: 760, size: 10, font: bold, color: rgb(0.15, 0.17, 0.2) });
      p.drawImage(img, { x: (612 - w) / 2, y: 740 - h, width: w, height: h });
    }
    const bytes = await doc.save();
    return { bytes, placed, missing, summary: !!needSummary };
  }

  function drawSummary(doc, font, bold, rgb, v, sig) {
    const p = doc.addPage([612, 792]);
    const dark = rgb(0.11, 0.13, 0.17), mute = rgb(0.42, 0.45, 0.5), accent = rgb(0.91, 0.36, 0.05);
    p.drawRectangle({ x: 0, y: 762, width: 612, height: 30, color: rgb(0.11, 0.13, 0.17) });
    p.drawRectangle({ x: 0, y: 758, width: 612, height: 4, color: accent });
    p.drawText('CLOSEOUT SUMMARY', { x: 36, y: 772, size: 12, font: bold, color: rgb(1, 1, 1) });
    p.drawText(winAnsi(v.workOrder ? `WO ${v.workOrder}` : ''), { x: 612 - 36 - bold.widthOfTextAtSize(winAnsi(v.workOrder ? `WO ${v.workOrder}` : ''), 12), y: 772, size: 12, font: bold, color: rgb(1, 1, 1) });
    let y = 728;
    const row = (label, val, x, w) => {
      p.drawText(label.toUpperCase(), { x, y, size: 7, font: bold, color: mute });
      p.drawText(winAnsi(val || '-'), { x, y: y - 13, size: 10.5, font, color: dark, maxWidth: w });
    };
    row('Technician', v.techName, 36, 260); row('Date', v.date, 316, 120); row('Arrival', v.arrival, 446, 70); row('Departure', v.departure, 526, 70);
    y -= 38; row('Site', v.address, 36, 540);
    y -= 42;
    p.drawText('DESCRIPTION OF WORK PERFORMED', { x: 36, y, size: 7, font: bold, color: mute });
    y -= 16;
    for (const ln of wrap(v.description || '-', font, 10.5, 540)) { p.drawText(ln, { x: 36, y, size: 10.5, font, color: dark }); y -= 14.5; if (y < 200) break; }
    if (v.followUps && v.followUps.length) {
      y -= 10;
      p.drawText('FOLLOW-UP / OPEN ITEMS', { x: 36, y, size: 7, font: bold, color: accent });
      y -= 15;
      for (const f of v.followUps) { for (const ln of wrap('- ' + f, font, 10, 530)) { p.drawText(ln, { x: 40, y, size: 10, font, color: dark }); y -= 13.5; } if (y < 180) break; }
    }
    const by = 120;
    p.drawLine({ start: { x: 36, y: by }, end: { x: 290, y: by }, thickness: 0.7, color: mute });
    p.drawLine({ start: { x: 322, y: by }, end: { x: 576, y: by }, thickness: 0.7, color: mute });
    p.drawText(winAnsi(v.managerName || ''), { x: 36, y: by + 6, size: 11, font, color: dark });
    p.drawText('MANAGER ON DUTY (PRINT)', { x: 36, y: by - 12, size: 7, font: bold, color: mute });
    p.drawText('MANAGER SIGNATURE', { x: 322, y: by - 12, size: 7, font: bold, color: mute });
    if (sig) { const s = Math.min(46 / sig.height, 240 / sig.width); p.drawImage(sig, { x: 326, y: by + 2, width: sig.width * s, height: sig.height * s }); }
    p.drawText(winAnsi(`Signed ${v.signedAt || ''}`), { x: 322, y: by - 24, size: 7, font, color: mute });
  }

  const Core = { FIELD_DEFS, buildRuns, analyzePdf, buildPdf, winAnsi, wrap };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core; else root.Core = Core;
})(typeof window !== 'undefined' ? window : globalThis);
