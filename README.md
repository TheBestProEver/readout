# Readout

Paste text and hear it read aloud. Dictate notes by voice. Free, no account, no limits, and it runs entirely in your browser.

**Use it:** https://thebestproever.github.io/readout/

## On your phone

1. Open the link in Chrome on Android.
2. Tap the ⋮ menu, then **Add to Home screen** (or **Install app**).
3. Open Readout from your home screen. It now works like an app, even offline.

Once it's installed, you can select text in any app, tap **Share**, and pick **Readout**. The text opens ready to play.

## What it does

- **Reads any length of text aloud**, one sentence at a time, with the sentence you're hearing highlighted (and the current word, in browsers that report it).
- **Speed from 0.5× to 4×**, changeable mid-sentence without starting over. Pick any voice your device has, and adjust pitch.
- **Tap a sentence to jump there.** Previous/next sentence buttons, a progress bar you can scrub, and time remaining.
- **Remembers where you stopped** in every text, and the library shows how far through each one you are.
- **Saves everything on your device**: a searchable list of texts you can pin, rename, copy, share, delete (with undo), and download as .txt or .md.
- **Opens files**: .txt, .md, and PDFs with real text (scanned PDFs are images, so they have no text to read). "Clean up line breaks" fixes text pasted from PDFs and emails.
- **Dictation for notes**: tap Dictate and talk. Say "comma," "period," "question mark," or "new paragraph" for punctuation.
- **Backups**: export all texts to one file and import it on another device.
- Dark mode, four text sizes, keyboard shortcuts on a computer.

## Good to know

- **Keep the screen on while listening.** Phones stop web speech when the screen locks, so Readout keeps the screen awake while it reads (you can turn that off in Settings). There's also an experimental setting that tries to keep reading on a locked screen; how well it works depends on the phone.
- **Better voices on Android:** open your phone's text-to-speech settings and install voice data for Google's speech engine. New voices show up in Readout's voice list.
- **Privacy:** your texts never leave the browser. Reading aloud uses your device's speech engine; voices marked "online" in the voice list send the text to Google or Microsoft to synthesize it. Dictation in Chrome usually sends audio to Google to transcribe it, unless you turn on on-device recognition in Settings and your Chrome supports it.
- Your texts live in this browser on this device. Clearing the browser's site data deletes them, so export a backup now and then.

## Keyboard shortcuts (computer)

| Key | Action |
| --- | --- |
| Space or K | Play / pause |
| ← → or J L | Previous / next sentence |
| [ ] | Slower / faster |
| E | Edit / done |
| N | New text |
| Ctrl+Enter (while editing) | Done and play |

Pasting anywhere outside a text box adds the text and starts reading it.

## Development

No build step and no dependencies. It's plain HTML, CSS, and JavaScript:

- `index.html`, `styles.css`: the interface
- `core.js`: text splitting and formatting logic, with no DOM, so it's testable in Node (`node tests/core.test.js`)
- `app.js`: storage (IndexedDB), the speech engine, dictation, and everything else
- `sw.js`: offline support. Bump `VERSION` here and the `?v=` numbers in `index.html` when you release changes.
- `tools/make_icons.py`: draws the PNG app icons. A GitHub Action runs it automatically.

To run locally: `python3 -m http.server` in this folder, then open http://localhost:8000.

PDF reading uses [pdf.js](https://mozilla.github.io/pdf.js/), loaded on demand from jsDelivr.

## License

MIT
