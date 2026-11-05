// A service worker that writes when asked: its request is the worker's own, not the page's.
self.addEventListener("message", () => {
  void fetch("/w/service-worker", { method: "POST" });
});
