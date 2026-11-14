// FireSong fake phones that "hear" the TV, for headless calibration runs.
// A phone held next to the TV speakers sends back what the TV plays, a
// moment later; `loopbackPhone` makes that stream from the TV's own output
// with a fixed delay, and `silentPhone` one that hears nothing. Both run in
// the TV page's AudioContext, so the delay is the only latency they add.

export const loopbackPhone = (context, tvOutput, delayMs) => {
  const delay = context.createDelay(2);
  delay.delayTime.value = delayMs / 1000;
  const sink = context.createMediaStreamDestination();
  tvOutput.connect(delay);
  delay.connect(sink);
  return {
    stream: sink.stream,
    stop() {
      tvOutput.disconnect(delay);
      delay.disconnect();
    },
  };
};

export const silentPhone = (context) => {
  const source = context.createConstantSource();
  source.offset.value = 0;
  const sink = context.createMediaStreamDestination();
  source.connect(sink);
  source.start();
  return {
    stream: sink.stream,
    stop() {
      source.stop();
      source.disconnect();
    },
  };
};
