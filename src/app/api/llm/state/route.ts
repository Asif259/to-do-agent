import { getDeps } from "@/lib/runtime";
import { getRouterState } from "@/lib/router/admin";
import { respond } from "@/lib/router/http";

export const dynamic = "force-dynamic";

export const GET = () => respond(() => getRouterState(getDeps().db));
