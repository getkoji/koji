import type { Db } from "@koji/db";
import type { Principal } from "./auth/adapter";
import type { Permission } from "./auth/roles";
import type { QueueProvider } from "./queue/provider";
import type { StorageProvider } from "./storage/provider";

export type Env = {
  Variables: {
    db: Db;
    principal: Principal;
    tenantId: string;
    grants: Set<Permission>;
    roles: string[];
    storage: StorageProvider;
    queue: QueueProvider;
  };
};
