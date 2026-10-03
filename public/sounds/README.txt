FREECORD SOUND FILES

Pixabay blocks automated downloads (HTTP 403), so these two files could not be
fetched and bundled automatically. Drop them here to use the exact sounds; the
app plays a synthesised stand-in only when a file is missing.

1) MESSAGE SEND / RECEIVE
   Pixabay: "Message envoyé – iPhone / Apple"
   https://pixabay.com/sound-effects/film-special-effects-message-envoy%C3%A9-iphone-apple-391098/
   Save as:  public/sounds/message-envoye-iphone.mp3
   Or set:   VITE_MESSAGE_SFX_URL = <direct .mp3 URL>   (Keys / API keys tab)

2) CALL RINGTONE
   Pixabay: "Discord SFX Calling"
   https://pixabay.com/sound-effects/film-special-effects-discord-sfx-calling-250633/
   Save as:  public/sounds/discord-calling.mp3
   Or set:   VITE_CALL_SFX_URL = <direct .mp3 URL>   (Keys / API keys tab)
   The ringtone loops while an incoming call rings, and while you wait for the
   person you called to answer.

Both are free to use under the Pixabay licence. A .wav works too if you point
VITE_MESSAGE_SFX_URL / VITE_CALL_SFX_URL at it.
