class DesktopAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = new Int16Array(48000);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.unread = 0;
    this.port.onmessage = ({ data }) => {
      const input = new Int16Array(data.buffer, data.byteOffset, data.byteLength / Int16Array.BYTES_PER_ELEMENT);
      for (const sample of input) {
        if (this.unread === this.queue.length) {
          this.readIndex = (this.readIndex + 1) % this.queue.length;
          this.unread--;
        }
        this.queue[this.writeIndex] = sample;
        this.writeIndex = (this.writeIndex + 1) % this.queue.length;
        this.unread++;
      }
    };
  }

  process(_input, [output]) {
    const [left, right] = output;
    for (let frame = 0; frame < left.length && this.unread >= 2; frame++) {
      left[frame] = this.queue[this.readIndex] / 32768;
      right[frame] = this.queue[(this.readIndex + 1) % this.queue.length] / 32768;
      this.readIndex = (this.readIndex + 2) % this.queue.length;
      this.unread -= 2;
    }
    return true;
  }
}

registerProcessor("rooms-desktop-audio", DesktopAudio);
