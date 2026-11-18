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
| Write | `whatsapp_send_message`, `whatsapp_send_file`, `whatsapp_create_upload_link`, `whatsapp_list_uploads`, `whatsapp_mark_read`, `whatsapp_load_older` |

In Claude's connector settings, set `whatsapp_send_message` and `whatsapp_send_file` to **Ask**.

### Files with Google, both ways

The two connectors pass files through the upload links each of them issues. A file never travels through Claude's output.

- **WhatsApp → Drive or Gmail:** G-Spot `create_upload_link`, then `whatsapp_files_to_link` with that link and the message ids, then `drive_save` or a Gmail attachment with the `upload_id`s.
- **Drive or Gmail → WhatsApp:** `whatsapp_create_upload_link`, then G-Spot `send_to_link` with that link and the Drive file or attachment, then `whatsapp_send_file` with the `link_id`.

Each connector sends files only to the hosts listed in its `PEER_UPLOAD_HOSTS`. A link someone posts in a group therefore cannot be used to take your files elsewhere.

## Set it up (Railway)

1. Deploy this repository as a Railway service, with a **volume mounted at `/data`** and **one replica**.
2. Set the variables `ADMIN_PASSWORD`, `TOKEN_ENCRYPTION_KEY` (`npm run generate-secrets` prints both), `PEER_UPLOAD_HOSTS` (your G-Spot Assistant's host name) and `DEFAULT_TIMEZONE` (e.g. `Europe/Paris`). Then generate a public domain for the service.
3. Open `https://<your domain>/admin`, sign in with the password, and choose **Get a pairing code** with your number. On the phone: WhatsApp → Settings → Linked devices → Link a device → **Link with phone number instead**, and type the code. A QR code works too, if the admin page is open on another screen.
4. In Claude: Settings → Connectors → Add custom connector, and paste `https://<your domain>/mcp`.
5. In G-Spot Assistant's variables, add this server's host name to `PEER_UPLOAD_HOSTS`, so Drive files and attachments can come back.

## What it keeps

WhatsApp keeps no history on its servers. When you link, the phone sends this device its recent history (usually the last months); after that, the connector receives every message live. `whatsapp_load_older` asks the phone for older messages of one chat.

- The WhatsApp session and the message text are stored **encrypted** (AES-256-GCM, key from `TOKEN_ENCRYPTION_KEY`) in one SQLite file on the volume. Chat and contact names are kept in clear so chats can be found by name.
- Files are not stored: they are fetched from WhatsApp when asked for. Files staged for sending are kept encrypted for 24 hours at most.
- **Unlink** on the admin page logs the device out and erases the session and the whole index.

## A word of caution

WhatsApp does not offer an official API for personal accounts. This connector uses [Baileys](https://github.com/WhiskeySockets/Baileys), which speaks the same protocol as WhatsApp Web. Ordinary personal use like reading your chats and sending the odd message is rarely a problem. Still, WhatsApp can log a linked device out at any time and, in rare cases, restrict an account it sees used for automation. Do not use it for bulk or unsolicited messages.

## License

Free software under the [GNU AGPL v3](LICENSE). It reuses the server skeleton of G-Spot Assistant (OAuth for Claude, encrypted storage, upload links, document reading).
