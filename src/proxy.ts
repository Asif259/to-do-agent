import { NextResponse, type NextRequest } from "next/server";
import { guard, TOKEN_COOKIE } from "./lib/guard";

export function proxy(req: NextRequest) {
  const token = process.env.ACCESS_TOKEN || undefined;
  const result = guard(
    {
      method: req.method,
      host: req.headers.get("host"),
      origin: req.headers.get("origin"),
      cookieToken: req.cookies.get(TOKEN_COOKIE)?.value ?? null,
      queryToken: req.nextUrl.searchParams.get("token"),
    },
    token,
  );

  if (result.action === "allow") return NextResponse.next();
  if (result.action === "deny") return NextResponse.json({ error: result.reason }, { status: result.status });

  const clean = req.nextUrl.clone();
  clean.searchParams.delete("token");
  const res = NextResponse.redirect(clean);
  res.cookies.set(TOKEN_COOKIE, token!, { httpOnly: true, sameSite: "strict", path: "/", maxAge: 60 * 60 * 24 * 365 });
  return res;
}

export default proxy;
export const config = { matcher: "/((?!_next/static|_next/image|favicon.ico).*)" };
