import type { Config, Context } from "@netlify/edge-functions";

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  header.split(/;\s*/).forEach((c) => {
    const i = c.indexOf("=");
    if (i > 0) out[c.slice(0, i).trim()] = c.slice(i + 1);
  });
  return out;
}

const LOGIN_HTML = `<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Login . House of Vinterberg</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#F8F5F0;color:#2C2C2C;font-family:'Inter',system-ui,-apple-system,sans-serif;font-size:16px;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}
  .card{background:#FDFCFA;border:1px solid #E8E0D5;padding:40px 36px;max-width:380px;width:100%}
  .brand{font-family:'Fraunces',Georgia,serif;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;font-size:11px;color:#C9BFB3;margin-bottom:10px}
  h1{font-family:'Fraunces',Georgia,serif;font-weight:500;font-size:22px;color:#1A1A1A;margin:0 0 6px;letter-spacing:0}
  .sub{font-size:13px;color:#C9BFB3;margin-bottom:24px}
  label{font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#C9BFB3;display:block;margin-bottom:6px}
  input[type=password]{width:100%;padding:11px 12px;border:1px solid #C9BFB3;background:#F8F5F0;font:inherit;color:#2C2C2C;border-radius:2px;margin-bottom:14px}
  input[type=password]:focus{outline:2px solid #C4A882;outline-offset:2px}
  button{width:100%;padding:12px 14px;background:#1A1A1A;color:#FDFCFA;border:1px solid #1A1A1A;font:inherit;font-size:13px;font-weight:500;letter-spacing:0.06em;text-transform:uppercase;cursor:pointer;border-radius:2px}
  button:hover{background:#000}
  .error{color:#9a4444;font-size:13px;margin-top:14px;min-height:18px}
</style>
</head>
<body>
  <div class="card">
    <div class="brand">House of Vinterberg</div>
    <h1>Daglig tjekliste</h1>
    <div class="sub">Staff login.</div>
    <form method="POST" action="/_auth">
      <label for="p">Kodeord</label>
      <input id="p" type="password" name="password" required autofocus />
      <button type="submit">Log ind</button>
    </form>
    <div class="error">{{ERROR}}</div>
  </div>
</body>
</html>`;

export default async (request: Request, _context: Context) => {
  const url = new URL(request.url);
  const SECRET = Netlify.env.get("AUTH_SECRET") || "change-me";
  const PASSWORD = Netlify.env.get("SHARED_PASSWORD") || "change-me";
  const EXPECTED = await hmac(SECRET, "ok-v1");
  const cookies = parseCookies(request.headers.get("cookie"));
  const valid = cookies["hov_auth"] === EXPECTED;

  // Handle login POST
  if (url.pathname === "/_auth" && request.method === "POST") {
    const formData = await request.formData().catch(() => null);
    const pwd = formData ? String(formData.get("password") || "") : "";
    if (pwd && pwd === PASSWORD) {
      return new Response("", {
        status: 303,
        headers: {
          "Location": "/",
          "Set-Cookie": `hov_auth=${EXPECTED}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
        },
      });
    }
    return new Response(LOGIN_HTML.replace("{{ERROR}}", "Forkert kodeord"), {
      status: 401,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Logout
  if (url.pathname === "/_logout") {
    return new Response("", {
      status: 303,
      headers: {
        "Location": "/",
        "Set-Cookie": "hov_auth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
      },
    });
  }

  if (valid) return; // pass through to static assets

  // Block: serve login page
  return new Response(LOGIN_HTML.replace("{{ERROR}}", ""), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
};

export const config: Config = {
  path: "/*",
};
