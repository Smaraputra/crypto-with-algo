import 'next-auth';
import 'next-auth/jwt';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      tosAccepted: boolean;
      /**
       * Navigation hint only. Derived in the session callback by comparing
       * against ADMIN_EMAIL server-side; authorization is always requireAdmin.
       */
      isAdmin: boolean;
    };
  }

  interface User {
    id: string;
    name?: string | null;
    email?: string | null;
    image?: string | null;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string;
    tosAccepted?: boolean;
  }
}
