import { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    /** The device endpoint id whose key proof created this session. */
    endpointId?: string;
  }
  interface Session {
    user: {
      /** accountId */
      id: string;
      endpointId: string;
    } & Omit<DefaultSession["user"], "email">;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    endpointId?: string;
  }
}
