# Desktop-Client

[Dokumentation](README.md) · [English](../desktop.md) · [简体中文](../zh-CN/desktop.md)

Der Desktop-Client ergänzt Rooms um Systemintegration, Aufnahmefunktionen, optionale Benachrichtigungen und geschützten Anmeldespeicher. Du brauchst weiterhin Adresse und Konto einer vertrauenswürdigen Rooms-Instanz.

## Verfügbare Pakete

Offizielle Downloads gibt es für **Windows x64** und **Linux x64**. Arm64-Unterstützung des Serverimages bedeutet kein Arm64-Desktop-Paket. Ein offizieller macOS-Installer ist hier nicht konfiguriert.

Lade Installer oder AppImage aus der [neuesten GitHub-Veröffentlichung](https://github.com/ZeloteZ/ZeloteZ-Rooms/releases/latest) oder wähle in Rooms **Client** neben deinem Profil.

### Windows

Starte `ZeloteZ-Rooms-<version>-x64.exe` und folge dem Installer. Erlaube Bildschirm- und Mikrofonzugriff, wenn du sie verwenden möchtest. **Systemaudio** funktioniert unter Windows 10/11; **Anwendungsaudio** benötigt Windows 11. Starte Ton in der gewünschten Anwendung, damit sie ausgewählt werden kann.

Das experimentelle Rooms-Capture-Backend benötigt Windows 10 Version 1903 oder neuer und kompatible D3D11-Grafik. Die Verfügbarkeit wird geprüft; Aufnahme und Leistung hängen weiterhin von Hardware und Systemunterstützung ab.

### Linux-AppImage

Lege `ZeloteZ-Rooms-<version>-x86_64.AppImage` an den vorgesehenen dauerhaften Ort, mache es ausführbar und starte es:

```sh
chmod +x /path/to/ZeloteZ-Rooms-VERSION-x86_64.AppImage
/path/to/ZeloteZ-Rooms-VERSION-x86_64.AppImage
```

Ersetze `VERSION` durch die heruntergeladene Versionsnummer und den Pfad durch den tatsächlichen Speicherort.

Unter Wayland brauchst du PipeWire und das ScreenCast-Portal für deinen aktiven Desktop, etwa GNOME oder KDE. Zusätzlich gelten die AppImage-Laufzeitanforderungen deiner Distribution. Rooms benötigt die Chromium-Sandbox. Ergänze bei Startproblemen kein `--no-sandbox`, sondern aktualisiere alte Starter mit diesem Argument und prüfe gegebenenfalls die User-Namespace-Regeln deiner Distribution.

## Mit der Instanz verbinden

1. Gib die HTTPS-Basisadresse ein, etwa `https://rooms.example.com`, ohne Raumpfad.
2. Wähle **Adresse prüfen**, kontrolliere das Ergebnis und bestätige die Verbindung.
3. Melde dich mit deinem Konto auf dieser Instanz an.
4. Öffne einen Raum und nutze Chat und Medien wie im Browser.

Die Adressprüfung kontrolliert, ob der Client die gewählte HTTPS-Instanz erreichen kann. Wähle weiterhin einen Betreiber, dem du vertraust.

## Einstellungen, Hinweise und Schließen

Öffne **Desktop-Einstellungen** über das Appmenü oder **Strg+,**. **Alt** zeigt das Menü unter Windows/Linux. Lokale Einstellungen umfassen Instanzverbindung, optionale Systembenachrichtigungen, Schließverhalten und Updatesuche.

Beim Schließen fragt die App zunächst, ob sie im Hintergrund bleiben oder beendet werden soll. **Nicht erneut fragen** wählt für künftige Schließvorgänge das automatische Minimieren. Ändere das bei Bedarf in den Einstellungen. Hole die App über ihre Tray-/Menü-/Taskleistenintegration zurück. Hintergrundverhalten und Benachrichtigungen hängen von der Desktopumgebung ab.

Hinweise können Freundschaftsanfragen, Direktnachrichten, Erwähnungen und freiwillig aktivierte Live-Starts betreffen. Die Glocke in der App bleibt auch bei ausgeschalteten Systembenachrichtigungen verfügbar.

## Anmeldespeicher

**Auf diesem Gerät angemeldet bleiben** schützt Sitzung und Chat-Entsperrmaterial im Systemspeicher bis zum Ablauf der Sitzung oder zur Abmeldung. Das unterscheidet sich vom bloßen Offenlassen einer Browsersitzung.

Unter Linux akzeptiert Rooms nur systemgestützte Verschlüsselung und lehnt Chromiums Rückfall auf einen festen Schlüssel ab. Ist der Schlüsselbund gesperrt oder sicherer Speicher nicht verfügbar, melde dich manuell an; dauerhaftes Merken kann dann fehlen. Gespeicherte Daten gelten nur für die jeweilige Instanzadresse. Melde dich auf gemeinsam genutzten oder unsicheren Geräten ab.

## Aufnahme und Audio

Wähle **Bildschirm teilen** in einem Channel mit Senderecht. Wähle Bildschirm, Fenster oder Region, bestätige den Systemdialog, lege Qualität und Audio fest und starte. Eine Region wird als Rechteck in der Vorschau gewählt. Wenn die eingebettete Vorschau verfügbar ist, blendet sich das native Linux-Aufnahmefenster nach dem Start aus; im Live-Channel erscheinen Vorschau, Dauer, Auflösung, FPS, Uploadrate und Stoppfunktion. Andernfalls verwendet der native Helfer sein eigenes Aufnahmefenster.

Unter Linux nutzt Anwendungs- und Systemaudio PipeWire-Ausgänge. Starte die Wiedergabe vor der Auswahl. Für den PipeWire-Audioweg des AppImage werden `pw-dump` und `pw-record` benötigt. Verschwindet die Quelle, beende die Freigabe und starte mit einer verfügbaren Quelle neu.

**Standard** ist die Vorgabe. Das experimentelle **Rooms Capture** erscheint nur mit verfügbarem Backend. [Streaming](streaming.md) erklärt Qualitätsziele, Statistiken, Grenzen und direkte/gepufferte Wiedergabe.

### Optionaler nativer Linux-Helfer

Er benötigt Python GObject/Cairo, GTK 4, Libadwaita, libportal mit GTK 4, PipeWire, GStreamer sowie Aufnahme- und Encoderplugins. Ohne die nativen Voraussetzungen verwendet das AppImage seinen eingebauten Aufnahmeweg.

Für CachyOS/Arch Linux mit GNOME ist diese Paketgruppe vorgesehen:

```sh
sudo pacman -S --needed python-gobject python-cairo gtk4 libadwaita libportal libportal-gtk4 \
  pipewire gst-plugin-pipewire xdg-desktop-portal xdg-desktop-portal-gnome \
  gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly \
  gst-plugin-gtk4 gst-libav glib-networking ca-certificates
```

Unter KDE Plasma ersetzt `xdg-desktop-portal-kde` das GNOME-Backend. Andere Distributionen verwenden andere Paketnamen; installiere dort die entsprechenden Pakete. Paketreferenz: [gst-plugin-gtk4 bei Arch](https://archlinux.org/packages/extra/x86_64/gst-plugin-gtk4/).

Geprüfte GStreamer-Elemente sind unter anderem `pipewiresrc`, `gtk4paintablesink`, `x264enc`, `h264parse`, `flvmux` und `rtmp2sink`, für Ton zusätzlich ein AAC-Encoder. Der native Linux-Publisher kodiert per CPU/x264 und prüft das RTMPS-Zertifikat über den System-Vertrauensspeicher.

## Links aus der Browsererweiterung

Starte die installierte App einmal und verbinde sie mit exakt derselben Rooms-Adresse wie die [YouTube-Erweiterung](browser-extension.md). Unter Linux muss das ausführbare AppImage am dauerhaften Ort gestartet werden, damit Menüeintrag und Linkhandler eingerichtet werden. Wiederhole das nach Verschieben oder Update auf eine neue Datei.

Auf Desktops mit XDG-Linkhandlern registriert Rooms `zelotez-rooms:`, wenn noch kein Standard gesetzt ist, und bereinigt erkannte alte AppImage-Starter. Ist bereits ein anderer Handler gewählt, ändere die Systemzuordnung oder nutze **Im Browser fortfahren** in der Erweiterung.

## Client aktualisieren

Die Updatesuche ist zunächst **ausgeschaltet**. Aktiviere sie unter **Desktop-Einstellungen → Desktop-Updates** und wähle 1, 6, 24 oder 168 Stunden. Die App fragt die öffentliche GitHub-Release-API ohne Anmeldedaten ab, vergleicht die Version und öffnet die Veröffentlichungsseite im Browser. Sie ersetzt die installierte App nicht heimlich.

Ein fehlgeschlagener Abruf kann auch durch Offlinebetrieb, ein Anfragelimit oder ungültige Metadaten entstehen. Nutze dann den Releaselink manuell. Aktualisiere Gateway und Server gemeinsam, wenn ein neuer Client ein neueres Instanzprotokoll braucht. Client- und Serverupdates sind getrennte Vorgänge.

## Download prüfen

Offizielle Desktop-Releases liefern SHA-256-Dateien und ein Ed25519-signiertes Installermanifest. Besorge `desktop-release-manifest.json`, `desktop-release-manifest.sig`, den Installer und eine unabhängig vertrauenswürdige Kopie des [Release-Prüfschlüssels](../../desktop/release-public.pem). Führe im Repository aus:

```sh
python3 deploy/desktop-release-signature.py verify VERSION \
  --source /path/to/downloads --trusted-key /path/to/trusted-public.pem --platform linux
```

Verwende für Windows `--platform windows`. Ersetze `VERSION` durch die gewünschte numerische Version ohne führendes `v`.

Unter Windows prüft OpenSSL die Signatur mit `openssl pkeyutl -verify -pubin -rawin -inkey public.pem -in desktop-release-manifest.json -sigfile desktop-release-manifest.sig`. Vergleiche danach exakten Dateinamen, Größe und SHA-256 des Windows-Installers (`Get-FileHash -Algorithm SHA256`) mit dem geprüften Manifest. Eine Prüfsumme aus derselben nicht vertrauenswürdigen Quelle allein belegt keine Echtheit. Das signierte Installermanifest deckt die Erweiterungs-ZIP nicht ab.
