import type { PageSnapshot } from "../engine.js";
import type { ParseResult } from "../../types.js";
/** Parses real-estate / hospitality listing pages into price & availability intelligence. */
export declare function parseRealEstate(snapshot: PageSnapshot): ParseResult;
