# PDF Studio — Chrome Extension

Edit, sign, resize/compress, and stamp images onto PDFs. Everything runs locally
inside your browser (pdf.js for rendering, pdf-lib for writing). No file ever
leaves your machine.

## Install (Load unpacked)

1. Unzip this folder anywhere permanent (Chrome loads it from disk).
2. Open `chrome://extensions`
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `pdf-studio` folder.
5. Optional but recommended: on the extension's **Details** page, enable
   **Allow access to file URLs** — this lets "Edit this PDF" work on PDFs you
   open from your own disk (`file://` tabs).

## Using it

**Edit a PDF that's open in a tab** — while viewing any PDF, click the
PDF Studio toolbar icon → **Edit this PDF**. You can also right-click a PDF
link or a PDF page and choose *Edit in PDF Studio*. Or open the editor
directly and drop/choose a file.

**Editing tools** (toolbar, with shortcuts):
- **Select (V)** — click to select, drag to move, corner dot to resize,
  Delete key to remove, Ctrl+Z to undo the last added item.
- **Text (T)** — click a page, type. Double-click a text box to re-edit.
  Size and color controls appear in the toolbar.
- **Draw (D)** — freehand pen with size/color.
- **Whiteout (W)** — drag a white rectangle over anything you want covered.

**Signature (S)** — two modes:
- *Draw*: sign with mouse/touch/stylus; smoothed strokes, black or blue ink.
- *Upload & clean up*: choose a photo/scan of your signature on paper. The
  paper background is stripped out, contrast is normalized, and the ink is
  re-colored so it sits on the document like a real scanned signature.
  Adjust the *Background removal* slider until the preview looks clean.
Then click on the page to place it; drag/resize as needed. The last
signature is remembered for reuse within the session.

**Insert a picture (I)** — choose any PNG/JPEG/WebP/GIF/BMP, click to place,
drag and resize. PNG transparency is preserved.

**Resize / Compress** button:
- *Page dimensions* — scale pages by % or fit to A3/A4/A5/Letter/Legal.
  This is lossless: vector text stays vector.
- *File size* — either a lossless re-save, or true compression that
  re-renders pages at a chosen DPI/JPEG quality (High/Balanced/Small/Tiny
  presets, or custom). Shows before/after size; download the result or load
  it back into the editor to keep working.

**Download PDF** — exports the document with all your edits baked in.

## Known limitations

- This is overlay-style editing (add text/ink/images/whiteout on top);
  it does not rewrite the PDF's existing text runs in place.
- The rasterizing compressor makes text non-selectable (that's what buys the
  big size reduction). Use "Lossless re-save" if selectable text matters.
- Non-Latin text (e.g. বাংলা) and text on rotated pages is embedded as a
  high-resolution image rather than vector glyphs, because the built-in PDF
  fonts only cover WinAnsi. It prints and displays fine.
- Password-protected PDFs and `blob:`/`data:` viewer URLs can't be fetched
  from a tab — download the file and open it in the editor instead.

## Stack

- Manifest V3, no build step, no remote code.
- `libs/pdf.min.js` + worker — pdfjs-dist 3.11.174 (rendering)
- `libs/pdf-lib.min.js` — pdf-lib 1.17.1 (writing/stamping/resizing)
