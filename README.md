# PDF Studio — Chrome Extension

A complete PDF workshop that runs entirely inside your browser. Read, edit,
annotate, sign, organise, protect and convert PDFs — and build new ones from
images, Word files, spreadsheets and plain text.

**Nothing is uploaded.** There is no server, no account and no network call:
pdf.js renders, pdf-lib writes, and the Office formats are produced by bundled
libraries. Every byte stays on your machine.

## Install (Load unpacked)

1. Unzip this folder somewhere permanent (Chrome loads it from disk).
2. Open `chrome://extensions`
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `pdf-studio` folder.
5. Optional but recommended: on the extension's **Details** page, enable
   **Allow access to file URLs** — this lets "Edit this PDF" work on PDFs you
   open from your own disk (`file://` tabs).

## Getting a document in

- While viewing any PDF in a tab, click the toolbar icon → **Edit this PDF**
  or **Convert this PDF…**
- Right-click a PDF link or page → *Edit* / *Convert in PDF Studio*.
- Open the editor and drop a file anywhere in the window, or press **Ctrl + O**.
  A picture, Word document, spreadsheet or text file dropped the same way is
  made into a PDF and opened.
- Password-protected files are supported: you are prompted when one is opened.

## Finding your way around

- **Top bar** — the file's name (click it to rename what you save), undo and
  redo, **Open**, **Tools** and **Save PDF**. A dot beside the name means there
  are changes you have not saved. The **⋯** menu holds the theme, night
  reading, presentation mode and the shortcut list.
- **Tool rail** down the left — every editing tool, one key each, and under
  them the buttons for the side panel: pages, bookmarks, find, form fields,
  notes. Pressing the button of the panel that is showing puts it away.
- **Options strip** above the page — the settings of the tool in hand, or of
  whatever is selected. It is always the same height, so the page never jumps
  when you change tool.
- **Dock** at the bottom of the document — page number, previous/next and zoom;
  click the percentage for fit-width, fit-page, actual size and presets.
- **Tools drawer** on the right — everything that produces a new file. It sits
  beside the document rather than over it, and its progress and result stay
  pinned to its foot.
- **Ctrl + K** searches every tool, task and setting by name — type `word` and
  press Enter to convert to Word, or type a number to jump to that page.
- Messages appear at the bottom corner. Confirmations leave on their own;
  anything that went wrong stays until you dismiss it. Deleting offers **Undo**
  right there.

The whole interface can be driven from the keyboard: Tab moves between regions,
the arrow keys move along the tool rail, dialogs keep focus inside themselves
and hand it back when they close, and Esc backs out of one thing at a time.
Animations are skipped when the system asks for reduced motion.

---

## Editing and markup

Every tool works as an overlay: your changes stay editable until you press
**Save PDF**, and the original file is never touched. Everything can be undone
and redone (`Ctrl+Z`, `Ctrl+Shift+Z`) — adding, deleting, moving, resizing,
retyping, recolouring — and the selection can be nudged with the arrow keys.
Closing the tab with unsaved changes asks first.

| Tool | Key | What it does |
| --- | --- | --- |
| Select | `V` | Move, resize (corner handles), duplicate (`Ctrl+D`), delete (`Del`) — the last two are also on a small bar that follows the selection |
| Text | `T` | Click to place a text box; bold, italic, size and colour. Double-click to re-edit |
| Draw | `D` | Smoothed freehand pen with size and colour |
| Highlight | `H` | Translucent marker in five colours, drawn with a multiply blend |
| Shape | `R` | Rectangle, ellipse, line and arrow, with stroke width and optional fill |
| Whiteout | `W` | Cover an area with white |
| Redact | `X` | Permanently remove content — see below |
| Note | `N` | Sticky note; exported as a real PDF comment annotation |
| Sign | `S` | Draw, type or upload a signature |
| Stamp | `M` | APPROVED / DRAFT / CONFIDENTIAL and friends, or your own text, with an optional date |
| Image | `I` | Place a PNG/JPEG/WebP/GIF/BMP; transparency is preserved |
| Pictures | `P` | Edit a picture the document already contains — see below |
| Edit text | `E` | Edit a paragraph the document already contains — see below |

**Signatures** come three ways: *draw* with mouse, touch or stylus; *type* your
name in one of four handwriting styles; or *upload* a photo of your signature on
paper — the paper background is removed, contrast normalised and the ink
re-coloured so it sits on the page like a real scan. The last signature is
remembered for reuse during the session.

**Editing the pictures already in a document.** Press `P` and every picture on
the page is outlined; click one — or just double-click it with the Select tool —
and it is lifted off the page into the overlay. From there it moves, resizes,
duplicates and deletes like a picture you placed yourself, and **Replace** swaps
the artwork while keeping the position. The area it used to occupy is covered
with the colour of the paper immediately around it, sampled from four strips at
its edges, so a picture on a tinted panel is covered with that tint rather than
with white. That cover is one flat colour: a picture lying over a gradient, a
pattern or text will leave a visible patch, and the original bitmap stays in the
file beneath the cover in the same way text stays beneath a whiteout.

**Editing the text already in a document.** Press `E` and every paragraph on the
page is outlined; click one — or double-click it with the Select tool — and it
becomes an editable text box in its place, carrying the same words, size,
weight, colour, typeface and alignment. Typing re-wraps inside that block.

A **paragraph** is the unit. Editing a single word where it sits would mean
rewriting the page's content stream, and a paragraph is the smallest block that
can be re-wrapped without shoving everything around it out of place. Text below
an edited block does not move: making room would mean re-laying-out the whole
page, and a PDF has no flow order to re-lay-out along.

**What is detected, and how.** Serif and monospace come from the font
descriptor's own flags, which pdf.js reports directly. Weight and slope come
from the font's real PostScript name — `ABCDEF+Arial-BoldMT` and the like —
which is the only place most PDFs record them; two further cases are caught
because names alone miss them, a document that fakes bold by stroking its
glyphs, and one that fakes italic by shearing the text matrix. Size is measured
as the true height of the em, so a sheared face is not reported a third of a
point too large, and each font's own ascent is used to place the block rather
than a fixed guess.

**The typeface itself is matched by kind, not by name.** Only the fourteen
standard PDF fonts can be embedded without a font toolkit, which this extension
does not bundle, so a serif paragraph is redrawn in Times, a monospaced one in
Courier and everything else in Helvetica, at the same weight and slope. The
shapes will not be identical to the original. The block's original font name and
size are shown in the options strip while it is selected, and the size, colour,
bold, italic and typeface controls beside them will correct anything detected
wrongly. Text the standard fonts cannot represent —
বাংলা, and anything else outside WinAnsi — is drawn by the browser's own fonts
and embedded as a high-resolution picture instead, exactly as a new text box is.

**The words you replace are taken out of the page, not painted over.** Covering
words does not delete them: the originals would still sit in the file
underneath, selectable and copyable by anything that looks. So when you save,
the page's content stream is rewritten (`contentedit.js`): the glyphs of each
lifted block are removed and replaced by a movement of exactly their width, so
nothing else on the line shifts. The page stays what it was — vector, with
selectable text, and whatever was behind the words still there. The same thing
is shown while you edit: the lifted words are left out of the page's picture
rather than hidden under a patch of colour.

The rewrite is checked before it is trusted. The saved page is read back and
every glyph that was meant to stay must be where it was, and none that was
meant to go may remain. If that fails — or the text sits inside a form XObject,
or is set vertically — the page falls back to the old way: the words are
covered and the page is re-rendered as a picture, and you are asked first,
because text on that page then stops being selectable. A left-hand bar marks
every block you have lifted, so you can see what you changed before saving.

A lifted block keeps its place to the point: its first baseline, its line
spacing and — where the stand-in face allows — its line breaks are the
original's, and a justified paragraph is still justified.

**Redaction is real.** Painting a black box over text leaves the text underneath,
still selectable and still copyable. When a document contains redactions, PDF
Studio re-renders those pages as images with the boxes burned in, so the covered
content genuinely stops existing. You are asked to confirm, because text on those
pages also stops being selectable.

## Reading and navigating

- Side panel with page thumbnails, bookmarks (outline), form fields and a list
  of your sticky notes — `F4` shows or hides it. In a narrow window it floats
  over the document and starts closed.
- **Find in document** (`Ctrl+F`) with live highlighting, match counts and
  jump-to-result.
- Page box with previous/next, `Page Up` / `Page Down`, zoom (`Ctrl` `+`/`−`/`0`,
  or `Ctrl` + wheel to zoom about the pointer).
- **Light and dark interface.** It follows the system until you choose
  otherwise — Light, Dark or System in the **⋯** menu, or the button in the
  toolbar popup — and the choice is remembered. It changes the interface
  only — the page, whiteout, redaction, highlights and the signature pad keep
  their real colours in both themes, because a whiteout that drew dark would
  misrepresent what the saved file contains.
- **Night reading mode** inverts the page without inverting the interface.
- **Presentation mode** (`F5`) goes full-screen with page snapping.
- Press `?` for the full shortcut list.

## Pages panel

Stage changes on the thumbnails, then press **Apply changes**:

- Drag to reorder, click to select, `Ctrl`-click for several.
- Rotate left/right, duplicate, delete, insert a blank page.
- Extract the selected pages into a new PDF.

## Tools

The **Tools** drawer holds everything that produces a new file. It opens on a
list of tasks; each task has its own page with a way back, and the document
stays live beside it.

### Convert from PDF

| Output | Notes |
| --- | --- |
| **Word** `.docx` | *Flowing text* rebuilds paragraphs, headings, lists and tables — best for editing. *Keep the visual layout* positions every line in its own frame, optionally over a picture of the page |
| **Excel** `.xlsx` | One sheet per page from the detected table grid, one row per line of text, or everything on a single sheet. Numeric-looking cells become real numbers |
| **PowerPoint** `.pptx` | One slide per page: a picture of the page with editable text boxes on top, picture only, or text only |
| **Images** | PNG, JPEG or WebP at 72–400 DPI; several pages arrive as a ZIP |
| **Web page** `.html` | A readable article, or positioned page-for-page with optional embedded page pictures |
| **Markdown** `.md` | Headings from font size, lists, and tables as pipe tables |
| **Plain text** `.txt` | Paragraph flow or original line layout |
| **CSV** `.csv` | The detected grid, page by page |
| **JSON** | Pages, paragraphs, lines and coordinates — for feeding something else |
| **Extract images** | Every bitmap the pages paint, as a ZIP |

A page range (`1-3, 8, 12-`) can be applied to any of them, and your unsaved
edits are baked in before conversion. A long conversion can be cancelled, and
keeps running at full speed if you switch to another tab.

**How the page is read.** Ruled tables are taken from their drawn grid, so
merged cells and cells holding several lines come out right. The rest of the
page is cut into columns and borderless tables by its white space and read in
the order a person would: down one column, then the next. Paragraphs keep their
inline bold, italic, superscripts and links; lists keep their markers and
nesting; headings are ranked by size across the whole document; repeated page
headers, footers and page numbers are left out (there is a checkbox to keep
them); a paragraph that a column or a page break cut in two is joined again.
Drawings and pictures are carried into Word and HTML as pictures. Exports that
lay editable text over a picture of the page (PowerPoint, Word and HTML layout
modes with a background) draw that picture without the text, so nothing is
there twice. In Excel, figures become numbers only when they are unmistakably
numbers — `00123`, a phone number or a 16-digit ID stay text — and keep their
percent, currency and thousands formatting.

**Scanned pages are read with OCR.** A page that carries no text of its own —
a scan, a photograph of a document — used to convert to an empty page. It is
now rendered and recognised, and the words come back as real, reflowable text
that flows into paragraphs, headings and tables like any other page. English and
Bengali are bundled and both are on by default; pick one alone if the document
is only in that language, and the recognition gets a little more certain.

It runs only on pages that have no text at all, so an ordinary PDF never pays
for it, and it is slow — roughly a second a page, more at the *Careful* setting.
The result is always flagged in the message after the conversion, because
recognition is a guess: check the words against the original before relying on
them. Turn it off with the checkbox if you would rather have the page picture.

Like everything else here it runs on your machine. Tesseract, its WebAssembly
core and both language models are bundled in `libs/` — see `libs/VENDOR.txt`
for exact versions, sources and checksums. No page and no word is ever sent
anywhere.

### Create a PDF

- **Images → PDF** — many at once, page size matched to each image or fitted to
  A3/A4/A5/Letter/Legal with a margin.
- **Word / Excel / CSV → PDF** — `.docx` text, styling, headings, lists and
  tables; spreadsheets as a drawn grid with automatic column widths.
- **Text file → PDF** — wrapped and paginated.

### Merge & split

Merge the open document with any number of other PDFs (reorderable), or split
into a ZIP: one file per page, every N pages, or at chosen break points.

### Page layout

Scale by percentage or fit to a paper size (lossless — vectors stay vectors),
2/4/6/8/9/16 pages per sheet, crop by percentage margins, reverse the page
order, rotate everything 90°.

### Watermark & numbering

Text or image watermarks with colour, size, opacity, angle, seven positions,
tiling, a page range and an optional *behind the content* mode. Headers and
footers take six independent slots and the tokens `{page}` `{pages}` `{date}`
`{time}` `{filename}` `{bates}` — the last gives Bates numbering with a prefix,
start value and digit count.

### Resize & compress

Lossless re-save, or true compression by re-rendering pages at a chosen DPI and
JPEG quality (High / Balanced / Small / Tiny, or custom). Before/after sizes are
shown; load the result straight back into the editor to keep working.

### Document details

Read and rewrite title, author, subject, keywords, creator and producer. Attach
files to the PDF, and list or save the files already attached.

### Security

- **Protect with a password** — AES-256 (`R6`), AES-128 (`R4`) or RC4 128-bit
  (`R3`), separate open and owner passwords, and eight permission flags.
- **Remove a password** — losslessly where the file's structure allows, with a
  rebuild-from-pages fallback that always works.
- **Clean up** — strip everything in a document that can act on its own:
  document-level JavaScript, open and additional actions, embedded files, XFA,
  media and file-attachment annotations, launch/submit actions on links, and
  the keystroke, format, validate and calculate scripts hanging off form
  fields — including fields with children, which are not annotations on any
  page and so are easy to miss. Page content, text, field values and ordinary
  in-document links are left alone. You are told exactly what was taken out.

### Forms

The **Form** side panel lists every AcroForm field with the right control for
its type — text, checkbox, radio group, dropdown, list — fills them in place,
and can flatten the result into the page content.

---

## What it does not do

- **Editing a single word where it sits.** Editing a paragraph removes its
  glyphs from the content stream and draws a new block in their place — see
  **Edit text** above for what follows from that: paragraph granularity, no
  reflow of the text below, and a typeface matched by kind. Inline styling
  inside a block (one bold phrase in a plain paragraph) is not carried into the
  edit box.
- **Reusing the document's own embedded fonts.** Embedding an arbitrary font
  needs `@pdf-lib/fontkit`, which is not bundled, and the fonts inside a PDF are
  usually subsets containing only the glyphs the document already used — so a
  letter you type may have no glyph to draw. The standard-font match above is
  what is offered instead.
- **OCR beyond English and Bengali.** Only those two language models are
  bundled. A page in another script will come back as nonsense rather than as
  nothing, which is arguably worse — turn OCR off for those.
- **Perfect conversion.** A PDF has no paragraphs, tables or headings; it has
  positioned glyphs. All of that structure is *inferred* (see `extract.js`), and
  complex layouts — multiple columns, nested tables, footnotes — will need
  tidying afterwards. Always check the result before sending it on. A page that
  cannot be read at all is skipped and named rather than taking the whole
  conversion down with it.
- **Non-Latin text in new text boxes.** The PDF standard fonts only cover
  WinAnsi, so text such as বাংলা and text on rotated pages is embedded as a
  high-resolution image instead of vector glyphs. It prints and displays fine.
- **Removing AES-256 protection losslessly** from files whose objects pdf-lib
  cannot re-parse. The rebuild fallback covers those, at the cost of selectable
  text.
- **Office → PDF fidelity.** Word and spreadsheet import carries text, styling
  and tables — not floating images, columns, headers or exact pagination.

## Security posture

A PDF is an untrusted document format, so the extension is built as if every
file it opens is hostile.

- **No network use of your data.** Nothing is uploaded, and there is no
  telemetry. The one outbound request the extension ever makes is fetching the
  PDF you asked it to open from the tab you were already looking at.
- **A locked-down page policy.** `default-src 'none'` with
  `script-src 'self' 'wasm-unsafe-eval'`, `object-src 'none'`,
  `frame-src 'none'`, `base-uri 'none'` and `form-action 'none'`. No remote
  code and no JavaScript `eval` — pdf.js is started with
  `isEvalSupported: false` so a document's fonts and CMaps cannot reach it.
- **`wasm-unsafe-eval` is the one concession, and OCR is why.** Recognition
  runs as WebAssembly, and WebAssembly cannot be compiled at all without it.
  It permits compiling WebAssembly inside the extension's own origin; it does
  **not** re-enable `eval`, and `script-src 'self'` still means every byte of
  code has to come from the extension folder. The bundled `.wasm.js` is the
  only WebAssembly here, its checksum is recorded in `libs/VENDOR.txt`, and the
  OCR worker is loaded straight from the extension rather than through a
  `blob:` URL so `worker-src` stays at `'self'`. If you would rather not have
  that concession at all, delete `libs/tesseract*`, drop `'wasm-unsafe-eval'`
  from the manifest and remove the two OCR `<script>` tags — everything else
  keeps working, and scanned pages go back to converting as pictures.
- **Two permissions only:** `activeTab` and `contextMenus`. Host access covers
  `http`, `https` and `file` because the whole point of "Edit this PDF" is
  fetching the document open in front of you — with your cookies, so PDFs behind
  a login work. Only those schemes are accepted.
- **Untrusted text is escaped** wherever it reaches the interface, and download
  names are stripped of path separators and control characters, so a document
  cannot use its own title or a bookmark to inject markup or steer a file.
- **Passwords** live in local variables for the length of one operation and are
  cleared from their inputs afterwards. They are never stored, logged or copied
  into document state.
- **Encryption uses the platform.** Salts, IVs and file keys come from
  `crypto.getRandomValues`; AES and SHA-2 come from WebCrypto. Only MD5 and RC4,
  which the older PDF revisions require and no browser exposes, are implemented
  in this codebase.

## A note on permission flags

The eight permissions in the Security pane (printing, copying, commenting…) are
what the PDF specification calls *advisory*: they are recorded in the file and
every well-behaved reader honours them, but nothing enforces them. Only the
**open password** actually keeps a document shut. RC4 is offered for old readers
and is not considered secure — prefer AES-256, or AES-128 for wider
compatibility.

## Stack

Manifest V3, no build step, no remote code, no network access.

| File | Role |
| --- | --- |
| `editor.js` | Viewer, annotation tools, export |
| `ui.js` | Tools drawer and side panels |
| `palette.js` | Ctrl+K action search; calls what the buttons call, implements nothing itself |
| `tokens.css` | Design tokens — colour, space, type, motion — for both themes |
| `extract.js` | Layout analysis: columns, paragraphs, lists, headings, tables, figures |
| `contentedit.js` | Removes text from a page's content stream, with verification |
| `convert.js` | Every format conversion, in and out |
| `docops.js` | Page operations, watermarks, numbering, forms, metadata |
| `pdfcrypt.js` | PDF standard security handler |
| `theme.js` | Light and dark interface, shared by the editor and the popup |
| `ocr.js` | Reads scanned pages, in the shape the rest of the pipeline expects |

Vendored libraries, all local:

- `libs/pdf.min.js` + worker — pdfjs-dist 3.11.174 (rendering, text extraction)
- `libs/pdf-lib.min.js` — pdf-lib 1.17.1 (writing, stamping, page operations)
- `libs/docx.min.js` — docx 9.7.1 (Word output)
- `libs/xlsx.full.min.js` — SheetJS 0.18.5 (Excel in and out)
- `libs/pptxgen.bundle.js` — PptxGenJS 3.12.0 (PowerPoint output)
- `libs/jszip.min.js` — JSZip 3.10.1 (ZIP output, reading `.docx`)
- `libs/tesseract*.js` — tesseract.js 6.0.1 and tesseract.js-core 6.1.2 (OCR)
- `libs/tessdata/*.traineddata.gz` — tessdata_fast 4.0.0, English and Bengali

Checksums and download sources for the OCR components are in `libs/VENDOR.txt`.
