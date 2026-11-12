# Chrome Web Store submission

Text and answers for the Developer Dashboard. Not included in the package.

## Build the package

```sh
git archive --format=zip -o dist/pdf-studio-2.2.0.zip HEAD
```

Packs exactly the committed extension files, with `manifest.json` at the root of
the zip. Files marked `export-ignore` in `.gitattributes` (this file, the README,
the privacy policy) are left out. Commit first — uncommitted changes are not
included. Upload the zip under **Package → Upload new package**.

## Store listing

**Name:** PDF Studio

**Summary** (from the manifest, 127 / 132 characters):
Edit, annotate, sign, organise, protect and convert PDFs to Word, Excel and
PowerPoint — entirely offline, on your own machine.

**Category:** Productivity → Tools

**Language:** English

**Description:**

> A complete PDF workshop that runs entirely inside your browser. Nothing is
> uploaded: there is no server and no account, and every document stays on
> your machine.
>
> EDIT AND MARK UP
> • Edit the existing text of a PDF, or add new text boxes
> • Draw, highlight, add shapes, arrows, stamps, images and sticky notes
> • Whiteout and true redaction that removes the content underneath
> • Sign with a drawn, typed or imported signature
> • Fill in PDF forms
>
> ORGANISE
> • Reorder, rotate, duplicate, delete and insert pages
> • Merge several PDFs, split one apart, extract pages
> • Add watermarks, headers, footers, page and Bates numbers
> • Compress, resize and n-up pages
>
> CONVERT
> • PDF to Word, Excel, PowerPoint, images, HTML, Markdown and text, keeping
>   columns, headings, lists and tables
> • Images, Word documents, spreadsheets and text files to PDF
> • Built-in OCR reads scanned pages (English and Bengali)
>
> PROTECT
> • Add or remove passwords with AES-256, AES-128 or RC4
> • Set printing, copying and editing restrictions
> • Strip scripts and embedded actions from untrusted PDFs
>
> FAST TO USE
> • One key for every tool, Ctrl+K to find any command
> • Light and dark interface that follows your system
> • Fully usable from the keyboard
>
> Open a PDF from the toolbar button while viewing it, from the right-click
> menu on any PDF link, or by dropping a file onto the editor.
>
> Tip: to edit PDFs opened from your own disk (file:// addresses), enable
> "Allow access to file URLs" on the extension's Details page.

## Graphic assets (to prepare)

| Asset | Size | Required |
| --- | --- | --- |
| Store icon | 128 × 128 PNG | Yes — use `icons/icon128.png` |
| Screenshots | 1280 × 800 or 640 × 400, 1–5 | Yes, at least one |
| Small promo tile | 440 × 280 | Yes |
| Marquee promo tile | 1400 × 560 | No |

Suggested screenshots: the editor with a document open and the tool rail
visible; text editing on an existing page; the Tools drawer converting to Word;
the page organiser; the Ctrl+K palette; dark theme.

## Privacy practices tab

**Single purpose:**
View, edit, annotate, organise, protect and convert PDF documents locally in
the browser.

**Permission justifications:**

- `contextMenus` — Adds "Edit in PDF Studio" and "Convert in PDF Studio" to the
  right-click menu on PDF links and on PDF pages, so a PDF can be opened in the
  editor from where the user found it.
- Host permissions (`http://*/*`, `https://*/*`, `file:///*`) — When the user
  chooses to open a PDF that is at a web address or on their disk, the editor
  downloads that one file so it can be rendered and edited locally. PDFs can be
  served from any site, so access cannot be limited to a fixed list of domains.
  The popup also reads the active tab's address to tell whether it is a PDF.
  No content scripts are injected and no page content is read.

**Remote code:** No, I am not using remote code. All JavaScript and
WebAssembly is included in the package.

**Data usage:** Collects none of the listed categories. Tick all three
certifications (no selling or transfer to third parties, no use unrelated to
the single purpose, no use for creditworthiness or lending).

**Privacy policy URL:**
https://github.com/ishtiaqueay0n/pdf-studio/blob/main/PRIVACY.md

## Distribution

Free. All regions.
