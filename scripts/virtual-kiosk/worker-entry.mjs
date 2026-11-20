// The local Worker's entry in the virtual kiosk stack: the real Worker, with GitHub's API answered here.
//
// The Worker reads the official release feed from api.github.com when a dashboard queues a kiosk update or checks for
// updates. Anonymous reads share 60 requests an hour per IP address, so on a busy developer computer or a shared CI
// runner the real feed refuses, and "Update kiosk" then fails with "No compatible official kiosk release is currently
// available". The scenarios must not depend on that, or on which release is published today, so this entry serves one
// fixed official release. No request from the virtual stack's Worker reaches api.github.com.
export * from "../../apps/api/src/index.ts";
export { default } from "../../apps/api/src/index.ts";

// The release the virtual feed offers: newer than the release a virtual kiosk first reports (2.0.0). A Worker entry can
// export only handlers and classes, so this is not exported.
const virtualOfficialRelease = "2.0.1";
const tag = `v${virtualOfficialRelease}`;
const repository = "/repos/isriah/LancerLogin";
const archives = ["arm64", "armv7"].map((arch) => `lancerlogin-kiosk-${virtualOfficialRelease}-linux-${arch}.tar.gz`);
const release = {
  tag_name: tag, name: tag, draft: false, prerelease: false, immutable: true,
  html_url: `https://github.com/isriah/LancerLogin/releases/tag/${tag}`,
  body: "A release served by the virtual kiosk stack. Nothing is downloaded or installed.",
  assets: ["install-lancerlogin.sh", ...archives].flatMap((name) => [{ name }, { name: `${name}.sha256` }]),
};
const answers = new Map([
  [`${repository}/releases/latest`, release],
  [`${repository}/releases`, [release]],
  [`${repository}/commits/${tag}`, { sha: "0".repeat(39) + "1" }],
]);

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "api.github.com") return realFetch(input, init);
  const answer = answers.get(url.pathname);
  return Promise.resolve(Response.json(answer ?? { message: "Not Found" }, { status: answer ? 200 : 404 }));
};
