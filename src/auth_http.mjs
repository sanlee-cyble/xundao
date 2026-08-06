export const SESSION_COOKIE = "xundao_session";

export function parseCookies(header = "") {
  return Object.fromEntries(String(header || "").split(";").map((item) => {
    const index = item.indexOf("=");
    if (index < 0) return ["", ""];
    return [
      decodeURIComponent(item.slice(0, index).trim()),
      decodeURIComponent(item.slice(index + 1).trim()),
    ];
  }).filter(([key]) => key));
}

export function sessionTokenFromRequest(req) {
  return parseCookies(req?.headers?.cookie || "")[SESSION_COOKIE] || "";
}

export function sessionCookie(token, { secure = false, maxAgeSeconds = 14 * 24 * 60 * 60 } = {}) {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.max(0, Number(maxAgeSeconds) || 0)}`,
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

export function clearSessionCookie({ secure = false } = {}) {
  return sessionCookie("", { secure, maxAgeSeconds: 0 });
}
