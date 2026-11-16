import { t } from "./i18n.js";

export function prepareDesktopAudio(signal) {
  const bridge = window.roomsDesktopAudio;
  const context = new AudioContext({ sampleRate: 48000 });
  const ready = Promise.all([context.resume(), context.audioWorklet.addModule(new URL("./desktop-audio-worklet.js", import.meta.url))])
    .then(() => true, () => false);
  const id = crypto.randomUUID();
  let timer;
  let requested = false;
  let track;

  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    track?.stop();
    if (requested) bridge.close(id).catch(() => {});
    context.close().catch(() => {});
  }, { once: true });

  return async (mode, ended) => {
    if (!await ready) {
      signal.throwIfAborted();
      throw new Error(t("The desktop audio mixer couldn’t start.", "Die Desktop-Tonausgabe konnte nicht starten."));
    }
    signal.throwIfAborted();
    const destination = context.createMediaStreamDestination();
    const source = new AudioWorkletNode(context, "rooms-desktop-audio", {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    });
    source.connect(destination);
    track = destination.stream.getAudioTracks()[0];
    requested = true;

    function disconnected() {
      if (!signal.aborted) ended(t("The selected audio output stopped. Start sharing again to choose another.",
        "Die ausgewählte Tonquelle wurde getrennt. Starte die Freigabe erneut, um eine andere auszuwählen."));
    }

    const result = await bridge.open(id, mode, packet => {
      if (signal.aborted) return;
      clearTimeout(timer);
      timer = setTimeout(disconnected, 6000);
      source.port.postMessage(packet);
    }, disconnected);
    signal.throwIfAborted();
    if (result === "ok") return track;
    if (result === "cancelled") return null;
    if (result === "empty" && mode === "application") {
      throw new Error(t("Play audio in the app, then try sharing again.", "Spiele in der Anwendung Ton ab und versuche es erneut."));
    }
    if (result === "pipewire") {
      throw new Error(t("Desktop audio needs the running PipeWire service and the pw-record and pw-dump tools.",
        "Für Desktop-Ton müssen PipeWire laufen und die Programme pw-record und pw-dump installiert sein."));
    }
    throw new Error(t("The selected audio output is unavailable.", "Die ausgewählte Tonquelle ist offline."));
  };
}
