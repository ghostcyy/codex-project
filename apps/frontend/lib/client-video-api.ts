function resolveVideoApiBaseUrl() {
  const envBaseUrl = process.env.NEXT_PUBLIC_VIDEO_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL;
  if (typeof envBaseUrl === "string" && envBaseUrl.trim().length > 0) {
    return envBaseUrl.replace(/\/$/, "");
  }

  if (typeof window !== "undefined") {
    const { protocol, hostname } = window.location;
    if (hostname !== "localhost" && hostname !== "127.0.0.1") {
      return `${protocol}//${hostname}:4101/api`;
    }
  }

  return "/api";
}

export function buildClientVideoApiUrl(path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveVideoApiBaseUrl()}${normalizedPath}`;
}

export function normalizeClientVideoAssetUrl(path: string) {
  if (/^https?:\/\//u.test(path)) {
    return path;
  }

  return buildClientVideoApiUrl(path.replace(/^\/api/u, ""));
}
