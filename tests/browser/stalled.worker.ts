// Test-only unresponsive Worker, after the same started notification as the real adapter.
self.onmessage = () => {
  self.postMessage({ type: 'started' });
  while (true) {
    /* host must terminate this Worker */
  }
};
