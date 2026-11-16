import os
from pathlib import Path
from tempfile import NamedTemporaryFile

APP_NAME = "ZeloteZ Rooms"
LANGUAGES = (("en", "English"), ("de", "Deutsch"))
DEFAULT_LANGUAGE = "en"

# English strings are the message IDs. Add a catalog and a language entry when a translation is ready.
CATALOGS = {
    "de": {
        "Server settings": "Servereinstellungen",
        "Desktop settings": "Desktop-Einstellungen",
        "Desktop app": "Desktop-App",
        "Appearance for desktop settings and capture windows.": "Darstellung für Desktop-Einstellungen und Aufnahmefenster.",
        "Appearance": "Darstellung",
        "System": "System",
        "Dark": "Dunkel",
        "Light": "Hell",
        "Language for the desktop controls.": "Sprache der Desktop-Bedienelemente.",
        "Your Rooms instance": "Deine Rooms-Instanz",
        "Current server · {origin}": "Aktueller Server · {origin}",
        "Server address": "Serveradresse",
        "Desktop notifications": "Desktop-Benachrichtigungen",
        "Show system notifications for activity in Rooms.": "Zeigt Systembenachrichtigungen für Aktivitäten in Rooms an.",
        "Minimize when closing": "Beim Schließen minimieren",
        "Keep ZeloteZ Rooms running in the taskbar when you close the window.": "ZeloteZ Rooms bleibt in der Taskleiste, wenn du das Fenster schließt.",
        "Quit ZeloteZ Rooms": "ZeloteZ Rooms beenden",
        "Keep ZeloteZ Rooms running?": "ZeloteZ Rooms weiterlaufen lassen?",
        "Minimize": "Minimieren",
        "Open ZeloteZ Rooms": "ZeloteZ Rooms öffnen",
        "Open it from the taskbar. To quit, use Desktop settings or Ctrl+Q.": "Öffne die App über die Taskleiste. Beenden kannst du sie in den Desktop-Einstellungen oder mit Strg+Q.",
        "Check the address, then connect when you’re ready.": "Prüfe die Adresse und verbinde dich, wenn du bereit bist.",
        "Check address": "Adresse prüfen",
        "Checking server …": "Server wird geprüft …",
        "Checking another address. Try again in a moment.": "Eine andere Adresse wird gerade geprüft. Versuche es gleich erneut.",
        "Rooms instance verified. You can connect now.": "Rooms-Instanz erkannt. Du kannst dich jetzt verbinden.",
        "This Rooms instance is already open.": "Diese Rooms-Instanz ist bereits geöffnet.",
        "Check this server before connecting.": "Prüfe diesen Server vor dem Verbinden.",
        "Check your saved server before connecting.": "Prüfe deinen gespeicherten Server, bevor du dich verbindest.",
        "This address did not identify itself as a ZeloteZ Rooms instance.": "Unter dieser Adresse wurde keine ZeloteZ Rooms-Instanz erkannt.",
        "This Rooms instance uses an unsupported desktop protocol.": "Diese Rooms-Instanz verwendet ein nicht unterstütztes Desktop-Protokoll.",
        "Couldn’t verify the server. Check the address, certificate and connection.": "Der Server konnte nicht geprüft werden. Prüfe Adresse, Zertifikat und Verbindung.",
        "The server sent an unexpected page.": "Der Server hat eine unerwartete Seite gesendet.",
        "The server tried to redirect the connection.": "Der Server hat versucht, die Verbindung weiterzuleiten.",
        "The desktop settings couldn’t be saved.": "Die Desktop-Einstellungen konnten nicht gespeichert werden.",
        "Connect to your server": "Mit deinem Server verbinden",
        "Connect": "Verbinden",
        "Back": "Zurück",
        "Enter an HTTPS server address or a local test URL.": "Gib eine HTTPS-Serveradresse oder eine lokale Testadresse ein.",
        "The server address couldn’t be saved.": "Die Serveradresse konnte nicht gespeichert werden.",
        "The server redirected to a different address.": "Der Server hat zu einer anderen Adresse weitergeleitet.",
        "Sign in to ZeloteZ Rooms again.": "Melde dich erneut bei ZeloteZ Rooms an.",
        "The live channel couldn’t prepare the stream.": "Der Live-Kanal konnte den Stream nicht vorbereiten.",
        "The live channel returned an invalid stream destination.": "Der Live-Kanal hat ein ungültiges Stream-Ziel geliefert.",
        "The live channel didn’t respond. Try again.": "Der Live-Kanal antwortet nicht. Versuch es erneut.",
        "End your stream in the other live channel before sharing here.": "Beende deinen Stream im anderen Live-Kanal, bevor du hier teilst.",
        "Allow microphone access?": "Mikrofonzugriff erlauben?",
        "The microphone is used for voice chat.": "Das Mikrofon wird für den Sprachchat verwendet.",
        "Allow": "Erlauben",
        "Save attachment": "Anhang speichern",
        "Choose a local location to save the attachment.": "Wähle einen lokalen Speicherort für den Anhang.",
        "Save": "Speichern",
        "The link couldn’t open in your browser.": "Der Link konnte nicht im Browser geöffnet werden.",
        "Couldn’t connect to the server. Check the address and try again.": "Keine Verbindung zum Server. Prüfe die Adresse und versuch es erneut.",
        "Monitor": "Monitor",
        "Live": "Live",
        "Offline": "Offline",
        "Upload": "Upload",
        "{rate} FPS": "{rate} FPS",
        "Choose a monitor": "Monitor auswählen",
        "Preview your capture here before going live.": "Hier siehst du deine Aufnahme vor dem Start.",
        "Preview hidden. Your stream is still running.": "Vorschau ausgeblendet. Die Übertragung läuft weiter.",
        "Capture source": "Bildschirmquelle",
        "Region": "Bereich",
        "App window": "Anwendung",
        "Video quality": "Videoqualität",
        "_Resolution": "_Auflösung",
        "_Frame rate": "_Bildrate",
        "Start stream": "Stream starten",
        "Close preview": "Vorschau schließen",
        "_Audio to share": "_Ton übertragen",
        "No audio": "Kein Ton",
        "Application audio": "Anwendungston",
        "System audio": "Systemton",
        "Choose an audio output": "Tonausgabe auswählen",
        "Audio output to share": "Zu übertragende Tonausgabe",
        "Refresh audio sources": "Tonquellen aktualisieren",
        "Looking for audio outputs …": "Tonausgaben werden gesucht …",
        "Choose the application audio you want to share.": "Wähle die Tonausgabe der Anwendung, die du übertragen möchtest.",
        "Play some audio in the app and refresh the list.": "Starte die Tonwiedergabe in der Anwendung und aktualisiere die Liste.",
        "All sound playing through this output will be shared.": "Der gesamte Ton dieser Ausgabe wird übertragen.",
        "No PipeWire playback output is available.": "Es ist keine Tonausgabe in PipeWire verfügbar.",
        "Hide preview": "Vorschau ausblenden",
        "End stream": "Stream beenden",
        "Time live": "Sendedauer",
        "Resolution": "Auflösung",
        "Frame rate": "Bildrate",
        "Manual connection": "Manuelle Verbindung",
        "RTMPS address": "RTMPS-Adresse",
        "_Server address": "_Serveradresse",
        "Stream _key": "Stream-_Schlüssel",
        "Show preview": "Vorschau einblenden",
        "Choose another window": "Anderes Fenster wählen",
        "Choose a window": "Fenster auswählen",
        "Choose another monitor": "Anderen Monitor wählen",
        "Viewers and chat": "Zuschauer und Chat",
        "Live room": "Live-Raum",
        "Live preview": "Live-Vorschau",
        "Capture preview": "Bildschirmvorschau",
        "Cancel": "Abbrechen",
        "Selecting source": "Auswahl",
        "Loading preview": "Vorschau wird geladen",
        "Preview": "Vorschau",
        "Connecting": "Verbinden",
        "Screen sharing": "Bildschirmfreigabe",
        "Drag a rectangle in the preview.": "Ziehe ein Rechteck in der Vorschau.",
        "The screen sharing portal is unavailable.": "Das Bildschirmfreigabe-Portal ist nicht erreichbar.",
        "Screen sharing was canceled.": "Die Bildschirmfreigabe wurde abgebrochen.",
        "PipeWire couldn’t open a capture connection.": "PipeWire hat keine Verbindung für die Aufnahme geöffnet.",
        "Screen sharing couldn’t start.": "Die Bildschirmfreigabe konnte nicht geöffnet werden.",
        "Screen sharing ended.": "Die Bildschirmfreigabe wurde beendet.",
        "Checking the selected audio source.": "Die ausgewählte Tonquelle wird geprüft.",
        "Preparing the stream in the live room.": "Der Stream wird im Live-Raum vorbereitet.",
        "Choose a live room in Studio.": "Wähle einen Live-Raum in Studio.",
        "The live room didn’t provide a stream.": "Der Live-Raum hat keinen Stream bereitgestellt.",
        "The capture source changed size. Check your selection.": "Die Größe der Aufnahme hat sich geändert. Prüfe deine Auswahl.",
        "Connecting to the streaming server.": "Verbindung zum Streamingserver wird aufgebaut.",
        "Video output couldn’t start.": "Der Videoausgang konnte nicht gestartet werden.",
        "The selected audio source is unavailable. Choose it again or stream without audio.": "Die ausgewählte Tonquelle ist nicht mehr verfügbar. Wähle sie erneut oder streame ohne Ton.",
        "Connection failed. Check the server address, TLS certificate and stream key.": "Verbindung fehlgeschlagen. Prüfe Serveradresse, TLS-Zertifikat und Stream-Schlüssel.",
        "Capture was interrupted. Choose the source again.": "Die Bildschirmaufnahme wurde unterbrochen. Wähle die Quelle erneut.",
        "Capture ended.": "Die Bildschirmaufnahme wurde beendet.",
        "The selected source didn’t provide a preview. Choose it again.": "Die gewählte Quelle liefert keine Vorschau. Wähle sie erneut.",
        "The live room didn’t respond. Try again.": "Der Live-Raum antwortet gerade nicht. Versuche es erneut.",
        "The streaming server didn’t confirm the connection in time.": "Der Streamingserver hat die Verbindung nicht rechtzeitig bestätigt.",
        "Stream ended.": "Stream beendet.",
        "ZeloteZ Rooms Studio needs a graphical desktop session.": "ZeloteZ Rooms Studio benötigt eine laufende grafische Sitzung.",
        "Install WebKitGTK 6 to sign in to Studio.": "Installiere WebKitGTK 6, um dich in Studio anzumelden.",
        "ZELOTEZ_STUDIO_ORIGIN is invalid.": "ZELOTEZ_STUDIO_ORIGIN ist ungültig.",
        "ZELOTEZ_STUDIO_ORIGIN needs an HTTPS or local test URL.": "ZELOTEZ_STUDIO_ORIGIN braucht eine HTTPS- oder lokale Testadresse.",
        "Reload ZeloteZ Rooms": "ZeloteZ Rooms erneut laden",
        "ZeloteZ Rooms couldn’t load in Studio.": "ZeloteZ Rooms konnte in Studio nicht geladen werden.",
        "ZeloteZ Rooms is disconnected in Studio.": "ZeloteZ Rooms ist in Studio nicht verbunden.",
        "ZeloteZ Rooms didn’t respond in Studio.": "ZeloteZ Rooms hat in Studio nicht geantwortet.",
        "Couldn’t open the Room in your browser.": "Der Raum konnte nicht im Browser geöffnet werden.",
        "Choose a live channel in Studio.": "Wähle einen Live-Channel in Studio.",
        "ZeloteZ Rooms couldn’t prepare the stream.": "ZeloteZ Rooms konnte den Stream nicht vorbereiten.",
        "ZeloteZ Rooms returned an invalid stream destination.": "ZeloteZ Rooms hat ein ungültiges Stream-Ziel geliefert.",
        "Audio outputs couldn’t be loaded. Check that PipeWire is running.": "Die Tonausgaben konnten nicht geladen werden. Prüfe, ob PipeWire läuft.",
        "The selected audio output is unavailable. Choose it again.": "Die gewählte Tonausgabe ist nicht mehr verfügbar. Wähle sie erneut.",
        "The capture preview couldn’t start.": "Die Bildschirmvorschau konnte nicht gestartet werden.",
        "A stream is already active.": "Ein Stream ist bereits aktiv.",
        "The capture source hasn’t provided a frame yet.": "Die Freigabe liefert noch kein Bild.",
        "The selected region is outside the shared area.": "Der gewählte Bereich liegt außerhalb der freigegebenen Fläche.",
        "This PipeWire version can’t target the selected audio output.": "Diese PipeWire-Version kann die gewählte Tonausgabe nicht gezielt aufnehmen.",
        "Video output couldn’t be added.": "Der Videoausgang konnte nicht hinzugefügt werden.",
        "Video output couldn’t be connected.": "Der Videoausgang konnte nicht verbunden werden.",
        "Screen share audio needs a GStreamer AAC encoder.": "Für den Ton der Bildschirmfreigabe fehlt ein GStreamer-AAC-Encoder.",
        "Enter the server address without extra parameters.": "Gib die Serveradresse ohne Zusätze ein.",
        "The server address is invalid.": "Die Serveradresse ist ungültig.",
        "Copy the RTMPS address from your live channel.": "Kopiere die RTMPS-Adresse aus deinem Live-Channel.",
        "The server name is invalid.": "Der Servername ist ungültig.",
        "RTMP without TLS is available only for local tests on 127.0.0.1 or [::1].": "RTMP ohne TLS ist nur für lokale Tests über 127.0.0.1 oder [::1] verfügbar.",
        "The stream key must contain 64 hexadecimal characters.": "Der Stream-Schlüssel muss aus 64 hexadezimalen Zeichen bestehen.",
        "Language": "Sprache",
        "Restart Studio to apply the language change.": "Starte Studio neu, um die Sprache zu ändern.",
        "The language preference couldn’t be saved.": "Die Spracheinstellung konnte nicht gespeichert werden.",
        "Select an app window in the system dialog.": "Wähle das Fenster der Anwendung im Dialog deines Systems.",
        "Select a monitor in the system dialog.": "Wähle einen Monitor im Dialog deines Systems.",
        "Choose exactly one window to capture.": "Wähle genau ein Fenster für die Aufnahme.",
        "Choose exactly one monitor to capture.": "Wähle genau einen Monitor für die Aufnahme.",
        "Selected region · {width} × {height} px": "Ausgewählter Bereich · {width} × {height} px",
        "{speed} Mbps": "{speed} Mbit/s",
        "Missing desktop dependency. {error}. See desktop/README.md.": "Desktop-Abhängigkeit fehlt. {error}. Siehe desktop/README.md.",
        "Missing GStreamer elements. {elements}. See desktop/README.md.": "GStreamer-Elemente fehlen. {elements}. Siehe desktop/README.md.",
        "Loading": "Vorschau lädt",
    },
}


def settings_directory():
    configuration = os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config"
    return Path(configuration) / "zelotez-rooms"


def read_setting(name, fallback):
    try:
        return (settings_directory() / name).read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError):
        return fallback


def save_setting(name, value):
    destination = settings_directory() / name
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with NamedTemporaryFile(mode="w", encoding="utf-8", dir=destination.parent, delete=False) as temporary:
        try:
            temporary.write(value + "\n")
            temporary.close()
            os.replace(temporary.name, destination)
        finally:
            Path(temporary.name).unlink(missing_ok=True)


def configured_language():
    requested = read_setting("language", DEFAULT_LANGUAGE)
    return requested if requested in dict(LANGUAGES) else DEFAULT_LANGUAGE


def save_language(language):
    if language not in dict(LANGUAGES):
        raise ValueError("Unsupported language")
    save_setting("language", language)


LANGUAGE = configured_language()


def t(message, **values):
    translated = CATALOGS.get(LANGUAGE, {}).get(message, message)
    return translated.format(**values) if values else translated


def decimal(value, places):
    formatted = f"{value:.{places}f}"
    return formatted.replace(".", ",") if LANGUAGE == "de" else formatted
