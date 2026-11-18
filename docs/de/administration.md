# Administration und Kontowiederherstellung

[English](../administration.md) · [Deutsch](administration.md) · [简体中文](../zh-CN/administration.md)

[Dokumentation](README.md) · [Selbst hosten](self-hosting.md) · [Betrieb](operations.md)

## Betreiber und Raum-Admins

Der **Instanzbetreiber** verwaltet Einladungen und Kontozugriff. Der **Ersteller eines Raums** verwaltet dessen Einstellungen, Mitgliedschaft, Adminrollen und Designfreigaben. **Raumersteller und Raum-Admins** können Kanäle verwalten und Nachrichten moderieren; die Adminrolle allein erlaubt keine Mitgliedschaftsverwaltung und gewährt keinen Designzugriff. Ein befördertes Raummitglied wird dadurch nicht zum Instanzbetreiber. Das Betreiberkonto selbst ist gegen Kontosperren in dieser Oberfläche geschützt.

Erstelle das erste Betreiberkonto über den in [Selbst hosten](self-hosting.md) beschriebenen Einrichtungsassistenten des einzelnen Images. Nach der Registrierung bleibt die Ersteinrichtung geschlossen; sie dient nicht zum Zurücksetzen von Passwörtern. Auch derselbe später erneut gesetzte Einrichtungsschlüssel öffnet die Registrierung nicht wieder.

## Mitglieder einladen

1. Melde dich als Betreiber an und öffne **Einladungen**.
2. Bestätige sensible Aktionen bei Aufforderung mit einem aktuellen Authenticator-Code.
3. Erstelle eine Einladung und teile den vollständigen Link privat. Er erlaubt eine Registrierung und läuft nach der ausgewählten Dauer ab.
4. Widerrufe eine unbenutzte Einladung, wenn sie an die falsche Person ging oder nicht mehr gebraucht wird.

Die Oberfläche bietet 1 Stunde, 24 Stunden, 3 Tage oder 7 Tage; die API akzeptiert 1–168 Stunden und verwendet ohne Angabe 48 Stunden. Der Einladungstoken liegt im URL-Fragment; der Server speichert dessen Hash. Der geheime Link wird bei der Erstellung ausgegeben, die Einladungsliste zeigt nur den Status und stellt ihn nicht wieder her. Der Widerruf entfernt kein Konto, das die Einladung bereits verwendet hat.

Eine Registrierung erfordert eine Einladung. Raummitgliedschaft und Gast-Zuschauerlinks sind getrennte Rechte: Eine Kontoeinladung gewährt nicht automatisch Zugriff auf jeden beschränkten Raum. Siehe [Benutzerhandbuch](user-guide.md) und [Streaming](streaming.md).

## Kontozugriff und Sitzungen

Unter **Einladungen → Konten** kannst du Mitgliedskonten sperren/freigeben oder ihre Sitzungen beenden. Eine Sperre widerruft Sitzungen und Übertragungen. Das Beenden von Sitzungen erzwingt eine erneute Anmeldung, löscht aber weder Konto noch gespeicherte Nachrichten. Das Betreiberkonto lässt sich hier nicht sperren.

Die Kontenliste zeigt auch den Vault-Verbrauch, das Speicherlimit und Reservierungen unvollständiger Uploads je Konto, auch bei deaktiviertem Vault. Dateinamen und Inhalte bleiben verschlüsselt.

Sensible Betreiberaktionen benötigen eine aktuelle Authenticator-Bestätigung, die fünf Minuten gilt. Ein MFA-Wiederherstellungscode kann die Anmeldung ermöglichen, für sensible Betreiberänderungen ist jedoch ein aktueller Authenticator-Code erforderlich. Der Zugang zur Verwaltungsseite ist keine dauerhafte Freigabe aller Aktionen.

## Passwörter und Chatschlüssel

Mitglieder ändern ihr Passwort unter **Profil → Passwort ändern**. Die offiziellen Clients verlangen mindestens 15 Zeichen und prüfen eine lokale Liste häufiger Passwörter; vorhandene Passwörter bleiben gültig. Der Server erhält einen abgeleiteten Anmeldewert und prüft dessen Format; Längen- und Sperrlistenprüfung erfolgen im offiziellen Client.

Ein erfolgreicher Passwortwechsel verpackt dieselbe Chatidentität neu und beendet andere Sitzungen. Eine gespeicherte Anmeldung oder wiederhergestellter Kontozugriff ersetzen nicht das Passwort zum Entsperren einer älteren verschlüsselten Chatidentität. Die folgenden Betreiberwerkzeuge stellen nur das Betreiberkonto wieder her; ein allgemeiner Passwort-Reset-Befehl für Mitglieder ist nicht dokumentiert.

## Zwei-Faktor-Anmeldung

Der Betreiber muss einen Authenticator einrichten. Andere Mitglieder können ihn unter **Profil → Zwei-Faktor-Anmeldung** aktivieren. Scanne den QR-Code, bestätige einen sechsstelligen Code und speichere die angezeigten einmaligen Wiederherstellungscodes getrennt vom Authenticator-Gerät. Im Profil lassen sich Gerät und Wiederherstellungscodes ersetzen. Freiwillige Mitglieder-MFA kann dort deaktiviert werden; Betreiber-MFA ist Pflicht.

Halte die Uhr des Docker-Hosts synchron, da Authenticator-Codes zeitbasiert sind. Veröffentliche keine Terminal-Einrichtungsdaten, QR-Codes oder Wiederherstellungscodes in Issues oder Screenshots.

## Verlorenen Betreiber-Authenticator ersetzen

Nutze dieselbe Compose-Datei, dasselbe Projekt, dieselbe `.env` und dieselben Volumes wie die laufende Instanz. Für das einzelne Image, im Projektstamm:

```sh
docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml exec -T rooms node bootstrap.mjs --setup-owner-mfa
```

Der Befehl ersetzt den Betreiber-Authenticator und widerruft vorhandene Betreibersitzungen. Scanne den QR-Code im Terminal oder trage den ausgegebenen zeitbasierten Schlüssel mit sechs Stellen und 30 Sekunden Intervall manuell ein. Melde dich wieder an und erstelle im Profil neue Wiederherstellungscodes. Ein SSH-/Docker-Administrator mit diesem Zugriff kann das Betreiberkonto übernehmen; schütze den Hostzugriff entsprechend.

## Betreiberkonto wiederherstellen

Wenn sich der Betreiber nicht anmelden kann, führe aus:

```sh
docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml exec -T rooms node bootstrap.mjs --recover-owner
```

Das pausiert die normale Betreiberanmeldung, widerruft vorhandene Betreibersitzungen sowie unbenutzte Einladungen dieses Betreibers und gibt einen einmaligen, **20 Minuten** gültigen Link aus. Öffne den vollständigen Link an der konfigurierten `PUBLIC_ORIGIN` und schließe die Wiederherstellung ab. Bei Ablauf führe den Befehl erneut aus; auch ein abgelaufener Wiederherstellungseintrag lässt die normale Betreiberanmeldung gesperrt, bis die Wiederherstellung abgeschlossen ist.

Verwende das bisherige Chatpasswort, wenn verfügbar, um den Zugriff auf verschlüsselte Chats zu erhalten. Bei Verlust kann die Wiederherstellung den Kontozugang mit weiterhin gesperrter alter Chatidentität herstellen; findest du das Passwort wieder, lässt sie sich später entsperren. Die Wiederherstellung entschlüsselt keine alten Inhalte für dich. Fehlt zusätzlich der Authenticator, verwende auch den Befehl zum Authenticator-Wechsel.

Führe die CLI nicht gegen ein leeres oder fremdes Volume aus; sie muss die Datenbank der bestehenden Instanz erreichen.

## Raummoderation und Löschen

Raumersteller und Raum-Admins können Text-/Live-Kanäle verwalten und Nachrichten moderieren. Nur der Raumersteller ändert Raumeinstellungen und Mitgliedschaften, befördert Mitglieder zu Raum-Admins oder stuft sie zurück, erteilt oder widerruft Designrechte und löscht den Raum. Designzugriff ist eine gesonderte Freigabe und folgt nicht automatisch aus der Adminrolle. Mitglieder können eigene Nachrichten löschen. Das Entfernen eines Mitglieds oder Löschen eines Raums ändert den App-Zugriff, entfernt aber keine bereits heruntergeladenen oder entschlüsselten Empfängerkopien. Kontosperre und Einladungswiderruf unterscheiden sich vom Löschen eines Raums oder Chatverlaufs.

Halte vor Wartung mit Änderungen an Konto- oder Raumzustand ein wiederherstellbares [Backup](operations.md) vor. Bearbeite die SQLite-Datenbank niemals direkt bei laufender API.

## ZeloteZ Vault

Betreiber können privaten verschlüsselten Speicher und Dateifreigaben unter **Verwaltung → ZeloteZ Vault** aktivieren. Standard sind **2 GiB pro Konto**. Die [Vault-Anleitung](vault.md) beschreibt Verwaltung, Freigaben, Dateimanager-Integration, Datenschutz und Wiederherstellung.
