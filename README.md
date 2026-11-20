# WhatsApp Connector

Let Claude read your WhatsApp chats and groups, browse and read the files people share, and send messages and files for you. It exchanges files with [G-Spot Assistant](https://github.com/romaxnova/g-spot-assistant), your Gmail and Drive connector, in both directions.

You run your own private copy. It joins your WhatsApp as a **linked device**, like WhatsApp Web. Your phone keeps working as usual.

## What you can ask Claude

- "What's new in the apartments group since yesterday? Anything under 1,300 € near Bastille?"
- "Find the PDF Marie sent me with the lease and save it in my Drive, in Logement."
- "Show me the photos of the flat Paul posted this morning."
- "Send my rental application (the PDF in Drive) to Paul on WhatsApp."
- "Reply in the group that I'm taking the Saturday visit."

## Tools

| | Tools |
|---|---|
| Read | `whatsapp_status`, `whatsapp_list_chats`, `whatsapp_read_chat`, `whatsapp_search_messages`, `whatsapp_group_info`, `whatsapp_find_contacts` |
| Files | `whatsapp_list_files` (documents, photos, videos, voice notes across chats), `whatsapp_get_file` (PDF/Word/Excel/PowerPoint as text, photos as images), `whatsapp_files_to_link` (to G-Spot Assistant: Drive, Gmail) |
| Write | `whatsapp_send_message`, `whatsapp_send_file`, `whatsapp_send_voice` (optional, see below), `whatsapp_create_upload_link`, `whatsapp_list_uploads`, `whatsapp_mark_read`, `whatsapp_load_older` |

In Claude's connector settings, set `whatsapp_send_message` and `whatsapp_send_file` to **Ask**.

### Files with Google, both ways

The two connectors pass files through the upload links each of them issues. A file never travels through Claude's output.

- **WhatsApp → Drive or Gmail:** G-Spot `create_upload_link`, then `whatsapp_files_to_link` with that link and the message ids, then `drive_save` or a Gmail attachment with the `upload_id`s.
- **Drive or Gmail → WhatsApp:** `whatsapp_create_upload_link`, then G-Spot `send_to_link` with that link and the Drive file or attachment, then `whatsapp_send_file` with the `link_id`.

Each connector sends files only to the hosts listed in its `PEER_UPLOAD_HOSTS`. A link someone posts in a group therefore cannot be used to take your files elsewhere.

## Set it up (Railway)

1. Deploy this repository as a Railway service, with a **volume mounted at `/data`** and **one replica**.
2. Set the variables `ADMIN_PASSWORD`, `TOKEN_ENCRYPTION_KEY` (`npm run generate-secrets` prints both), `PEER_UPLOAD_HOSTS` (your G-Spot Assistant's host name) and `DEFAULT_TIMEZONE` (e.g. `Europe/Paris`). Then generate a public domain for the service.
3. Open `https://<your domain>/admin` **on a computer**, sign in with the password, and choose **Show a QR code**. On the phone: WhatsApp → Settings → Linked devices → Link a device, and scan it. The phone then sends recent history for a few minutes. (Linking by pairing code is offered too, but WhatsApp currently refuses most codes from linked-device apps.)
4. In Claude: Settings → Connectors → Add custom connector, and paste `https://<your domain>/mcp`.
5. In G-Spot Assistant's variables, add this server's host name to `PEER_UPLOAD_HOSTS`, so Drive files and attachments can come back.

### Without a GitHub account (Docker image)

Every push to `main` publishes the server as a public image, `ghcr.io/romaxnova/whatsapp-connector:latest`. On Railway:

1. **New project → Empty service.** In the service's **Settings → Source**, choose **Connect image** and enter `ghcr.io/romaxnova/whatsapp-connector:latest`.
2. **Volume:** right-click the service → **Attach volume**, with mount path `/data`.
3. **Variables:**
   - `ADMIN_PASSWORD`: any password of 12+ characters.
   - `TOKEN_ENCRYPTION_KEY`: any random passphrase of **32+ characters** (two generated passwords one after the other will do). **Never change it afterwards.**
   - `DEFAULT_TIMEZONE`: e.g. `Europe/Paris`.
4. **Settings:**
   - **Networking → Generate domain** (port 8080).
   - Healthcheck path `/healthz`.
   - **Replicas: 1**, region of your choice.
5. Continue with step 3 above: open `/admin` on a computer and scan the QR code.

To update later, redeploy the service: Railway pulls the newest image.

## Voice messages (optional)

`whatsapp_send_voice` says a text with an [ElevenLabs](https://elevenlabs.io) voice and sends it as a real voice note, with a play button and a waveform. The tool only appears when these variables are set:

| Variable | Value |
|---|---|
| `ELEVENLABS_API_KEY` | Your key: elevenlabs.io → profile → **API Keys** (the free plan works) |
| `ELEVENLABS_VOICE_ID` | The voice to use (see below) |
| `ELEVENLABS_MODEL_ID` | Optional: `eleven_multilingual_v2` (default) or `eleven_v3` |
| `ELEVENLABS_STYLE_TAGS` | Optional, `eleven_v3` only: a default style for messages that ask for none, e.g. `[strong French accent] [playful]` |
| `VOICE_MAX_CHARS` | Optional: the longest text per message (default 600) |

- **Free plan limits.** The free plan includes about 10,000 characters a month, roughly 15 voice messages of 600 characters. It can only use the built-in voices and voices you made yourself: library voices, and creating voices through the API, need a paid plan.
- **Accent and tone per message.** Just say it: "send Pierre a voice message in French with a strong Russian accent" or "in English, West African accent, playful". Claude passes it to `whatsapp_send_voice` as `style`, which switches that message to the expressive `eleven_v3` model. Without a style, the voice speaks naturally with `ELEVENLABS_MODEL_ID`. Nothing needs setting in advance.
- **Your own voice.** Clone it on elevenlabs.io (Voices → My Voices; instant cloning needs the Starter plan) and put its id in `ELEVENLABS_VOICE_ID`, for example `ELEVENLABS_VOICE_ID=YLCbQxXSS0chg2xbSelB` (the author's cloned voice; use your own). Speaking another language, it keeps its natural accent.
- **Comparing voices.** `ELEVENLABS_API_KEY=… npm run voice-preview -- --list` lists your voices; `--voices id1,id2 --tags "[strong French accent]"` saves one MP3 per voice and model to compare by ear.
- **ffmpeg.** The Docker image already includes it, to turn speech into a WhatsApp voice note (Ogg Opus).
- **No undo.** Like any message, a voice message goes out at once and cannot be unsent: Claude shows you the text and the recipient first.

## What it keeps

WhatsApp keeps no history on its servers. When you link, the phone sends this device its recent history (usually the last months); after that, the connector receives every message live. `whatsapp_load_older` asks the phone for older messages of one chat.

- The WhatsApp session and the message text are stored **encrypted** (AES-256-GCM, key from `TOKEN_ENCRYPTION_KEY`) in one SQLite file on the volume. Chat and contact names are kept in clear so chats can be found by name.
- Files are not stored: they are fetched from WhatsApp when asked for. Files staged for sending are kept encrypted for 24 hours at most.
- **Unlink** on the admin page logs the device out and erases the session and the whole index.

## A word of caution

WhatsApp does not offer an official API for personal accounts. This connector uses [Baileys](https://github.com/WhiskeySockets/Baileys), which speaks the same protocol as WhatsApp Web. Ordinary personal use like reading your chats and sending the odd message is rarely a problem. Still, WhatsApp can log a linked device out at any time and, in rare cases, restrict an account it sees used for automation. Do not use it for bulk or unsolicited messages.

## License

Free software under the [GNU AGPL v3](LICENSE). It reuses the server skeleton of G-Spot Assistant (OAuth for Claude, encrypted storage, upload links, document reading).
