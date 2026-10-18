# Readout

Paste text or open a file and hear it read aloud, in a natural voice that keeps reading with your phone's screen off. Dictate notes by voice. Free, no account, no limits, and it runs entirely in your browser. Optional sync keeps your phone and computer in step.

**Use it:** https://thebestproever.github.io/readout/

## On your phone

1. Open the link in Chrome on Android.
2. Tap the ⋮ menu, then **Add to Home screen** (or **Install app**).
3. Open Readout from your home screen. It now works like an app, even offline.

Once it's installed, you can share to Readout from any app: select text and tap **Share**, or share a PDF, a photo, or a document, and pick **Readout**. It opens ready to play.

To listen to a PDF, a Word document, an ebook, or a page of a book, tap **Open file** (or **Open a PDF, photo, or file** on the first screen) and pick the file, or choose the camera to photograph a page.

## Voices

Tap the speed button to pick a voice:

- **Natural**: Michael, a natural-sounding voice that runs on your phone's graphics chip (WebGPU). It's a one-time download of 326 MB; Readout asks first and shows the size, whether you're on Wi-Fi, and how much space is free. If the download stops, it picks up where it left off. Other natural voices (Fenrir, Puck, Heart, Bella; British: George, Emma) share the same download.
- **Standard**: Ryan (British: Alba or Cori), 63 MB, for phones where the natural voice can't run. Readout checks the natural voice on your phone the first time it loads it, and offers the standard voice if it doesn't run well there.
- **Device**: your phone's own speech voices. They work at once, with nothing to download, but stop when the screen turns off. Readout uses this until a voice is downloaded.

Natural and standard voices keep reading with the screen off and the phone locked, with lock-screen controls (play/pause, previous/next sentence, and a seek bar). Pick **American** or **British** for the accent: it also changes how dates and numbers are read. **Preview** plays a sample. Downloaded voices are listed in **Settings → Voices on this device**, where you can remove them.

## What it does

- **Reads any length of text aloud**, one sentence at a time, with the sentence you're hearing highlighted (and the word, with the natural voice). Numbers, dates, money, abbreviations, and links are read the way a person would say them.
- **Speed from 0.5× to 3×** (4× with the device voice), changeable while it reads.
- **Tap a sentence to jump there.** Previous/next sentence buttons, a progress bar you can scrub, time remaining, and **Headings and chapters** (in the ⋯ menu) to jump within a long text.
- **Sleep timer**: stop after 15, 30, 45, or 60 minutes, or at the end of the text, fading out gently. It works with the screen off.
- **Play next text automatically** (Settings): when a text ends, the next one in your list starts.
- **Pronunciations** (Settings): tell Readout how to say a word, like a name it gets wrong. With sync on, the list is on all your devices.
- **Remembers where you stopped** in every text, and the library shows how far through each one you are.
- **Saves everything on your device**: a searchable list of texts you can pin, rename, copy, share, delete (with undo), and download as .txt or .md. **Save audio** (⋯ menu) downloads what the natural or standard voice has read of a text as an audio file (.ogg).
- **Opens PDFs, photos and screenshots, Word (.docx), OpenDocument (.odt, .odp), PowerPoint (.pptx), EPUB ebooks, RTF, web pages, Markdown, and text.** Running heads, page numbers, footnotes, and margin notes are left out (Settings can keep the footnotes and margin notes), and so are citations like “(Lee et al., 2020)” (Settings can read them). Scanned PDFs and photos of pages are read with text recognition on your device; scanned course readings that already carry a scanner's hidden text layer are read both ways and combined, for a clean text. The first time, Readout asks before a one-time download of about 7 MB, which is then kept on your device. A long file shows its progress, and **Stop** keeps the pages read so far. "Clean up line breaks" fixes text pasted from PDFs and emails.
- **Dictation for notes**: tap Dictate and talk. Say "comma," "period," "question mark," or "new paragraph" for punctuation.
- **Sync** between your phone and computer through your GitHub account (optional, see below).
- **Backups**: export all texts to one file and import it on another device.
- Dark mode, four text sizes, keyboard shortcuts on a computer.

## Sync between your phone and computer

Readout can keep the same texts, notes, pins, and reading places on all your devices. It stores them in a secret gist on your GitHub account, so there's no extra service or account.

**First device:**

1. Open **Settings → Sync** and tap **Create a GitHub token**. GitHub opens a form that's already filled in (a token that can only use gists). Scroll down, tap **Generate token**, and copy it.
2. Paste the token into Readout and tap **Connect**, then **Start syncing from this device**.

**Each other device:** on the first device, tap **Copy sync key** in Settings → Sync. Get the key to your other device (email it to yourself, for example), paste it into the same box there, and tap **Connect**.

How it behaves:

- Changes sync a few seconds after you make them, when you open or leave Readout, and about once a minute while it's open. **Sync now** does it immediately.
- If the same note was changed on two devices before they synced, Readout keeps both versions. The other one appears as "(other copy)".
- A note you're typing in, dictating into, or listening to doesn't change under you. Changes from another device wait until you stop.
- Deleting a text deletes it everywhere. Importing a backup that contains it brings it back.
- Texts over 3 million characters stay on the device they're on.
- Keep the sync key private: anyone with it can read and change your synced texts. If it leaks, delete the token on GitHub (Settings → Developer settings → Personal access tokens), make a new one, and paste it into Readout on each device.
- **Turn off sync on this device** stops syncing. Your texts stay on the device.

- With sync on, the pronunciation list syncs too (in its own file in the gist, which versions before 2.0 leave alone).

## Good to know

- **Screen off:** the natural and standard voices keep reading with the screen off. The device voice can't: phones stop web speech when the screen locks, so Readout keeps the screen awake while the device voice reads (you can turn that off in Settings).
- **Better device voices on Android:** open your phone's text-to-speech settings and install voice data for Google's speech engine. New voices show up in Readout's device voice list.
- **Voice licences:** Michael and the other natural voices (Kokoro) are Apache-2.0. The standard voices are Piper voices: Ryan is CC BY-NC-SA 4.0 (non-commercial use), Alba is CC BY 4.0, and Cori is public domain.
- **Privacy:** without sync, your texts never leave the browser. Files, scanned pages, and photos are read on your device, and the natural and standard voices run on your device too. The only downloads are pinned public files: the libraries Readout uses (from jsDelivr) and the voices (from Hugging Face), kept in the browser's storage. With sync on, your texts are also kept in a secret gist on your GitHub account. Secret gists are unlisted, not encrypted: anyone with the gist's address could read it, and GitHub keeps its edit history. Device voices marked "online" send the text to Google or Microsoft to synthesize it. Dictation in Chrome usually sends audio to Google to transcribe it, unless you turn on on-device recognition in Settings and your Chrome supports it.
- Without sync, your texts live only in this browser on this device. Clearing the browser's site data deletes them, so turn on sync or export a backup now and then.

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

No build step and no dependencies. It's plain HTML, CSS, and JavaScript, built on [readkit](https://github.com/TheBestProEver/readkit), which is vendored in `readkit/` (see `readkit/VERSION`; don't edit it there):

- `index.html`, `styles.css`: the interface
- `core.js`: segment helpers, formatting, and the sync merge, with no DOM, so it's testable in Node
- `app.js`: storage (IndexedDB), opening files (readkit `extract()`), the speech plan (readkit `plan()`), the voices and the screen-off player (readkit), the device voice, dictation, GitHub sync, and everything else
- `sw.js`: offline support, cross-origin isolation (it adds COOP/COEP headers, which GitHub Pages can't send, so the standard voice can use several threads), and the share target. Bump `VERSION` here and the `?v=` numbers in `index.html` when you release changes. After vendoring a new readkit, run `node tools/readkit-files.mjs` to update the list of readkit files it keeps.
- `tools/make_icons.py`: draws the PNG app icons. A GitHub Action runs it automatically.

To run locally: `python3 -m http.server` in this folder, then open http://localhost:8000. For a local copy of the voice models, `?local=http://127.0.0.1:<port>` points the voices at a local server with the layout of readkit's test model server (only when both are on this machine).

Tests (browser tests need Chrome or Edge and always run it headless with a temporary profile):

- `node tests/core.test.js`, `node tests/sync.test.js`: the text pipeline and the sync merge
- `node tests/sync.e2e.mjs`: two browser "devices" syncing through a stand-in for GitHub's gist API
- `node tests/pdf.e2e.mjs`: opening every kind of file, scanned PDFs and photos (needs the internet for pdf.js and Tesseract)
- `node tests/v2.e2e.mjs [section,...]`: a scanned course reading, highlighting, the natural and standard voices playing for over a minute in a hidden page with Android's freezing rule, lock-screen controls, sleep timer, the share sheet, the service worker, and the phone layout. The voice sections use local model copies found through the `READKIT_SCRATCH` environment variable (see `tests/fixtures/servers.mjs`) and skip without them.

## License

MIT. readkit is MIT; its third-party data, libraries, and voice models keep their own licences (see `readkit/NOTICE.md`).
