# Publishing the Railway template (maintainer notes)

The template is the "Deploy on Railway" button: a friend taps it, types a password, taps Deploy, and Railway
generates the encryption key, attaches the storage and gives the server its address. No GitHub account and no
AI prompt needed. Templates can only be created in the Railway dashboard (or with the Railway CLI).

1. Railway → your workspace → **Templates** → **New Template**.
2. **Add** → **Docker Image** → `ghcr.io/romaxnova/whatsapp-connector:latest` (published by the Image workflow).
   Name the service `whatsapp`.
3. **Variables** of the service (the description is what the person reads on the deploy form):

   | Variable | Value | Description |
   |---|---|---|
   | `ADMIN_PASSWORD` | *(empty: the person fills it in)* | Choose a password (12+ characters) for your connector's admin page. Keep it: you need it to link WhatsApp and approve Claude. |
   | `TOKEN_ENCRYPTION_KEY` | `${{secret(48)}}` | Generated for you. Encrypts your WhatsApp session and messages. Never change it. |
   | `DEFAULT_TIMEZONE` | `Europe/Paris` | Your time zone, e.g. Europe/Paris or America/New_York. |
   | `PORT` | `8080` | Leave as it is. |

   No `BASE_URL` or `DATA_DIR`: the server reads `RAILWAY_PUBLIC_DOMAIN` and `RAILWAY_VOLUME_MOUNT_PATH`.
   `PEER_UPLOAD_HOSTS` stays unset (only for people who also run G-Spot Assistant).
4. **Settings** of the service: public networking (HTTP) on port `8080`; healthcheck path `/healthz`;
   restart policy *On failure*; 1 replica.
5. Right-click the service → **Attach volume** → mount path `/data`.
6. **Create Template**, then copy its link (`https://railway.com/deploy/…` or `https://railway.com/new/template/…`).
7. Put the button in the README ("Set it up"):

   ```markdown
   [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/TEMPLATE-CODE)
   ```

8. Optional: **Publish** it to Railway's marketplace (needs a category, description and readme); open-source
   templates can earn a share of what their deployments spend.

Shortcut for steps 2 to 5: with the new, empty template open in the dashboard, ask Railway's built-in assistant
to fill it in from this list, then check each line before creating the template.

Before sharing the link, deploy it once yourself (a throwaway project), check that `/admin` asks for the
password you typed and that the logs show `listening`, then delete that project.
