import type { PageSnapshot } from "../engine.js";
import type { ParseResult } from "../../types.js";
/** Parses /pricing pages into tier structure intelligence (saas_pricing). */
export declare function parseSaas(snapshot: PageSnapshot): ParseResult;
