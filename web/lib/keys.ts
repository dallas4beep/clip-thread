/** Object key layout in the bucket. Keys are always derived server-side from DB ids. */
export const submissionPrefix = (videoId: string) => `submissions/${videoId}/`;

export const segmentKey = (videoId: string, index: number, mimeType: string) =>
  `${submissionPrefix(videoId)}seg-${String(index).padStart(2, "0")}.${extensionFor(mimeType)}`;

export const manifestKey = (videoId: string) => `${submissionPrefix(videoId)}manifest.json`;

export function extensionFor(mimeType: string): "webm" | "mp4" | "mov" {
  const base = mimeType.split(";")[0].trim().toLowerCase();
  if (base === "video/mp4") return "mp4";
  if (base === "video/quicktime") return "mov";
  return "webm";
}

export const ALLOWED_SEGMENT_MIME = /^video\/(webm|mp4|quicktime)(;.*)?$/i;
