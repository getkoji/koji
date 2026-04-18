import type { Db } from "@koji/db";
import type { Principal } from "./auth/adapter";
import type { Permission } from "./auth/roles";

export type Env = {
  Variables: {
    db: Db;
    principal: Principal;
    tenantId: string;
    grants: Set<Permission>;
    roles: string[];
  };
};
