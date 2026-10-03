MESSAGE SOUND — "Message envoyé iPhone / Apple"

Freecord plays this exact Pixabay sound on message send AND receive:

  https://pixabay.com/sound-effects/film-special-effects-message-envoy%C3%A9-iphone-apple-391098/

Pixabay blocks automated downloads (HTTP 403), so the file could not be
downloaded and bundled automatically. To enable the exact sound, do ONE of:

Option A — drop the file here (recommended)
  1. Open the link above in a browser.
  2. Click "Download" (the file is free to use under the Pixabay licence).
  3. Save it into this folder as EXACTLY:

         public/sounds/message-envoye-iphone.mp3

     (If you only have a .wav, add the VITE_MESSAGE_SFX_URL route below,
      or rename/convert it to .mp3.)

Option B — point Freecord at a direct URL
  In the project's Keys / API keys tab, add:

         VITE_MESSAGE_SFX_URL = <direct https URL to the .mp3>

  A direct CDN link to the Pixabay file works, and so does any URL that
  serves the same audio with CORS enabled.

If neither is present, a short synthesised blip is used so messaging still
has audible feedback. The exact Pixabay sound is used whenever it is found.
