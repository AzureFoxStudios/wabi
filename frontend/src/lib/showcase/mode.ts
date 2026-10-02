/** Dedicated, loopback-only development origin. Never enabled by production builds. */
export function isShowcaseMode(): boolean {
  return (
    import.meta.env.DEV &&
    import.meta.env.VITE_WABI_SHOWCASE === "1" &&
    typeof location !== "undefined" &&
    location.origin === "http://127.0.0.1:5196"
  );
}
