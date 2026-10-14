# Readout

Paste text and hear it read aloud. Dictate notes by voice. Free, no account, no limits, and it runs entirely in your browser. Optional sync keeps your phone and computer in step.

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

## Good to know

- **Keep the screen on while listening.** Phones stop web speech when the screen locks, so Readout keeps the screen awake while it reads (you can turn that off in Settings). There's also an experimental setting that tries to keep reading on a locked screen; how well it works depends on the phone.
- **Better voices on Android:** open your phone's text-to-speech settings and install voice data for Google's speech engine. New voices show up in Readout's voice list.
- **Privacy:** without sync, your texts never leave the browser. With sync on, they're also kept in a secret gist on your GitHub account. Secret gists are unlisted, not encrypted: anyone with the gist's address could read it, and GitHub keeps its edit history. Reading aloud uses your device's speech engine; voices marked "online" in the voice list send the text to Google or Microsoft to synthesize it. Dictation in Chrome usually sends audio to Google to transcribe it, unless you turn on on-device recognition in Settings and your Chrome supports it.
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

No build step and no dependencies. It's plain HTML, CSS, and JavaScript:

- `index.html`, `styles.css`: the interface
- `core.js`: text splitting, formatting, and the sync merge, with no DOM, so it's testable in Node (`node tests/core.test.js`, `node tests/sync.test.js`)
- `app.js`: storage (IndexedDB), the speech engine, dictation, GitHub sync, and everything else
- `tests/sync.e2e.mjs`: two browser "devices" syncing through a stand-in for GitHub's gist API (needs Chrome or Edge: `node tests/sync.e2e.mjs`)
- `sw.js`: offline support. Bump `VERSION` here and the `?v=` numbers in `index.html` when you release changes.
- `tools/make_icons.py`: draws the PNG app icons. A GitHub Action runs it automatically.

To run locally: `python3 -m http.server` in this folder, then open http://localhost:8000.

PDF reading uses [pdf.js](https://mozilla.github.io/pdf.js/), loaded on demand from jsDelivr.

## License

MIT
