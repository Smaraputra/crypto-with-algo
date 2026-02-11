import { NextRequest, NextResponse } from 'next/server';

const authPages = ['/login', '/register'];
const publicPrefixes = ['/login', '/register', '/docs', '/api-reference', '/blog', '/features', '/how-it-works'];
const publicExact = ['/'];

function getSessionToken(req: NextRequest): string | undefined {
  return (
    req.cookies.get('authjs.session-token')?.value ||
    req.cookies.get('__Secure-authjs.session-token')?.value
  );
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Redirect authenticated users away from login/register to dashboard
  if (authPages.includes(pathname)) {
    const token = getSessionToken(req);
    if (token) return NextResponse.redirect(new URL('/dashboard', req.url));
    return NextResponse.next();
  }

  const isPublic =
    publicExact.includes(pathname) ||
    publicPrefixes.some((path) => pathname.startsWith(path));
  if (isPublic) return NextResponse.next();

  // Check for the session token cookie. Cryptographic verification
  // happens server-side in auth() calls -- middleware only needs to
  // gate unauthenticated navigation to redirect to login.
  const token = getSessionToken(req);

  if (!token) {
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|public|api).*)'],
};
